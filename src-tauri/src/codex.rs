// 코덱스(Codex CLI) 사용량 조회 — ~/.codex/sessions/<년>/<월>/<일>/rollout-*.jsonl 의
// 마지막 token_count 이벤트에 담긴 rate_limits(사용률·윈도우·리셋 시각)를 읽는다.
// 코덱스가 세션 중 주기적으로 기록하므로, 최신 파일의 꼬리만 읽으면 현재 사용량이 나온다.
// 읽기 전용 — 코덱스 저장소를 건드리지 않는다.
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

// rate_limits 는 token_count 마다 기록되므로 파일 꼬리에서 금방 나온다
const TAIL_CAP: u64 = 128 * 1024;
// 날짜 디렉토리 스캔 범위 — 자정을 넘긴 장기 세션도 시작일 파일에 계속 기록되므로 여유를 둔다
const SCAN_DAYS: usize = 3;
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

#[derive(Serialize)]
pub struct CodexWindow {
    #[serde(rename = "windowMinutes")]
    pub window_minutes: u64,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<u64>, // unix 초
}

#[derive(Serialize)]
pub struct CodexUsage {
    pub windows: Vec<CodexWindow>, // primary(짧은 윈도우) → secondary(주간) 순
    pub plan: Option<String>,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64, // 데이터 신선도 판단용 (파일 mtime)
}

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

/// 최근 SCAN_DAYS 개 날짜 디렉토리에서 mtime 이 가장 최신인 rollout 파일
fn latest_rollout() -> Option<(PathBuf, u64)> {
    recent_rollouts(SCAN_DAYS).into_iter().next()
}

fn window_of(v: &serde_json::Value) -> Option<CodexWindow> {
    Some(CodexWindow {
        window_minutes: v.get("window_minutes")?.as_u64()?,
        used_percent: v.get("used_percent")?.as_f64()?,
        resets_at: v.get("resets_at").and_then(|x| x.as_u64()),
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

/// 코덱스 사용량 (없으면 None). async 커맨드 → 파일 탐색이 UI 를 막지 않는다.
#[tauri::command]
pub async fn codex_usage() -> Option<CodexUsage> {
    let (path, mtime_ms) = latest_rollout()?;
    let rl = tail_rate_limits(&path)?;
    let mut windows = Vec::new();
    if let Some(w) = rl.get("primary").and_then(window_of) {
        windows.push(w);
    }
    if let Some(w) = rl.get("secondary").and_then(window_of) {
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
    use super::*;
    use serde_json::json;

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
