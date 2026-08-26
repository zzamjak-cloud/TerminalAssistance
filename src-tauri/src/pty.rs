// PTY 세션 수명주기 + 상태 머신 (portable-pty).
// 상태 감지는 훅 신호 우선 + 출력 활동 휴리스틱 보조:
//   - 훅(Claude Code)이 붙은 세션은 Stop 훅만이 '완료'의 근거다. 도구 실행·응답 대기로
//     출력이 잠깐 끊겨도 완료로 승격하지 않는다 (작업 중 오알림의 원인이었다).
//   - 훅이 없는 세션(codex·셸)은 출력 휴리스틱: 출력 수신 → busy, DONE_QUIET_MS 무출력 +
//     DONE_MIN_MS 이상 busy 였으면 'done'. TUI 가 1초 간격으로 경과 시간을 다시 그리는
//     구간을 완료로 오판하지 않도록 무출력 판정을 넉넉히 잡는다.
// 폴링은 앱 전체에 500ms 스레드 1개뿐 — 세션 수와 무관하게 가볍다.
//
// 출력 경로 (웹뷰 과부하/OOM 방지 3단 방어):
//   리더 스레드(PTY read → pending 버퍼) → 이미터 스레드(16ms 코얼레싱 → emit)
//   1) 버스트 수집 코얼레싱: 출력이 잠잠해질 때까지(2ms 공백, 최대 16ms) 모아
//      TUI 재그리기를 한 프레임으로 보내고, emit 을 최대 초당 ~60회로 묶어 IPC 폭주 차단
//   2) flow control: 프론트가 ack 하지 않은 바이트가 FLOW_HIGH 를 넘으면 emit 일시정지
//   3) 백프레셔: pending 이 PENDING_CAP 을 넘으면 PTY read 자체를 멈춰
//      OS 파이프 버퍼가 차게 만들고, 결국 자식 프로세스의 write 가 블록된다
// 또한 emit 한 텍스트를 세션별 링버퍼(scrollback)에 보관해,
// 웹뷰가 크래시/리로드돼도 get_scrollback 으로 화면을 복원할 수 있다.
// (디스크 영속화는 하지 않는다 — 세션은 앱 수명과 함께 끝나고,
// 과거 작업 재개는 Claude Code 자체 세션 저장소를 통한다. claude.rs 참고)
use crate::util::plock;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const BUSY_HOLD_MS: u128 = 800; // 마지막 출력 후 이 시간 동안은 busy 유지
const DONE_MIN_MS: u128 = 3000; // 이보다 오래 busy 였다가 멈추면 '완료'로 간주
// 훅 없는 세션의 완료 판정 무출력 시간. TUI 의 초 단위 재그리기(≈1s)보다 충분히 길어야
// 작업 중 공백을 완료로 오판하지 않는다.
const DONE_QUIET_MS: u128 = 5000;
// 훅 세션에서 Stop 신호 없이 이만큼 조용하면 판정을 포기하고 idle 로 내린다 —
// 인터럽트(Esc)·훅 유실로 Running 에 갇히는 것을 막되, 근거 없는 완료 알림은 보내지 않는다.
const HOOK_STALE_MS: u128 = 20_000;

const COALESCE_MS: u64 = 16; // 버스트 수집 최대 지연 (~60fps 하한)
const QUIET_MS: u64 = 2; // 버스트 종료 판정 공백 — 이 시간 동안 새 출력이 없으면 방출
const SCROLLBACK_CAP: usize = 2 * 1024 * 1024; // 세션당 백엔드 보관 스크롤백 (복구용)
const SCROLLBACK_SLACK: usize = SCROLLBACK_CAP / 4; // 트리밍 슬랙 — emit 마다 memmove 하지 않도록 일괄 처리
const FLOW_HIGH: u64 = 512 * 1024; // 미확인(un-acked) 바이트 상한 — 넘으면 emit 일시정지
const FLOW_STALL_MS: u64 = 3000; // ack 유실(웹뷰 리로드 등) 시 이 시간 후 강제 재개
const PENDING_CAP: usize = 8 * 1024 * 1024; // pending 상한 — 넘으면 PTY read 중단(OS 백프레셔)
const EMIT_CHUNK: usize = 512 * 1024; // 이벤트 1건당 최대 크기 — 스톨 해제 직후 대형 IPC 폭탄 방지

/// 현재 시각 (unix millis) — 세션 생성 순서 보존용
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// 세션 상태. serde 직렬화 결과는 소문자 문자열 — 프론트의 기존 비교 문자열과 동일
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Running,
    Waiting, // AI 도구가 실행 허가를 기다림 (훅/OSC 신호 기반 — 출력 휴리스틱보다 우선)
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
    pub created_at_ms: u64, // 생성 시각 — 목록 정렬·재시작 복원 순서 보존용
    pub waiting: bool,      // 허가 대기 신호 (훅 상태 파일 또는 OSC 알림)
    pub waiting_cleared_ms: u64, // 마지막 사용자 입력 시각 — 이보다 낡은 훅 waiting 은 무시
    pub hook_seen: bool,    // 이 세션의 훅 상태 파일이 살아 있는가 (= 완료를 훅으로 판정)
    pub hook_done: bool,    // 마지막 훅 이벤트가 Stop(완료) 인가
    pub hook_done_ts: u64,  // 그 Stop 신호의 시각
    pub hook_done_used_ts: u64, // 이미 완료로 소비한 Stop 신호 — 같은 신호로 두 번 알리지 않는다
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub title: String,
    pub status: Status,
    pub cwd: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: u64, // 채팅 뷰 신선도 기준 (세션 생성 이전 대화는 표시하지 않음)
}

impl SessionMeta {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            status: self.status,
            cwd: self.cwd.clone(),
            created_at_ms: self.created_at_ms,
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
    total: u64,          // off 발급용 논리 오프셋 (재시작 복원 시드 포함) — 복구 시 중복 제거 기준점
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

/// 셸 지정 해석 결과 — Windows 의 git-bash 처럼 지정 문자열과 실제 실행 파일·인자가
/// 다른 경우를 흡수한다
struct ResolvedShell {
    program: String,
    args: Vec<&'static str>,
    msys_bash: bool, // Git Bash(MSYS) 여부 — CHERE_INVOKE 등 전용 env 적용 근거
}

/// Windows 에서 Git Bash 실행 파일(bin\bash.exe)을 찾는다.
/// spec 이 경로면 그 설치본 기준(런처 git-bash.exe → 같은 설치본의 bin\bash.exe),
/// 이름뿐이면 표준 설치 위치와 PATH 의 git.exe 위치로부터 유추한다 (scoop 등 비표준 설치 대응).
fn find_git_bash(spec: &str) -> Option<String> {
    use std::path::{Path, PathBuf};
    let existing = |pb: PathBuf| pb.is_file().then(|| pb.to_string_lossy().into_owned());
    let p = Path::new(spec);
    if p.components().count() > 1 {
        let base = p.file_name()?.to_str()?.to_ascii_lowercase();
        if base.starts_with("git-bash") {
            return existing(p.parent()?.join("bin").join("bash.exe"));
        }
        return existing(p.to_path_buf());
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(var) {
            roots.push(PathBuf::from(v).join("Git"));
        }
    }
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(v).join("Programs").join("Git"));
    }
    // git.exe 는 보통 Git\cmd\ 에 있어 PATH 에 잡힌다 → 그 부모가 설치 루트
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("git.exe").is_file() {
                if let Some(root) = dir.parent() {
                    roots.push(root.to_path_buf());
                }
            }
        }
    }
    roots.into_iter().find_map(|root| existing(root.join("bin").join("bash.exe")))
}

/// PATH 에서 실행 파일 존재 여부
fn on_path(name: &str) -> bool {
    std::env::var("PATH")
        .ok()
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}

/// 설치된 셸 자동 감지 — 설정 UI 의 셸 드롭다운 항목.
/// value 는 settings.shell 에 저장되는 문자열(빈 값 = OS 기본), label 은 표시용.
/// 저장된 value 의 해석은 세션 생성 시 resolve_shell 이 담당한다.
#[tauri::command]
pub fn list_shells() -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut push =
        |label: String, value: &str| out.push(serde_json::json!({ "label": label, "value": value }));
    if cfg!(windows) {
        push("OS 기본".into(), "");
        push("PowerShell".into(), "powershell.exe");
        if on_path("pwsh.exe") {
            push("PowerShell 7 (pwsh)".into(), "pwsh.exe");
        }
        push("명령 프롬프트 (cmd)".into(), "cmd.exe");
        if find_git_bash("git-bash").is_some() {
            push("Git Bash".into(), "git-bash");
        }
    } else {
        let sys = std::env::var("SHELL").unwrap_or_default();
        let label = if sys.is_empty() { "OS 기본".into() } else { format!("OS 기본 ({})", sys) };
        push(label, "");
        for sh in ["/bin/zsh", "/bin/bash"] {
            if sh != sys && std::path::Path::new(sh).is_file() {
                push(sh.into(), sh);
            }
        }
    }
    out
}

/// 셸 설정 문자열을 실행 가능한 (프로그램, 인자) 로 해석한다.
/// Windows 의 bash 계열 지정은 Git Bash 를 탐색해 실제 셸로 바꾼다 — GUI 런처(git-bash.exe)는
/// PTY 에 붙지 않고 새 창을 띄우며, Git 의 bash.exe 는 보통 PATH 에 없어 이름만으론 못 찾는다.
fn resolve_shell(override_shell: &str) -> Result<ResolvedShell, String> {
    // 경로 복사 시 흔한 둘러싼 따옴표는 허용
    let shell = default_shell(override_shell).trim_matches('"').to_string();
    if !cfg!(windows) {
        // 로그인 셸: 사용자 PATH·프롬프트 환경을 그대로 상속 (GUI 앱은 셸 env 를 못 받음)
        return Ok(ResolvedShell { program: shell, args: vec!["-l"], msys_bash: false });
    }
    let base = shell.rsplit(['/', '\\']).next().unwrap_or(&shell).to_ascii_lowercase();
    let bashish = matches!(base.as_str(), "bash" | "bash.exe" | "git-bash" | "git-bash.exe");
    if !bashish {
        return Ok(ResolvedShell { program: shell, args: Vec::new(), msys_bash: false });
    }
    if let Some(program) = find_git_bash(&shell) {
        // System32 의 bash.exe 는 WSL 런처 — MSYS 전용 인자를 주지 않고 그대로 실행
        if program.to_ascii_lowercase().contains("system32") {
            return Ok(ResolvedShell { program, args: Vec::new(), msys_bash: false });
        }
        // --login: Git Bash 의 PATH·프롬프트 초기화, -i: 대화형 (Windows Terminal 프로필과 동일)
        return Ok(ResolvedShell { program, args: vec!["--login", "-i"], msys_bash: true });
    }
    Err(format!(
        "Git Bash 를 찾을 수 없습니다 — 설정의 셸에 bash.exe 전체 경로를 입력하세요 \
         (예: C:\\Program Files\\Git\\bin\\bash.exe). 입력값: {}",
        shell
    ))
}

/// 상태 전이 판정 (순수 함수 — 테스트 가능하게 분리).
/// `hook_fresh_done` 은 "아직 소비하지 않은 Stop 훅 신호가 있는가".
fn decide_status(
    cur: Status,
    waiting: bool,
    quiet_ms: u128,
    busy_ms: u128,
    hook_seen: bool,
    hook_fresh_done: bool,
) -> Status {
    if waiting {
        return Status::Waiting;
    }
    if quiet_ms < BUSY_HOLD_MS {
        return Status::Running;
    }
    if cur == Status::Running {
        if hook_seen {
            // 훅 세션: Stop 훅이 유일한 완료 근거 — 도구 실행 중 출력 공백으로는 알리지 않는다.
            if hook_fresh_done {
                Status::Done
            } else if quiet_ms >= HOOK_STALE_MS {
                Status::Idle // 인터럽트·훅 유실 — 조용히 유휴로 (근거 없는 완료 알림 금지)
            } else {
                Status::Running
            }
        } else if busy_ms < DONE_MIN_MS {
            Status::Idle // 짧은 출력(에코 등)
        } else if quiet_ms >= DONE_QUIET_MS {
            Status::Done
        } else {
            Status::Running // TUI 재그리기 간격일 수 있어 판정 보류
        }
    } else if cur == Status::Waiting {
        Status::Idle // waiting 해제 후 무출력 — 승인 직후 잠깐의 공백
    } else {
        cur
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

/// PTY 출력에서 OSC(터미널 알림) 페이로드를 추출하는 증분 스캐너.
/// 시퀀스(`ESC ] … BEL` 또는 `ESC ] … ESC \`)가 read 청크 경계에서 잘려도 동작한다.
/// Codex 의 [tui] notifications(OSC 9), OSC 777(notify) 를 잡기 위한 것 —
/// OSC 52(클립보드) 같은 대형 페이로드는 캡을 넘기면 수집을 포기하고 종결자까지 건너뛴다.
struct OscScanner {
    state: OscState,
    payload: Vec<u8>,
    overflow: bool,
}

#[derive(PartialEq)]
enum OscState {
    Ground,
    Esc,      // ESC 수신
    InOsc,    // ESC ] 수신 — 페이로드 수집 중
    InOscEsc, // 페이로드 중 ESC 수신 — 다음이 '\' 면 ST 종결
}

const OSC_PAYLOAD_CAP: usize = 1024;

impl OscScanner {
    fn new() -> Self {
        OscScanner { state: OscState::Ground, payload: Vec::new(), overflow: false }
    }

    /// 청크를 소비하고 완성된 OSC 페이로드들을 반환
    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                OscState::Ground => {
                    if b == 0x1b {
                        self.state = OscState::Esc;
                    }
                }
                OscState::Esc => {
                    if b == b']' {
                        self.state = OscState::InOsc;
                        self.payload.clear();
                        self.overflow = false;
                    } else if b != 0x1b {
                        self.state = OscState::Ground;
                    }
                }
                OscState::InOsc => {
                    if b == 0x07 {
                        self.finish(&mut out);
                    } else if b == 0x1b {
                        self.state = OscState::InOscEsc;
                    } else if self.payload.len() < OSC_PAYLOAD_CAP {
                        self.payload.push(b);
                    } else {
                        self.overflow = true;
                    }
                }
                OscState::InOscEsc => {
                    if b == b'\\' {
                        self.finish(&mut out);
                    } else {
                        // ESC 뒤 '\' 가 아니면 비정상 시퀀스 — 수집 포기
                        self.state = if b == 0x1b { OscState::Esc } else { OscState::Ground };
                        self.payload.clear();
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self, out: &mut Vec<String>) {
        self.state = OscState::Ground;
        if !self.overflow {
            out.push(String::from_utf8_lossy(&self.payload).into_owned());
        }
        self.payload.clear();
    }
}

/// 알림성 OSC 페이로드가 '허가 대기' 신호인지 분류.
/// OSC 9(`9;메시지`) / OSC 777(`777;notify;제목;본문`) 만 대상 — 그 외(창 제목 등)는 무시.
/// 미분류 메시지는 버린다 (오탐으로 배지가 잘못 켜지는 것보다 놓치는 쪽이 안전).
fn osc_waiting_signal(payload: &str) -> bool {
    if !(payload.starts_with("9;") || payload.starts_with("777;")) {
        return false;
    }
    let l = payload.to_lowercase();
    l.contains("approv") || l.contains("permission") || l.contains("허가")
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            metas: Arc::new(Mutex::new(HashMap::new())),
            ios: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            chans: Mutex::new(HashMap::new()),
        }
    }

    /// 상태 머신 폴링 스레드 (앱 시작 시 1회 기동).
    /// 출력 휴리스틱에 훅 상태 파일(claude)·OSC 신호(codex, 리더 스레드가 기록)를 병합한다.
    /// 우선순위: Waiting > Running(출력) > Done/Idle — waiting 중에도 스피너 출력이 나오므로.
    pub fn start_status_thread(&self, app: AppHandle) {
        let metas = Arc::clone(&self.metas);
        std::thread::spawn(move || {
            let mut hook_mtime: Option<std::time::SystemTime> = None;
            let mut hook_states: std::collections::HashMap<String, crate::hooks::HookState> =
                std::collections::HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                // 훅 상태 파일 재로딩 — 디렉토리 mtime 이 그대로면 캐시 재사용
                if let Some(fresh) = crate::hooks::read_states(&mut hook_mtime) {
                    hook_states = fresh;
                }
                let mut changed: Vec<(String, Status, u128)> = Vec::new();
                {
                    let mut map = plock(&metas);
                    let now = Instant::now();
                    for m in map.values_mut() {
                        if m.exited {
                            continue;
                        }
                        // 훅 신호 병합 — 상태 파일은 항상 '가장 최근 이벤트' 하나만 담으므로
                        // 완료 여부는 매 폴링마다 파일 내용에서 직접 읽는다(누적 상태를 두지 않는다).
                        // waiting 만 사용자 입력(waiting_cleared_ms)보다 낡으면 무시한다.
                        match hook_states.get(&m.id) {
                            Some(h) => {
                                m.hook_seen = true;
                                m.hook_done = h.state == "done";
                                if m.hook_done {
                                    m.hook_done_ts = h.ts;
                                }
                                if h.ts > m.waiting_cleared_ms {
                                    match h.state.as_str() {
                                        "waiting" => m.waiting = true,
                                        "busy" | "done" => {
                                            m.waiting = false;
                                            m.waiting_cleared_ms = h.ts;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            // 파일 없음 = 훅 미설치이거나 SessionEnd 로 정리됨 → 출력 휴리스틱으로
                            None => {
                                m.hook_seen = false;
                                m.hook_done = false;
                            }
                        }
                        let quiet_ms = now.duration_since(m.last_output).as_millis();
                        // 이미 소비한 Stop 신호로는 다시 완료가 되지 않는다 —
                        // 완료 후의 화면 재그리기가 같은 신호로 또 알림을 띄우는 것을 막는다.
                        let hook_fresh_done = m.hook_done && m.hook_done_ts > m.hook_done_used_ts;
                        let new_status = decide_status(
                            m.status,
                            m.waiting,
                            quiet_ms,
                            now.duration_since(m.busy_since).as_millis(),
                            m.hook_seen,
                            hook_fresh_done,
                        );
                        if new_status == Status::Done && hook_fresh_done {
                            m.hook_done_used_ts = m.hook_done_ts;
                        }
                        if new_status != m.status {
                            let busy_ms = if new_status == Status::Done {
                                now.duration_since(m.busy_since).as_millis()
                            } else {
                                0
                            };
                            m.status = new_status;
                            changed.push((m.id.clone(), m.status, busy_ms));
                        }
                    }
                }
                for (id, status, busy_ms) in changed {
                    emit_status(&app, &id, status, busy_ms);
                }
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
        let (id, created_at_ms) = (crate::store::new_id(), now_ms());
        let shell = resolve_shell(shell_override)?;
        let home = || std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".into());
        let mut cwd = cwd.unwrap_or_else(home);
        // cwd 가 사라졌으면(폴더 삭제·드라이브 미연결) 홈으로 폴백 — spawn 실패 방지
        if !std::path::Path::new(&cwd).is_dir() {
            cwd = home();
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&shell.program);
        for a in &shell.args {
            cmd.arg(a);
        }
        if shell.msys_bash {
            // Git Bash 로그인 셸은 기본으로 홈으로 cd 한다 — 지정 cwd(프로젝트 폴더)를 유지시킨다
            cmd.env("CHERE_INVOKE", "1");
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Claude Code 훅(자식 프로세스)이 자기 세션을 식별하는 열쇠 — hooks.rs 참고
        cmd.env("TA_SESSION_ID", &id);
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
            shell.program.rsplit(['/', '\\']).next().unwrap_or(&shell.program).to_string()
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
            created_at_ms,
            waiting: false,
            waiting_cleared_ms: 0,
            hook_seen: false,
            hook_done: false,
            hook_done_ts: 0,
            hook_done_used_ts: 0,
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
            let mut osc = OscScanner::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF = 셸 종료
                    Ok(n) => {
                        // OSC 알림 감지 (codex approval-requested 등) — 어느 PTY 출력인지
                        // 여기서 원천적으로 알므로 세션 매칭이 필요 없다
                        let waiting_signal =
                            osc.feed(&buf[..n]).iter().any(|p| osc_waiting_signal(p));
                        {
                            let mut map = plock(&metas);
                            if let Some(m) = map.get_mut(&sid) {
                                let now = Instant::now();
                                // 작업 구간의 시작 시각. 진행 중(Running/Waiting)에는 갱신하지 않는다 —
                                // 중간 공백마다 리셋되면 완료 알림의 소요 시간이 마지막 버스트만 세게 된다.
                                if !matches!(m.status, Status::Running | Status::Waiting)
                                    && now.duration_since(m.last_output).as_millis() > BUSY_HOLD_MS
                                {
                                    m.busy_since = now; // idle → busy 진입 시각
                                }
                                m.last_output = now;
                                if waiting_signal {
                                    m.waiting = true;
                                }
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
                // 2) 버스트 수집 코얼레싱 — 출력이 QUIET_MS 동안 잠잠해질 때까지 모아
                //    한 프레임으로 보낸다. TUI 재그리기(지우기+다시쓰기)가 emit 경계에서
                //    쪼개지면 반쯤 그려진 중간 상태가 화면에 비쳐 깜빡이기 때문.
                //    타이핑 에코(낱개 출력)는 첫 공백 판정에서 바로 나가 지연이 ~QUIET_MS 다.
                //    상한: 지연 COALESCE_MS, 수집량 EMIT_CHUNK/2 — 넘으면 스트리밍 전환
                let collect_start = Instant::now();
                loop {
                    let before = plock(&chan_e.inner).pending.len();
                    std::thread::sleep(Duration::from_millis(QUIET_MS));
                    let g = plock(&chan_e.inner);
                    if g.pending.len() == before
                        || g.closed
                        || g.pending.len() >= EMIT_CHUNK / 2
                        || collect_start.elapsed().as_millis() >= COALESCE_MS as u128
                    {
                        break;
                    }
                }
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
        // 사용자 입력 = 허가 응답 가능성 — waiting 즉시 해제 (500ms 폴링을 기다리지 않음).
        // 낡은 훅 waiting 파일이 다시 켜지 않도록 해제 시각을 기록한다
        {
            let mut map = plock(&self.metas);
            if let Some(m) = map.get_mut(id) {
                m.waiting = false;
                m.waiting_cleared_ms = now_ms();
            }
        }
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
        // 맵 락은 remove 즉시 놓는다 (가드를 문장 스코프로 떨어뜨림) —
        // 락을 쥔 채 chan 통지·kill·파일 삭제를 하면 다른 세션의 생성/닫기가 그 뒤에서 대기한다
        let chan = plock(&self.chans).remove(id);
        if let Some(chan) = chan {
            let mut g = plock(&chan.inner);
            g.closed = true;
            chan.cv.notify_all();
        }
        // kill 은 세션 io 락과 무관하게 수행 — write 가 블록된 세션도 즉시 해제된다
        let child = plock(&self.children).remove(id);
        if let Some(mut child) = child {
            let _ = child.kill();
        }
        plock(&self.ios).remove(id);
        plock(&self.metas).remove(id);
        crate::hooks::remove_state(id); // SessionEnd 훅이 못 지운 경우의 보강 정리
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

    /// 세션 제목 변경 (사이드바 인라인 편집)
    pub fn rename(&self, id: &str, title: &str) {
        let mut map = plock(&self.metas);
        if let Some(m) = map.get_mut(id) {
            m.title = title.to_string();
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
        // HashMap 순회 순서는 무작위 → 생성 시각으로 정렬해 사이드바 순서를 안정화
        let map = plock(&self.metas);
        let mut metas: Vec<&SessionMeta> = map.values().collect();
        metas.sort_by_key(|m| m.created_at_ms);
        metas.into_iter().map(|m| m.info()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 상태 판정 (완료 알림의 근거) ──

    #[test]
    fn hook_session_stays_running_through_tool_gaps() {
        // Claude Code 훅 세션: Stop 신호가 없으면 출력이 끊겨도 완료가 아니다.
        // (작업 중인데 "작업 완료" 알림이 뜨던 원인)
        for quiet in [BUSY_HOLD_MS, 2_000, DONE_QUIET_MS, HOOK_STALE_MS - 1] {
            assert_eq!(
                decide_status(Status::Running, false, quiet, 60_000, true, false),
                Status::Running,
                "quiet={quiet}"
            );
        }
    }

    #[test]
    fn hook_session_done_only_on_stop_signal() {
        assert_eq!(
            decide_status(Status::Running, false, 900, 60_000, true, true),
            Status::Done
        );
        // 짧은 작업이어도 Stop 훅이 왔으면 완료 — 훅이 출력 휴리스틱보다 정확하다
        assert_eq!(
            decide_status(Status::Running, false, 900, 100, true, true),
            Status::Done
        );
    }

    #[test]
    fn hook_session_falls_back_to_idle_when_signal_missing() {
        // 인터럽트·훅 유실로 Stop 이 오지 않으면 Running 에 갇히지 않고 조용히 유휴로 —
        // 근거 없는 완료 알림은 보내지 않는다
        assert_eq!(
            decide_status(Status::Running, false, HOOK_STALE_MS, 60_000, true, false),
            Status::Idle
        );
    }

    #[test]
    fn plain_session_needs_long_quiet_before_done() {
        // 훅 없는 세션(codex·셸): TUI 가 1초 간격으로 경과 시간을 다시 그리는 구간을
        // 완료로 오판하지 않는다
        assert_eq!(
            decide_status(Status::Running, false, 1_200, 30_000, false, false),
            Status::Running
        );
        assert_eq!(
            decide_status(Status::Running, false, DONE_QUIET_MS, 30_000, false, false),
            Status::Done
        );
        // 짧은 출력(명령 에코 등)은 완료가 아니다
        assert_eq!(
            decide_status(Status::Running, false, DONE_QUIET_MS, DONE_MIN_MS - 1, false, false),
            Status::Idle
        );
    }

    #[test]
    fn waiting_and_recent_output_take_priority() {
        assert_eq!(
            decide_status(Status::Running, true, 60_000, 60_000, true, true),
            Status::Waiting
        );
        assert_eq!(
            decide_status(Status::Idle, false, 0, 0, false, false),
            Status::Running
        );
        // 완료 배지가 붙은 세션은 조용한 동안 그대로 — 재판정으로 다시 완료가 되지 않는다
        assert_eq!(
            decide_status(Status::Done, false, 60_000, 60_000, true, true),
            Status::Done
        );
    }

    #[test]
    fn osc_scanner_handles_chunk_split() {
        // 시퀀스가 read 청크 경계에서 잘려도 이어서 조립돼야 한다
        let mut s = OscScanner::new();
        assert!(s.feed(b"hello \x1b]9;approval requ").is_empty());
        let out = s.feed(b"ested\x07 world");
        assert_eq!(out, vec!["9;approval requested".to_string()]);
        assert!(osc_waiting_signal(&out[0]));
    }

    #[test]
    fn osc_scanner_st_terminator_and_title_noise() {
        let mut s = OscScanner::new();
        let out = s.feed(b"\x1b]777;notify;Codex;approval requested\x1b\\\x1b]0;window title\x07");
        assert_eq!(out.len(), 2);
        assert!(osc_waiting_signal(&out[0]));
        assert!(!osc_waiting_signal(&out[1])); // 창 제목(OSC 0)은 알림이 아님
    }

    #[test]
    fn osc_scanner_drops_oversized_payload() {
        // OSC 52(클립보드) 같은 대형 페이로드는 수집 포기 — 이후 시퀀스는 정상 처리
        let mut s = OscScanner::new();
        let mut big = b"\x1b]52;c;".to_vec();
        big.extend(std::iter::repeat(b'A').take(OSC_PAYLOAD_CAP * 2));
        big.extend(b"\x07\x1b]9;permission needed\x07");
        let out = s.feed(&big);
        assert_eq!(out, vec!["9;permission needed".to_string()]);
    }
}
