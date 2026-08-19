// PTY 세션 수명주기 + 상태 머신 (portable-pty).
// 상태 감지는 출력 활동 휴리스틱: 출력 수신 → busy, 800ms 무출력 → idle.
// 3초 이상 busy 였다가 멈추면 'done'(작업 완료)으로 승격해 프론트에 통지한다.
// 폴링은 앱 전체에 500ms 스레드 1개뿐 — 세션 수와 무관하게 가볍다.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const BUSY_HOLD_MS: u128 = 800; // 마지막 출력 후 이 시간 동안은 busy 유지
const DONE_MIN_MS: u128 = 3000; // 이보다 오래 busy 였다가 멈추면 '완료'로 간주

#[derive(Clone)]
pub struct SessionMeta {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub status: String, // idle | running | done | exited
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
    pub status: String,
    pub cwd: String,
}

impl SessionMeta {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            status: self.status.clone(),
            cwd: self.cwd.clone(),
        }
    }
}

/// 입출력 핸들 (메타와 분리해 락 경합 최소화)
struct SessionIo {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct PtyManager {
    metas: Arc<Mutex<HashMap<String, SessionMeta>>>,
    ios: Mutex<HashMap<String, SessionIo>>,
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

fn emit_status(app: &AppHandle, id: &str, status: &str, busy_ms: u128) {
    let _ = app.emit(
        "ta:status",
        serde_json::json!({ "sessionId": id, "status": status, "busyMs": busy_ms }),
    );
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            metas: Arc::new(Mutex::new(HashMap::new())),
            ios: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
        }
    }

    /// 상태 머신 폴링 스레드 (앱 시작 시 1회 기동)
    pub fn start_status_thread(&self, app: AppHandle) {
        let metas = Arc::clone(&self.metas);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut changed: Vec<(String, String, u128)> = Vec::new();
            {
                let mut map = metas.lock().unwrap();
                let now = Instant::now();
                for m in map.values_mut() {
                    if m.exited {
                        continue;
                    }
                    let busy = now.duration_since(m.last_output).as_millis() < BUSY_HOLD_MS;
                    if busy && m.status != "running" {
                        m.status = "running".into();
                        changed.push((m.id.clone(), m.status.clone(), 0));
                    } else if !busy && m.status == "running" {
                        // 충분히 오래 돌던 작업이 멈춤 → 완료. 짧은 출력(에코 등)은 그냥 idle
                        let busy_ms = now.duration_since(m.busy_since).as_millis();
                        m.status = if busy_ms >= DONE_MIN_MS { "done".into() } else { "idle".into() };
                        changed.push((m.id.clone(), m.status.clone(), busy_ms));
                    }
                }
            }
            for (id, status, busy_ms) in changed {
                emit_status(&app, &id, &status, busy_ms);
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
            status: "idle".into(),
            last_output: now - Duration::from_secs(10), // 시작 직후 프롬프트 에코를 busy 로 오인하지 않게
            busy_since: now,
            exited: false,
        };
        let info = meta.info();

        self.metas.lock().unwrap().insert(id.clone(), meta);
        self.ios.lock().unwrap().insert(
            id.clone(),
            SessionIo { writer, master: pair.master, child },
        );

        // 리더 스레드: PTY 출력 → 프론트로 즉시 전달 + 활동 시각 갱신
        let metas = Arc::clone(&self.metas);
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new(); // UTF-8 문자가 청크 경계에서 잘릴 때의 이월 버퍼
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF = 셸 종료
                    Ok(n) => {
                        {
                            let mut map = metas.lock().unwrap();
                            if let Some(m) = map.get_mut(&sid) {
                                let now = Instant::now();
                                if now.duration_since(m.last_output).as_millis() > BUSY_HOLD_MS {
                                    m.busy_since = now; // idle → busy 진입 시각
                                }
                                m.last_output = now;
                            }
                        }
                        carry.extend_from_slice(&buf[..n]);
                        let (text, rest) = match std::str::from_utf8(&carry) {
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
                                    (String::from_utf8_lossy(&carry).into_owned(), Vec::new())
                                }
                            }
                        };
                        carry = rest;
                        if !text.is_empty() {
                            let _ = app.emit(
                                "ta:data",
                                serde_json::json!({ "sessionId": sid, "data": text }),
                            );
                        }
                    }
                }
            }
            // 종료 처리
            {
                let mut map = metas.lock().unwrap();
                if let Some(m) = map.get_mut(&sid) {
                    m.exited = true;
                    m.status = "exited".into();
                }
            }
            emit_status(&app, &sid, "exited", 0);
            let _ = app.emit("ta:exit", serde_json::json!({ "sessionId": sid }));
        });

        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) {
        if let Some(io) = self.ios.lock().unwrap().get_mut(id) {
            let _ = io.writer.write_all(data.as_bytes());
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        if let Some(io) = self.ios.lock().unwrap().get(id) {
            let _ = io.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(mut io) = self.ios.lock().unwrap().remove(id) {
            let _ = io.child.kill();
        }
        self.metas.lock().unwrap().remove(id);
    }

    /// 사용자가 해당 세션을 확인함 → '완료' 배지 해제
    pub fn ack(&self, app: &AppHandle, id: &str) {
        let mut map = self.metas.lock().unwrap();
        if let Some(m) = map.get_mut(id) {
            if m.status == "done" {
                m.status = "idle".into();
                emit_status(app, id, "idle", 0);
            }
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.metas.lock().unwrap().values().map(|m| m.info()).collect()
    }
}
