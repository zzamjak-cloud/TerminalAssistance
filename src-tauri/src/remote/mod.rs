// 모바일 원격 제어 — 서버 수명주기(RemoteHub) + 데스크톱 설정 UI 용 Tauri 커맨드.
// 기본 꺼짐. 켜지면 tauri 의 tokio 런타임 위에서 axum 서버를 띄운다
mod assets;
pub mod auth;
mod notify;
mod server;
mod upload;

use crate::pty::{PtyEvent, PtyManager, RemoteSub, SessionInfo};
use crate::store::{RemoteConfig, RemoteDevice, Store};
use crate::util::plock;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

const STOP_TIMEOUT: Duration = Duration::from_secs(2);
// last_seen 디스크 저장 최소 간격 — 매 요청마다 설정 파일을 다시 쓰지 않는다
const TOUCH_SAVE_GAP_MS: u64 = 60_000;
// ta:remote-input 세션별 간격 — 타이핑마다 IPC 를 쏘지 않게
const INPUT_EVENT_GAP: Duration = Duration::from_millis(200);
// 켜져 있는데 서버가 없거나 Tailscale IP 가 바뀐 경우를 점검하는 주기
const WATCH_INTERVAL: Duration = Duration::from_secs(15);
// 고정 바인드 연속 실패 시 재시도 간격 상한
const RETRY_MAX: Duration = Duration::from_secs(120);
// tailscale CLI 응답 대기 — 데몬이 멈춰 있어도 감시 주기를 붙잡지 않게
const TS_CLI_TIMEOUT: Duration = Duration::from_millis(1500);
/// 바인드 '자동' — 서버 시작 시점의 Tailscale IPv4 로 해석한다
pub const BIND_AUTO: &str = "auto";
const NO_TAILSCALE: &str = "Tailscale 미연결 — 이 컴퓨터에서 Tailscale 에 로그인하면 자동으로 다시 시도합니다";

type ConnCounts = Arc<Mutex<std::collections::HashMap<String, usize>>>;

/// 키별 선두 스로틀 — 간격 안의 반복 이벤트는 버린다
struct Throttle {
    gap: Duration,
    last: std::collections::HashMap<String, Instant>,
}

impl Throttle {
    fn new(gap: Duration) -> Self {
        Throttle { gap, last: std::collections::HashMap::new() }
    }

    fn allow(&mut self, key: &str, now: Instant) -> bool {
        if self.last.get(key).is_some_and(|t| now.duration_since(*t) < self.gap) {
            return false;
        }
        // 닫힌 세션 키가 쌓이지 않게 오래된 항목은 정리
        if self.last.len() > 256 {
            let gap = self.gap;
            self.last.retain(|_, t| now.duration_since(*t) < gap);
        }
        self.last.insert(key.to_string(), now);
        true
    }
}

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

fn is_auto(bind: &str) -> bool {
    bind.trim().eq_ignore_ascii_case(BIND_AUTO)
}

/// Tailscale 이 만드는 인터페이스 이름 — macOS utun*, Linux tailscale0, Windows 'Tailscale'.
/// 100.64/10 은 통신사 CGNAT·다른 VPN 도 쓰므로 대역만으로는 판정하지 않는다
fn is_tailscale_iface(name: &str) -> bool {
    name.starts_with("utun") || name.to_ascii_lowercase().contains("tailscale")
}

fn iface_named_ips() -> Vec<(String, IpAddr)> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    nets.iter()
        .flat_map(|(name, n)| n.ip_networks().iter().map(move |ipn| (name.clone(), ipn.addr)))
        .collect()
}

/// CLI 가 준 IP 가 실제 로컬 인터페이스에 있으면 우선, 아니면 Tailscale 이름 인터페이스의 100.64/10 주소
fn choose_tailscale(cli: Option<IpAddr>, ifaces: &[(String, IpAddr)]) -> Option<IpAddr> {
    if let Some(ip) = cli.filter(|ip| auth::is_cgnat(ip) && ifaces.iter().any(|(_, a)| a == ip)) {
        return Some(ip);
    }
    let mut v: Vec<IpAddr> = ifaces
        .iter()
        .filter(|(n, ip)| ip.is_ipv4() && auth::is_cgnat(ip) && is_tailscale_iface(n))
        .map(|(_, ip)| *ip)
        .collect();
    v.sort();
    v.into_iter().next()
}

// CLI 가 없는 환경에서 매 주기 프로세스 생성을 시도하지 않게
static TS_CLI_MISSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `tailscale ip -4` — 없거나 응답이 늦으면 None (블로킹: spawn_blocking 에서 부른다)
fn tailscale_cli_ip() -> Option<IpAddr> {
    use std::sync::atomic::Ordering;
    if TS_CLI_MISSING.load(Ordering::Relaxed) {
        return None;
    }
    // GUI 앱은 PATH 가 짧아 흔한 설치 위치도 직접 본다
    const CANDIDATES: &[&str] = &[
        "tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    for bin in CANDIDATES {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(["ip", "-4"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let Ok(mut child) = cmd.spawn() else { continue };
        let deadline = Instant::now() + TS_CLI_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut out = String::new();
        if let Some(mut so) = child.stdout.take() {
            use std::io::Read;
            let _ = so.read_to_string(&mut out);
        }
        return out.lines().next().and_then(|l| l.trim().parse().ok());
    }
    TS_CLI_MISSING.store(true, Ordering::Relaxed);
    None
}

/// Tailscale IPv4 탐지 (블로킹). CLI 결과 우선, 없으면 인터페이스 이름으로
fn tailscale_ip_blocking() -> Option<IpAddr> {
    choose_tailscale(tailscale_cli_ip(), &iface_named_ips())
}

pub async fn tailscale_ip() -> Option<IpAddr> {
    tauri::async_runtime::spawn_blocking(tailscale_ip_blocking).await.ok().flatten()
}

/// 설정 바인드 문자열 → 실제 바인드 IP. auto 는 미리 탐지한 Tailscale IP
fn resolve_bind(bind: &str, ts: Option<IpAddr>) -> Result<IpAddr, String> {
    if is_auto(bind) {
        return ts.ok_or_else(|| NO_TAILSCALE.to_string());
    }
    bind.trim().parse().map_err(|_| format!("잘못된 바인드 주소: {}", bind))
}

/// 감시 주기 판단 — 켜져 있는데 안 떠 있으면 재시도, auto 면 Tailscale IP 변경 시 즉시 재바인드.
/// IP 가 사라진 건 일시 끊김일 수 있어 2회 연속 관측(ts_missing_streak)해야 내린다.
/// auto 인데 Tailscale 이 아직 없으면 재시도해도 같은 실패라 건너뛴다
fn needs_restart(enabled: bool, auto: bool, bound: Option<IpAddr>, ts_now: Option<IpAddr>, ts_missing_streak: u32) -> bool {
    if !enabled {
        return false;
    }
    match (bound, ts_now) {
        (None, _) => !auto || ts_now.is_some(),
        (Some(_), _) if !auto => false,
        (Some(_), None) => ts_missing_streak >= 2,
        (Some(b), Some(t)) => b != t,
    }
}

/// 연속 실패 백오프 — 15초에서 두 배씩, 최대 2분
fn next_backoff(prev: Option<Duration>) -> Duration {
    prev.map_or(WATCH_INTERVAL, |d| (d * 2).min(RETRY_MAX))
}

/// 기기별 WS 연결 수 갱신. 연결된 기기 집합이 바뀌었으면 true
fn count_conn(counts: &mut std::collections::HashMap<String, usize>, device_id: &str, open: bool) -> bool {
    if open {
        let n = counts.entry(device_id.to_string()).or_insert(0);
        *n += 1;
        return *n == 1;
    }
    match counts.get_mut(device_id) {
        Some(n) if *n > 1 => {
            *n -= 1;
            false
        }
        Some(_) => {
            counts.remove(device_id);
            true
        }
        None => false,
    }
}

fn url_of(ip: &IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V6(v6) => format!("http://[{}]:{}", v6, port),
        IpAddr::V4(v4) => format!("http://{}:{}", v4, port),
    }
}

/// 접속 URL 후보 — 0.0.0.0 바인드면 인터페이스 IP 들, 아니면 바인드 주소 하나
fn urls_for(ip: &IpAddr, port: u16) -> Vec<String> {
    if ip.is_unspecified() {
        let mut v: Vec<String> = iface_ips().iter().map(|ip| url_of(ip, port)).collect();
        v.push(format!("http://127.0.0.1:{}", port));
        v
    } else {
        vec![url_of(ip, port)]
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
    #[serde(default)]
    pub include_project: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    created_ms: u64,
    last_seen_ms: u64,
}

/// 설정 UI 에 주는 상태 — 토큰 해시는 절대 포함하지 않는다
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    enabled: bool,
    bind: String,
    /// 실제(또는 지금 해석한) 바인드 IP — auto 의 해석 결과 표시용
    resolved_bind: Option<String>,
    port: u16,
    running: bool,
    error: Option<String>,
    bind_warning: Option<String>,
    bind_level: &'static str,
    push_warning: Option<String>,
    urls: Vec<String>,
    devices: Vec<DeviceView>,
    connected_devices: usize,
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
    gen: u64,
    bind: IpAddr,
    shutdown: watch::Sender<bool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct HubState {
    server: Option<Running>,
    error: Option<String>,
    gen: u64, // 서버 세대 — 스스로 종료한 옛 태스크가 새 서버 상태를 지우지 않게
    /// 마지막 Tailscale 탐지 결과 — view 는 동기라 프로세스를 띄우지 않고 이 값을 쓴다
    ts_cache: Option<IpAddr>,
    ts_missing_streak: u32,
    /// 감시 태스크 재시도 백오프 (None = 실패 이력 없음)
    backoff: Option<Duration>,
    next_retry: Option<Instant>,
}

pub struct RemoteHub {
    state: Arc<Mutex<HubState>>,
    // stop→start 를 한 덩어리로 — 동시 설정 변경이 서로의 서버를 엇갈려 띄우지 않게
    apply_lock: tokio::sync::Mutex<()>,
    pairing: Arc<Mutex<auth::Pairing>>,
    revoked: broadcast::Sender<String>,
    conns: ConnCounts,
}

impl RemoteHub {
    pub fn new() -> Self {
        RemoteHub {
            state: Arc::new(Mutex::new(HubState::default())),
            apply_lock: tokio::sync::Mutex::new(()),
            pairing: Arc::new(Mutex::new(auth::Pairing::default())),
            revoked: broadcast::channel(16).0,
            conns: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn running(&self) -> bool {
        plock(&self.state).server.is_some()
    }

    fn bound(&self) -> Option<IpAddr> {
        plock(&self.state).server.as_ref().map(|r| r.bind)
    }

    /// 실행 중인 서버를 멈춘다. WS 연결은 shutdown 신호로 스스로 닫히고,
    /// HTTP 는 진행 중 요청을 마친 뒤 종료 — 시간 초과 시 강제 중단해 포트를 확실히 놓는다
    async fn stop(&self) {
        let running = plock(&self.state).server.take();
        let Some(Running { shutdown, mut handle, .. }) = running else { return };
        let _ = shutdown.send(true);
        if tokio::time::timeout(STOP_TIMEOUT, &mut handle).await.is_err() {
            handle.abort();
            let _ = handle.await;
        }
    }

    /// 설정대로 서버를 (재)기동한다. 바인드 실패는 error 에 남겨 설정 UI 에 표시한다.
    /// 사용자 조작 경로라 감시 백오프를 초기화한다
    async fn apply(&self, app: &AppHandle) {
        let _apply = self.apply_lock.lock().await;
        let auto = is_auto(&plock(&app.state::<Mutex<Store>>()).data.remote.bind);
        let ts = if auto { tailscale_ip().await } else { None };
        {
            let mut st = plock(&self.state);
            st.ts_cache = ts;
            st.backoff = None;
            st.next_retry = None;
        }
        self.apply_locked(app, ts).await;
    }

    /// apply_lock 을 쥔 호출부 전용. 결과(바인드·오류)가 바뀌었을 때만 통지한다
    async fn apply_locked(&self, app: &AppHandle, ts: Option<IpAddr>) {
        let before = (self.bound(), plock(&self.state).error.clone());
        self.stop().await;
        let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.clone();
        let error =
            if cfg.enabled { resolve_bind(&cfg.bind, ts).and_then(|ip| self.start(app, &cfg, ip)).err() } else { None };
        plock(&self.state).error = error;
        if before != (self.bound(), plock(&self.state).error.clone()) {
            emit_status(app);
        }
    }

    /// 감시 주기 1회 — 판단 재료(설정·바인드·Tailscale)를 apply_lock 안에서 다시 읽어
    /// 사용자 설정 변경과 엇갈려 옛 판단으로 재시작하지 않게 한다
    async fn apply_if_needed(&self, app: &AppHandle) {
        let _apply = self.apply_lock.lock().await;
        let (enabled, auto) = {
            let store = app.state::<Mutex<Store>>();
            let s = plock(&store);
            (s.data.remote.enabled, is_auto(&s.data.remote.bind))
        };
        if !enabled {
            return;
        }
        let bound = self.bound();
        let ts = if auto { tailscale_ip().await } else { None };
        let now = Instant::now();
        let restart = {
            let mut st = plock(&self.state);
            if auto {
                st.ts_cache = ts;
            }
            st.ts_missing_streak = if auto && bound.is_some() && ts.is_none() { st.ts_missing_streak + 1 } else { 0 };
            let due = bound.is_some() || st.next_retry.is_none_or(|t| now >= t);
            due && needs_restart(enabled, auto, bound, ts, st.ts_missing_streak)
        };
        if !restart {
            return;
        }
        self.apply_locked(app, ts).await;
        let mut st = plock(&self.state);
        if st.server.is_some() {
            st.backoff = None;
            st.next_retry = None;
        } else {
            let b = next_backoff(st.backoff);
            st.backoff = Some(b);
            st.next_retry = Some(Instant::now() + b);
        }
    }

    fn start(&self, app: &AppHandle, cfg: &RemoteConfig, bind: IpAddr) -> Result<(), String> {
        // 동기 바인드 — 포트 충돌 등 실패를 즉시 호출부로 돌려준다
        let std_listener = std::net::TcpListener::bind((bind, cfg.port))
            .map_err(|e| format!("{} 바인드 실패: {}", url_of(&bind, cfg.port), e))?;
        std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let ifaces = if bind.is_unspecified() { iface_ips() } else { Vec::new() };
        let (stx, srx) = watch::channel(false);
        let ctx = Arc::new(server::Ctx {
            backend: Arc::new(TauriBackend {
                app: app.clone(),
                last_saved: Mutex::new(0),
                input_throttle: Mutex::new(Throttle::new(INPUT_EVENT_GAP)),
                conns: Arc::clone(&self.conns),
            }),
            pairing: Arc::clone(&self.pairing),
            bind,
            port: cfg.port,
            allowed_hosts: Mutex::new((Instant::now(), auth::allowed_hosts(&bind, cfg.port, &ifaces))),
            revoked: self.revoked.clone(),
            shutdown: srx.clone(),
            next_conn: std::sync::atomic::AtomicU64::new(1),
            upload_slots: tokio::sync::Semaphore::new(server::UPLOAD_CONCURRENCY),
        });
        let router = server::router(ctx);
        let mut sig = srx.clone();
        let stopping = srx;
        let state = Arc::clone(&self.state);
        let app = app.clone();
        // 상태 락을 쥔 채 spawn → 태스크가 즉시 끝나도 server 등록이 먼저 일어난다
        let mut st = plock(&self.state);
        st.gen += 1;
        let gen = st.gen;
        let handle = tauri::async_runtime::spawn(async move {
            let result = match tokio::net::TcpListener::from_std(std_listener) {
                Err(e) => Err(format!("원격 서버 리스너 생성 실패: {}", e)),
                Ok(listener) => {
                    let shutdown = async move {
                        let _ = sig.wait_for(|v| *v).await;
                    };
                    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                        .with_graceful_shutdown(shutdown)
                        .await
                        .map_err(|e| format!("원격 서버가 중단되었습니다: {}", e))
                }
            };
            if *stopping.borrow() {
                return; // 요청된 정지
            }
            // 스스로 끝났다 — 설정 UI 가 '실행 중' 으로 남지 않게 상태를 내린다
            {
                let mut st = plock(&state);
                if !st.server.as_ref().is_some_and(|r| r.gen == gen) {
                    return;
                }
                st.server = None;
                st.error = Some(result.err().unwrap_or_else(|| "원격 서버가 예기치 않게 종료되었습니다".into()));
            }
            emit_status(&app);
        });
        st.server = Some(Running { gen, bind, shutdown: stx, handle });
        Ok(())
    }

    fn view(&self, app: &AppHandle) -> RemoteView {
        let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.clone();
        let auto = is_auto(&cfg.bind);
        // 실행 중이면 실제 바인드, 아니면 지금 해석한 주소 (auto 는 마지막 탐지값)
        let ts_cache = plock(&self.state).ts_cache;
        let ip = self.bound().or_else(|| resolve_bind(&cfg.bind, ts_cache).ok());
        let connected_devices = plock(&self.conns).len();
        let st = plock(&self.state);
        RemoteView {
            enabled: cfg.enabled,
            bind_warning: ip.as_ref().and_then(auth::bind_warning),
            // auto 는 Tailscale 로만 해석되므로 미연결이어도 tailscale 등급
            bind_level: if auto { "tailscale" } else { ip.as_ref().map(auth::bind_level).unwrap_or("public") },
            push_warning: push_warning(&cfg.push.url),
            urls: ip.map(|ip| urls_for(&ip, cfg.port)).unwrap_or_default(),
            resolved_bind: ip.map(|ip| ip.to_string()),
            connected_devices,
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
                include_project: cfg.push.include_project,
            },
        }
    }
}

/// 데스크톱의 📱 배지·연결 모달 갱신용 상태 통지
/// 앱 종료 중(연결 Drop 등)에도 불릴 수 있어 상태가 없으면 조용히 건너뛴다
fn emit_status(app: &AppHandle) {
    let (Some(hub), Some(_)) = (app.try_state::<RemoteHub>(), app.try_state::<Mutex<Store>>()) else { return };
    let view = hub.view(app);
    let _ = app.emit("ta:remote-status", view);
}

fn push_warning(url: &str) -> Option<String> {
    url.trim().to_ascii_lowercase().starts_with("http://").then(|| {
        "ntfy 서버 주소가 http:// 입니다 — 알림 내용과 토픽이 암호화되지 않은 채 전송됩니다.".to_string()
    })
}

fn random_topic() -> String {
    format!("ta-{}", auth::hex(&auth::random_bytes::<16>()))
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
    if plock(&app.state::<Mutex<Store>>()).data.remote.enabled {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            app.state::<RemoteHub>().apply(&app).await;
        });
    }
    notify::spawn_watcher(app.clone());
    spawn_control_bridge(app.clone());
    spawn_bind_watcher(app.clone());
}

/// 바인드 실패·Tailscale 늦은 연결·IP 변경을 주기적으로 회복한다
fn spawn_bind_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(WATCH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tick.tick().await; // 첫 tick 은 즉시 — 기동 직후는 init 의 apply 가 맡는다
        loop {
            tick.tick().await;
            app.state::<RemoteHub>().apply_if_needed(&app).await;
        }
    });
}

/// 제어권 변경을 데스크톱에 전달 (배너 표시·되찾기). 원천은 PtyManager 이벤트 하나 —
/// 폰 요청·연결 종료·폐기·데스크톱 되찾기 어느 경로든 같은 이벤트로 나간다
fn spawn_control_bridge(app: AppHandle) {
    let mut rx = app.state::<PtyManager>().subscribe_events();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Control { id, holder, device_name, cols, rows }) => {
                    let _ = app.emit(
                        "ta:remote-control",
                        json!({ "id": id, "holder": holder, "deviceName": device_name, "cols": cols, "rows": rows }),
                    );
                }
                Ok(_) => {}
                // 놓친 변경이 있으면 현재 보유 상태 전체를 다시 알린다
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let ptys = app.state::<PtyManager>();
                    for s in ptys.list() {
                        let ctrl = ptys.control_of(&s.id);
                        let _ = app.emit(
                            "ta:remote-control",
                            json!({
                                "id": s.id, "holder": ctrl.as_ref().map(|c| &c.0),
                                "deviceName": ctrl.as_ref().map(|c| &c.1),
                                "cols": s.cols, "rows": s.rows,
                            }),
                        );
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Backend 의 Tauri 구현 — 저장소·PTY 매니저를 앱 상태에서 꺼내 쓴다
struct TauriBackend {
    app: AppHandle,
    last_saved: Mutex<u64>,
    input_throttle: Mutex<Throttle>,
    conns: ConnCounts,
}

impl server::Backend for TauriBackend {
    fn devices(&self) -> Vec<RemoteDevice> {
        plock(&self.app.state::<Mutex<Store>>()).data.remote.devices.clone()
    }

    fn add_device(&self, dev: RemoteDevice) -> Result<(), String> {
        {
            let store = self.app.state::<Mutex<Store>>();
            let mut s = plock(&store);
            s.data.remote.devices.push(dev);
            s.save()?;
        }
        // 데스크톱 연결 모달이 '연결됨' 으로 바뀌는 신호
        emit_status(&self.app);
        Ok(())
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

    fn remove_device(&self, id: &str) {
        {
            let store = self.app.state::<Mutex<Store>>();
            let mut s = plock(&store);
            s.data.remote.devices.retain(|d| d.id != id);
            let _ = s.save();
        }
        self.app.state::<PtyManager>().release_device(id);
        emit_status(&self.app);
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
        // 데스크톱의 입력 줄 추적(typed-line)이 폰 입력과 어긋나지 않게 리셋을 알린다
        if plock(&self.input_throttle).allow(id, Instant::now()) {
            let _ = self.app.emit("ta:remote-input", json!({ "id": id }));
        }
    }

    fn take_control(
        &self,
        id: &str,
        device_id: &str,
        device_name: &str,
        conn_id: u64,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.app.state::<PtyManager>().take_control(id, device_id, device_name, conn_id, cols, rows)
    }

    fn release_control(&self, id: &str, device_id: &str) {
        self.app.state::<PtyManager>().release_control_by_device(id, device_id);
    }

    fn release_conn(&self, conn_id: u64) {
        self.app.state::<PtyManager>().release_conn(conn_id);
    }

    fn image_dir(&self) -> Result<std::path::PathBuf, String> {
        // 데스크톱 clipboard_image 와 같은 위치
        Ok(self.app.path().app_data_dir().map_err(|e| e.to_string())?.join("images"))
    }

    fn image_saved(&self, session: &str, path: &str) {
        let _ = self.app.emit("ta:remote-image", json!({ "sessionId": session, "path": path }));
    }

    fn ack(&self, id: &str) {
        self.app.state::<PtyManager>().ack(&self.app, id);
    }

    fn create(&self, project_id: Option<String>) -> Result<SessionInfo, String> {
        let store = self.app.state::<Mutex<Store>>();
        let ptys = self.app.state::<PtyManager>();
        // 상한 검사와 ta:session-created(데스크톱 탭 추가) 발행은 생성 경로 안에서 직렬화돼 일어난다
        crate::create_session_inner(&self.app, &store, &ptys, project_id, Some(server::MAX_SESSIONS))
    }

    fn events(&self) -> broadcast::Receiver<PtyEvent> {
        self.app.state::<PtyManager>().subscribe_events()
    }

    fn conn_changed(&self, device_id: &str, open: bool) {
        // 락을 놓은 뒤 통지 — view 가 같은 락을 다시 잡는다
        let changed = count_conn(&mut plock(&self.conns), device_id, open);
        if changed {
            emit_status(&self.app);
        }
    }
}

// ── Tauri 커맨드 (데스크톱 설정 UI) ──

#[tauri::command]
pub fn remote_get_config(app: AppHandle, hub: State<RemoteHub>) -> RemoteView {
    hub.view(&app)
}

// 서버 정지 대기(최대 수 초)가 있어 async — 동기 커맨드면 메인 스레드(UI)를 막는다
#[tauri::command]
pub async fn remote_set_config(app: AppHandle, cfg: RemoteConfigInput) -> Result<RemoteView, String> {
    let hub = app.state::<RemoteHub>();
    let bind = cfg.bind.trim().to_string();
    let bind = if is_auto(&bind) {
        BIND_AUTO.to_string()
    } else {
        bind.parse::<IpAddr>().map_err(|_| format!("바인드 주소는 IP 또는 auto 여야 합니다: {}", bind))?;
        bind
    };
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
        r.push.include_project = cfg.push.include_project;
        s.save()?;
        restart
    };
    if restart {
        hub.apply(&app).await;
    }
    Ok(hub.view(&app))
}

#[tauri::command]
pub fn remote_start_pairing(app: AppHandle, hub: State<RemoteHub>) -> Result<PairingView, String> {
    issue_pairing(&app, &hub)
}

fn issue_pairing(app: &AppHandle, hub: &RemoteHub) -> Result<PairingView, String> {
    let Some(bind) = hub.bound() else {
        return Err("원격 서버가 실행 중이 아닙니다".into());
    };
    let port = plock(&app.state::<Mutex<Store>>()).data.remote.port;
    // QR 에는 실제 바인드 IP (auto 면 Tailscale IP) 가 들어간다
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
    app.state::<PtyManager>().release_device(&id);
    let _ = hub.revoked.send(id);
    emit_status(&app);
    Ok(hub.view(&app))
}

/// '폰 연결' 원클릭 결과. 실패도 Err 가 아닌 reason 으로 돌려 UI 가 분기 안내를 그린다
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickConnect {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<RemoteView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing: Option<PairingView>,
    /// 켜져 있던 고정 바인드를 auto 로 바꿨으면 이전 값 — UI 가 한 줄 알린다
    #[serde(skip_serializing_if = "Option::is_none")]
    changed_from: Option<String>,
}

impl QuickConnect {
    fn fail(reason: &'static str, view: Option<RemoteView>) -> Self {
        let error = view.as_ref().and_then(|v| v.error.clone());
        QuickConnect { ok: false, reason: Some(reason), error, view, pairing: None, changed_from: None }
    }
}

/// 원클릭 시 재시작 여부 — 이미 그 Tailscale IP 로 떠 있으면 설정만 바꾸고 연결을 유지한다
fn quick_restart(bound: Option<IpAddr>, ts: IpAddr) -> bool {
    bound != Some(ts)
}

/// 켜져 있던 고정 바인드를 덮어쓸 때만 이전 값을 알린다 (꺼져 있던 기본값 변경은 소음)
fn quick_changed_from(enabled: bool, bind: &str) -> Option<String> {
    (enabled && !is_auto(bind)).then(|| bind.to_string())
}

/// Tailscale IP 로 자동 바인드해 서버를 켜고 페어링 코드를 발급한다
#[tauri::command]
pub async fn remote_quick_connect(app: AppHandle) -> Result<QuickConnect, String> {
    let hub = app.state::<RemoteHub>();
    let changed_from = {
        let _apply = hub.apply_lock.lock().await;
        let ts = tailscale_ip().await;
        {
            let mut st = plock(&hub.state);
            st.ts_cache = ts;
            st.backoff = None;
            st.next_retry = None;
        }
        let Some(ts) = ts else {
            return Ok(QuickConnect::fail("no-tailscale", None));
        };
        let changed_from = {
            let store = app.state::<Mutex<Store>>();
            let mut s = plock(&store);
            let r = &mut s.data.remote;
            let changed_from = quick_changed_from(r.enabled, &r.bind);
            r.enabled = true;
            r.bind = BIND_AUTO.into();
            s.save()?;
            changed_from
        };
        if quick_restart(hub.bound(), ts) {
            hub.apply_locked(&app, Some(ts)).await;
        } else {
            emit_status(&app); // 설정 표시(auto)만 갱신
        }
        changed_from
    };
    if !hub.running() {
        return Ok(QuickConnect::fail("start-failed", Some(hub.view(&app))));
    }
    let pairing = issue_pairing(&app, &hub)?;
    Ok(QuickConnect {
        ok: true,
        reason: None,
        error: None,
        view: Some(hub.view(&app)),
        pairing: Some(pairing),
        changed_from,
    })
}

/// 데스크톱이 제어권을 되찾는다 — PTY 크기는 데스크톱 희망 크기로 복원된다
#[tauri::command]
pub fn remote_release_control(ptys: State<PtyManager>, id: String) {
    ptys.release_control(&id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_throttle_per_session() {
        let t0 = Instant::now();
        let mut t = Throttle::new(INPUT_EVENT_GAP);
        assert!(t.allow("a", t0));
        assert!(!t.allow("a", t0 + Duration::from_millis(150)));
        assert!(t.allow("b", t0 + Duration::from_millis(10)));
        assert!(t.allow("a", t0 + INPUT_EVENT_GAP));
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn auto_bind_resolves_to_tailscale_only() {
        assert!(is_auto("auto") && is_auto(" AUTO ") && !is_auto("127.0.0.1"));
        assert_eq!(resolve_bind("auto", Some(ip("100.64.0.9"))), Ok(ip("100.64.0.9")));
        assert!(resolve_bind("auto", None).unwrap_err().contains("Tailscale 미연결"));
        assert_eq!(resolve_bind(" 127.0.0.1 ", Some(ip("100.64.0.9"))), Ok(ip("127.0.0.1")));
        assert!(resolve_bind("nope", None).is_err());
    }

    #[test]
    fn tailscale_detection_needs_iface_name_or_cli() {
        let n = |name: &str, a: &str| (name.to_string(), ip(a));
        assert!(is_tailscale_iface("utun4") && is_tailscale_iface("tailscale0") && is_tailscale_iface("Tailscale"));
        assert!(!is_tailscale_iface("en0") && !is_tailscale_iface("wwan0"));
        // 다른 인터페이스의 CGNAT(통신사망 등)는 Tailscale 이 아니다
        assert_eq!(choose_tailscale(None, &[n("wwan0", "100.70.1.1"), n("en0", "192.168.0.5")]), None);
        assert_eq!(choose_tailscale(None, &[n("en0", "192.168.0.5"), n("utun3", "100.101.1.2")]), Some(ip("100.101.1.2")));
        assert_eq!(choose_tailscale(None, &[n("utun3", "100.128.0.1")]), None, "100.64/10 밖");
        // CLI 결과는 실제 로컬 주소일 때만 — 인터페이스 이름이 달라도 채택
        let ifs = [n("wg0", "100.90.0.3"), n("utun3", "100.101.1.2")];
        assert_eq!(choose_tailscale(Some(ip("100.90.0.3")), &ifs), Some(ip("100.90.0.3")));
        assert_eq!(choose_tailscale(Some(ip("100.99.9.9")), &ifs), Some(ip("100.101.1.2")), "로컬에 없는 CLI 값은 무시");
    }

    #[test]
    fn restart_decision() {
        let (a, b) = (Some(ip("100.64.0.1")), Some(ip("100.64.0.2")));
        assert!(!needs_restart(false, true, None, a, 0), "꺼져 있으면 아무것도 안 함");
        assert!(needs_restart(true, false, None, None, 0), "고정 바인드 실패는 재시도");
        assert!(!needs_restart(true, false, a, b, 0), "고정 바인드는 IP 변화와 무관");
        assert!(needs_restart(true, true, None, a, 0), "Tailscale 이 늦게 붙으면 시작");
        assert!(!needs_restart(true, true, None, None, 0), "Tailscale 없으면 헛시도 안 함");
        assert!(!needs_restart(true, true, a, a, 0));
        assert!(needs_restart(true, true, a, b, 0), "IP 변경은 즉시 재바인드");
        assert!(!needs_restart(true, true, a, None, 1), "한 번 사라진 건 일시 끊김일 수 있다");
        assert!(needs_restart(true, true, a, None, 2), "2회 연속 사라지면 내려서 오류 표시");
    }

    #[test]
    fn retry_backoff_doubles_to_two_minutes() {
        let mut d = next_backoff(None);
        assert_eq!(d, Duration::from_secs(15));
        let mut seen = vec![d];
        for _ in 0..5 {
            d = next_backoff(Some(d));
            seen.push(d);
        }
        assert_eq!(seen.iter().map(|d| d.as_secs()).collect::<Vec<_>>(), [15, 30, 60, 120, 120, 120]);
    }

    #[test]
    fn quick_connect_restart_and_changed_from() {
        let t = ip("100.64.0.1");
        assert!(!quick_restart(Some(t), t), "같은 IP 로 떠 있으면 유지");
        assert!(quick_restart(Some(ip("100.64.0.2")), t));
        assert!(quick_restart(Some(ip("0.0.0.0")), t), "다른 고정 바인드로 떠 있으면 재시작");
        assert!(quick_restart(None, t));
        assert_eq!(quick_changed_from(true, "0.0.0.0").as_deref(), Some("0.0.0.0"));
        assert_eq!(quick_changed_from(false, "127.0.0.1"), None, "꺼져 있던 기본값은 알리지 않음");
        assert_eq!(quick_changed_from(true, "auto"), None);
    }

    #[test]
    fn conn_counts_track_unique_devices() {
        let mut m = std::collections::HashMap::new();
        assert!(count_conn(&mut m, "a", true));
        assert!(!count_conn(&mut m, "a", true), "같은 기기 두 번째 연결은 변화 없음");
        assert!(count_conn(&mut m, "b", true));
        assert_eq!(m.len(), 2);
        assert!(!count_conn(&mut m, "a", false));
        assert!(count_conn(&mut m, "a", false));
        assert!(!count_conn(&mut m, "a", false), "없는 기기 종료는 무시");
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn quick_connect_no_tailscale_shape() {
        let v = serde_json::to_value(QuickConnect::fail("no-tailscale", None)).unwrap();
        assert!(v.get("changedFrom").is_none());
        assert_eq!(v, json!({ "ok": false, "reason": "no-tailscale" }));
    }

    #[test]
    fn push_warning_only_for_plain_http() {
        assert!(push_warning("http://ntfy.local").is_some());
        assert!(push_warning(" HTTP://x ").is_some());
        assert!(push_warning("https://ntfy.sh").is_none());
    }

    #[test]
    fn random_topic_is_16_bytes_and_valid() {
        let t = random_topic();
        assert_eq!(t.len(), 3 + 32);
        assert!(notify::valid_topic(&t));
        assert_ne!(t, random_topic());
    }
}
