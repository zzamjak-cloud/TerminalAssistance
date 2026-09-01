// Claude Code 남은 사용량 조회 — 코덱스와 달리 Claude Code 는 사용률을 로컬 파일에 남기지 않는다.
// 그래서 ~/.claude/.credentials.json 에 저장된 OAuth 액세스 토큰으로 Anthropic 사용량 API
// (GET /api/oauth/usage) 를 직접 조회한다. 토큰 갱신은 Claude Code 본체가 하므로 앱은 읽기만 하고,
// 만료·오류로 조회에 실패하면 상단바 표시를 숨긴다.
use crate::claude::home_dir;
use crate::util::plock;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const FRESH_MS: u64 = 12 * 3600 * 1000; // 이 시간 안에 Claude Code 를 쓴 흔적이 있을 때만 표시
const CACHE_MS: u64 = 60_000; // API 호출 간격 상한 (상단바 폴링 주기보다 훨씬 길게)
const API_TIMEOUT_SECS: u64 = 8;
const FIVE_HOUR_MIN: u64 = 300; // 세션(5시간) 윈도우
const WEEK_MIN: u64 = 10080; // 주간 윈도우

/// 코덱스 게이지와 같은 표시 형식을 쓰도록 CodexUsage 와 동일한 JSON 모양으로 맞춘다.
#[derive(Serialize, Clone)]
pub struct UsageWindow {
    #[serde(rename = "windowMinutes")]
    pub window_minutes: u64,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<u64>, // unix 초
}

#[derive(Serialize, Clone)]
pub struct ClaudeUsage {
    pub windows: Vec<UsageWindow>, // 5시간 → 주간 순
    pub plan: Option<String>,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64, // 조회 시각 (데이터 신선도 판단용)
}

// (조회 시각, 결과) — 폴링마다 네트워크를 두드리지 않도록 CACHE_MS 동안 재사용한다.
// 실패(None)도 캐시해 API 가 죽었을 때 폴링 주기마다 재시도하지 않게 한다.
static CACHE: Mutex<Option<(u64, Option<ClaudeUsage>)>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(p: &Path) -> Option<u64> {
    fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Claude Code 를 마지막으로 쓴 시각(ms). history.jsonl 은 프롬프트를 보낼 때마다,
/// projects/<프로젝트> 디렉토리는 새 세션 파일이 생길 때 갱신된다.
fn last_use_ms() -> Option<u64> {
    let root = home_dir()?.join(".claude");
    let mut newest = mtime_ms(&root.join("history.jsonl"));
    if let Ok(entries) = fs::read_dir(root.join("projects")) {
        for e in entries.flatten() {
            let Some(ms) = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
            else {
                continue;
            };
            if newest.is_none_or(|n| ms > n) {
                newest = Some(ms);
            }
        }
    }
    newest
}

/// (액세스 토큰, 구독 플랜) — 읽기 전용. 갱신은 Claude Code 본체 담당이다.
fn oauth() -> Option<(String, Option<String>)> {
    let txt = fs::read_to_string(home_dir()?.join(".claude").join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let o = v.get("claudeAiOauth")?;
    let token = o.get("accessToken")?.as_str()?.to_string();
    let plan = o
        .get("subscriptionType")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    Some((token, plan))
}

/// RFC3339 → unix 초. 응답 형식은 "2026-09-02T02:40:00.119807+00:00" 또는 "...Z".
fn rfc3339_secs(s: &str) -> Option<u64> {
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // 초 뒤의 소수점 이하를 건너뛰면 타임존 오프셋이 남는다
    let tz = s[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let off = match tz.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&c @ (b'+' | b'-')) => {
            let sign = if c == b'+' { 1 } else { -1 };
            let oh = tz.get(1..3)?.parse::<i64>().ok()?;
            let om = tz.get(4..6).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            sign * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    // 1970-01-01 기준 일수 (Howard Hinnant days_from_civil)
    let (cy, cm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = if cy >= 0 { cy } else { cy - 399 } / 400;
    let yoe = cy - era * 400;
    let doy = (153 * cm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + mi * 60 + se - off).ok()
}

/// 응답의 한 버킷(five_hour / seven_day) → 표시용 윈도우. utilization 이 없으면 제외.
fn window_of(v: Option<&serde_json::Value>, minutes: u64) -> Option<UsageWindow> {
    let o = v?.as_object()?;
    Some(UsageWindow {
        window_minutes: minutes,
        used_percent: o.get("utilization")?.as_f64()?,
        resets_at: o
            .get("resets_at")
            .and_then(|x| x.as_str())
            .and_then(rfc3339_secs),
    })
}

/// 사용량 API 호출 (블로킹). 실패·만료는 전부 None → 상단바 미표시.
fn fetch(token: &str) -> Option<serde_json::Value> {
    let body = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(API_TIMEOUT_SECS))
        .call()
        .ok()?
        .into_string()
        .ok()?;
    serde_json::from_str(&body).ok()
}

/// Claude Code 남은 사용량 (없으면 None). async 커맨드 — 네트워크 호출은 블로킹 스레드로 넘긴다.
#[tauri::command]
pub async fn claude_usage() -> Option<ClaudeUsage> {
    // 최근에 Claude Code 를 쓰지 않았으면 조회도 표시도 하지 않는다 (코덱스 게이지와 같은 규칙)
    let now = now_ms();
    if last_use_ms().is_none_or(|t| now.saturating_sub(t) > FRESH_MS) {
        return None;
    }
    if let Some((at, u)) = plock(&CACHE).as_ref() {
        if now.saturating_sub(*at) < CACHE_MS {
            return u.clone();
        }
    }
    let usage = fetch_usage().await;
    *plock(&CACHE) = Some((now_ms(), usage.clone()));
    usage
}

/// 실제 조회 1회. 자격 증명·네트워크·응답 어디서든 실패하면 None.
async fn fetch_usage() -> Option<ClaudeUsage> {
    let (token, plan) = oauth()?;
    let v = tauri::async_runtime::spawn_blocking(move || fetch(&token))
        .await
        .ok()??;
    let mut windows = Vec::new();
    if let Some(w) = window_of(v.get("five_hour"), FIVE_HOUR_MIN) {
        windows.push(w);
    }
    if let Some(w) = window_of(v.get("seven_day"), WEEK_MIN) {
        windows.push(w);
    }
    if windows.is_empty() {
        return None;
    }
    Some(ClaudeUsage { windows, plan, mtime_ms: now_ms() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339_offsets() {
        // 1970-01-01T00:00:00Z = 0
        assert_eq!(rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        // 2026-09-02T02:40:00+00:00 — 소수점 이하와 +00:00 오프셋을 함께 처리
        let base = rfc3339_secs("2026-09-02T02:40:00Z").unwrap();
        assert_eq!(rfc3339_secs("2026-09-02T02:40:00.119807+00:00"), Some(base));
        // +09:00 는 UTC 보다 9시간 이른 순간을 가리킨다
        assert_eq!(rfc3339_secs("2026-09-02T11:40:00+09:00"), Some(base));
        assert_eq!(rfc3339_secs("2026-09-01T17:40:00-09:00"), Some(base));
        assert_eq!(rfc3339_secs("깨진값"), None);
    }

    #[test]
    fn window_needs_utilization() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"utilization":18.0,"resets_at":"2026-09-02T02:40:00Z"}"#).unwrap();
        let w = window_of(Some(&v), FIVE_HOUR_MIN).unwrap();
        assert_eq!((w.window_minutes, w.used_percent), (300, 18.0));
        assert!(w.resets_at.is_some());
        // null 버킷(해당 한도 없음)은 표시 대상이 아니다
        assert!(window_of(Some(&serde_json::Value::Null), FIVE_HOUR_MIN).is_none());
        assert!(window_of(None, FIVE_HOUR_MIN).is_none());
    }
}
