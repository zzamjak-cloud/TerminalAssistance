// PTY 세션 수명주기 + 상태 머신 (portable-pty).
// 상태 감지는 출력 활동 휴리스틱: 출력 수신 → busy, 800ms 무출력 → idle.
// 3초 이상 busy 였다가 멈추면 'done'(작업 완료)으로 승격해 프론트에 통지한다.
// 폴링은 앱 전체에 500ms 스레드 1개뿐 — 세션 수와 무관하게 가볍다.
//
// 출력 경로 (웹뷰 과부하/OOM 방지 3단 방어):
//   리더 스레드(PTY read → pending 버퍼) → 이미터 스레드(16ms 코얼레싱 → emit)
//   1) 코얼레싱: emit 을 최대 초당 ~60회로 묶어 IPC 폭주를 차단
//   2) flow control: 프론트가 ack 하지 않은 바이트가 FLOW_HIGH 를 넘으면 emit 일시정지
//   3) 백프레셔: pending 이 PENDING_CAP 을 넘으면 PTY read 자체를 멈춰
//      OS 파이프 버퍼가 차게 만들고, 결국 자식 프로세스의 write 가 블록된다
// 또한 emit 한 텍스트를 세션별 링버퍼(scrollback)에 보관해,
// 웹뷰가 크래시/리로드돼도 get_scrollback 으로 화면을 복원할 수 있다.
use crate::util::plock;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const BUSY_HOLD_MS: u128 = 800; // 마지막 출력 후 이 시간 동안은 busy 유지
const DONE_MIN_MS: u128 = 3000; // 이보다 오래 busy 였다가 멈추면 '완료'로 간주

const COALESCE_MS: u64 = 16; // 출력 묶음 전송 주기 (~60fps)
const SCROLLBACK_CAP: usize = 2 * 1024 * 1024; // 세션당 백엔드 보관 스크롤백 (복구용)
const SCROLLBACK_SLACK: usize = SCROLLBACK_CAP / 4; // 트리밍 슬랙 — emit 마다 memmove 하지 않도록 일괄 처리
const FLOW_HIGH: u64 = 512 * 1024; // 미확인(un-acked) 바이트 상한 — 넘으면 emit 일시정지
const FLOW_STALL_MS: u64 = 3000; // ack 유실(웹뷰 리로드 등) 시 이 시간 후 강제 재개
const PENDING_CAP: usize = 8 * 1024 * 1024; // pending 상한 — 넘으면 PTY read 중단(OS 백프레셔)
const EMIT_CHUNK: usize = 512 * 1024; // 이벤트 1건당 최대 크기 — 스톨 해제 직후 대형 IPC 폭탄 방지

/// 세션 상태. serde 직렬화 결과는 소문자 문자열 — 프론트의 기존 비교 문자열과 동일
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Running,
    Done,
    Exited,
}

#[derive(Clone)]
pub struct SessionMeta {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub status: Status,
    pub last_output: Instant,
    pub busy_since: Instant,
    pub exited: bool,
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub title: String,
    pub status: Status,
    pub cwd: String,
}

impl SessionMeta {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            status: self.status,
            cwd: self.cwd.clone(),
        }
    }
}

/// 입출력 핸들 (메타와 분리해 락 경합 최소화).
/// 세션별 락으로 감싸므로 한 세션의 블로킹 write 가 다른 세션의 I/O 를 막지 않는다.
/// child 는 별도 맵에 보관 — write 가 블록된 세션도 close 시 kill 로 즉시 해제 가능.
struct SessionIo {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

/// 리더 ↔ 이미터 ↔ 프론트(ack) 사이의 세션별 출력 채널 상태
struct ChanInner {
    pending: Vec<u8>,    // 리더가 쌓고 이미터가 가져가는 미전송 출력
    scrollback: Vec<u8>, // 웹뷰 복구용 최근 출력 (emit 된 텍스트 기준, CAP 로 잘림)
    total: u64,          // 지금까지 emit 한 누적 바이트 — 복구 시 중복 제거 기준점(off)
    outstanding: u64,    // emit 했지만 프론트가 아직 ack 하지 않은 바이트
    closed: bool,        // 셸 종료 또는 사용자 닫기
}

struct SessionChan {
    inner: Mutex<ChanInner>,
    cv: Condvar, // pending 도착 / pending 비움 / ack / 종료 모두 이 cv 로 통지
}

impl SessionChan {
    fn new() -> Self {
        SessionChan {
            inner: Mutex::new(ChanInner {
                pending: Vec::new(),
                scrollback: Vec::new(),
                total: 0,
                outstanding: 0,
                closed: false,
            }),
            cv: Condvar::new(),
        }
    }
}

pub struct PtyManager {
    metas: Arc<Mutex<HashMap<String, SessionMeta>>>,
    ios: Mutex<HashMap<String, Arc<Mutex<SessionIo>>>>,
    children: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
    chans: Mutex<HashMap<String, Arc<SessionChan>>>,
    seq: AtomicU64,
}

fn default_shell(override_shell: &str) -> String {
    if !override_shell.is_empty() {
        return override_shell.to_string();
    }
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
        })
    }
}

fn emit_status(app: &AppHandle, id: &str, status: Status, busy_ms: u128) {
    let _ = app.emit(
        "ta:status",
        serde_json::json!({ "sessionId": id, "status": status, "busyMs": busy_ms }),
    );
}

/// carry(이월 버퍼)에서 완성된 UTF-8 프리픽스를 잘라낸다.
/// 반환: (전송할 텍스트, 다음으로 이월할 미완성 바이트)
fn carve_utf8(carry: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(carry) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            if carry.len() - valid < 4 {
                (
                    String::from_utf8_lossy(&carry[..valid]).into_owned(),
                    carry[valid..].to_vec(),
                )
            } else {
                // 4바이트 넘게 invalid 면 진짜 비 UTF-8 → lossy 로 전부 방출
                (String::from_utf8_lossy(carry).into_owned(), Vec::new())
            }
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            metas: Arc::new(Mutex::new(HashMap::new())),
            ios: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            chans: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
        }
    }

    /// 상태 머신 폴링 스레드 (앱 시작 시 1회 기동)
    pub fn start_status_thread(&self, app: AppHandle) {
        let metas = Arc::clone(&self.metas);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut changed: Vec<(String, Status, u128)> = Vec::new();
            {
                let mut map = plock(&metas);
                let now = Instant::now();
                for m in map.values_mut() {
                    if m.exited {
                        continue;
                    }
                    let busy = now.duration_since(m.last_output).as_millis() < BUSY_HOLD_MS;
                    if busy && m.status != Status::Running {
                        m.status = Status::Running;
                        changed.push((m.id.clone(), m.status, 0));
                    } else if !busy && m.status == Status::Running {
                        // 충분히 오래 돌던 작업이 멈춤 → 완료. 짧은 출력(에코 등)은 그냥 idle
                        let busy_ms = now.duration_since(m.busy_since).as_millis();
                        m.status = if busy_ms >= DONE_MIN_MS { Status::Done } else { Status::Idle };
                        changed.push((m.id.clone(), m.status, busy_ms));
                    }
                }
            }
            for (id, status, busy_ms) in changed {
                emit_status(&app, &id, status, busy_ms);
            }
        });
    }

    pub fn create(
        &self,
        app: AppHandle,
        project_id: Option<String>,
        cwd: Option<String>,
        shell_override: &str,
        title: Option<String>,
    ) -> Result<SessionInfo, String> {
        let id = format!("s{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let shell = default_shell(shell_override);
        let cwd = cwd.unwrap_or_else(|| {
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".into())
        });

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&shell);
        // 로그인 셸: 사용자 PATH·프롬프트 환경을 그대로 상속 (GUI 앱은 셸 env 를 못 받음)
        if !cfg!(windows) {
            cmd.arg("-l");
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // GUI 앱은 LANG 을 상속받지 못해 셸이 C 로케일로 동작 → 한글 등 멀티바이트 입력이 깨짐
        if std::env::var("LANG").is_err() {
            cmd.env("LANG", "ko_KR.UTF-8");
            cmd.env("LC_ALL", "ko_KR.UTF-8");
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let title = title.unwrap_or_else(|| {
            shell.rsplit(['/', '\\']).next().unwrap_or(&shell).to_string()
        });
        let now = Instant::now();
        let meta = SessionMeta {
            id: id.clone(),
            project_id,
            title,
            cwd,
            status: Status::Idle,
            last_output: now - Duration::from_secs(10), // 시작 직후 프롬프트 에코를 busy 로 오인하지 않게
            busy_since: now,
            exited: false,
        };
        let info = meta.info();

        let chan = Arc::new(SessionChan::new());
        plock(&self.metas).insert(id.clone(), meta);
        plock(&self.ios).insert(
            id.clone(),
            Arc::new(Mutex::new(SessionIo { writer, master: pair.master })),
        );
        plock(&self.children).insert(id.clone(), child);
        plock(&self.chans).insert(id.clone(), Arc::clone(&chan));

        // ── 리더 스레드: PTY 출력 → pending 버퍼 + 활동 시각 갱신 ──
        let metas = Arc::clone(&self.metas);
        let chan_r = Arc::clone(&chan);
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF = 셸 종료
                    Ok(n) => {
                        {
                            let mut map = plock(&metas);
                            if let Some(m) = map.get_mut(&sid) {
                                let now = Instant::now();
                                if now.duration_since(m.last_output).as_millis() > BUSY_HOLD_MS {
                                    m.busy_since = now; // idle → busy 진입 시각
                                }
                                m.last_output = now;
                            }
                        }
                        let mut g = plock(&chan_r.inner);
                        // pending 이 가득이면 이미터가 비울 때까지 대기 → OS 파이프 백프레셔
                        while g.pending.len() >= PENDING_CAP && !g.closed {
                            g = chan_r.cv.wait(g).unwrap_or_else(|e| e.into_inner());
                        }
                        if g.closed {
                            break;
                        }
                        g.pending.extend_from_slice(&buf[..n]);
                        chan_r.cv.notify_all();
                    }
                }
            }
            // 셸 종료 표시 — 남은 출력 flush 와 exit 이벤트는 이미터가 처리
            {
                let mut map = plock(&metas);
                if let Some(m) = map.get_mut(&sid) {
                    m.exited = true;
                    m.status = Status::Exited;
                }
            }
            let mut g = plock(&chan_r.inner);
            g.closed = true;
            chan_r.cv.notify_all();
        });

        // ── 이미터 스레드: 코얼레싱 + flow control + 스크롤백 적재 → emit ──
        let chan_e = Arc::clone(&chan);
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut carry: Vec<u8> = Vec::new(); // UTF-8 문자가 청크 경계에서 잘릴 때의 이월 버퍼
            loop {
                // 1) 데이터 도착 또는 종료 대기
                {
                    let mut g = plock(&chan_e.inner);
                    while g.pending.is_empty() && !g.closed {
                        g = chan_e.cv.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                    if g.pending.is_empty() && g.closed {
                        break;
                    }
                }
                // 2) 코얼레싱 창 — 이 사이 도착분까지 묶어 한 번에 보낸다
                std::thread::sleep(Duration::from_millis(COALESCE_MS));
                // 3) flow control 확인 후 pending 인출
                let (raw, closed_now) = {
                    let mut g = plock(&chan_e.inner);
                    let deadline = Instant::now() + Duration::from_millis(FLOW_STALL_MS);
                    while g.outstanding >= FLOW_HIGH && !g.closed {
                        let now = Instant::now();
                        if now >= deadline {
                            g.outstanding = 0; // ack 유실(웹뷰 리로드/크래시) → 리셋 후 진행
                            break;
                        }
                        let (g2, _) = chan_e
                            .cv
                            .wait_timeout(g, deadline - now)
                            .unwrap_or_else(|e| e.into_inner());
                        g = g2;
                    }
                    (std::mem::take(&mut g.pending), g.closed)
                };
                chan_e.cv.notify_all(); // pending 비움 → 리더(백프레셔 대기) 재개
                if !raw.is_empty() {
                    carry.extend_from_slice(&raw);
                    let (text, rest) = carve_utf8(&carry);
                    carry = rest;
                    // EMIT_CHUNK 단위로 나눠 전송 (UTF-8 문자 경계 유지)
                    let mut remaining: &str = &text;
                    while !remaining.is_empty() {
                        let take = if remaining.len() <= EMIT_CHUNK {
                            remaining.len()
                        } else {
                            let mut i = EMIT_CHUNK;
                            while !remaining.is_char_boundary(i) {
                                i -= 1;
                            }
                            i
                        };
                        let (piece, rest) = remaining.split_at(take);
                        remaining = rest;
                        // 스크롤백 적재 + off 발급 (emit 순서 보장을 위해 같은 락 안에서)
                        let off = {
                            let mut g = plock(&chan_e.inner);
                            let off = g.total;
                            g.total += take as u64;
                            g.outstanding += take as u64;
                            g.scrollback.extend_from_slice(piece.as_bytes());
                            // 슬랙을 두고 일괄 트리밍 — 포화 상태에서 emit 마다 2MB memmove 가
                            // (락을 쥔 채) 일어나는 것을 방지. 복사 횟수가 1/SLACK 로 줄어든다.
                            if g.scrollback.len() > SCROLLBACK_CAP + SCROLLBACK_SLACK {
                                let excess = g.scrollback.len() - SCROLLBACK_CAP;
                                g.scrollback.drain(..excess);
                            }
                            off
                        };
                        let _ = app.emit(
                            "ta:data",
                            serde_json::json!({
                                "sessionId": sid, "data": piece,
                                "off": off, "bytes": take
                            }),
                        );
                    }
                }
                if closed_now && plock(&chan_e.inner).pending.is_empty() {
                    break;
                }
            }
            // 종료 통지 — 남은 출력을 모두 flush 한 뒤에 보낸다
            emit_status(&app, &sid, Status::Exited, 0);
            let _ = app.emit("ta:exit", serde_json::json!({ "sessionId": sid }));
        });

        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) {
        // 맵 락은 조회 즉시 놓고 세션별 락으로 쓰기 — 한 세션의 블로킹 write 가
        // 다른 세션의 write/resize/close 를 막지 않는다
        let io = plock(&self.ios).get(id).cloned();
        if let Some(io) = io {
            let _ = plock(&io).writer.write_all(data.as_bytes());
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let io = plock(&self.ios).get(id).cloned();
        if let Some(io) = io {
            let _ = plock(&io).master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(chan) = plock(&self.chans).remove(id) {
            let mut g = plock(&chan.inner);
            g.closed = true;
            chan.cv.notify_all();
        }
        // kill 은 세션 io 락과 무관하게 수행 — write 가 블록된 세션도 즉시 해제된다
        if let Some(mut child) = plock(&self.children).remove(id) {
            let _ = child.kill();
        }
        plock(&self.ios).remove(id);
        plock(&self.metas).remove(id);
    }

    /// 웹뷰 복구용 스크롤백 스냅샷.
    /// off = 누적 emit 바이트 — 프론트는 off 이전의 큐잉된 이벤트를 중복으로 버린다.
    /// 새 웹뷰는 아직 아무것도 소비하지 않았으므로 outstanding 을 리셋한다.
    pub fn scrollback(&self, id: &str) -> serde_json::Value {
        let chan = plock(&self.chans).get(id).cloned();
        if let Some(chan) = chan {
            let mut g = plock(&chan.inner);
            g.outstanding = 0;
            chan.cv.notify_all();
            let text = String::from_utf8_lossy(&g.scrollback).into_owned();
            serde_json::json!({ "data": text, "off": g.total })
        } else {
            serde_json::json!({ "data": "", "off": 0 })
        }
    }

    /// 프론트가 xterm 에 기록 완료한 바이트 수를 확인(ack) → flow control 재개
    pub fn ack_data(&self, id: &str, bytes: u64) {
        let chan = plock(&self.chans).get(id).cloned();
        if let Some(chan) = chan {
            let mut g = plock(&chan.inner);
            g.outstanding = g.outstanding.saturating_sub(bytes);
            chan.cv.notify_all();
        }
    }

    /// 사용자가 해당 세션을 확인함 → '완료' 배지 해제
    pub fn ack(&self, app: &AppHandle, id: &str) {
        let mut map = plock(&self.metas);
        if let Some(m) = map.get_mut(id) {
            if m.status == Status::Done {
                m.status = Status::Idle;
                emit_status(app, id, Status::Idle, 0);
            }
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        plock(&self.metas).values().map(|m| m.info()).collect()
    }
}
