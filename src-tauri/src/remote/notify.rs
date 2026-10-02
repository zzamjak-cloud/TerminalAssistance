// 원격 푸시 (ntfy). 상태 전이 Done/Waiting 만, 세션별 간격 제한.
// 본문에는 세션 라벨과 상태만 싣는다 — 터미널 내용은 외부 서버로 보내지 않는다
use crate::pty::{PtyEvent, PtyManager, Status};
use crate::store::{PushConfig, Store};
use crate::util::plock;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

// 데스크톱 알림 간격(app.js NOTIFY_GAP_MS)과 동일
pub const NOTIFY_GAP: Duration = Duration::from_millis(15_000);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Limiter {
    last: HashMap<String, Instant>,
}

impl Limiter {
    pub fn allow(&mut self, id: &str, now: Instant) -> bool {
        if let Some(t) = self.last.get(id) {
            if now.duration_since(*t) < NOTIFY_GAP {
                return false;
            }
        }
        self.last.insert(id.to_string(), now);
        true
    }

    pub fn forget(&mut self, id: &str) {
        self.last.remove(id);
    }
}

/// 보낼 알림 (제목·본문·ntfy 우선순위·태그). 대상 상태가 아니거나 꺼져 있으면 None
pub fn message(cfg: &PushConfig, label: &str, status: Status) -> Option<(String, &'static str, &'static str)> {
    match status {
        Status::Done if cfg.on_done => Some((format!("{} — 작업 완료", label), "default", "white_check_mark")),
        Status::Waiting if cfg.on_waiting => Some((format!("{} — 허가 대기 중", label), "high", "warning")),
        _ => None,
    }
}

/// ntfy 토픽 이름 — URL 경로에 그대로 들어가므로 안전한 문자만 허용한다
pub fn valid_topic(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 블로킹 HTTP — 반드시 spawn_blocking 안에서 호출
pub fn send_ntfy(url: &str, topic: &str, body: &str, priority: &str, tags: &str) -> Result<(), String> {
    let endpoint = format!("{}/{}", url.trim_end_matches('/'), topic);
    ureq::post(&endpoint)
        .timeout(HTTP_TIMEOUT)
        // 헤더는 ASCII 만 안전 — 한글 라벨은 본문에만 싣는다
        .set("Title", "Terminal Assistance")
        .set("Priority", priority)
        .set("Tags", tags)
        .send_string(body)
        .map(|_| ())
        .map_err(|e| format!("푸시 전송 실패: {}", e))
}

/// 기본은 세션 제목만. include_project 면 '프로젝트명 — S2' (데스크톱 표기와 같다)
fn session_label(app: &AppHandle, id: &str, include_project: bool) -> Option<String> {
    let info = app.state::<PtyManager>().list().into_iter().find(|s| s.id == id)?;
    if !include_project {
        return Some(info.title);
    }
    let store = app.state::<Mutex<Store>>();
    let s = plock(&store);
    let project = info
        .project_id
        .as_ref()
        .and_then(|pid| s.data.projects.iter().find(|p| &p.id == pid))
        .map(|p| p.name.clone());
    Some(match project {
        Some(name) => format!("{} — {}", name, info.title),
        None => info.title,
    })
}

/// 앱 수명 동안 세션 이벤트를 감시해 푸시를 보낸다
pub fn spawn_watcher(app: AppHandle) {
    let mut rx = app.state::<PtyManager>().subscribe_events();
    tauri::async_runtime::spawn(async move {
        let mut limiter = Limiter::default();
        loop {
            let (id, status) = match rx.recv().await {
                Ok(PtyEvent::Status { id, status, .. }) => (id, status),
                Ok(PtyEvent::Exited { id }) => {
                    limiter.forget(&id);
                    continue;
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if !matches!(status, Status::Done | Status::Waiting) {
                continue;
            }
            let cfg = plock(&app.state::<Mutex<Store>>()).data.remote.push.clone();
            if cfg.kind != "ntfy" || !valid_topic(&cfg.topic) {
                continue;
            }
            let Some(label) = session_label(&app, &id, cfg.include_project) else { continue };
            let Some((body, priority, tags)) = message(&cfg, &label, status) else { continue };
            if !limiter.allow(&id, Instant::now()) {
                continue;
            }
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = send_ntfy(&cfg.url, &cfg.topic, &body, priority, tags) {
                    eprintln!("{}", e);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_spaces_pushes_per_session() {
        let t0 = Instant::now();
        let mut l = Limiter::default();
        assert!(l.allow("a", t0));
        assert!(!l.allow("a", t0 + Duration::from_secs(14)));
        assert!(l.allow("b", t0 + Duration::from_secs(1))); // 다른 세션은 독립
        assert!(l.allow("a", t0 + NOTIFY_GAP));
        l.forget("b");
        assert!(l.allow("b", t0 + Duration::from_secs(2)));
    }

    #[test]
    fn message_only_for_done_and_waiting_and_respects_flags() {
        let mut cfg = PushConfig::default();
        let (body, prio, _) = message(&cfg, "proj — S1", Status::Done).unwrap();
        assert_eq!(body, "proj — S1 — 작업 완료");
        assert_eq!(prio, "default");
        assert_eq!(message(&cfg, "x", Status::Waiting).unwrap().1, "high");
        assert!(message(&cfg, "x", Status::Running).is_none());
        assert!(message(&cfg, "x", Status::Idle).is_none());
        cfg.on_done = false;
        assert!(message(&cfg, "x", Status::Done).is_none());
    }

    #[test]
    fn topic_validation() {
        assert!(valid_topic("ta-0123456789abcdef"));
        assert!(!valid_topic(""));
        assert!(!valid_topic("a/b"));
        assert!(!valid_topic("a b"));
        assert!(!valid_topic(&"a".repeat(65)));
    }
}
