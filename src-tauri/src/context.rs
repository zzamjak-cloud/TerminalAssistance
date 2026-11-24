// 세션 컨텍스트 사용량 조회 — 에이전트가 응답을 마친 시점에 프런트가 경고 배너 여부를 판단하는 근거.
// 읽기 전용이다: 앱은 알리기만 하고 /clear·/new 같은 입력을 PTY 로 보내지 않는다.
use crate::pty::PtyManager;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::State;

#[derive(Serialize, Debug, PartialEq)]
pub struct ContextUsage {
    pub agent: &'static str, // "claude" | "codex"
    pub tokens: u64,
    pub window: Option<u64>,
    #[serde(rename = "convId")]
    pub conv_id: String,
}

const TAIL_START: u64 = 256 * 1024;
const TAIL_MAX: u64 = 4 * 1024 * 1024;

/// 파일 꼬리 n 바이트의 줄들. 중간에서 잘린 첫 줄은 버린다 (파일 전체를 읽은 경우는 유지)
fn read_tail_lines(path: &Path, n: u64) -> Option<(Vec<String>, bool)> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(n).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next();
    }
    Some((lines.map(str::to_string).collect(), start == 0))
}

/// 꼬리 크기를 4배씩 늘리며 parse 가 값을 찾을 때까지 재시도 (최대 4MB)
fn scan_tail<T>(path: &Path, parse: impl Fn(&[String]) -> Option<T>) -> Option<T> {
    let mut n = TAIL_START;
    loop {
        let (lines, whole) = read_tail_lines(path, n)?;
        if let Some(v) = parse(&lines) {
            return Some(v);
        }
        if whole || n >= TAIL_MAX {
            return None;
        }
        n = (n * 4).min(TAIL_MAX);
    }
}

/// Claude transcript 줄들에서 가장 최근 메인 체인 assistant 응답의 컨텍스트 토큰.
/// 사이드체인(서브에이전트)과 토큰 합이 0인 레코드(API 오류의 <synthetic>)는 건너뛴다
pub fn parse_claude_tokens(lines: &[String]) -> Option<u64> {
    lines.iter().rev().find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        if v["type"].as_str() != Some("assistant") || v["isSidechain"].as_bool() == Some(true) {
            return None;
        }
        let u = &v["message"]["usage"];
        let sum: u64 = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
            .iter()
            .map(|k| u[*k].as_u64().unwrap_or(0))
            .sum();
        (sum > 0).then_some(sum)
    })
}

/// Codex rollout 줄들에서 마지막 token_count 의 (현재 입력 토큰, 컨텍스트 창).
/// cached_input_tokens 는 input_tokens 의 부분집합이라 더하지 않는다
pub fn parse_codex_tokens(lines: &[String]) -> Option<(u64, Option<u64>)> {
    lines.iter().rev().find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        if v["type"].as_str() != Some("event_msg") || v["payload"]["type"].as_str() != Some("token_count") {
            return None;
        }
        let info = &v["payload"]["info"];
        if info.is_null() {
            return None;
        }
        let tokens = info["last_token_usage"]["input_tokens"].as_u64()?;
        Some((tokens, info["model_context_window"].as_u64()))
    })
}

/// ~/.claude/projects/*/<sid>.jsonl — 실행 폴더가 달랐을 수 있어 프로젝트 하위 전체에서 찾는다
fn find_claude_transcript(sid: &str) -> Option<std::path::PathBuf> {
    let root = crate::claude::home_dir()?.join(".claude").join("projects");
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path().join(format!("{}.jsonl", sid)))
        .find(|p| p.is_file())
}

fn claude_usage(t: &crate::resume::ResumeTarget) -> Option<ContextUsage> {
    let sid = crate::hooks::claude_session_of(t.id.clone())?;
    if !crate::resume::is_uuid(&sid) || crate::hooks::state_ts(&t.id)? <= t.created_at_ms {
        return None;
    }
    let path = find_claude_transcript(&sid)?;
    let tokens = scan_tail(&path, parse_claude_tokens)?;
    Some(ContextUsage { agent: "claude", tokens, window: None, conv_id: sid })
}

#[cfg(unix)]
fn codex_usage(t: crate::resume::ResumeTarget) -> Option<ContextUsage> {
    let targets = [t];
    let (_, agent, proc_cwd) = crate::resume::probe_agents(&targets).into_iter().next()?;
    if agent != crate::resume::Agent::Codex {
        return None;
    }
    let cwd = proc_cwd?;
    let created = targets[0].created_at_ms;
    let (path, conv_id) = crate::codex::recent_rollouts(2).into_iter().find_map(|(p, mtime)| {
        if mtime < created {
            return None;
        }
        let (id, c) = crate::codex::codex_meta(&p)?;
        crate::codex::same_cwd(&c, &cwd).then_some((p, id))
    })?;
    let (tokens, window) = scan_tail(&path, parse_codex_tokens).unwrap_or((0, None));
    Some(ContextUsage { agent: "codex", tokens, window, conv_id })
}

#[cfg(not(unix))]
fn codex_usage(_t: crate::resume::ResumeTarget) -> Option<ContextUsage> {
    None
}

#[tauri::command]
pub async fn context_usage(ptys: State<'_, PtyManager>, session_id: String) -> Result<Option<ContextUsage>, String> {
    let Some(t) = ptys.target(&session_id) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || claude_usage(&t).or_else(|| codex_usage(t)))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn claude_picks_latest_main_chain_with_usage() {
        let lines = s(&[
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":300}}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":999999}}}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            r#"{"type":"user","message":{}}"#,
            "not json",
        ]);
        assert_eq!(parse_claude_tokens(&lines), Some(330));
        assert_eq!(parse_claude_tokens(&s(&[r#"{"type":"user"}"#])), None);
    }

    #[test]
    fn codex_uses_last_token_count_and_skips_null_info() {
        let lines = s(&[
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":49119,"cached_input_tokens":47872},"model_context_window":258400}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message"}}"#,
        ]);
        assert_eq!(parse_codex_tokens(&lines), Some((49119, Some(258400))));
        assert_eq!(parse_codex_tokens(&lines[1..]), None);
    }

    #[test]
    fn scan_tail_drops_partial_first_line_and_grows() {
        let dir = std::env::temp_dir().join(format!("ta-ctx-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let mut body = String::from(
            r#"{"type":"assistant","message":{"usage":{"input_tokens":777}}}"#,
        );
        body.push('\n');
        // 꼬리 256KB 안에는 usage 가 없도록 채운다 → 재시도로 앞쪽에서 찾아야 한다
        for _ in 0..4000 {
            body.push_str(r#"{"type":"user","message":{"content":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#);
            body.push('\n');
        }
        fs::write(&p, &body).unwrap();
        assert_eq!(scan_tail(&p, parse_claude_tokens), Some(777));
        let _ = fs::remove_dir_all(&dir);
    }

    // 실제 기록 파일 판독 확인용 (수동): TA_CTX_FILE=<jsonl> cargo test real_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_file() {
        let p = std::path::PathBuf::from(std::env::var("TA_CTX_FILE").expect("TA_CTX_FILE"));
        println!("claude={:?} codex={:?}", scan_tail(&p, parse_claude_tokens), scan_tail(&p, parse_codex_tokens));
    }
}
