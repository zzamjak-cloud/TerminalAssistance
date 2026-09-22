// 코덱스(Codex CLI) 사용량 조회 — 두 출처를 합친다.
// 1) ChatGPT 사용량 API (GET /backend-api/wham/usage, 코덱스 `/status` 와 같은 출처):
//    ~/.codex/auth.json 의 액세스 토큰으로 조회한다. 다른 PC·IDE·웹에서 쓴 양까지 반영되므로
//    앱을 켜자마자(이 PC 에서 코덱스를 아직 안 돌렸어도) 실제 남은 양이 나온다.
// 2) ~/.codex/sessions/<년>/<월>/<일>/rollout-*.jsonl 의 마지막 token_count 이벤트의 rate_limits:
//    코덱스가 실행 중이면 API 캐시보다 최신일 수 있고, API 가 실패할 때 대체값이 된다.
// 둘 다 읽기 전용 — 토큰 갱신은 코덱스 본체 담당이고 코덱스 저장소를 건드리지 않는다.
use crate::util::plock;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

// 사용량 API 호출 간격 상한 — 프런트 폴링이 잦아도 네트워크는 이 주기로만 나간다
const API_CACHE_MS: u64 = 60_000;
const API_TIMEOUT_SECS: u64 = 8;

// rate_limits 는 token_count 마다 기록되므로 파일 꼬리에서 금방 나온다
const TAIL_CAP: u64 = 128 * 1024;
// 사용량 스캔 범위 — 한동안 코덱스를 쓰지 않아도 마지막 기록으로 게이지를 계속 띄우기 위해 넓게 본다
const USAGE_SCAN_DAYS: usize = 30;
// rate_limits 가 없는 짧은 세션 파일이 이어질 때 꼬리 읽기가 무한정 늘지 않도록 상한을 둔다
const USAGE_FILE_CAP: usize = 20;
const SESSION_LIST_CAP: usize = 30;
const SESSION_SCAN_DAYS: usize = 30;
const SESSION_SCAN_CAP: u64 = 2 * 1024 * 1024;
const SESSION_VIEW_TAIL_CAP: u64 = 512 * 1024;
const PREVIEW_LEN: usize = 200;

#[derive(Serialize)]
pub struct CodexSession {
    pub id: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    pub preview: String,
}

#[derive(Serialize, Clone)]
pub struct CodexWindow {
    #[serde(rename = "windowMinutes")]
    pub window_minutes: u64,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<u64>, // unix 초
}

#[derive(Serialize, Clone)]
pub struct CodexUsage {
    pub windows: Vec<CodexWindow>, // primary(짧은 윈도우) → secondary(주간) 순
    pub plan: Option<String>,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64, // 데이터 신선도 판단용 (API 조회 시각 또는 rollout 파일 mtime)
    // 이번 조회에서 사용량 API 가 실패했으면 "unavailable" — 표시값은 마지막으로 구한 값이다
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

// (조회 시각, 결과) — 실패(None)도 캐시해 API 가 죽었을 때 폴링마다 재시도하지 않는다
static API_CACHE: Mutex<Option<(u64, Result<CodexUsage, ApiFail>)>> = Mutex::new(None);

/// 사용량 API 를 못 쓴 이유 — 토큰이 아예 없으면(API 키 로그인 등) 실패로 보지 않는다
#[derive(Clone, Copy, PartialEq, Debug)]
enum ApiFail {
    NoToken,
    Failed,
}
// 마지막으로 성공한 API 값 — API 가 실패해도 이보다 오래된 로컬 기록으로 되돌아가지 않게 한다
static API_LAST_GOOD: Mutex<Option<CodexUsage>> = Mutex::new(None);

/// 하위 디렉토리를 이름 내림차순으로 반환 (년/월/일 디렉토리는 숫자 이름이라 사전순 = 시간순)
fn subdirs_desc(dir: &PathBuf) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .map(|es| {
            es.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.reverse();
    v
}

fn recent_rollouts(scan_days: usize) -> Vec<(PathBuf, u64)> {
    let Some(home) = crate::claude::home_dir() else {
        return Vec::new();
    };
    let root = home.join(".codex").join("sessions");
    let mut day_dirs = Vec::new();
    'outer: for y in subdirs_desc(&root) {
        for m in subdirs_desc(&y) {
            for d in subdirs_desc(&m) {
                day_dirs.push(d);
                if day_dirs.len() >= scan_days {
                    break 'outer;
                }
            }
        }
    }
    let mut files = Vec::new();
    for dir in day_dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(ms) = e
                .metadata()
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|mt| mt.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
            else {
                continue;
            };
            files.push((p, ms));
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
}

/// 최근 기록 중 rate_limits 가 담긴 가장 최신 rollout 의 (rate_limits, 파일 mtime)
fn latest_rate_limits() -> Option<(serde_json::Value, u64)> {
    recent_rollouts(USAGE_SCAN_DAYS)
        .into_iter()
        .take(USAGE_FILE_CAP)
        .find_map(|(p, mtime_ms)| tail_rate_limits(&p).map(|rl| (rl, mtime_ms)))
}

/// 코덱스 CLI 설치 여부 — 홈의 설정 디렉토리 존재로 판단한다 (GUI 실행 시 PATH 를 믿을 수 없다)
pub fn is_installed() -> bool {
    crate::claude::home_dir().is_some_and(|h| h.join(".codex").is_dir())
}

/// now_secs 는 리셋 판정용 현재 시각(unix 초).
fn window_of(v: &serde_json::Value, now_secs: u64) -> Option<CodexWindow> {
    let window_minutes = v.get("window_minutes")?.as_u64()?;
    let used_percent = v.get("used_percent")?.as_f64()?;
    let resets_at = v.get("resets_at").and_then(|x| x.as_u64());
    // 리셋 시각이 지났으면 한도가 회복된 상태 — 오래된 기록을 그대로 쓰지 않고 0% 로 본다
    let reset = resets_at.is_some_and(|t| t <= now_secs);
    Some(CodexWindow {
        window_minutes,
        used_percent: if reset { 0.0 } else { used_percent },
        resets_at: if reset { None } else { resets_at },
    })
}

/// 파일 꼬리에서 마지막 rate_limits 레코드를 파싱
fn tail_rate_limits(path: &PathBuf) -> Option<serde_json::Value> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_CAP);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?; // UTF-8 경계에서 잘리면 실패 → 다음 폴링에서 재시도
    for line in buf.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(rl) = v.get("payload").and_then(|p| p.get("rate_limits")) {
            return Some(rl.clone());
        }
    }
    None
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 코덱스 사용량 (없으면 None). async 커맨드 → 파일 탐색·네트워크가 UI 를 막지 않는다.
/// API 값·마지막 API 성공값·로컬 기록 중 가장 최근 것을 쓴다
/// (코덱스 실행 중엔 로컬이 API 캐시보다 앞선다). API 가 실패했으면 error 를 달아 보낸다.
#[tauri::command]
pub async fn codex_usage() -> Option<CodexUsage> {
    let api = api_usage_cached().await;
    let local = tauri::async_runtime::spawn_blocking(local_usage).await.ok().flatten();
    let last_good = {
        let mut g = plock(&API_LAST_GOOD);
        if let Ok(a) = &api {
            *g = Some(a.clone());
        }
        g.clone()
    };
    let api_failed = matches!(api, Err(ApiFail::Failed));
    let now = now_ms();
    let mut best = pick_freshest([api.ok().or(last_good), local])?;
    expire_passed_resets(&mut best.windows, now / 1000);
    // API 가 실패했어도 방금 기록된 로컬 값(코덱스 실행 중)이 있으면 최신이므로 경고하지 않는다
    if api_failed && now.saturating_sub(best.mtime_ms) > API_CACHE_MS {
        best.error = Some("unavailable");
    }
    Some(best)
}

/// 리셋 시각이 지난 윈도우는 한도가 회복된 상태 — 마지막 값을 유지할 때도 옛 사용률을 그대로 쓰지 않는다
fn expire_passed_resets(windows: &mut [CodexWindow], now_secs: u64) {
    for w in windows {
        if w.resets_at.is_some_and(|t| t <= now_secs) {
            w.used_percent = 0.0;
            w.resets_at = None;
        }
    }
}

/// 후보 중 mtime 이 가장 최근인 값
fn pick_freshest<const N: usize>(cands: [Option<CodexUsage>; N]) -> Option<CodexUsage> {
    cands.into_iter().flatten().max_by_key(|u| u.mtime_ms)
}

/// API_CACHE_MS 동안은 직전 결과를 재사용한다
async fn api_usage_cached() -> Result<CodexUsage, ApiFail> {
    let now = now_ms();
    {
        let mut g = plock(&API_CACHE);
        if let Some((at, u)) = g.as_mut() {
            if now.saturating_sub(*at) < API_CACHE_MS {
                return u.clone();
            }
            // 조회 중에 들어온 다른 폴링이 중복 호출하지 않도록 캐시 시각을 먼저 당겨 둔다
            *at = now;
        } else {
            *g = Some((now, Err(ApiFail::Failed)));
        }
    }
    let usage = tauri::async_runtime::spawn_blocking(api_usage)
        .await
        .unwrap_or(Err(ApiFail::Failed));
    *plock(&API_CACHE) = Some((now_ms(), usage.clone()));
    usage
}

/// (액세스 토큰, 계정 ID) — ChatGPT 로그인(auth_mode=chatgpt)일 때만 있다. API 키 로그인은 한도 개념이 없다.
fn oauth() -> Option<(String, Option<String>)> {
    let path = crate::claude::home_dir()?.join(".codex").join("auth.json");
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let t = v.get("tokens")?;
    let token = t.get("access_token")?.as_str()?.to_string();
    let account = t.get("account_id").and_then(|x| x.as_str()).map(str::to_string);
    Some((token, account))
}

/// 사용량 API 1회 조회 (블로킹). 토큰 만료·네트워크·응답 오류는 전부 None → 로컬 기록으로 대체된다.
fn api_usage() -> Result<CodexUsage, ApiFail> {
    let (token, account) = oauth().ok_or(ApiFail::NoToken)?;
    api_request(&token, account.as_deref()).ok_or(ApiFail::Failed)
}

fn api_request(token: &str, account: Option<&str>) -> Option<CodexUsage> {
    let mut req = ureq::get("https://chatgpt.com/backend-api/wham/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "codex_cli_rs")
        .timeout(std::time::Duration::from_secs(API_TIMEOUT_SECS));
    if let Some(a) = account {
        req = req.set("ChatGPT-Account-Id", a);
    }
    let body = req.call().ok()?.into_string().ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    parse_api_usage(&v, now_ms())
}

/// 응답 → 표시용 사용량. 형태:
/// {"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":97,"limit_window_seconds":18000,
///  "reset_after_seconds":1200,"reset_at":1790000000},"secondary_window":{...}}}
fn parse_api_usage(v: &serde_json::Value, now_ms: u64) -> Option<CodexUsage> {
    let rl = v.get("rate_limit")?;
    let now_secs = now_ms / 1000;
    let window = |w: Option<&serde_json::Value>| -> Option<CodexWindow> {
        let w = w?;
        let used_percent = w.get("used_percent")?.as_f64()?;
        let window_minutes = w.get("limit_window_seconds")?.as_u64()? / 60;
        let resets_at = w.get("reset_at").and_then(|x| x.as_u64()).or_else(|| {
            w.get("reset_after_seconds")
                .and_then(|x| x.as_u64())
                .map(|s| now_secs + s)
        });
        Some(CodexWindow { window_minutes, used_percent, resets_at })
    };
    let windows: Vec<CodexWindow> = [rl.get("primary_window"), rl.get("secondary_window")]
        .into_iter()
        .filter_map(window)
        .collect();
    if windows.is_empty() {
        return None;
    }
    Some(CodexUsage {
        windows,
        plan: v.get("plan_type").and_then(|x| x.as_str()).map(str::to_string),
        mtime_ms: now_ms,
        error: None,
    })
}

/// 로컬 rollout 기록 기준 사용량
fn local_usage() -> Option<CodexUsage> {
    let (rl, mtime_ms) = latest_rate_limits()?;
    let now_secs = now_ms() / 1000;
    let mut windows = Vec::new();
    if let Some(w) = rl.get("primary").and_then(|v| window_of(v, now_secs)) {
        windows.push(w);
    }
    if let Some(w) = rl.get("secondary").and_then(|v| window_of(v, now_secs)) {
        windows.push(w);
    }
    if windows.is_empty() {
        return None;
    }
    Some(CodexUsage {
        windows,
        plan: rl
            .get("plan_type")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        mtime_ms,
        error: None,
    })
}

fn same_cwd(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn safe_session_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains('\\') && !id.contains("..")
}

/// 서브에이전트 스레드가 남긴 rollout 인지 판별.
/// 이런 파일은 `codex resume <id>` 로 되살릴 수 없고(부모를 먼저 띄워야 한다),
/// payload.id 가 부모의 session_id 와 달라 세션 목록에 노출되면 재개가 실패한다.
fn is_subagent_meta(p: &serde_json::Value) -> bool {
    p.get("thread_source").and_then(|x| x.as_str()) == Some("subagent")
        || p.get("source")
            .and_then(|s| s.get("subagent"))
            .is_some_and(|s| !s.is_null())
}

/// rollout 파일의 session_meta 에서 (세션 id, cwd) 를 읽는다.
/// 서브에이전트 rollout 은 재개 불가라 None 을 돌려 목록에서 제외한다.
fn codex_meta(path: &Path) -> Option<(String, String)> {
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f.take(SESSION_SCAN_CAP));
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            continue;
        }
        let p = v.get("payload")?;
        if is_subagent_meta(p) {
            return None;
        }
        let id = p
            .get("id")
            .or_else(|| p.get("session_id"))
            .and_then(|x| x.as_str())?
            .to_string();
        let cwd = p.get("cwd").and_then(|x| x.as_str())?.to_string();
        return Some((id, cwd));
    }
    None
}

fn codex_payload(v: &serde_json::Value) -> &serde_json::Value {
    v.get("payload").filter(|x| x.is_object()).unwrap_or(v)
}

fn codex_content_texts(content: &serde_json::Value, block_type: &str) -> Vec<String> {
    match content {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|x| x.as_str()) == Some(block_type) {
                    b.get("text").and_then(|x| x.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn codex_user_text_with_cap(p: &serde_json::Value, cap: usize) -> Option<String> {
    if p.get("type").and_then(|x| x.as_str()) != Some("message")
        || p.get("role").and_then(|x| x.as_str()) != Some("user")
    {
        return None;
    }
    for text in codex_content_texts(p.get("content")?, "input_text") {
        let t = text.trim();
        if t.is_empty()
            || t.starts_with('<')
            || t.starts_with("Caveat:")
            || t.starts_with("# AGENTS.md instructions")
        {
            continue;
        }
        return Some(t.chars().take(cap).collect());
    }
    None
}

fn codex_user_text(p: &serde_json::Value) -> Option<String> {
    codex_user_text_with_cap(p, PREVIEW_LEN)
}

fn extract_codex_preview(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f.take(SESSION_SCAN_CAP));
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(t) = codex_user_text(codex_payload(&v)) {
            return Some(t);
        }
    }
    None
}

/// cwd 에 해당하는 Codex 세션 목록 (최근 활동 순).
#[tauri::command]
pub async fn list_codex_sessions(cwd: String) -> Vec<CodexSession> {
    let mut out = Vec::new();
    for (path, mtime_ms) in recent_rollouts(SESSION_SCAN_DAYS) {
        let Some((id, file_cwd)) = codex_meta(&path) else {
            continue;
        };
        if !same_cwd(&file_cwd, &cwd) {
            continue;
        }
        let preview = extract_codex_preview(&path).unwrap_or_else(|| "대화 내용 없음".to_string());
        out.push(CodexSession {
            id,
            mtime_ms,
            preview,
        });
        if out.len() >= SESSION_LIST_CAP {
            break;
        }
    }
    out
}

fn codex_session_path(cwd: &str, id: &str) -> Option<PathBuf> {
    if !safe_session_id(id) {
        return None;
    }
    for (path, _) in recent_rollouts(SESSION_SCAN_DAYS) {
        let Some((file_id, file_cwd)) = codex_meta(&path) else {
            continue;
        };
        if file_id == id && same_cwd(&file_cwd, cwd) {
            return Some(path);
        }
    }
    None
}

fn codex_args_hint(v: &serde_json::Value) -> String {
    let Some(args) = v.get("arguments") else {
        return String::new();
    };
    let parsed = if let Some(s) = args.as_str() {
        serde_json::from_str::<serde_json::Value>(s)
            .unwrap_or_else(|_| serde_json::Value::String(s.to_string()))
    } else {
        args.clone()
    };
    crate::claude::tool_hint(&parsed)
}

fn codex_line_msgs(v: &serde_json::Value, out: &mut Vec<crate::claude::ChatMsg>) {
    let p = codex_payload(v);
    match p.get("type").and_then(|x| x.as_str()) {
        Some("message") => match p.get("role").and_then(|x| x.as_str()) {
            Some("user") => {
                if let Some(text) = codex_user_text_with_cap(p, crate::claude::CHAT_MSG_CAP) {
                    out.push(crate::claude::ChatMsg {
                        role: "user".into(),
                        kind: "text".into(),
                        text,
                    });
                }
            }
            Some("assistant") => {
                let Some(content) = p.get("content") else {
                    return;
                };
                for text in codex_content_texts(content, "output_text") {
                    let t = text.trim();
                    if !t.is_empty() {
                        out.push(crate::claude::ChatMsg {
                            role: "assistant".into(),
                            kind: "text".into(),
                            text: t.chars().take(crate::claude::CHAT_MSG_CAP).collect(),
                        });
                    }
                }
            }
            _ => {}
        },
        Some("function_call") | Some("tool_search_call") => {
            let name = p
                .get("name")
                .or_else(|| p.get("namespace"))
                .and_then(|x| x.as_str())
                .unwrap_or("도구");
            let hint = codex_args_hint(p);
            let text = if hint.is_empty() {
                name.to_string()
            } else {
                format!("{}: {}", name, hint)
            };
            out.push(crate::claude::ChatMsg {
                role: "assistant".into(),
                kind: "tool".into(),
                text,
            });
        }
        _ => {}
    }
}

/// 세션 열람 팝업용: Codex rollout jsonl 의 꼬리를 파싱해 대화 메시지 목록으로 반환.
#[tauri::command]
pub async fn codex_session_messages(cwd: String, id: String) -> Vec<crate::claude::ChatMsg> {
    let Some(path) = codex_session_path(&cwd, &id) else {
        return Vec::new();
    };
    let Ok(mut f) = fs::File::open(&path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(SESSION_VIEW_TAIL_CAP);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let begin = if start > 0 {
        buf.iter()
            .position(|&b| b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buf.len())
    } else {
        0
    };
    let mut out = Vec::new();
    for line in buf[begin..].split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
            codex_line_msgs(&v, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn expired_window_counts_as_reset() {
        let v = json!({"used_percent": 82.0, "window_minutes": 300, "resets_at": 1_000_u64});
        // 리셋 시각이 지난 기록은 한도가 회복된 상태로 본다
        let w = window_of(&v, 2_000).unwrap();
        assert_eq!((w.used_percent, w.resets_at), (0.0, None));
        // 아직 리셋 전이면 기록값 그대로
        let w = window_of(&v, 500).unwrap();
        assert_eq!((w.used_percent, w.resets_at), (82.0, Some(1_000)));
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn passed_reset_clears_kept_value() {
        let mut ws = vec![
            CodexWindow { window_minutes: 300, used_percent: 97.0, resets_at: Some(100) },
            CodexWindow { window_minutes: 10080, used_percent: 40.0, resets_at: Some(900) },
        ];
        expire_passed_resets(&mut ws, 500);
        assert_eq!((ws[0].used_percent, ws[0].resets_at), (0.0, None));
        assert_eq!((ws[1].used_percent, ws[1].resets_at), (40.0, Some(900)));
    }

    #[test]
    fn freshest_value_wins() {
        let u = |mtime_ms| CodexUsage { windows: Vec::new(), plan: None, mtime_ms, error: None };
        // API 가 실패해도 마지막 API 값(2000)이 오래된 로컬 기록(1000)보다 우선한다
        assert_eq!(pick_freshest([Some(u(2_000)), Some(u(1_000))]).unwrap().mtime_ms, 2_000);
        // 코덱스 실행 중이라 로컬이 더 최신이면 로컬을 쓴다
        assert_eq!(pick_freshest([Some(u(2_000)), Some(u(3_000))]).unwrap().mtime_ms, 3_000);
        assert!(pick_freshest::<2>([None, None]).is_none());
    }

    #[test]
    fn parses_usage_api_response() {
        let v = json!({"plan_type": "plus", "rate_limit": {
            "primary_window": {"used_percent": 97, "limit_window_seconds": 18000, "reset_at": 5_000_u64},
            "secondary_window": {"used_percent": 40.5, "limit_window_seconds": 604800, "reset_after_seconds": 100}
        }});
        let u = parse_api_usage(&v, 1_000_000).unwrap();
        assert_eq!(u.plan.as_deref(), Some("plus"));
        assert_eq!(u.mtime_ms, 1_000_000);
        let w: Vec<_> = u.windows.iter().map(|w| (w.window_minutes, w.used_percent, w.resets_at)).collect();
        // reset_at 이 없으면 reset_after_seconds 로 환산한다
        assert_eq!(w, vec![(300, 97.0, Some(5_000)), (10080, 40.5, Some(1_100))]);
        // 한도 정보가 없는 응답(API 키 계정 등)은 표시 대상이 아니다
        assert!(parse_api_usage(&json!({"plan_type": "plus", "rate_limit": null}), 0).is_none());
    }

    #[test]
    fn codex_preview_skips_agent_instructions() {
        let v = json!({
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": "# AGENTS.md instructions\n..." },
                { "type": "input_text", "text": "실제 요청" }
            ]
        });
        assert_eq!(codex_user_text(&v).as_deref(), Some("실제 요청"));
    }

    #[test]
    fn codex_meta_rejects_subagent_rollout() {
        // 서브에이전트 rollout — payload.id 가 부모와 달라 resume 이 실패한다
        let sub = json!({
            "session_id": "parent-id",
            "id": "child-id",
            "parent_thread_id": "parent-id",
            "thread_source": "subagent",
            "source": { "subagent": { "thread_spawn": { "depth": 1 } } },
            "cwd": "D:/proj"
        });
        assert!(is_subagent_meta(&sub));

        // 포크된 일반 세션 — 재개 가능하므로 걸러내면 안 된다
        let forked = json!({
            "session_id": "own-id",
            "id": "own-id",
            "forked_from_id": "other-id",
            "thread_source": "user",
            "cwd": "D:/proj"
        });
        assert!(!is_subagent_meta(&forked));

        // thread_source 가 없는 구버전 rollout
        assert!(!is_subagent_meta(&json!({ "id": "own-id", "cwd": "D:/proj" })));
    }

    #[test]
    fn codex_messages_parse_assistant_and_tool_call() {
        let mut out = Vec::new();
        codex_line_msgs(
            &json!({
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "답변" }]
                }
            }),
            &mut out,
        );
        codex_line_msgs(
            &json!({
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"npm test\"}"
                }
            }),
            &mut out,
        );
        assert_eq!(
            (out[0].role.as_str(), out[0].text.as_str()),
            ("assistant", "답변")
        );
        assert_eq!(
            (out[1].kind.as_str(), out[1].text.as_str()),
            ("tool", "exec_command: npm test")
        );
    }
}
