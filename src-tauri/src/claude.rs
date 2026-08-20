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
fn munge_path(p: &str) -> String {
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
