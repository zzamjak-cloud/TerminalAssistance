// 원격 HTTP/WebSocket 서버 (axum). 앱 상태 접근은 Backend 트레잇으로 추상화해
// Tauri 없이도 라우트·인증·WS 프로토콜을 테스트할 수 있게 한다
use super::auth::{self, PairCheck, Pairing};
use crate::pty::{PtyEvent, RemoteChunk, RemoteSub, SessionInfo};
use crate::store::RemoteDevice;
use crate::util::plock;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::middleware::{self, Next};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, watch};

pub const COOKIE_NAME: &str = "ta_rt";
pub const TAIL_BYTES: usize = 256 * 1024; // 폰에 보내는 스크롤백 tail
pub const WRITE_MAX: usize = 64 * 1024;
const WS_MAX_MESSAGE: usize = 512 * 1024; // write 64KB 가 JSON 이스케이프로 부풀어도 수용
const PING_EVERY: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(75); // 이만큼 응답 없는 연결은 죽은 것으로 본다
const SEND_TIMEOUT: Duration = Duration::from_secs(10); // 수신을 멈춘 클라이언트가 루프를 붙잡지 않게
const CLOSE_REVOKED: u16 = 4001;
const WRITE_QUEUE: usize = 256;
pub const MAX_SESSIONS: usize = 64; // 원격 생성 허용 상한 (전체 세션 수 기준)
const IFACE_CACHE: Duration = Duration::from_secs(5);
pub const UPLOAD_CONCURRENCY: usize = 2;

pub trait Backend: Send + Sync + 'static {
    fn devices(&self) -> Vec<RemoteDevice>;
    fn add_device(&self, dev: RemoteDevice) -> Result<(), String>;
    fn touch_device(&self, id: &str);
    fn remove_device(&self, id: &str);
    /// `{projects, presets, sessions}` — get_state 와 같은 직렬화 형태
    fn state(&self) -> serde_json::Value;
    fn sessions(&self) -> Vec<SessionInfo>;
    fn subscribe(&self, id: &str, tail_bytes: usize) -> Option<RemoteSub>;
    /// 블로킹될 수 있다 (자식이 입력을 안 읽으면 PTY write 가 멈춤) — 전용 스레드에서만 호출
    fn write(&self, id: &str, data: &str);
    fn ack(&self, id: &str);
    /// 블로킹 (PTY spawn + 설정 저장). MAX_SESSIONS 초과 시 Err
    fn create(&self, project_id: Option<String>) -> Result<SessionInfo, String>;
    fn take_control(
        &self,
        id: &str,
        device_id: &str,
        device_name: &str,
        conn_id: u64,
        cols: u16,
        rows: u16,
    ) -> Result<(), String>;
    /// 같은 기기가 쥔 경우 반환 (어느 연결이 쥐었든)
    fn release_control(&self, id: &str, device_id: &str);
    fn release_conn(&self, conn_id: u64);
    /// 첨부 이미지 저장 디렉터리 (데스크톱 클립보드 이미지와 같은 곳)
    fn image_dir(&self) -> Result<std::path::PathBuf, String>;
    /// 업로드 저장 완료 — 데스크톱 첨부 스트립에 알린다
    fn image_saved(&self, session: &str, path: &str);
    fn events(&self) -> broadcast::Receiver<PtyEvent>;
    /// WS 연결 열림/닫힘 — 데스크톱의 '연결된 폰' 표시용
    fn conn_changed(&self, _device_id: &str, _open: bool) {}
}

/// 연결 종료 통지를 Drop 에 묶는다 — 태스크가 중단(abort)돼도 연결 수가 남지 않게
struct ConnGuard {
    ctx: Arc<Ctx>,
    device_id: String,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.ctx.backend.conn_changed(&self.device_id, false);
    }
}

pub struct Ctx {
    pub backend: Arc<dyn Backend>,
    pub pairing: Arc<Mutex<Pairing>>,
    pub bind: IpAddr,
    pub port: u16,
    /// (마지막 갱신 시각, 허용 Host 목록)
    pub allowed_hosts: Mutex<(Instant, Vec<String>)>,
    pub revoked: broadcast::Sender<String>,
    pub shutdown: watch::Receiver<bool>,
    /// WS 연결 일련번호 — 제어권 보유를 연결 단위로 추적
    pub next_conn: std::sync::atomic::AtomicU64,
    /// 동시 업로드 디코드 수 제한 — 큰 이미지 여러 장이 메모리·CPU 를 동시에 점유하지 못하게
    pub upload_slots: tokio::sync::Semaphore,
    /// HTTPS 모드(tailscale serve 경유)의 공개 Host (`<name>.ts.net:7443`). HTTP 모드면 None
    pub https_host: Option<String>,
}

impl Ctx {
    /// 이 요청이 serve 경유 HTTPS Host 로 왔는가 — Origin 스킴·CSP wss·쿠키 Secure 판단
    fn is_https(&self, host: &str) -> bool {
        self.https_host.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(host))
    }

    fn host_ok(&self, host: &str) -> bool {
        if self.is_https(host) {
            return true;
        }
        let mut g = plock(&self.allowed_hosts);
        if auth::host_allowed(host, &g.1) {
            return true;
        }
        // 0.0.0.0 바인드는 서버 기동 후 생긴 인터페이스(Tailscale 연결 등)도 받아야 한다 → 목록 갱신 후 재확인.
        // 인터페이스 열거는 비싸므로 5초 캐시 — 잘못된 Host 남발로 매 요청 재열거하지 않게
        if self.bind.is_unspecified() && g.0.elapsed() >= IFACE_CACHE {
            *g = (Instant::now(), auth::allowed_hosts(&self.bind, self.port, &super::iface_ips()));
            return auth::host_allowed(host, &g.1);
        }
        false
    }
}

pub fn router(ctx: Arc<Ctx>) -> Router {
    Router::new()
        .route("/api/pair", post(pair))
        .route("/api/me", get(me))
        .route("/api/state", get(api_state))
        .route("/ws", get(ws))
        // 업로드만 큰 본문 허용 — 인증 뒤 핸들러 안에서 직접 읽는다
        .route("/api/upload", post(upload).layer(DefaultBodyLimit::max(super::upload::UPLOAD_MAX)))
        .fallback(static_file)
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(Arc::clone(&ctx), security_headers))
        .with_state(ctx)
}

/// 모든 응답에 CSP·프레임 차단·nosniff. connect-src 에 ws://<Host> 를 명시하는 이유:
/// 일부 Safari 는 'self' 를 ws: 스킴에 대응시키지 않는다. 허용된 Host 만 넣어 헤더 주입을 막는다
async fn security_headers(State(ctx): State<Arc<Ctx>>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|h| ctx.host_ok(h))
        .map(str::to_string);
    let mut res = next.run(req).await;
    let connect = match host {
        Some(h) if ctx.is_https(&h) => format!("'self' wss://{}", h),
        Some(h) => format!("'self' ws://{}", h),
        None => "'self'".into(),
    };
    let csp = format!(
        "default-src 'self'; connect-src {}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
         frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
        connect
    );
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, axum::Json(json!({ "error": msg }))).into_response()
}

/// Host 허용 목록 + 동일 출처 검사. 토큰 검사보다 먼저 — 리바인딩·CSWSH 요청은 쿠키 유무와 무관하게 403
fn guard(ctx: &Ctx, headers: &HeaderMap) -> Result<(), Response> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !ctx.host_ok(host) {
        return Err(err(StatusCode::FORBIDDEN, "host"));
    }
    let origin = match headers.get(header::ORIGIN) {
        None => None,
        Some(v) => match v.to_str() {
            Ok(s) => Some(s),
            Err(_) => return Err(err(StatusCode::FORBIDDEN, "origin")),
        },
    };
    if !auth::origin_ok(origin, host, ctx.is_https(host)) {
        return Err(err(StatusCode::FORBIDDEN, "origin"));
    }
    Ok(())
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).find_map(|line| {
        line.split(';').find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == COOKIE_NAME && !v.is_empty()).then(|| v.to_string())
        })
    })
}

fn authed(ctx: &Ctx, headers: &HeaderMap) -> Result<RemoteDevice, Response> {
    guard(ctx, headers)?;
    let token = cookie_token(headers).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let devices = ctx.backend.devices();
    let dev = auth::find_device(&token, &devices)
        .cloned()
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    if auth::idle_expired(&dev, now_ms()) {
        // 오래 안 쓴 기기는 분실·유출 가능성이 크다 — 자동 제거하고 다시 페어링하게 한다
        ctx.backend.remove_device(&dev.id);
        let _ = ctx.revoked.send(dev.id);
        return Err(err(StatusCode::UNAUTHORIZED, "expired"));
    }
    Ok(dev)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(rename = "deviceName", default)]
    device_name: String,
}

async fn pair(
    State(ctx): State<Arc<Ctx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(r) = guard(&ctx, &headers) {
        return r;
    }
    let Ok(req) = serde_json::from_slice::<PairBody>(&body) else {
        return err(StatusCode::BAD_REQUEST, "bad request");
    };
    let xff = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
    let client = auth::client_ip(peer.ip(), ctx.https_host.is_some(), xff);
    match plock(&ctx.pairing).consume(client, &req.code, Instant::now()) {
        PairCheck::Ok => {}
        PairCheck::Invalid => return err(StatusCode::UNAUTHORIZED, "invalid code"),
        PairCheck::TooMany => return err(StatusCode::TOO_MANY_REQUESTS, "too many attempts"),
    }
    let name: String = req.device_name.trim().chars().filter(|c| !c.is_control()).take(64).collect();
    let token = auth::new_token();
    let now = now_ms();
    let dev = RemoteDevice {
        id: crate::store::new_id(),
        name: if name.is_empty() { "모바일".into() } else { name },
        token_hash: auth::hash_token(&token),
        created_ms: now,
        last_seen_ms: now,
        tailscale_ip: Some(client.to_string()),
        platform: Some(
            auth::platform_from_ua(headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or(""))
                .to_string(),
        ),
    };
    let id = dev.id.clone();
    if let Err(e) = ctx.backend.add_device(dev) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let secure = if ctx.is_https(host) { "; Secure" } else { "" };
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000{}",
        COOKIE_NAME, token, secure
    );
    let mut res = axum::Json(json!({ "deviceId": id })).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn me(State(ctx): State<Arc<Ctx>>, headers: HeaderMap) -> Response {
    match authed(&ctx, &headers) {
        Err(r) => r,
        Ok(d) => {
            ctx.backend.touch_device(&d.id);
            axum::Json(json!({ "deviceId": d.id, "deviceName": d.name })).into_response()
        }
    }
}

async fn api_state(State(ctx): State<Arc<Ctx>>, headers: HeaderMap) -> Response {
    match authed(&ctx, &headers) {
        Err(r) => r,
        Ok(d) => {
            ctx.backend.touch_device(&d.id);
            axum::Json(ctx.backend.state()).into_response()
        }
    }
}

/// `?session=<id>` — 세션 id 는 new_id 의 hex 라 퍼센트 인코딩이 필요 없다
fn session_param(uri: &Uri) -> Option<String> {
    uri.query()?.split('&').find_map(|kv| {
        let v = kv.strip_prefix("session=")?;
        (!v.is_empty() && v.len() <= 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
            .then(|| v.to_string())
    })
}

async fn upload(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Body,
) -> Response {
    // 인증을 본문 수신보다 먼저 — 무인증 요청이 15MB 를 버퍼링시키지 못하게
    if let Err(r) = authed(&ctx, &headers) {
        return r;
    }
    let Some(session) = session_param(&uri) else {
        return err(StatusCode::BAD_REQUEST, "session required");
    };
    if !ctx.backend.sessions().iter().any(|s| s.id == session) {
        return err(StatusCode::NOT_FOUND, "no such session");
    }
    // 본문 수신 전에 자리 확보 — 대기하지 않고 바로 거절해 연결이 쌓이지 않게
    let Ok(_slot) = ctx.upload_slots.try_acquire() else {
        return err(StatusCode::TOO_MANY_REQUESTS, "upload busy");
    };
    let ctype = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = match axum::body::to_bytes(body, super::upload::UPLOAD_MAX).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
    };
    let dir = match ctx.backend.image_dir() {
        Ok(d) => d,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let saved = tokio::task::spawn_blocking(move || {
        let img = super::upload::decode(&ctype, &bytes).map_err(|e| match e {
            super::upload::UploadError::Unsupported(m) => (StatusCode::UNSUPPORTED_MEDIA_TYPE, m.to_string()),
            super::upload::UploadError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "image too large".into()),
        })?;
        crate::images::save_png(&dir, &img).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
    })
    .await;
    match saved {
        Ok(Ok(path)) => {
            let path = path.to_string_lossy().into_owned();
            ctx.backend.image_saved(&session, &path);
            axum::Json(json!({ "path": path })).into_response()
        }
        Ok(Err((st, m))) => err(st, &m),
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "upload failed"),
    }
}

async fn static_file(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    match super::assets::lookup(uri.path()) {
        None => StatusCode::NOT_FOUND.into_response(),
        Some((body, ctype)) => (
            [
                (header::CONTENT_TYPE, ctype),
                // 앱 업데이트 시 옛 셸이 남지 않게 — 오프라인 캐시는 sw.js 가 담당
                (header::CACHE_CONTROL, "no-cache"),
                (header::REFERRER_POLICY, "no-referrer"),
            ],
            body,
        )
            .into_response(),
    }
}

async fn ws(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // 인증을 업그레이드 검사보다 먼저 — 무토큰 요청은 핸드셰이크 형식과 무관하게 401
    let dev = match authed(&ctx, &headers) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let upgrade = match upgrade {
        Ok(u) => u,
        Err(rej) => return rej.into_response(),
    };
    ctx.backend.touch_device(&dev.id);
    upgrade
        .max_message_size(WS_MAX_MESSAGE)
        .on_upgrade(move |socket| run_ws(socket, ctx, dev))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientMsg {
    Sub { id: String },
    Unsub,
    Write { id: String, data: String },
    Ack { id: String },
    Create {
        #[serde(rename = "projectId", default)]
        project_id: Option<String>,
        #[serde(rename = "reqId", default)]
        req_id: Option<serde_json::Value>,
    },
    Ping,
    Control { id: String, cols: u16, rows: u16 },
    Release { id: String },
}

/// 세션 이벤트 → 클라이언트 메시지
fn event_json(ev: &PtyEvent) -> serde_json::Value {
    match ev {
        PtyEvent::Status { id, status, busy_ms } => {
            json!({ "t": "status", "id": id, "status": status, "busyMs": busy_ms })
        }
        PtyEvent::Created(info) => json!({ "t": "created", "session": info }),
        PtyEvent::Exited { id } => json!({ "t": "exited", "id": id }),
        PtyEvent::Resize { id, cols, rows } => {
            json!({ "t": "resize", "id": id, "cols": cols, "rows": rows })
        }
        PtyEvent::Control { id, holder, device_name, cols, rows } => json!({
            "t": "control", "id": id, "holder": holder, "deviceName": device_name,
            "cols": cols, "rows": rows
        }),
    }
}

fn snap_json(id: &str, s: &RemoteSub) -> serde_json::Value {
    json!({
        "t": "snap", "id": id, "data": s.data, "off": s.off, "cols": s.cols, "rows": s.rows,
        "bracketedPaste": s.bracketed_paste, "controlHolder": s.control_holder
    })
}

enum Step {
    Client(Option<Result<Message, axum::Error>>),
    Chunk(Result<Arc<RemoteChunk>, broadcast::error::RecvError>),
    Event(Result<PtyEvent, broadcast::error::RecvError>),
    Revoked(Result<String, broadcast::error::RecvError>),
    Shutdown,
    Ping,
    Created(Option<serde_json::Value>, Result<SessionInfo, String>),
}

async fn recv_chunk(
    sub: &mut Option<(String, broadcast::Receiver<Arc<RemoteChunk>>)>,
) -> Result<Arc<RemoteChunk>, broadcast::error::RecvError> {
    match sub {
        Some((_, rx)) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// 송신은 시간 제한 — 수신을 멈춘(화면 꺼진) 폰 하나가 연결 루프를 무한정 붙잡지 않게
async fn send_msg(socket: &mut WebSocket, m: Message) -> bool {
    matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(m)).await, Ok(Ok(())))
}

async fn send_json(socket: &mut WebSocket, v: serde_json::Value) -> bool {
    send_msg(socket, Message::Text(v.to_string().into())).await
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = send_msg(socket, Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
}

fn device_exists(ctx: &Ctx, id: &str) -> bool {
    ctx.backend.devices().iter().any(|d| d.id == id)
}

async fn run_ws(socket: WebSocket, ctx: Arc<Ctx>, dev: RemoteDevice) {
    let conn_id = ctx.next_conn.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ctx.backend.conn_changed(&dev.id, true);
    let _guard = ConnGuard { ctx: Arc::clone(&ctx), device_id: dev.id.clone() };
    run_ws_conn(socket, Arc::clone(&ctx), dev.id, dev.name, conn_id).await;
    // 어떤 이유로 끝나든(폐기·종료·끊김) 이 연결이 쥔 제어권은 데스크톱으로 돌려준다
    ctx.backend.release_conn(conn_id);
}

async fn run_ws_conn(
    mut socket: WebSocket,
    ctx: Arc<Ctx>,
    device_id: String,
    device_name: String,
    conn_id: u64,
) {
    let mut events = ctx.backend.events();
    let mut revoked = ctx.revoked.subscribe();
    let mut shutdown = ctx.shutdown.clone();
    let mut sub: Option<(String, broadcast::Receiver<Arc<RemoteChunk>>)> = None;
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.reset(); // 첫 tick 즉시 발화 방지

    // 입력은 연결별 전용 스레드에서 순서대로 쓴다 — 블로킹 PTY write 가 런타임 워커를 막지 않게
    let (wtx, mut wrx) = mpsc::channel::<(String, String)>(WRITE_QUEUE);
    let wb = Arc::clone(&ctx.backend);
    tokio::task::spawn_blocking(move || {
        while let Some((id, data)) = wrx.blocking_recv() {
            wb.write(&id, &data);
        }
    });
    // 세션 생성 결과는 블로킹 작업에서 돌아와 이 루프로 합류한다. 연결당 진행 중 생성은 1개
    let (ctx_tx, mut ctx_rx) =
        mpsc::channel::<(Option<serde_json::Value>, Result<SessionInfo, String>)>(1);
    let mut creating = false;
    let mut last_alive = Instant::now();

    if *shutdown.borrow() {
        return;
    }
    // 업그레이드 인증 ~ revoked 구독 사이에 폐기됐을 수 있다 — 구독 후 저장소로 재확인
    if !device_exists(&ctx, &device_id) {
        close(&mut socket, CLOSE_REVOKED, "revoked").await;
        return;
    }
    if !send_json(&mut socket, json!({ "t": "sessions", "list": ctx.backend.sessions() })).await {
        return;
    }

    loop {
        let step = tokio::select! {
            m = socket.recv() => Step::Client(m),
            c = recv_chunk(&mut sub) => Step::Chunk(c),
            e = events.recv() => Step::Event(e),
            r = revoked.recv() => Step::Revoked(r),
            _ = shutdown.changed() => Step::Shutdown,
            _ = ping.tick() => Step::Ping,
            Some((r, c)) = ctx_rx.recv() => Step::Created(r, c),
        };
        if matches!(step, Step::Client(Some(Ok(_)))) {
            last_alive = Instant::now(); // pong 포함 어떤 수신이든 살아 있다는 증거
        }
        let ok = match step {
            Step::Client(None) | Step::Client(Some(Err(_))) => break,
            Step::Client(Some(Ok(Message::Close(_)))) => break,
            Step::Client(Some(Ok(Message::Text(t)))) => {
                match serde_json::from_str::<ClientMsg>(t.as_str()) {
                    Err(_) => send_json(&mut socket, json!({ "t": "error", "msg": "bad message" })).await,
                    Ok(ClientMsg::Ping) => send_json(&mut socket, json!({ "t": "pong" })).await,
                    Ok(ClientMsg::Unsub) => {
                        sub = None;
                        true
                    }
                    Ok(ClientMsg::Sub { id }) => match ctx.backend.subscribe(&id, TAIL_BYTES) {
                        None => {
                            sub = None;
                            send_json(&mut socket, json!({ "t": "error", "msg": "no such session" })).await
                        }
                        Some(s) => {
                            let v = snap_json(&id, &s);
                            sub = Some((id, s.rx));
                            send_json(&mut socket, v).await
                        }
                    },
                    Ok(ClientMsg::Write { id, data }) => {
                        if data.len() > WRITE_MAX {
                            send_json(&mut socket, json!({ "t": "error", "msg": "write too large" })).await
                        } else if wtx.try_send((id, data)).is_err() {
                            send_json(&mut socket, json!({ "t": "error", "msg": "input queue full" })).await
                        } else {
                            true
                        }
                    }
                    Ok(ClientMsg::Control { id, cols, rows }) => {
                        match ctx.backend.take_control(&id, &device_id, &device_name, conn_id, cols, rows) {
                            Ok(()) => true, // 결과는 control 이벤트로 모든 연결에 간다
                            Err(e) => send_json(&mut socket, json!({ "t": "error", "msg": e })).await,
                        }
                    }
                    Ok(ClientMsg::Release { id }) => {
                        ctx.backend.release_control(&id, &device_id);
                        true
                    }
                    Ok(ClientMsg::Ack { id }) => {
                        ctx.backend.ack(&id);
                        true
                    }
                    Ok(ClientMsg::Create { project_id, req_id }) => {
                        if creating {
                            send_json(&mut socket, json!({ "t": "error", "msg": "create in progress", "reqId": req_id }))
                                .await
                        } else if ctx.backend.sessions().len() >= MAX_SESSIONS {
                            // 빠른 거절용 사전 검사 — 최종 판정은 생성 경로의 직렬화된 검사
                            let msg = format!("세션이 너무 많습니다 (최대 {}개)", MAX_SESSIONS);
                            send_json(&mut socket, json!({ "t": "error", "msg": msg, "reqId": req_id })).await
                        } else {
                            creating = true;
                            let b = Arc::clone(&ctx.backend);
                            let tx = ctx_tx.clone();
                            tokio::task::spawn_blocking(move || {
                                let _ = tx.blocking_send((req_id, b.create(project_id)));
                            });
                            true
                        }
                    }
                }
            }
            Step::Client(Some(Ok(_))) => true, // ping/pong/binary — ping 응답은 라이브러리가 처리
            Step::Chunk(Ok(c)) => {
                let id = sub.as_ref().map(|(id, _)| id.clone()).unwrap_or_default();
                send_json(&mut socket, json!({ "t": "data", "id": id, "off": c.off, "data": c.data })).await
            }
            Step::Chunk(Err(broadcast::error::RecvError::Lagged(_))) => {
                // 느린 폰: 이 연결만 스냅샷으로 재동기화 (데스크톱·다른 구독자는 영향 없음)
                let id = sub.as_ref().map(|(id, _)| id.clone()).unwrap_or_default();
                match ctx.backend.subscribe(&id, TAIL_BYTES) {
                    Some(s) => {
                        let v = snap_json(&id, &s);
                        sub = Some((id, s.rx));
                        send_json(&mut socket, v).await
                    }
                    None => {
                        sub = None;
                        true
                    }
                }
            }
            Step::Chunk(Err(broadcast::error::RecvError::Closed)) => {
                sub = None; // 세션 종료 — exited 이벤트가 따로 간다
                true
            }
            Step::Event(Ok(ev)) => send_json(&mut socket, event_json(&ev)).await,
            Step::Event(Err(broadcast::error::RecvError::Lagged(_))) => {
                send_json(&mut socket, json!({ "t": "sessions", "list": ctx.backend.sessions() })).await
            }
            Step::Event(Err(broadcast::error::RecvError::Closed)) => break,
            Step::Revoked(Ok(id)) if id == device_id => {
                close(&mut socket, CLOSE_REVOKED, "revoked").await;
                break;
            }
            Step::Revoked(Ok(_)) => true,
            Step::Revoked(Err(_)) => {
                // 통지를 놓쳤으면 저장소 기준으로 다시 확인
                if !device_exists(&ctx, &device_id) {
                    close(&mut socket, CLOSE_REVOKED, "revoked").await;
                    break;
                }
                true
            }
            Step::Shutdown => {
                close(&mut socket, 1001, "server stopping").await;
                break;
            }
            Step::Ping => {
                if last_alive.elapsed() >= PONG_TIMEOUT {
                    break; // 응답 없는 반쯤 열린 연결 정리 (폰 네트워크 전환 등)
                }
                // 폐기 통지 유실 대비 — 주기적으로 저장소 기준 재확인
                if !device_exists(&ctx, &device_id) {
                    close(&mut socket, CLOSE_REVOKED, "revoked").await;
                    break;
                }
                ctx.backend.touch_device(&device_id); // 오래 열린 연결도 유휴 만료되지 않게
                send_msg(&mut socket, Message::Ping(Bytes::new())).await
            }
            Step::Created(req_id, Ok(info)) => {
                creating = false;
                // 목록 반영은 created 이벤트로 모든 연결에 가고, 요청 연결엔 결과를 따로 준다
                send_json(&mut socket, json!({ "t": "createResult", "reqId": req_id, "session": info })).await
            }
            Step::Created(req_id, Err(e)) => {
                creating = false;
                send_json(&mut socket, json!({ "t": "error", "msg": e, "reqId": req_id })).await
            }
        };
        if !ok {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    pub struct MockBackend {
        pub devices: Mutex<Vec<RemoteDevice>>,
        pub writes: Mutex<Vec<(String, String)>>,
        pub tap: broadcast::Sender<Arc<RemoteChunk>>,
        pub events: broadcast::Sender<PtyEvent>,
        pub n_sessions: Mutex<usize>,
        pub create_delay: Mutex<Duration>,
        pub controls: Mutex<Vec<String>>, // 호출 기록
        pub images: Mutex<Vec<(String, String)>>,
        pub dir: std::path::PathBuf,
    }

    impl MockBackend {
        fn new() -> Arc<Self> {
            Arc::new(MockBackend {
                devices: Mutex::new(Vec::new()),
                writes: Mutex::new(Vec::new()),
                tap: broadcast::channel(16).0,
                events: broadcast::channel(16).0,
                n_sessions: Mutex::new(1),
                create_delay: Mutex::new(Duration::ZERO),
                controls: Mutex::new(Vec::new()),
                images: Mutex::new(Vec::new()),
                dir: std::env::temp_dir().join(format!(
                    "ta-upload-test-{}-{}",
                    std::process::id(),
                    crate::store::new_id()
                )),
            })
        }
    }

    fn info(id: &str) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            project_id: None,
            title: "S1".into(),
            status: crate::pty::Status::Idle,
            cwd: "/tmp".into(),
            created_at_ms: 1,
            control_holder: None,
            control_device_name: None,
            cols: 80,
            rows: 24,
        }
    }

    impl Backend for MockBackend {
        fn devices(&self) -> Vec<RemoteDevice> {
            plock(&self.devices).clone()
        }
        fn add_device(&self, dev: RemoteDevice) -> Result<(), String> {
            plock(&self.devices).push(dev);
            Ok(())
        }
        fn touch_device(&self, _id: &str) {}
        fn remove_device(&self, id: &str) {
            plock(&self.devices).retain(|d| d.id != id);
        }
        fn state(&self) -> serde_json::Value {
            json!({ "projects": [], "presets": [], "sessions": [info("s1")] })
        }
        fn sessions(&self) -> Vec<SessionInfo> {
            vec![info("s1"); *plock(&self.n_sessions)]
        }
        fn subscribe(&self, id: &str, _tail: usize) -> Option<RemoteSub> {
            (id == "s1").then(|| RemoteSub {
                rx: self.tap.subscribe(),
                data: "hello".into(),
                off: 5,
                cols: 80,
                rows: 24,
                bracketed_paste: true,
                control_holder: None,
            })
        }
        fn write(&self, id: &str, data: &str) {
            plock(&self.writes).push((id.into(), data.into()));
        }
        fn ack(&self, _id: &str) {}
        fn create(&self, _project_id: Option<String>) -> Result<SessionInfo, String> {
            std::thread::sleep(*plock(&self.create_delay));
            let i = info("s2");
            let _ = self.events.send(PtyEvent::Created(i.clone()));
            Ok(i)
        }
        fn events(&self) -> broadcast::Receiver<PtyEvent> {
            self.events.subscribe()
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
            if id != "s1" {
                return Err("no such session".into());
            }
            plock(&self.controls).push(format!("take {id} {conn_id}"));
            let _ = self.events.send(PtyEvent::Control {
                id: id.into(),
                holder: Some(device_id.into()),
                device_name: Some(device_name.into()),
                cols,
                rows,
            });
            Ok(())
        }
        fn release_control(&self, id: &str, device_id: &str) {
            plock(&self.controls).push(format!("release {id} {device_id}"));
        }
        fn release_conn(&self, conn_id: u64) {
            plock(&self.controls).push(format!("conn {conn_id}"));
        }
        fn image_dir(&self) -> Result<std::path::PathBuf, String> {
            Ok(self.dir.clone())
        }
        fn image_saved(&self, session: &str, path: &str) {
            plock(&self.images).push((session.into(), path.into()));
        }
    }

    const HOST: &str = "127.0.0.1:7788";

    fn ctx_with(backend: Arc<MockBackend>, port: u16) -> (Arc<Ctx>, watch::Sender<bool>) {
        let (stx, srx) = watch::channel(false);
        let bind: IpAddr = "127.0.0.1".parse().unwrap();
        let ctx = Arc::new(Ctx {
            backend,
            pairing: Arc::new(Mutex::new(Pairing::default())),
            bind,
            port,
            allowed_hosts: Mutex::new((Instant::now(), auth::allowed_hosts(&bind, port, &[]))),
            revoked: broadcast::channel(8).0,
            shutdown: srx,
            next_conn: std::sync::atomic::AtomicU64::new(1),
            upload_slots: tokio::sync::Semaphore::new(UPLOAD_CONCURRENCY),
            https_host: None,
        });
        (ctx, stx)
    }

    fn req(method: &str, path: &str, host: &str) -> axum::http::request::Builder {
        Request::builder().method(method).uri(path).header(header::HOST, host)
    }

    async fn status_from(ctx: &Arc<Ctx>, r: Request<Body>, peer: [u8; 4]) -> (StatusCode, HeaderMap) {
        let app = router(Arc::clone(ctx))
            .layer(axum::extract::connect_info::MockConnectInfo(SocketAddr::from((peer, 50000))));
        let res = app.oneshot(r).await.unwrap();
        (res.status(), res.headers().clone())
    }

    async fn status_of(ctx: &Arc<Ctx>, r: Request<Body>) -> (StatusCode, HeaderMap) {
        status_from(ctx, r, [127, 0, 0, 1]).await
    }

    async fn paired_cookie(ctx: &Arc<Ctx>) -> String {
        let (code, _) = plock(&ctx.pairing).start(Instant::now());
        let body = json!({ "code": code, "deviceName": "폰" }).to_string();
        let (st, h) = status_of(ctx, req("POST", "/api/pair", HOST).body(Body::from(body)).unwrap()).await;
        assert_eq!(st, StatusCode::OK);
        let c = h.get(header::SET_COOKIE).unwrap().to_str().unwrap().to_string();
        assert!(c.contains("HttpOnly") && c.contains("SameSite=Strict") && c.contains("Max-Age=31536000"));
        c.split(';').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn static_routes_need_no_auth() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        for p in [
            "/", "/mobile.js", "/xterm.js", "/sw.js", "/icon.png", "/dashboard-core.js", "/boot-guard.js",
            "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
        ] {
            let (st, h) = status_of(&ctx, req("GET", p, HOST).body(Body::empty()).unwrap()).await;
            assert_eq!(st, StatusCode::OK, "{p}");
            assert!(h.get(header::CONTENT_TYPE).is_some());
        }
        let (st, _) = status_of(&ctx, req("GET", "/nope", HOST).body(Body::empty()).unwrap()).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn api_requires_token_and_same_origin() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        // 무토큰 → 401 (ws 도 업그레이드 헤더와 무관하게 401)
        for p in ["/api/state", "/api/me", "/ws"] {
            let (st, _) = status_of(&ctx, req("GET", p, HOST).body(Body::empty()).unwrap()).await;
            assert_eq!(st, StatusCode::UNAUTHORIZED, "{p}");
        }
        let cookie = paired_cookie(&ctx).await;
        let ok = req("GET", "/api/state", HOST).header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        assert_eq!(status_of(&ctx, ok).await.0, StatusCode::OK);
        let me = req("GET", "/api/me", HOST)
            .header(header::COOKIE, format!("other=1; {}", cookie))
            .header(header::ORIGIN, format!("http://{}", HOST))
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_of(&ctx, me).await.0, StatusCode::OK);

        // 다른 Origin → 403 (토큰이 맞아도)
        let bad_origin = req("GET", "/api/state", HOST)
            .header(header::COOKIE, &cookie)
            .header(header::ORIGIN, "http://evil.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_of(&ctx, bad_origin).await.0, StatusCode::FORBIDDEN);
        // 허용 목록 밖 Host → 403 (DNS 리바인딩)
        let bad_host = req("GET", "/api/state", "evil.example:7788")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_of(&ctx, bad_host).await.0, StatusCode::FORBIDDEN);
        // 잘못된 토큰 → 401
        let wrong = req("GET", "/api/state", HOST)
            .header(header::COOKIE, "ta_rt=deadbeef")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_of(&ctx, wrong).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn pair_rejects_bad_code_and_rate_limits() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        let post = |code: &str| {
            req("POST", "/api/pair", HOST)
                .body(Body::from(json!({ "code": code, "deviceName": "x" }).to_string()))
                .unwrap()
        };
        assert_eq!(status_of(&ctx, post("NOPE")).await.0, StatusCode::UNAUTHORIZED); // 발급 전
        let (code, _) = plock(&ctx.pairing).start(Instant::now());
        for _ in 0..auth::PAIR_MAX_FAILS - 1 {
            assert_eq!(status_of(&ctx, post("WRONG")).await.0, StatusCode::UNAUTHORIZED);
        }
        assert_eq!(status_of(&ctx, post("WRONG")).await.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(status_of(&ctx, post(&code)).await.0, StatusCode::TOO_MANY_REQUESTS);
        // 잠금은 그 IP 에만 — 다른 기기는 같은 코드로 페어링된다
        assert_eq!(status_from(&ctx, post(&code), [100, 64, 0, 9]).await.0, StatusCode::OK);
        let bad = req("POST", "/api/pair", HOST).body(Body::from("{")).unwrap();
        assert_eq!(status_of(&ctx, bad).await.0, StatusCode::BAD_REQUEST);
        let big = req("POST", "/api/pair", HOST).body(Body::from(vec![b' '; 64 * 1024])).unwrap();
        assert_eq!(status_of(&ctx, big).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn revoked_device_loses_access() {
        let backend = MockBackend::new();
        let (ctx, _s) = ctx_with(Arc::clone(&backend), 7788);
        let cookie = paired_cookie(&ctx).await;
        plock(&backend.devices).clear();
        let r = req("GET", "/api/state", HOST).header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        assert_eq!(status_of(&ctx, r).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn upload_validates_and_saves_like_desktop() {
        let backend = MockBackend::new();
        let (ctx, _s) = ctx_with(Arc::clone(&backend), 7788);
        let up = |cookie: Option<&str>, q: &str, ctype: &str, body: Vec<u8>| {
            let mut r = req("POST", &format!("/api/upload{q}"), HOST).header(header::CONTENT_TYPE, ctype);
            if let Some(c) = cookie {
                r = r.header(header::COOKIE, c);
            }
            r.body(Body::from(body)).unwrap()
        };
        let png = {
            let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255]));
            let mut out = std::io::Cursor::new(Vec::new());
            img.write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        };
        // 무인증 → 401 (본문 크기와 무관)
        assert_eq!(status_of(&ctx, up(None, "?session=s1", "image/png", png.clone())).await.0, StatusCode::UNAUTHORIZED);
        let cookie = paired_cookie(&ctx).await;
        let c = Some(cookie.as_str());
        assert_eq!(status_of(&ctx, up(c, "", "image/png", png.clone())).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(status_of(&ctx, up(c, "?session=../../etc", "image/png", png.clone())).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(status_of(&ctx, up(c, "?session=zz", "image/png", png.clone())).await.0, StatusCode::NOT_FOUND);
        assert_eq!(
            status_of(&ctx, up(c, "?session=s1", "image/jpeg", png.clone())).await.0,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            status_of(&ctx, up(c, "?session=s1", "image/png", b"\x89PNG\r\n\x1a\nbroken".to_vec())).await.0,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        // 15MB 초과 → 413 (다른 API 는 16KB 제한 그대로)
        let huge = vec![0u8; super::super::upload::UPLOAD_MAX + 1];
        assert_eq!(status_of(&ctx, up(c, "?session=s1", "image/png", huge)).await.0, StatusCode::PAYLOAD_TOO_LARGE);

        let res = router(Arc::clone(&ctx))
            .layer(axum::extract::connect_info::MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1))))
            .oneshot(up(c, "?session=s1", "image/png", png))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let path = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["path"].as_str().unwrap().to_string();
        let p = std::path::Path::new(&path);
        assert_eq!(p.parent().unwrap(), backend.dir);
        assert!(p.file_name().unwrap().to_str().unwrap().starts_with("img_"));
        assert_eq!(image::open(p).unwrap().width(), 4);
        assert_eq!(plock(&backend.images).as_slice(), &[("s1".to_string(), path.clone())]);
        let _ = std::fs::remove_dir_all(&backend.dir);
    }

    #[tokio::test]
    async fn upload_rejects_when_slots_busy() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        let cookie = paired_cookie(&ctx).await;
        let _a = ctx.upload_slots.try_acquire().unwrap();
        let _b = ctx.upload_slots.try_acquire().unwrap();
        let r = req("POST", "/api/upload?session=s1", HOST)
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "image/png")
            .body(Body::from(vec![0u8; 16]))
            .unwrap();
        assert_eq!(status_of(&ctx, r).await.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn idle_device_expires_and_is_removed() {
        let backend = MockBackend::new();
        let (ctx, _s) = ctx_with(Arc::clone(&backend), 7788);
        let cookie = paired_cookie(&ctx).await;
        {
            let mut d = plock(&backend.devices);
            d[0].created_ms = 0;
            d[0].last_seen_ms = now_ms() - auth::IDLE_EXPIRY_MS - 1000;
        }
        let r = req("GET", "/api/me", HOST).header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        assert_eq!(status_of(&ctx, r).await.0, StatusCode::UNAUTHORIZED);
        assert!(plock(&backend.devices).is_empty());
    }

    #[tokio::test]
    async fn https_mode_via_serve() {
        const TS: &str = "mac.tail1.ts.net:7443";
        let (stx, srx) = watch::channel(false);
        let bind: IpAddr = "127.0.0.1".parse().unwrap();
        let ctx = Arc::new(Ctx {
            backend: MockBackend::new(),
            pairing: Arc::new(Mutex::new(Pairing::default())),
            bind,
            port: 7788,
            allowed_hosts: Mutex::new((Instant::now(), auth::allowed_hosts(&bind, 7788, &[]))),
            revoked: broadcast::channel(8).0,
            shutdown: srx,
            next_conn: std::sync::atomic::AtomicU64::new(1),
            upload_slots: tokio::sync::Semaphore::new(UPLOAD_CONCURRENCY),
            https_host: Some(TS.into()),
        });
        let _keep = stx;
        // serve Host 허용 + CSP 는 wss
        let (st, h) = status_of(&ctx, req("GET", "/", TS).body(Body::empty()).unwrap()).await;
        assert_eq!(st, StatusCode::OK);
        let csp = h.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap();
        assert!(csp.contains(&format!("connect-src 'self' wss://{}", TS)), "{csp}");
        // 로컬 직접 접속은 여전히 ws
        let (_, h) = status_of(&ctx, req("GET", "/", HOST).body(Body::empty()).unwrap()).await;
        assert!(h.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().contains("ws://127.0.0.1"));
        // Origin 은 https 여야 한다
        let bad = req("GET", "/api/me", TS).header(header::ORIGIN, format!("http://{}", TS)).body(Body::empty()).unwrap();
        assert_eq!(status_of(&ctx, bad).await.0, StatusCode::FORBIDDEN);
        let ok = req("GET", "/api/me", TS).header(header::ORIGIN, format!("https://{}", TS)).body(Body::empty()).unwrap();
        assert_eq!(status_of(&ctx, ok).await.0, StatusCode::UNAUTHORIZED);
        // 페어링: 쿠키 Secure, 기기 IP 는 X-Forwarded-For, 플랫폼은 UA
        let (code, _) = plock(&ctx.pairing).start(Instant::now());
        let body = json!({ "code": code, "deviceName": "폰" }).to_string();
        let r = req("POST", "/api/pair", TS)
            .header(header::ORIGIN, format!("https://{}", TS))
            .header("x-forwarded-for", "100.72.45.122")
            .header(header::USER_AGENT, "Mozilla/5.0 (Linux; Android 14; K)")
            .body(Body::from(body))
            .unwrap();
        let (st, h) = status_from(&ctx, r, [127, 0, 0, 1]).await;
        assert_eq!(st, StatusCode::OK);
        assert!(h.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("; Secure"));
        let devs = ctx.backend.devices();
        let d = devs.last().unwrap();
        assert_eq!(d.tailscale_ip.as_deref(), Some("100.72.45.122"));
        assert_eq!(d.platform.as_deref(), Some("android"));
    }

    #[tokio::test]
    async fn http_pair_cookie_not_secure_and_records_peer() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        let c = paired_cookie(&ctx).await;
        assert!(!c.is_empty());
        let (code, _) = plock(&ctx.pairing).start(Instant::now());
        let body = json!({ "code": code, "deviceName": "폰" }).to_string();
        let r = req("POST", "/api/pair", HOST).header("x-forwarded-for", "100.1.1.1").body(Body::from(body)).unwrap();
        let (st, h) = status_from(&ctx, r, [100, 72, 45, 122]).await;
        assert_eq!(st, StatusCode::OK);
        assert!(!h.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("Secure"));
        assert_eq!(ctx.backend.devices().last().unwrap().tailscale_ip.as_deref(), Some("100.72.45.122"), "HTTP 모드는 헤더 무시");
    }

    #[tokio::test]
    async fn security_headers_on_every_response() {
        let (ctx, _s) = ctx_with(MockBackend::new(), 7788);
        for (path, want) in [("/", StatusCode::OK), ("/api/state", StatusCode::UNAUTHORIZED), ("/nope", StatusCode::NOT_FOUND)] {
            let (st, h) = status_of(&ctx, req("GET", path, HOST).body(Body::empty()).unwrap()).await;
            assert_eq!(st, want, "{path}");
            let csp = h.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap();
            assert!(csp.contains("default-src 'self'") && csp.contains("frame-ancestors 'none'"), "{csp}");
            assert!(csp.contains(&format!("connect-src 'self' ws://{}", HOST)), "{csp}");
            assert_eq!(h.get(header::X_FRAME_OPTIONS).unwrap(), "DENY");
            assert_eq!(h.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
        }
        // 허용되지 않은 Host 는 CSP 에 들어가지 않는다 (헤더 오염 방지)
        let (_, h) = status_of(&ctx, req("GET", "/", "evil.example").body(Body::empty()).unwrap()).await;
        let csp = h.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap();
        assert!(!csp.contains("evil"), "{csp}");
    }

    // ── 실제 소켓으로 띄운 서버: HTTP 상태코드 + WS 프로토콜 ──

    async fn spawn_server(backend: Arc<MockBackend>) -> (Arc<Ctx>, watch::Sender<bool>, u16) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ctx, stx) = ctx_with(backend, port);
        let mut srx = stx.subscribe();
        let app = router(Arc::clone(&ctx));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = srx.changed().await;
                })
                .await;
        });
        (ctx, stx, port)
    }

    async fn raw_http(port: u16, request: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_server_status_codes() {
        let (_ctx, _stx, port) = spawn_server(MockBackend::new()).await;
        let host = format!("127.0.0.1:{}", port);
        let r = raw_http(port, format!("GET /api/state HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 401"), "{r}");
        let r = raw_http(
            port,
            format!("GET /api/state HTTP/1.1\r\nHost: {host}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = raw_http(port, format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_websocket_protocol_and_revoke() {
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as TMsg};
        let backend = MockBackend::new();
        let (ctx, _stx, port) = spawn_server(Arc::clone(&backend)).await;
        let host = format!("127.0.0.1:{}", port);
        let (code, _) = plock(&ctx.pairing).start(Instant::now());
        let body = json!({ "code": code, "deviceName": "폰" }).to_string();
        let r = raw_http(
            port,
            format!(
                "POST /api/pair HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            ),
        )
        .await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let cookie = r
            .lines()
            .find_map(|l| l.strip_prefix("set-cookie: ").or_else(|| l.strip_prefix("Set-Cookie: ")))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        let mut rq = format!("ws://{host}/ws").into_client_request().unwrap();
        rq.headers_mut().insert("Cookie", cookie.parse().unwrap());
        rq.headers_mut().insert("Origin", format!("http://{host}").parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(rq).await.unwrap();

        async fn next_json(
            ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        ) -> serde_json::Value {
            use futures_util::StreamExt;
            loop {
                match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
                    TMsg::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
                    _ => continue,
                }
            }
        }
        use futures_util::SinkExt;
        let first = next_json(&mut ws).await;
        assert_eq!(first["t"], "sessions");
        assert_eq!(first["list"][0]["id"], "s1");
        // 제어 상태·크기 필드가 camelCase 로 실린다
        let s0 = &first["list"][0];
        assert!(s0["controlHolder"].is_null() && s0["controlDeviceName"].is_null());
        assert_eq!((s0["cols"].as_u64(), s0["rows"].as_u64()), (Some(80), Some(24)));

        ws.send(TMsg::Text(json!({ "t": "sub", "id": "s1" }).to_string().into())).await.unwrap();
        let snap = next_json(&mut ws).await;
        assert_eq!((snap["t"].as_str(), snap["off"].as_u64(), snap["cols"].as_u64()), (Some("snap"), Some(5), Some(80)));
        assert_eq!(snap["bracketedPaste"], true);
        backend.tap.send(Arc::new(RemoteChunk { off: 5, data: " world".into() })).unwrap();
        let data = next_json(&mut ws).await;
        assert_eq!((data["t"].as_str(), data["off"].as_u64(), data["data"].as_str()), (Some("data"), Some(5), Some(" world")));

        ws.send(TMsg::Text(json!({ "t": "write", "id": "s1", "data": "ls\r" }).to_string().into())).await.unwrap();
        let big = "x".repeat(WRITE_MAX + 1);
        ws.send(TMsg::Text(json!({ "t": "write", "id": "s1", "data": big }).to_string().into())).await.unwrap();
        assert_eq!(next_json(&mut ws).await["t"], "error");
        ws.send(TMsg::Text(json!({ "t": "ping" }).to_string().into())).await.unwrap();
        assert_eq!(next_json(&mut ws).await["t"], "pong");
        assert_eq!(plock(&backend.writes).as_slice(), &[("s1".to_string(), "ls\r".to_string())]);

        // create: 모든 연결엔 created, 요청 연결엔 reqId 가 붙은 createResult. 진행 중 중복 요청은 거절
        *plock(&backend.create_delay) = Duration::from_millis(300);
        ws.send(TMsg::Text(json!({ "t": "create", "projectId": null, "reqId": "r1" }).to_string().into())).await.unwrap();
        ws.send(TMsg::Text(json!({ "t": "create", "projectId": null, "reqId": 2 }).to_string().into())).await.unwrap();
        let busy = next_json(&mut ws).await;
        assert_eq!((busy["t"].as_str(), busy["reqId"].as_i64()), (Some("error"), Some(2)));
        let mut got: Vec<serde_json::Value> = vec![next_json(&mut ws).await, next_json(&mut ws).await];
        got.sort_by_key(|v| v["t"].as_str().unwrap_or("").to_string());
        assert_eq!((got[0]["t"].as_str(), got[0]["reqId"].as_str()), (Some("createResult"), Some("r1")));
        assert_eq!(got[0]["session"]["id"], "s2");
        assert_eq!((got[1]["t"].as_str(), got[1]["session"]["id"].as_str()), (Some("created"), Some("s2")));
        // 세션 상한
        *plock(&backend.n_sessions) = MAX_SESSIONS;
        ws.send(TMsg::Text(json!({ "t": "create", "reqId": "r3" }).to_string().into())).await.unwrap();
        let full = next_json(&mut ws).await;
        assert_eq!((full["t"].as_str(), full["reqId"].as_str()), (Some("error"), Some("r3")));
        *plock(&backend.n_sessions) = 1;

        backend
            .events
            .send(PtyEvent::Status { id: "s1".into(), status: crate::pty::Status::Done, busy_ms: 42 })
            .unwrap();
        let st = next_json(&mut ws).await;
        assert_eq!((st["status"].as_str(), st["busyMs"].as_u64()), (Some("done"), Some(42)));

        // 제어권: control 이벤트가 holder·deviceName 과 함께 오고, release 는 연결 id 로 전달
        ws.send(TMsg::Text(json!({ "t": "control", "id": "s1", "cols": 50, "rows": 20 }).to_string().into())).await.unwrap();
        let ctrl = next_json(&mut ws).await;
        let dev_id = plock(&backend.devices)[0].id.clone();
        assert_eq!(ctrl["t"], "control");
        assert_eq!((ctrl["holder"].as_str(), ctrl["deviceName"].as_str()), (Some(dev_id.as_str()), Some("폰")));
        assert_eq!((ctrl["cols"].as_u64(), ctrl["rows"].as_u64()), (Some(50), Some(20)));
        ws.send(TMsg::Text(json!({ "t": "control", "id": "nope", "cols": 50, "rows": 20 }).to_string().into())).await.unwrap();
        assert_eq!(next_json(&mut ws).await["t"], "error");
        ws.send(TMsg::Text(json!({ "t": "release", "id": "s1" }).to_string().into())).await.unwrap();
        ws.send(TMsg::Text(json!({ "t": "ping" }).to_string().into())).await.unwrap();
        assert_eq!(next_json(&mut ws).await["t"], "pong");
        assert_eq!(plock(&backend.controls).as_slice(), &["take s1 1".to_string(), format!("release s1 {dev_id}")]);

        // 폐기 → close 4001
        ctx.revoked.send(dev_id).unwrap();
        use futures_util::StreamExt;
        let closed = loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
                Some(Ok(TMsg::Close(f))) => break f.map(|f| u16::from(f.code)),
                Some(Ok(_)) => continue,
                _ => break None,
            }
        };
        assert_eq!(closed, Some(CLOSE_REVOKED));
        // 연결이 끝나면 그 연결의 제어권이 자동 반환된다
        let deadline = Instant::now() + Duration::from_secs(5);
        while !plock(&backend.controls).contains(&"conn 1".to_string()) {
            assert!(Instant::now() < deadline, "release_conn 미호출");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
