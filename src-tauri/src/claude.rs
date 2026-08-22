// Claude Code 세션 열람 — Claude Code 가 ~/.claude/projects/<경로 변환>/ 에 저장하는
// 세션 기록(jsonl)을 읽기 전용으로 나열한다. 재개는 앱이 파일을 건드리지 않고
// 터미널에서 `claude --resume <id>` 를 실행하는 방식이라 Claude Code 저장소와 충돌하지 않는다.
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SESSIONS: usize = 30; // 목록 상한 — IPC·미리보기 파싱 비용 제한
// 미리보기 탐색 상한. 첫 사용자 프롬프트는 보통 파일 앞쪽에 있지만,
// 훅/시스템 컨텍스트가 앞을 채운 세션이 있어 여유를 둔다. 수십 MB 파일 전체는 읽지 않는다.
const SCAN_CAP: u64 = 2 * 1024 * 1024;
const PREVIEW_LEN: usize = 200;

#[derive(Serialize)]
pub struct ClaudeSession {
    pub id: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: u64,
    pub preview: String,
}

/// Claude Code 의 프로젝트 디렉토리명 규칙: 절대 경로에서 영숫자 외 문자를 전부 '-' 로 치환
/// (예: /Users/a/.b → -Users-a--b, C:\dev → C--dev)
pub(crate) fn munge_path(p: &str) -> String {
    p.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok().map(PathBuf::from)
}

/// 한 레코드에서 사용자 프롬프트 텍스트 추출.
/// 훅·사이드체인(서브에이전트)·메타 레코드와 <command-name> 류 래퍼 텍스트는 제외한다.
fn user_text(v: &serde_json::Value) -> Option<String> {
    if v.get("type").and_then(|x| x.as_str()) != Some("user") {
        return None;
    }
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
        || v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        // 배열 형태(텍스트+이미지 블록)면 첫 텍스트 블록 사용
        serde_json::Value::Array(arr) => arr.iter().find_map(|b| {
            if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                b.get("text").and_then(|x| x.as_str()).map(str::to_string)
            } else {
                None
            }
        })?,
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.chars().take(PREVIEW_LEN).collect())
}

/// 세션 파일 미리보기: 첫 사용자 프롬프트 우선, 없으면 이어진 세션의 summary 레코드로 폴백.
/// 둘 다 없으면 None — 실제 대화가 없는 세션(빈 실행)은 목록에서 제외된다.
fn extract_preview(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f.take(SCAN_CAP));
    let mut line = String::new();
    let mut summary: Option<String> = None;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break, // EOF 또는 비 UTF-8 — 탐색 종료
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(t) = user_text(&v) {
            return Some(t);
        }
        if summary.is_none() && v.get("type").and_then(|x| x.as_str()) == Some("summary") {
            summary = v.get("summary").and_then(|x| x.as_str()).map(|s| s.chars().take(PREVIEW_LEN).collect());
        }
    }
    summary
}

/// cwd 에 해당하는 Claude Code 세션 목록 (최근 활동 순).
/// async 커맨드 → 워커 스레드에서 실행되므로 파일 파싱이 UI 를 막지 않는다.
#[tauri::command]
pub async fn list_claude_sessions(cwd: String) -> Vec<ClaudeSession> {
    let Some(home) = home_dir() else { return Vec::new() };
    let dir = home.join(".claude").join("projects").join(munge_path(&cwd));
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };

    // (mtime, id, path) 수집 후 최신순 정렬 — 미리보기 파싱은 상위 MAX_SESSIONS 개만
    let mut files: Vec<(u64, String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let id = p.file_stem()?.to_str()?.to_string();
            // 서브에이전트 기록(agent-*.jsonl)은 resume 대상이 아님
            if id.starts_with("agent-") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?
                .duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((mtime, id, p))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out = Vec::new();
    for (mtime_ms, id, path) in files {
        if out.len() >= MAX_SESSIONS {
            break;
        }
        if let Some(preview) = extract_preview(&path) {
            out.push(ClaudeSession { id, mtime_ms, preview });
        }
    }
    out
}

// ── 세션 열람 팝업: 세션 jsonl → 대화 메시지 파서 ──
pub(crate) const CHAT_MSG_CAP: usize = 4000; // 말풍선 1개 텍스트 상한
pub(crate) const TOOL_HINT_CAP: usize = 100;
const VIEW_TAIL_CAP: u64 = 512 * 1024; // 열람 시 파일 끝에서 읽는 최대 범위 (대형 세션 방어)

#[derive(Serialize)]
pub struct ChatMsg {
    pub role: String, // "user" | "assistant"
    pub kind: String, // "text" | "tool"
    pub text: String,
}

/// 세션 열람 팝업용: 저장된 세션 jsonl 의 꼬리를 파싱해 대화 메시지 목록으로 반환.
/// 읽기 전용 — Claude Code 저장소를 건드리지 않는다.
#[tauri::command]
pub async fn claude_session_messages(cwd: String, id: String) -> Vec<ChatMsg> {
    // id 는 우리가 나열한 파일 스템이지만, 경로 탈출 문자는 방어적으로 거부
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Vec::new();
    }
    let Some(home) = home_dir() else { return Vec::new() };
    let path = home
        .join(".claude").join("projects").join(munge_path(&cwd))
        .join(format!("{}.jsonl", id));
    let Ok(mut f) = fs::File::open(&path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(VIEW_TAIL_CAP);
    use std::io::{Seek, SeekFrom};
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    // 중간에서 시작했다면 첫 부분 줄(잘린 레코드)은 버린다
    let begin = if start > 0 {
        buf.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(buf.len())
    } else {
        0
    };
    let mut out = Vec::new();
    for line in buf[begin..].split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
            line_msgs(&v, &mut out);
        }
    }
    out
}

/// tool_use 입력에서 사람이 알아볼 대표값 하나 (파일 경로·명령 등)
pub(crate) fn tool_hint(input: &serde_json::Value) -> String {
    for k in ["file_path", "command", "cmd", "pattern", "url", "path", "query", "description", "prompt"] {
        if let Some(s) = input.get(k).and_then(|x| x.as_str()) {
            return s.trim().replace('\n', " ").chars().take(TOOL_HINT_CAP).collect();
        }
    }
    String::new()
}

/// jsonl 레코드 1개 → 채팅 메시지들. 훅/메타/사이드체인/래퍼 텍스트는 잡음이라 제외
pub(crate) fn line_msgs(v: &serde_json::Value, out: &mut Vec<ChatMsg>) {
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
        || v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
    {
        return;
    }
    match v.get("type").and_then(|x| x.as_str()) {
        Some("user") => {
            let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return };
            let text = match content {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|b| {
                        if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                            b.get("text").and_then(|x| x.as_str()).map(str::to_string)
                        } else {
                            None // tool_result·이미지 블록은 채팅에 표시하지 않음
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => return,
            };
            let t = text.trim();
            if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
                return;
            }
            out.push(ChatMsg { role: "user".into(), kind: "text".into(), text: t.chars().take(CHAT_MSG_CAP).collect() });
        }
        Some("assistant") => {
            let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { return };
            for b in arr {
                match b.get("type").and_then(|x| x.as_str()) {
                    Some("text") => {
                        let t = b.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                        if !t.is_empty() {
                            out.push(ChatMsg { role: "assistant".into(), kind: "text".into(), text: t.chars().take(CHAT_MSG_CAP).collect() });
                        }
                    }
                    Some("tool_use") => {
                        let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("도구");
                        let hint = b.get("input").map(tool_hint).unwrap_or_default();
                        let text = if hint.is_empty() { name.to_string() } else { format!("{}: {}", name, hint) };
                        out.push(ChatMsg { role: "assistant".into(), kind: "tool".into(), text });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn msgs_of(line: &str) -> Vec<ChatMsg> {
        let mut out = Vec::new();
        line_msgs(&serde_json::from_str(line).unwrap(), &mut out);
        out
    }

    #[test]
    fn chat_parses_user_and_assistant() {
        let u = msgs_of(r#"{"type":"user","message":{"content":"테스트 프롬프트"}}"#);
        assert_eq!((u[0].role.as_str(), u[0].text.as_str()), ("user", "테스트 프롬프트"));
        let a = msgs_of(
            r#"{"type":"assistant","message":{"content":[
                {"type":"text","text":"답변"},
                {"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}]}}"#,
        );
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].kind.as_str(), a[0].text.as_str()), ("text", "답변"));
        assert_eq!((a[1].kind.as_str(), a[1].text.as_str()), ("tool", "Read: src/a.ts"));
    }

    #[test]
    fn chat_skips_noise() {
        // 메타·사이드체인·래퍼 텍스트·tool_result 는 채팅에 나오면 안 된다
        assert!(msgs_of(r#"{"type":"user","isMeta":true,"message":{"content":"x"}}"#).is_empty());
        assert!(msgs_of(r#"{"type":"user","isSidechain":true,"message":{"content":"x"}}"#).is_empty());
        assert!(msgs_of(r#"{"type":"user","message":{"content":"<system-reminder>x</system-reminder>"}}"#).is_empty());
        assert!(msgs_of(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"y"}]}}"#).is_empty());
        assert!(msgs_of(r#"{"type":"summary","summary":"s"}"#).is_empty());
    }
}
