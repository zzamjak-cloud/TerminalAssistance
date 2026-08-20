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
        .map(|es| es.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    v.sort();
    v.reverse();
    v
}

/// 최근 SCAN_DAYS 개 날짜 디렉토리에서 mtime 이 가장 최신인 rollout 파일
fn latest_rollout() -> Option<(PathBuf, u64)> {
    let root = crate::claude::home_dir()?.join(".codex").join("sessions");
    let mut day_dirs = Vec::new();
    'outer: for y in subdirs_desc(&root) {
        for m in subdirs_desc(&y) {
            for d in subdirs_desc(&m) {
                day_dirs.push(d);
                if day_dirs.len() >= SCAN_DAYS {
                    break 'outer;
                }
            }
        }
    }
    let mut best: Option<(PathBuf, u64)> = None;
    for dir in day_dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(ms) = e
                .metadata().ok()
                .and_then(|md| md.modified().ok())
                .and_then(|mt| mt.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
            else { continue };
            if best.as_ref().map(|(_, b)| ms > *b).unwrap_or(true) {
                best = Some((p, ms));
            }
        }
    }
    best
}

// ── 채팅 뷰: cwd 매칭 rollout 탐색 + 레코드 파서 ──

// cwd 판별을 위해 첫 줄(session_meta)을 여는 파일 수 상한 — 최신 mtime 순이라 앞에서 걸린다
const CWD_SCAN_CAP: usize = 40;

/// rollout 첫 줄(session_meta)의 작업 디렉토리
fn rollout_cwd(path: &Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(f.take(64 * 1024)).read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(&line).ok()?;
    v.get("payload")?.get("cwd")?.as_str().map(str::to_string)
}

/// cwd 가 일치하는 최근 rollout (경로, mtime ms) — 채팅 뷰의 Codex 후보
pub(crate) fn latest_rollout_for_cwd(cwd: &str) -> Option<(PathBuf, u64)> {
    let root = crate::claude::home_dir()?.join(".codex").join("sessions");
    let mut day_dirs = Vec::new();
    'outer: for y in subdirs_desc(&root) {
        for m in subdirs_desc(&y) {
            for d in subdirs_desc(&m) {
                day_dirs.push(d);
                if day_dirs.len() >= SCAN_DAYS {
                    break 'outer;
                }
            }
        }
    }
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for dir in day_dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(ms) = e
                .metadata().ok()
                .and_then(|md| md.modified().ok())
                .and_then(|mt| mt.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
            {
                files.push((ms, p));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(CWD_SCAN_CAP)
        .find(|(_, p)| rollout_cwd(p).as_deref() == Some(cwd))
        .map(|(ms, p)| (p, ms))
}

/// rollout 레코드 1개 → 채팅 메시지.
/// developer(주입 지침)·reasoning·AGENTS.md 류 래퍼 user 텍스트는 잡음이라 제외
pub(crate) fn rollout_line_msgs(v: &serde_json::Value, out: &mut Vec<crate::claude::ChatMsg>) {
    use crate::claude::{ChatMsg, CHAT_MSG_CAP, TOOL_HINT_CAP};
    if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
        return;
    }
    let Some(p) = v.get("payload") else { return };
    match p.get("type").and_then(|x| x.as_str()) {
        Some("message") => {
            let role = match p.get("role").and_then(|x| x.as_str()) {
                Some(r @ ("user" | "assistant")) => r,
                _ => return, // developer = 시스템 주입
            };
            let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { return };
            let text = arr
                .iter()
                .filter_map(|b| match b.get("type").and_then(|x| x.as_str()) {
                    Some("input_text") | Some("output_text") => b.get("text").and_then(|x| x.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let t = text.trim();
            if t.is_empty() || t.starts_with('<') || t.starts_with("# AGENTS.md") {
                return;
            }
            out.push(ChatMsg { role: role.into(), kind: "text".into(), text: t.chars().take(CHAT_MSG_CAP).collect() });
        }
        Some("function_call") => {
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("도구");
            // arguments 는 JSON 문자열 — 대표 필드 추출 시도, 실패하면 원문 축약
            let hint = p
                .get("arguments")
                .and_then(|x| x.as_str())
                .map(|a| {
                    serde_json::from_str::<serde_json::Value>(a)
                        .ok()
                        .map(|av| crate::claude::tool_hint(&av))
                        .filter(|h| !h.is_empty())
                        .unwrap_or_else(|| a.trim().replace('\n', " ").chars().take(TOOL_HINT_CAP).collect())
                })
                .unwrap_or_default();
            let text = if hint.is_empty() { name.to_string() } else { format!("{}: {}", name, hint) };
            out.push(ChatMsg { role: "assistant".into(), kind: "tool".into(), text });
        }
        _ => {}
    }
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
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if let Some(rl) = v.get("payload").and_then(|p| p.get("rate_limits")) {
            return Some(rl.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs_of(line: &str) -> Vec<crate::claude::ChatMsg> {
        let mut out = Vec::new();
        rollout_line_msgs(&serde_json::from_str(line).unwrap(), &mut out);
        out
    }

    #[test]
    fn rollout_parses_messages_and_tools() {
        let u = msgs_of(r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"질문"}]}}"#);
        assert_eq!((u[0].role.as_str(), u[0].text.as_str()), ("user", "질문"));
        let a = msgs_of(r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"답"}]}}"#);
        assert_eq!((a[0].role.as_str(), a[0].text.as_str()), ("assistant", "답"));
        let f = msgs_of(r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls\"]}"}}"#);
        assert_eq!(f[0].kind.as_str(), "tool");
        assert!(f[0].text.starts_with("shell:"));
    }

    #[test]
    fn rollout_skips_noise() {
        // developer 주입·AGENTS.md 래퍼·reasoning·이벤트 레코드는 채팅에 나오면 안 된다
        assert!(msgs_of(r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"주입 지침"}]}}"#).is_empty());
        assert!(msgs_of(r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}"##).is_empty());
        assert!(msgs_of(r#"{"type":"response_item","payload":{"type":"reasoning"}}"#).is_empty());
        assert!(msgs_of(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#).is_empty());
    }
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
        plan: rl.get("plan_type").and_then(|x| x.as_str()).map(str::to_string),
        mtime_ms,
    })
}
