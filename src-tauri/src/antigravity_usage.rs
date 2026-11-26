// Antigravity 남은 사용량 조회.
// Antigravity 는 사용량을 클라우드 API 로만 관리하지만, 실행 중인 Antigravity 허브(IDE 의 language
// server)가 ~/.gemini/antigravity/daemon/hub_<port>.json 에 로컬 포트와 CSRF 토큰을 남긴다.
// 그 로컬 서버의 RetrieveUserQuotaSummary 를 호출하면 그룹별(Gemini / Claude·GPT) 5시간·주간
// 잔여 비율을 얻는다. OAuth 토큰을 직접 다루지 않으므로 로그인 상태를 건드리지 않는다.
// 허브가 꺼져 있으면 조회할 수 없어 마지막 성공값을 옅게 유지한다.
use crate::claude::home_dir;
use crate::claude_usage::{rfc3339_secs, UsageWindow};
use crate::util::plock;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const OK_INTERVAL_MS: u64 = 60_000;
const RETRY_MS: u64 = 15_000;
const API_TIMEOUT_SECS: u64 = 4;
const FIVE_HOUR_MIN: u64 = 300;
const WEEK_MIN: u64 = 10080;
const RPC_PATH: &str = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

#[derive(Serialize, Clone)]
pub struct QuotaGroup {
    pub name: String,
    pub windows: Vec<UsageWindow>,
}

/// 다른 게이지와 같은 모양 { windows, plan, mtimeMs, error } 에 그룹별 상세(groups)를 더한다.
/// windows 는 윈도우(5시간·주간)마다 가장 적게 남은 그룹의 값 — 소진 경고가 게이지의 목적이다.
#[derive(Serialize, Clone)]
pub struct AntigravityUsage {
    pub windows: Vec<UsageWindow>,
    pub groups: Vec<QuotaGroup>,
    pub plan: Option<String>,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    // not_running(허브 없음) / network / no_data. 성공이면 없음
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    #[serde(rename = "retryAtMs", skip_serializing_if = "Option::is_none")]
    pub retry_at_ms: Option<u64>,
}

#[derive(Default)]
struct State {
    last_good: Option<AntigravityUsage>,
    error: Option<&'static str>,
    next_try_ms: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Antigravity CLI(agy) 설치 여부 — GUI 실행 시 PATH 를 믿을 수 없어 흔한 설치 위치와
/// CLI 가 만드는 상태 디렉토리를 함께 본다.
pub fn is_installed() -> bool {
    let exe = if cfg!(windows) { "agy.exe" } else { "agy" };
    let Some(home) = home_dir() else { return false };
    if home.join(".gemini").join("antigravity-cli").is_dir() {
        return true;
    }
    let mut dirs: Vec<PathBuf> = vec![
        home.join(".local").join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs.iter().any(|d| d.join(exe).is_file())
}

struct Hub {
    port: u64,
    csrf: String,
}

/// 허브 발견 파일들 — 최근 것부터. 죽은 허브의 파일이 남아 있을 수 있어 여러 개를 차례로 시도한다.
fn hubs() -> Vec<Hub> {
    let Some(dir) = home_dir().map(|h| h.join(".gemini").join("antigravity").join("daemon")) else {
        return Vec::new();
    };
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("hub_") && n.ends_with(".json")
        })
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH), e.path()))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .filter_map(|(_, p)| {
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(p).ok()?).ok()?;
            Some(Hub {
                port: v.get("httpPort")?.as_u64()?,
                csrf: v.get("csrfToken")?.as_str()?.to_string(),
            })
        })
        .collect()
}

fn call(hub: &Hub) -> Option<serde_json::Value> {
    let body = ureq::post(&format!("http://127.0.0.1:{}{}", hub.port, RPC_PATH))
        .set("Content-Type", "application/json")
        .set("Connect-Protocol-Version", "1")
        .set("X-Codeium-Csrf-Token", &hub.csrf)
        .timeout(std::time::Duration::from_secs(API_TIMEOUT_SECS))
        .send_string("{}")
        .ok()?
        .into_string()
        .ok()?;
    serde_json::from_str(&body).ok()
}

fn window_minutes(w: &str) -> Option<u64> {
    match w {
        "5h" => Some(FIVE_HOUR_MIN),
        "weekly" => Some(WEEK_MIN),
        _ => None,
    }
}

/// 응답 → 표시용 사용량. 인식 가능한 버킷이 하나도 없으면 None.
fn parse(v: &serde_json::Value, now: u64) -> Option<AntigravityUsage> {
    let groups: Vec<QuotaGroup> = v
        .get("response")?
        .get("groups")?
        .as_array()?
        .iter()
        .filter_map(|g| {
            let mut windows: Vec<UsageWindow> = g
                .get("buckets")?
                .as_array()?
                .iter()
                .filter_map(|b| {
                    let minutes = window_minutes(b.get("window")?.as_str()?)?;
                    // proto3 JSON 은 기본값 0 을 생략한다 — 필드가 없으면 소진(0 남음)이다
                    let left = b.get("remainingFraction").and_then(|x| x.as_f64()).unwrap_or(0.0);
                    Some(UsageWindow {
                        window_minutes: minutes,
                        used_percent: ((1.0 - left) * 100.0).clamp(0.0, 100.0),
                        resets_at: b.get("resetTime").and_then(|x| x.as_str()).and_then(rfc3339_secs),
                    })
                })
                .collect();
            if windows.is_empty() {
                return None;
            }
            windows.sort_by_key(|w| w.window_minutes);
            let name = g.get("displayName").and_then(|x| x.as_str()).unwrap_or("?").to_string();
            Some(QuotaGroup { name, windows })
        })
        .collect();
    if groups.is_empty() {
        return None;
    }
    let mut windows: Vec<UsageWindow> = Vec::new();
    for w in groups.iter().flat_map(|g| g.windows.iter()) {
        match windows.iter_mut().find(|x| x.window_minutes == w.window_minutes) {
            Some(x) if w.used_percent > x.used_percent => *x = w.clone(),
            Some(_) => {}
            None => windows.push(w.clone()),
        }
    }
    windows.sort_by_key(|w| w.window_minutes);
    Some(AntigravityUsage { windows, groups, plan: None, mtime_ms: now, error: None, retry_at_ms: None })
}

fn fetch(now: u64) -> Result<AntigravityUsage, &'static str> {
    let hubs = hubs();
    if hubs.is_empty() {
        return Err("not_running");
    }
    let mut got_response = false;
    for h in &hubs {
        if let Some(v) = call(h) {
            got_response = true;
            if let Some(u) = parse(&v, now) {
                return Ok(u);
            }
        }
    }
    Err(if got_response { "no_data" } else { "not_running" })
}

/// 리셋 시각이 지난 윈도우는 회복된 것이므로 0% 로 보낸다
fn reset_passed(ws: &mut [UsageWindow], now_secs: u64) {
    for w in ws {
        if w.resets_at.is_some_and(|t| t <= now_secs) {
            w.used_percent = 0.0;
            w.resets_at = None;
        }
    }
}

fn view(st: &State, now_secs: u64) -> AntigravityUsage {
    let mut u = st.last_good.clone().unwrap_or(AntigravityUsage {
        windows: Vec::new(),
        groups: Vec::new(),
        plan: None,
        mtime_ms: 0,
        error: None,
        retry_at_ms: None,
    });
    reset_passed(&mut u.windows, now_secs);
    for g in &mut u.groups {
        reset_passed(&mut g.windows, now_secs);
    }
    u.error = st.error;
    u.retry_at_ms = st.error.map(|_| st.next_try_ms);
    u
}

#[tauri::command]
pub async fn antigravity_usage() -> Option<AntigravityUsage> {
    let now = now_ms();
    {
        let mut g = plock(&STATE);
        let st = g.get_or_insert_with(State::default);
        if now < st.next_try_ms {
            return Some(view(st, now / 1000));
        }
        st.next_try_ms = now + RETRY_MS; // 동시 폴링의 중복 호출 방지
    }
    let res = tauri::async_runtime::spawn_blocking(move || fetch(now))
        .await
        .unwrap_or(Err("network"));
    let mut g = plock(&STATE);
    let st = g.get_or_insert_with(State::default);
    let now = now_ms();
    match res {
        Ok(u) => {
            st.last_good = Some(u);
            st.error = None;
            st.next_try_ms = now + OK_INTERVAL_MS;
        }
        Err(e) => {
            st.error = Some(e);
            st.next_try_ms = now + RETRY_MS;
        }
    }
    Some(view(st, now / 1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_groups_and_takes_worst_per_window() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"response":{"groups":[
              {"displayName":"Gemini Models","buckets":[
                {"window":"weekly","remainingFraction":0.8,"resetTime":"2026-12-03T01:06:24Z"},
                {"window":"5h","remainingFraction":0.5,"resetTime":"2026-11-26T06:06:24Z"}]},
              {"displayName":"Claude and GPT models","buckets":[
                {"window":"weekly","remainingFraction":0.3},
                {"window":"5h"}]}]}}"#,
        )
        .unwrap();
        let u = parse(&v, 1).unwrap();
        assert_eq!(u.groups.len(), 2);
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0].window_minutes, FIVE_HOUR_MIN);
        assert_eq!(u.windows[0].used_percent, 100.0);
        assert_eq!(u.windows[1].window_minutes, WEEK_MIN);
        assert!((u.windows[1].used_percent - 70.0).abs() < 1e-9);
        // remainingFraction 생략 = 소진 (100% 사용) → 5시간 최악값도 이 그룹
        assert_eq!(u.groups[1].windows[0].used_percent, 100.0);
    }

    #[test]
    fn empty_response_is_none() {
        let v: serde_json::Value = serde_json::from_str(r#"{"response":{"groups":[]}}"#).unwrap();
        assert!(parse(&v, 1).is_none());
    }
}
