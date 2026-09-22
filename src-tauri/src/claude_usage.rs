// Claude Code 남은 사용량 조회 — 코덱스와 달리 Claude Code 는 사용률을 로컬 파일에 남기지 않는다.
// 그래서 ~/.claude/.credentials.json 에 저장된 OAuth 액세스 토큰으로 Anthropic 사용량 API
// (GET /api/oauth/usage) 를 직접 조회한다. 토큰 갱신은 Claude Code 본체가 하므로 앱은 읽기만 한다
// (앱이 갱신하면 회전된 refresh 토큰 때문에 Claude Code 로그인이 풀릴 수 있다).
// 조회에 실패해도 마지막 성공값을 계속 돌려주고, 실패 이유(error)와 재시도 시각을 함께 실어 보낸다.
use crate::claude::home_dir;
use crate::util::plock;
use serde::Serialize;
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const OK_INTERVAL_MS: u64 = 60_000; // 성공 후 다음 조회까지 (상단바 폴링보다 길게)
const TRANSIENT_RETRY_MS: u64 = 15_000; // 네트워크·서버 일시 오류 뒤 빠른 재시도
const AUTH_RETRY_MS: u64 = 60_000; // 인증 실패 — 토큰 파일이 바뀌면 이 대기와 무관하게 바로 재시도
const RATE_BACKOFF_MIN_MS: u64 = 120_000; // 429 첫 대기
const RATE_BACKOFF_MAX_MS: u64 = 900_000; // 429 대기 상한 (15분)
const RETRY_AFTER_MAX_SECS: u64 = 3600; // 비정상적으로 큰 Retry-After 는 1시간으로 자른다
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
    pub windows: Vec<UsageWindow>, // 5시간 → 주간 순. 한 번도 성공하지 못했으면 비어 있다
    pub plan: Option<String>,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64, // 마지막 성공 조회 시각 (데이터 신선도 판단용)
    // 직전 조회의 실패 이유 — token_expired / forbidden / rate_limited / network / no_data /
    // no_credentials. 성공이면 없음
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    #[serde(rename = "retryAtMs", skip_serializing_if = "Option::is_none")]
    pub retry_at_ms: Option<u64>,
}

/// 조회 실패 분류 — 종류마다 재시도 간격과 안내 문구가 다르다
#[derive(Debug, Clone, Copy, PartialEq)]
enum FetchError {
    NoCredentials,
    TokenExpired,
    Forbidden,                // 403 — 권한(scope) 문제일 수 있어 만료와 구분한다
    RateLimited(Option<u64>), // Retry-After (초)
    Network,
    NoData, // 200 이지만 한도 버킷이 없음 (한도 없는 플랜 등) — 곧 바뀌지 않으므로 천천히 재시도
}

impl FetchError {
    fn code(self) -> &'static str {
        match self {
            FetchError::NoCredentials => "no_credentials",
            FetchError::TokenExpired => "token_expired",
            FetchError::Forbidden => "forbidden",
            FetchError::RateLimited(_) => "rate_limited",
            FetchError::Network => "network",
            FetchError::NoData => "no_data",
        }
    }

    /// 자격 증명 파일이 바뀌면(로그인·토큰 갱신) 대기 없이 다시 시도할 실패인가
    fn waits_for_credentials(self) -> bool {
        matches!(self, FetchError::NoCredentials | FetchError::TokenExpired | FetchError::Forbidden)
    }
}

#[derive(Default)]
struct State {
    last_good: Option<ClaudeUsage>,
    error: Option<FetchError>,
    next_try_ms: u64,
    rate_backoff_ms: u64,
    token_at_error: Option<String>, // 인증 실패 당시 토큰 — 바뀌면 Claude Code 가 갱신·로그인한 것
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Claude Code 설치 여부 — 홈의 설정 디렉토리 존재로 판단한다 (GUI 실행 시 PATH 를 믿을 수 없다)
pub fn is_installed() -> bool {
    home_dir().is_some_and(|h| h.join(".claude").is_dir())
}

struct OAuth {
    token: String,
    plan: Option<String>,
    expires_at_ms: Option<u64>,
}

/// 자격 증명 읽기 — 읽기 전용. 갱신은 Claude Code 본체 담당이다.
fn oauth() -> Option<OAuth> {
    let txt = fs::read_to_string(home_dir()?.join(".claude").join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let o = v.get("claudeAiOauth")?;
    Some(OAuth {
        token: o.get("accessToken")?.as_str()?.to_string(),
        plan: o
            .get("subscriptionType")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        expires_at_ms: o.get("expiresAt").and_then(|x| x.as_u64()),
    })
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

/// 사용량 API 호출 (블로킹). 실패는 종류별로 분류해 돌려준다.
fn fetch(token: &str) -> Result<serde_json::Value, FetchError> {
    let res = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(API_TIMEOUT_SECS))
        .call();
    let resp = match res {
        Ok(r) => r,
        Err(ureq::Error::Status(401, _)) => return Err(FetchError::TokenExpired),
        Err(ureq::Error::Status(403, _)) => return Err(FetchError::Forbidden),
        Err(ureq::Error::Status(429, r)) => {
            let after = r.header("retry-after").and_then(|x| x.trim().parse::<u64>().ok());
            return Err(FetchError::RateLimited(after));
        }
        Err(_) => return Err(FetchError::Network),
    };
    let body = resp.into_string().map_err(|_| FetchError::Network)?;
    serde_json::from_str(&body).map_err(|_| FetchError::Network)
}

/// 응답 → 표시용 사용량. 버킷이 하나도 없으면 None.
fn parse_usage(v: &serde_json::Value, plan: Option<String>, now: u64) -> Option<ClaudeUsage> {
    let windows: Vec<UsageWindow> = [
        window_of(v.get("five_hour"), FIVE_HOUR_MIN),
        window_of(v.get("seven_day"), WEEK_MIN),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        return None;
    }
    Some(ClaudeUsage { windows, plan, mtime_ms: now, error: None, retry_at_ms: None })
}

/// 실제 조회 1회 (블로킹). 만료가 확실한 토큰으로는 네트워크를 쓰지 않는다.
fn fetch_usage(cred: Option<OAuth>, now: u64) -> Result<ClaudeUsage, FetchError> {
    let cred = cred.ok_or(FetchError::NoCredentials)?;
    if cred.expires_at_ms.is_some_and(|t| t <= now) {
        return Err(FetchError::TokenExpired);
    }
    let v = fetch(&cred.token)?;
    parse_usage(&v, cred.plan, now).ok_or(FetchError::NoData)
}

/// 실패 종류별 다음 재시도 시각. 429 는 지수 백오프(Retry-After 가 더 길면 그쪽)를 쓴다.
fn schedule_retry(st: &mut State, err: FetchError, now: u64) {
    let wait = match err {
        FetchError::RateLimited(after) => {
            st.rate_backoff_ms =
                (st.rate_backoff_ms * 2).clamp(RATE_BACKOFF_MIN_MS, RATE_BACKOFF_MAX_MS);
            let after = after.unwrap_or(0).min(RETRY_AFTER_MAX_SECS) * 1000;
            st.rate_backoff_ms.max(after)
        }
        FetchError::TokenExpired | FetchError::Forbidden | FetchError::NoCredentials => AUTH_RETRY_MS,
        FetchError::NoData => OK_INTERVAL_MS,
        FetchError::Network => TRANSIENT_RETRY_MS,
    };
    st.next_try_ms = now.saturating_add(wait);
}

/// 프런트에 보낼 값 — 마지막 성공값(없으면 빈 윈도우)에 현재 실패 상태를 덧붙인다.
/// 리셋 시각이 지난 윈도우는 한도가 회복된 것이므로 옛 사용률 대신 0% 로 보낸다.
fn view(st: &State, now_secs: u64) -> ClaudeUsage {
    let mut u = st.last_good.clone().unwrap_or(ClaudeUsage {
        windows: Vec::new(),
        plan: None,
        mtime_ms: 0,
        error: None,
        retry_at_ms: None,
    });
    for w in &mut u.windows {
        if w.resets_at.is_some_and(|t| t <= now_secs) {
            w.used_percent = 0.0;
            w.resets_at = None;
        }
    }
    u.error = st.error.map(FetchError::code);
    u.retry_at_ms = st.error.map(|_| st.next_try_ms);
    u
}

/// Claude Code 남은 사용량. async 커맨드 — 네트워크 호출은 블로킹 스레드로 넘긴다.
#[tauri::command]
pub async fn claude_usage() -> Option<ClaudeUsage> {
    let now = now_ms();
    let cred = oauth();
    {
        let mut g = plock(&STATE);
        let st = g.get_or_insert_with(State::default);
        // 인증 실패 뒤 Claude Code 가 토큰을 갱신했으면 대기 시간과 무관하게 바로 다시 조회한다
        let token = cred.as_ref().map(|c| c.token.clone());
        let refreshed = st.error.is_some_and(FetchError::waits_for_credentials)
            && token != st.token_at_error;
        if now < st.next_try_ms && !refreshed {
            return Some(view(st, now / 1000));
        }
        // 동시에 들어온 폴링이 중복 호출하지 않도록 먼저 예약해 두고, 새 토큰도 '확인 중'으로 기록한다
        st.next_try_ms = now + TRANSIENT_RETRY_MS;
        st.token_at_error = token;
    }
    let token = cred.as_ref().map(|c| c.token.clone());
    let res = tauri::async_runtime::spawn_blocking(move || fetch_usage(cred, now))
        .await
        .unwrap_or(Err(FetchError::Network));
    let mut g = plock(&STATE);
    let st = g.get_or_insert_with(State::default);
    let now = now_ms();
    match res {
        Ok(u) => {
            st.last_good = Some(u);
            st.error = None;
            st.rate_backoff_ms = 0;
            st.token_at_error = None;
            st.next_try_ms = now + OK_INTERVAL_MS;
        }
        Err(e) => {
            st.error = Some(e);
            st.token_at_error = token;
            schedule_retry(st, e, now);
        }
    }
    Some(view(st, now / 1000))
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
    fn rate_limit_backoff_grows_and_honors_retry_after() {
        let mut st = State::default();
        schedule_retry(&mut st, FetchError::RateLimited(None), 0);
        assert_eq!(st.next_try_ms, RATE_BACKOFF_MIN_MS);
        schedule_retry(&mut st, FetchError::RateLimited(None), 0);
        assert_eq!(st.next_try_ms, RATE_BACKOFF_MIN_MS * 2);
        // Retry-After 가 백오프보다 길면 서버 요구를 따른다
        schedule_retry(&mut st, FetchError::RateLimited(Some(3600)), 0);
        assert_eq!(st.next_try_ms, 3_600_000);
        // 상한을 넘지 않는다
        for _ in 0..10 {
            schedule_retry(&mut st, FetchError::RateLimited(None), 0);
        }
        assert_eq!(st.rate_backoff_ms, RATE_BACKOFF_MAX_MS);
        schedule_retry(&mut st, FetchError::Network, 0);
        assert_eq!(st.next_try_ms, TRANSIENT_RETRY_MS);
        // 거대한 Retry-After 도 넘치지 않고 1시간으로 잘린다
        schedule_retry(&mut st, FetchError::RateLimited(Some(u64::MAX)), u64::MAX - 10);
        assert_eq!(st.next_try_ms, u64::MAX);
        schedule_retry(&mut st, FetchError::RateLimited(Some(u64::MAX)), 0);
        assert_eq!(st.next_try_ms, RETRY_AFTER_MAX_SECS * 1000);
        // 한도 버킷이 없는 응답은 곧 바뀌지 않으므로 성공 주기로 천천히 본다
        schedule_retry(&mut st, FetchError::NoData, 0);
        assert_eq!(st.next_try_ms, OK_INTERVAL_MS);
    }

    #[test]
    fn failure_keeps_last_good_value() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":30.0},"seven_day":{"utilization":10.0}}"#,
        )
        .unwrap();
        let mut st = State { last_good: parse_usage(&v, None, 1_000), ..Default::default() };
        st.error = Some(FetchError::TokenExpired);
        st.next_try_ms = 5_000;
        let u = view(&st, 0);
        // 실패해도 직전 값과 그 조회 시각을 그대로 보여 주고, 이유와 재시도 시각을 덧붙인다
        assert_eq!((u.windows.len(), u.mtime_ms), (2, 1_000));
        assert_eq!((u.error, u.retry_at_ms), (Some("token_expired"), Some(5_000)));
        // 만료가 확실한 토큰은 네트워크를 쓰지 않고 바로 실패 처리한다
        let cred = OAuth { token: "t".into(), plan: None, expires_at_ms: Some(10) };
        assert_eq!(fetch_usage(Some(cred), 20).err(), Some(FetchError::TokenExpired));
        assert_eq!(fetch_usage(None, 20).err(), Some(FetchError::NoCredentials));
        // 리셋 시각이 지난 윈도우는 유지 중인 값이라도 0% 로 보낸다
        st.last_good.as_mut().unwrap().windows[0].resets_at = Some(100);
        let u = view(&st, 200);
        assert_eq!((u.windows[0].used_percent, u.windows[0].resets_at), (0.0, None));
        assert_eq!(u.windows[1].used_percent, 10.0);
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
