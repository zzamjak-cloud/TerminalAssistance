// 비정상 종료(강제 종료·크래시) 후 복구.
// 종료 처리기가 돌지 못하므로 평소에 대비해 둔다:
//   - 실행 표식(running.json): 시작 시 쓰고 정상 종료 경로에서 지운다. 다음 실행에 남아 있으면 비정상 종료.
//   - crash_resume: 실행 중인 에이전트의 재개 명령 스냅샷을 주기적으로(60초, 변화 직후 3초 디바운스) 저장.
// 다음 실행이 비정상 종료를 감지하면 업데이트 이어하기와 같은 경로로 탭마다 에이전트를 다시 띄운다.
use crate::pty::PtyManager;
use crate::store::{PendingResume, ResumeEntry, Store};
use crate::util::plock;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 스냅샷이 이보다 오래되면 복구에 쓰지 않는다 — 하루 넘게 지난 대화를 자동으로 띄우면 혼란스럽다
pub const CRASH_RESUME_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(60);
const SNAPSHOT_DEBOUNCE: Duration = Duration::from_secs(3);
// 내용이 그대로여도 이 간격마다 시각을 갱신한다 — 오래 켜 둔 앱의 스냅샷이 24시간 상한에 걸리지 않게
const SNAPSHOT_REFRESH_MS: u64 = 60 * 60 * 1000;

#[derive(serde::Serialize, serde::Deserialize)]
struct Marker {
    pid: u32,
    #[serde(rename = "startedMs")]
    started_ms: u64,
}

/// 이번 실행이 비정상 종료 뒤의 실행인가 + 그때 쓸 재개 목록 (시작 시 저장소에서 옮겨 둔다 —
/// 복원 직후의 새 스냅샷이 프론트가 가져가기 전에 덮어쓰지 않게)
#[derive(Default)]
pub struct CrashRecovery {
    pub crashed: bool,
    pub entries: Mutex<Option<PendingResume>>,
}

static MARKER: OnceLock<PathBuf> = OnceLock::new();
static POKE: OnceLock<Mutex<Sender<()>>> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 표식에 적힌 pid 가 아직 살아 있는 다른 프로세스인가 (같은 앱의 다른 인스턴스)
fn other_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        // 단일 인스턴스 플러그인이 동시 실행을 막으므로 남은 표식은 곧 비정상 종료다
        false
    }
}

/// 표식 내용 → 비정상 종료였는가 (순수 판정)
pub fn crashed_from_marker(text: Option<&str>, alive: impl Fn(u32) -> bool) -> bool {
    let Some(text) = text else { return false };
    match serde_json::from_str::<Marker>(text) {
        Ok(m) => !alive(m.pid),
        Err(_) => true, // 깨진 표식도 정상 종료가 지우지 못한 것
    }
}

pub fn crash_resume_valid(created_ms: u64, now: u64) -> bool {
    now >= created_ms && now - created_ms <= CRASH_RESUME_TTL_MS
}

/// 앱 시작 시 1회 — 지난 실행이 비정상 종료였는지 판정하고 새 표식을 남긴다
pub fn init(app: &AppHandle, data_dir: PathBuf) {
    let path = data_dir.join("running.json");
    let prev = std::fs::read_to_string(&path).ok();
    let crashed = crashed_from_marker(prev.as_deref(), other_alive);
    let store = app.state::<Mutex<Store>>();
    let taken = {
        let mut s = plock(&store);
        let snap = s.data.crash_resume.take();
        if snap.is_some() {
            let _ = s.save();
        }
        snap
    };
    let entries = taken.filter(|p| crashed && crash_resume_valid(p.created_ms, now_ms()));
    app.manage(CrashRecovery { crashed, entries: Mutex::new(entries) });
    let _ = std::fs::create_dir_all(&data_dir);
    let marker = Marker { pid: std::process::id(), started_ms: now_ms() };
    if let Ok(json) = serde_json::to_string(&marker) {
        let _ = std::fs::write(&path, json);
    }
    let _ = MARKER.set(path);
    start_snapshot_thread(app.clone());
}

/// 정상 종료 경로에서 호출 — 다음 실행이 비정상 종료로 오인하지 않게
pub fn clear_marker() {
    if let Some(p) = MARKER.get() {
        let _ = std::fs::remove_file(p);
    }
}

/// 업데이트 설치가 실패해 앱이 계속 돌 때 표식을 되살린다
pub fn restore_marker() {
    if let Some(p) = MARKER.get() {
        let marker = Marker { pid: std::process::id(), started_ms: now_ms() };
        if let Ok(json) = serde_json::to_string(&marker) {
            let _ = std::fs::write(p, json);
        }
    }
}

/// 세션 생성·종료·에이전트 실행 직후 — 디바운스 뒤 스냅샷을 갱신한다
pub fn poke() {
    if let Some(tx) = POKE.get() {
        let _ = plock(tx).send(());
    }
}

/// 저장할지 판정 — 내용이 바뀌었거나 시각이 오래됐을 때만 디스크를 건드린다
pub fn snapshot_needs_write(prev: Option<&PendingResume>, next: &[ResumeEntry], now: u64) -> bool {
    match prev {
        None => !next.is_empty(),
        Some(p) => p.entries != next || now.saturating_sub(p.created_ms) >= SNAPSHOT_REFRESH_MS,
    }
}

fn start_snapshot_thread(app: AppHandle) {
    let (tx, rx) = channel::<()>();
    let _ = POKE.set(Mutex::new(tx));
    std::thread::spawn(move || loop {
        match rx.recv_timeout(SNAPSHOT_INTERVAL) {
            Ok(()) => {
                // 탭 여러 개가 한꺼번에 생기는 복원 등은 한 번으로 합친다
                std::thread::sleep(SNAPSHOT_DEBOUNCE);
                while rx.try_recv().is_ok() {}
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        snapshot_once(&app);
    });
}

fn snapshot_once(app: &AppHandle) {
    let targets = app.state::<PtyManager>().resume_targets();
    let entries = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(5), crate::resume::collect_resume_entries(targets))
            .await
            .ok()
    });
    // 판별이 시간 초과로 끝났으면 이전 스냅샷을 지우지 않는다
    let Some(entries) = entries else { return };
    let store = app.state::<Mutex<Store>>();
    let mut s = plock(&store);
    let now = now_ms();
    if !snapshot_needs_write(s.data.crash_resume.as_ref(), &entries, now) {
        return;
    }
    s.data.crash_resume = if entries.is_empty() { None } else { Some(PendingResume { created_ms: now, entries }) };
    let _ = s.save();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_decides_crash() {
        assert!(!crashed_from_marker(None, |_| false), "표식 없음 = 정상 종료");
        assert!(crashed_from_marker(Some(r#"{"pid":42,"startedMs":1}"#), |_| false), "pid 가 죽음 = 비정상 종료");
        assert!(!crashed_from_marker(Some(r#"{"pid":42,"startedMs":1}"#), |p| p == 42), "다른 인스턴스가 실행 중");
        assert!(crashed_from_marker(Some("garbage"), |_| true));
    }

    #[test]
    fn crash_resume_expiry_and_write_rule() {
        assert!(crash_resume_valid(0, CRASH_RESUME_TTL_MS));
        assert!(!crash_resume_valid(0, CRASH_RESUME_TTL_MS + 1));
        assert!(!crash_resume_valid(10, 5));
        let e = |c: &str| ResumeEntry { session_id: "s".into(), command: c.into() };
        assert!(!snapshot_needs_write(None, &[], 0), "빈 것을 빈 것으로");
        assert!(snapshot_needs_write(None, &[e("claude --resume a")], 0));
        let prev = PendingResume { created_ms: 1000, entries: vec![e("claude --resume a")] };
        assert!(!snapshot_needs_write(Some(&prev), &[e("claude --resume a")], 2000), "그대로면 쓰지 않는다");
        assert!(snapshot_needs_write(Some(&prev), &[e("claude --resume b")], 2000));
        assert!(snapshot_needs_write(Some(&prev), &[], 2000), "에이전트가 모두 끝났다");
        assert!(snapshot_needs_write(Some(&prev), &[e("claude --resume a")], 1000 + SNAPSHOT_REFRESH_MS), "오래되면 시각 갱신");
    }
}
