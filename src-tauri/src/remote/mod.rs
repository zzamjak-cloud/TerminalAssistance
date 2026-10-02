// 모바일 원격 제어 — 서버 수명주기(RemoteHub) + 데스크톱 설정 UI 용 Tauri 커맨드.
// 기본 꺼짐. 켜지면 tauri 의 tokio 런타임 위에서 axum 서버를 띄운다
mod assets;
pub mod auth;
mod notify;
mod server;

use crate::pty::{PtyEvent, PtyManager, RemoteSub, SessionInfo};
use crate::store::{RemoteConfig, RemoteDevice, Store};
use crate::util::plock;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

const STOP_TIMEOUT: Duration = Duration::from_secs(2);
// last_seen 디스크 저장 최소 간격 — 매 요청마다 설정 파일을 다시 쓰지 않는다
const TOUCH_SAVE_GAP_MS: u64 = 60_000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// 로컬 인터페이스 IPv4 (루프백 제외). Tailscale(100.64/10) → 사설 → 그 외 순
pub fn iface_ips() -> Vec<IpAddr> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut ips: Vec<IpAddr> = nets
        .values()
        .flat_map(|n| n.ip_networks().iter().map(|ipn| ipn.addr))
        .filter(|ip| ip.is_ipv4() && !ip.is_loopback() && !ip.is_unspecified())
        .collect();
    let rank = |ip: &IpAddr| match ip {
        IpAddr::V4(v4) if v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64 => 0,
        IpAddr::V4(v4) if v4.is_private() => 1,
        _ => 2,
    };
    ips.sort_by_key(|ip| (rank(ip), *ip));
    ips.dedup();
    ips
}

fn url_of(ip: &IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V6(v6) => format!("http://[{}]:{}", v6, port),
        IpAddr::V4(v4) => format!("http://{}:{}", v4, port),
    }
}

/// 접속 URL 후보 — 0.0.0.0 바인드면 인터페이스 IP 들, 아니면 바인드 주소 하나
fn urls_for(bind: &str, port: u16) -> Vec<String> {
    match bind.parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => {
            let mut v: Vec<String> = iface_ips().iter().map(|ip| url_of(ip, port)).collect();
            v.push(format!("http://127.0.0.1:{}", port));
            v
        }
        Ok(ip) => vec![url_of(&ip, port)],
        Err(_) => Vec::new(),
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PushView {
    pub kind: String,
    pub url: String,
    pub topic: String,
    pub on_done: bool,
    pub on_waiting: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    created_ms: u64,
    last_seen_ms: u64,
}

/// 설정 UI 에 주는 상태 — 토큰 해시는 절대 포함하지 않는다
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    enabled: bool,
    bind: String,
    port: u16,
    running: bool,
    error: Option<String>,
    bind_warning: Option<String>,
    urls: Vec<String>,
    devices: Vec<DeviceView>,
    push: PushView,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigInput {
    enabled: bool,
    bind: String,
    port: u16,
    push: PushView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    code: String,
    url: String,
    qr_svg: String,
    expires_ms: u64,
}

struct Running {
    shutdown: watch::Sender<bool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct HubState {
    server: Option<Running>,
    error: Option<String>,
}

pub struct RemoteHub {
    state: Mutex<HubState>,
    pairing: Arc<Mutex<auth::Pairing>>,
    revoked: broadcast::Sender<String>,
}

impl RemoteHub {
    pub fn new() -> Self {
        RemoteHub {
            state: Mutex::new(HubState::default()),
            pairing: Arc::new(Mutex::new(auth::Pairing::default())),
            revoked: broadcast::channel(16).0,
        }
    }

    fn running(&self) -> bool {
        plock(&self.state).server.is_some()
    }

    /// 실행 중인 서버를 멈춘다. WS 연결은 shutdown 신호로 스스로 닫히고,
    /// HTTP 는 진행 중 요청을 마친 뒤 종료 — 시간 초과 시 강제 중단해 포트를 확실히 놓는다
    fn stop(&self) {
        let running = plock(&self.state).server.take();
        let Some(Running { shutdown, mut handle }) = running else { return };
        let _ = shutdown.send(true);
        tauri::async_runtime::block_on(async {
            if tokio::time::timeout(STOP_TIMEOUT, &mut handle).await.is_err() {
                handle.abort();
                let _ = handle.await;
            }
        });
    }

    /// 설정대로 서버를 (재)기동한다. 바인드 실패는 error 에 남겨 설정 UI 에 표시한다
    fn apply(&self, app: &AppHandle) {
        self.stop();
        let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.clone();
        let error = if cfg.enabled { self.start(app, &cfg).err() } else { None };
        plock(&self.state).error = error;
    }

    fn start(&self, app: &AppHandle, cfg: &RemoteConfig) -> Result<(), String> {
        let bind: IpAddr = cfg.bind.trim().parse().map_err(|_| format!("잘못된 바인드 주소: {}", cfg.bind))?;
        // 동기 바인드 — 포트 충돌 등 실패를 즉시 호출부로 돌려준다
        let std_listener = std::net::TcpListener::bind((bind, cfg.port))
            .map_err(|e| format!("{}:{} 바인드 실패: {}", cfg.bind, cfg.port, e))?;
        std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let ifaces = if bind.is_unspecified() { iface_ips() } else { Vec::new() };
        let (stx, srx) = watch::channel(false);
        let ctx = Arc::new(server::Ctx {
            backend: Arc::new(TauriBackend { app: app.clone(), last_saved: Mutex::new(0) }),
            pairing: Arc::clone(&self.pairing),
            bind,
            port: cfg.port,
            allowed_hosts: Mutex::new(auth::allowed_hosts(&bind, cfg.port, &ifaces)),
            revoked: self.revoked.clone(),
            shutdown: srx.clone(),
        });
        let router = server::router(ctx);
        let mut sig = srx;
        let handle = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("원격 서버 리스너 변환 실패: {}", e);
                    return;
                }
            };
            let shutdown = async move {
                let _ = sig.wait_for(|v| *v).await;
            };
            if let Err(e) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
                eprintln!("원격 서버 종료: {}", e);
            }
        });
        plock(&self.state).server = Some(Running { shutdown: stx, handle });
        Ok(())
    }

    fn view(&self, app: &AppHandle) -> RemoteView {
        let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.clone();
        let st = plock(&self.state);
        RemoteView {
            enabled: cfg.enabled,
            bind_warning: cfg.bind.parse::<IpAddr>().ok().and_then(|ip| auth::bind_warning(&ip)),
            urls: urls_for(&cfg.bind, cfg.port),
            bind: cfg.bind,
            port: cfg.port,
            running: st.server.is_some(),
            error: st.error.clone(),
            devices: cfg
                .devices
                .iter()
                .map(|d| DeviceView {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    created_ms: d.created_ms,
                    last_seen_ms: d.last_seen_ms,
                })
                .collect(),
            push: PushView {
                kind: cfg.push.kind,
                url: cfg.push.url,
                topic: cfg.push.topic,
                on_done: cfg.push.on_done,
                on_waiting: cfg.push.on_waiting,
            },
        }
    }
}

fn random_topic() -> String {
    format!("ta-{}", auth::hex(&auth::random_bytes::<8>()))
}

/// 앱 setup 에서 1회 — 랜덤 ntfy 토픽 발급, 설정이 켜져 있으면 서버 기동, 푸시 감시 시작
pub fn init(app: &AppHandle) {
    {
        let store = app.state::<Mutex<Store>>();
        let mut s = plock(&store);
        if s.data.remote.push.topic.is_empty() {
            // 공개 ntfy.sh 는 토픽 이름이 곧 구독 권한 — 추측 불가능한 랜덤 값을 기본으로
            s.data.remote.push.topic = random_topic();
            let _ = s.save();
        }
    }
    let hub = app.state::<RemoteHub>();
    if plock(&app.state::<Mutex<Store>>()).data.remote.enabled {
        hub.apply(app);
    }
    notify::spawn_watcher(app.clone());
}

/// Backend 의 Tauri 구현 — 저장소·PTY 매니저를 앱 상태에서 꺼내 쓴다
struct TauriBackend {
    app: AppHandle,
    last_saved: Mutex<u64>,
}

impl server::Backend for TauriBackend {
    fn devices(&self) -> Vec<RemoteDevice> {
        plock(&self.app.state::<Mutex<Store>>()).data.remote.devices.clone()
    }

    fn add_device(&self, dev: RemoteDevice) -> Result<(), String> {
        let store = self.app.state::<Mutex<Store>>();
        let mut s = plock(&store);
        s.data.remote.devices.push(dev);
        s.save()
    }

    fn touch_device(&self, id: &str) {
        let now = now_ms();
        let store = self.app.state::<Mutex<Store>>();
        let mut s = plock(&store);
        let Some(d) = s.data.remote.devices.iter_mut().find(|d| d.id == id) else { return };
        d.last_seen_ms = now;
        let mut last = plock(&self.last_saved);
        if now.saturating_sub(*last) >= TOUCH_SAVE_GAP_MS {
            *last = now;
            let _ = s.save();
        }
    }

    fn state(&self) -> serde_json::Value {
        let store = self.app.state::<Mutex<Store>>();
        let s = plock(&store);
        json!({
            "projects": s.data.projects,
            "presets": s.data.presets,
            "sessions": self.app.state::<PtyManager>().list(),
        })
    }

    fn sessions(&self) -> Vec<SessionInfo> {
        self.app.state::<PtyManager>().list()
    }

    fn subscribe(&self, id: &str, tail_bytes: usize) -> Option<RemoteSub> {
        self.app.state::<PtyManager>().remote_subscribe(id, tail_bytes)
    }

    fn write(&self, id: &str, data: &str) {
        self.app.state::<PtyManager>().write(id, data);
    }

    fn ack(&self, id: &str) {
        self.app.state::<PtyManager>().ack(&self.app, id);
    }

    fn create(&self, project_id: Option<String>) -> Result<SessionInfo, String> {
        let store = self.app.state::<Mutex<Store>>();
        let ptys = self.app.state::<PtyManager>();
        let info = crate::create_session_inner(&self.app, &store, &ptys, project_id)?;
        // 데스크톱은 자기가 만든 세션만 알고 있으므로 탭 추가를 위해 알린다
        let _ = self.app.emit("ta:session-created", &info);
        Ok(info)
    }

    fn events(&self) -> broadcast::Receiver<PtyEvent> {
        self.app.state::<PtyManager>().subscribe_events()
    }
}

// ── Tauri 커맨드 (데스크톱 설정 UI) ──

#[tauri::command]
pub fn remote_get_config(app: AppHandle, hub: State<RemoteHub>) -> RemoteView {
    hub.view(&app)
}

#[tauri::command]
pub fn remote_set_config(
    app: AppHandle,
    hub: State<RemoteHub>,
    cfg: RemoteConfigInput,
) -> Result<RemoteView, String> {
    let bind = cfg.bind.trim().to_string();
    bind.parse::<IpAddr>().map_err(|_| format!("바인드 주소는 IP 여야 합니다: {}", bind))?;
    if cfg.port == 0 {
        return Err("포트는 1~65535 사이여야 합니다".into());
    }
    let kind = cfg.push.kind.trim().to_string();
    if kind != "off" && kind != "ntfy" {
        return Err(format!("지원하지 않는 푸시 종류: {}", kind));
    }
    let url = cfg.push.url.trim().trim_end_matches('/').to_string();
    let topic = cfg.push.topic.trim().to_string();
    if kind == "ntfy" {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("ntfy 서버 주소는 http(s):// 로 시작해야 합니다".into());
        }
        if !topic.is_empty() && !notify::valid_topic(&topic) {
            return Err("ntfy 토픽은 영문·숫자·-·_ 64자 이내여야 합니다".into());
        }
    }
    let restart = {
        let store = app.state::<Mutex<Store>>();
        let mut s = plock(&store);
        let r = &mut s.data.remote;
        // 푸시만 바뀐 경우엔 서버를 재시작하지 않는다 — 폰 연결이 끊기지 않게
        let restart = r.enabled != cfg.enabled || r.bind != bind || r.port != cfg.port || (cfg.enabled && !hub.running());
        r.enabled = cfg.enabled;
        r.bind = bind;
        r.port = cfg.port;
        r.push.kind = kind;
        r.push.url = if url.is_empty() { "https://ntfy.sh".into() } else { url };
        r.push.topic = if topic.is_empty() { random_topic() } else { topic };
        r.push.on_done = cfg.push.on_done;
        r.push.on_waiting = cfg.push.on_waiting;
        s.save()?;
        restart
    };
    if restart {
        hub.apply(&app);
    }
    Ok(hub.view(&app))
}

#[tauri::command]
pub fn remote_start_pairing(app: AppHandle, hub: State<RemoteHub>) -> Result<PairingView, String> {
    if !hub.running() {
        return Err("원격 서버가 실행 중이 아닙니다".into());
    }
    let (bind, port) = {
        let store = app.state::<Mutex<Store>>();
        let s = plock(&store);
        (s.data.remote.bind.clone(), s.data.remote.port)
    };
    let base = urls_for(&bind, port).into_iter().next().ok_or("접속 주소를 찾을 수 없습니다")?;
    let now = Instant::now();
    let (code, expires) = plock(&hub.pairing).start(now);
    let expires_ms = now_ms() + expires.duration_since(now).as_millis() as u64;
    let url = format!("{}/#pair={}", base, code);
    let qr_svg = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .build();
    Ok(PairingView { code, url, qr_svg, expires_ms })
}

#[tauri::command]
pub fn remote_revoke_device(
    app: AppHandle,
    hub: State<RemoteHub>,
    id: String,
) -> Result<RemoteView, String> {
    {
        let store = app.state::<Mutex<Store>>();
        let mut s = plock(&store);
        s.data.remote.devices.retain(|d| d.id != id);
        s.save()?;
    }
    // 해시 삭제로 이후 요청은 401, 열려 있던 WS 는 이 통지로 즉시 4001 종료
    let _ = hub.revoked.send(id);
    Ok(hub.view(&app))
}

#[tauri::command]
pub async fn remote_test_push(app: AppHandle) -> Result<(), String> {
    let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.push.clone();
    if cfg.kind != "ntfy" {
        return Err("푸시가 꺼져 있습니다".into());
    }
    if !notify::valid_topic(&cfg.topic) {
        return Err("ntfy 토픽이 올바르지 않습니다".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        notify::send_ntfy(&cfg.url, &cfg.topic, "테스트 알림 — 원격 푸시가 연결되었습니다", "default", "bell")
    })
    .await
    .map_err(|e| e.to_string())?
}
