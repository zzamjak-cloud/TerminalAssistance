// 진행 계획(체크리스트) 상태 관리.
// - 자동 연동: Claude Code 가 ~/.claude/todos/*.json 에 기록하는 작업 계획을 감시해
//   "실행 중" 세션과 휴리스틱으로 바인딩한다 (세션이 busy 인 동안 갱신된 파일 = 그 세션의 계획).
// - 수동 항목: 세션별로 사용자가 직접 추가/체크하는 항목. Rust 쪽에 보관하므로
//   웹뷰 크래시/리로드에도 유지된다 (앱 재시작 시에는 세션과 함께 소멸).
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// 사용자가 직접 관리하는 수동 체크리스트 항목
#[derive(Serialize, Deserialize, Clone)]
pub struct ManualItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

pub struct PlanWatcher {
    /// sessionId → 바인딩된 Claude Code todo 파일
    bindings: Mutex<HashMap<String, PathBuf>>,
    /// sessionId → 수동 항목 목록
    manual: Mutex<HashMap<String, Vec<ManualItem>>>,
}

fn todos_dir() -> Option<PathBuf> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok()?;
    Some(PathBuf::from(home).join(".claude").join("todos"))
}

/// 뮤텍스 poisoning 무해화
fn plock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl PlanWatcher {
    pub fn new() -> Self {
        PlanWatcher { bindings: Mutex::new(HashMap::new()), manual: Mutex::new(HashMap::new()) }
    }

    /// 감시 스레드: 2초마다 todos 디렉토리를 스캔해 갱신된 파일을 실행 중 세션에 바인딩
    pub fn start(app: tauri::AppHandle) {
        std::thread::spawn(move || {
            use tauri::Manager;
            let mut last_scan = SystemTime::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let Some(dir) = todos_dir() else { continue };
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };

                // 지난 스캔 이후 수정된 todo 파일 수집
                let scan_started = SystemTime::now();
                let mut changed: Vec<PathBuf> = Vec::new();
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().map(|x| x == "json").unwrap_or(false) {
                        if let Ok(md) = e.metadata() {
                            if md.modified().map(|m| m > last_scan).unwrap_or(false) {
                                changed.push(p);
                            }
                        }
                    }
                }
                last_scan = scan_started;
                if changed.is_empty() {
                    continue;
                }

                let watcher = app.state::<PlanWatcher>();
                let running = app.state::<crate::pty::PtyManager>().running_ids();
                if running.is_empty() {
                    continue;
                }
                let mut binds = plock(&watcher.bindings);
                for f in changed {
                    // 이미 이 파일에 바인딩된 세션이 있으면 유지
                    if binds.values().any(|p| p == &f) {
                        continue;
                    }
                    // 바인딩 없는 실행 중 세션 우선, 없고 실행 중이 1개뿐이면 재바인딩
                    // (같은 세션에서 새 Claude 실행 = 새 todo 파일)
                    let target = running
                        .iter()
                        .find(|s| !binds.contains_key(*s))
                        .or_else(|| if running.len() == 1 { running.first() } else { None });
                    if let Some(sid) = target {
                        binds.insert(sid.clone(), f);
                    }
                }
            }
        });
    }

    /// 세션에 바인딩된 Claude Code todo 파일을 파싱해 반환. 바인딩 없으면 null
    pub fn auto_plan(&self, session_id: &str) -> serde_json::Value {
        let path = { plock(&self.bindings).get(session_id).cloned() };
        let Some(path) = path else { return serde_json::Value::Null };
        let Ok(txt) = std::fs::read_to_string(&path) else { return serde_json::Value::Null };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            return serde_json::Value::Null;
        };
        // 형식 방어: 최상위 배열 또는 { "todos": [...] } 둘 다 수용
        let arr = if v.is_array() { v } else { v.get("todos").cloned().unwrap_or(serde_json::Value::Null) };
        let Some(items) = arr.as_array() else { return serde_json::Value::Null };
        let mapped: Vec<serde_json::Value> = items
            .iter()
            .filter_map(|it| {
                let text = it.get("content").and_then(|x| x.as_str())
                    .or_else(|| it.get("activeForm").and_then(|x| x.as_str()))?;
                let status = it.get("status").and_then(|x| x.as_str()).unwrap_or("pending");
                Some(serde_json::json!({
                    "text": text,
                    "done": status == "completed",
                    "active": status == "in_progress"
                }))
            })
            .collect();
        serde_json::json!(mapped)
    }

    pub fn manual_plan(&self, session_id: &str) -> Vec<ManualItem> {
        plock(&self.manual).get(session_id).cloned().unwrap_or_default()
    }

    pub fn set_manual_plan(&self, session_id: &str, items: Vec<ManualItem>) {
        plock(&self.manual).insert(session_id.to_string(), items);
    }

    /// 세션 종료 시 관련 상태 정리
    pub fn remove_session(&self, session_id: &str) {
        plock(&self.bindings).remove(session_id);
        plock(&self.manual).remove(session_id);
    }
}
