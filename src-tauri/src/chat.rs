// 통합 채팅 tail — 활성 세션 경로(cwd)의 Claude(jsonl) / Codex(rollout) 대화 중
// 최근에 활동한(mtime) 쪽을 자동 선택해 증분 tail 한다.
// 파일 토큰: "c:<세션id>" / "x:<rollout 경로>" — 프론트는 불투명 문자열로 취급하며
// 값이 바뀌면 로그를 리셋한다 (도구 전환·새 세션 시작 감지).
use crate::claude::{self, ChatChunk, ChatMsg};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn mtime_ms(p: &Path) -> Option<u64> {
    fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Claude 후보: 훅이 준 sid 우선, 없으면 프로젝트 디렉토리의 최근 세션
fn claude_candidate(cwd: &str, sid: Option<&str>) -> Option<(String, PathBuf, u64)> {
    let home = claude::home_dir()?;
    let dir = home.join(".claude").join("projects").join(claude::munge_path(cwd));
    let id = sid
        .map(str::to_string)
        .or_else(|| claude::latest_session_id(&dir))?;
    let path = dir.join(format!("{}.jsonl", id));
    let m = mtime_ms(&path)?; // sid 파일이 아직 없으면 None → Codex 폴백
    Some((id, path, m))
}

// 신선도 판정 여유 — 세션 생성과 거의 동시에 갱신된 파일을 시계 오차로 놓치지 않게
const FRESH_SLACK_MS: u64 = 5000;

/// 증분 tail. offset 0(파일 전환·재작성 포함)이면 끝 CHAT_TAIL_INIT 범위에서 시작하고
/// 첫 부분 줄은 버린다. 마지막 미완성 줄(도구가 쓰는 중)은 다음 폴링으로 이월.
/// since(세션 생성 시각) 이전에 멈춘 대화는 후보에서 제외 — 새 터미널에서 다른 터미널의
/// 옛 대화가 뜨는 오해를 막는다. 훅 sid 는 이 세션 것임이 확실하므로 예외.
#[tauri::command]
pub async fn chat_tail(cwd: String, sid: Option<String>, file: Option<String>, offset: u64, since: Option<u64>) -> Option<ChatChunk> {
    let since = since.unwrap_or(0).saturating_sub(FRESH_SLACK_MS);
    let hook_sid = sid.as_deref().filter(|s| !s.is_empty());
    let claude_c = claude_candidate(&cwd, hook_sid).filter(|(_, _, m)| hook_sid.is_some() || *m >= since);
    let codex_c = crate::codex::latest_rollout_for_cwd(&cwd).filter(|(_, m)| *m >= since);
    let (token, path, is_codex) = match (claude_c, codex_c) {
        (Some((cid, cp, cm)), Some((xp, xm))) => {
            // 최근 활동한 도구의 대화를 보여준다 — codex 작업 중 옛 Claude 대화가 뜨지 않게
            if xm > cm {
                (format!("x:{}", xp.display()), xp, true)
            } else {
                (format!("c:{}", cid), cp, false)
            }
        }
        (Some((cid, cp, _)), None) => (format!("c:{}", cid), cp, false),
        (None, Some((xp, _))) => (format!("x:{}", xp.display()), xp, true),
        (None, None) => return None,
    };
    let len = fs::metadata(&path).ok()?.len();
    let fresh = file.as_deref() != Some(token.as_str()) || offset > len; // 전환 또는 재작성(축소)
    let start = if fresh { len.saturating_sub(claude::CHAT_TAIL_INIT) } else { offset };
    if start >= len {
        return Some(ChatChunk { file: token, offset: len, messages: Vec::new() });
    }
    let mut f = fs::File::open(&path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    // 중간에서 시작했다면 첫 부분 줄(잘린 레코드)은 버린다.
    // (윈도우 안에 개행이 하나도 없는 초대형 단일 레코드는 포기 — 파싱 실패로 자연 스킵)
    let mut begin = 0usize;
    if fresh && start > 0 {
        begin = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => i + 1,
            None => return Some(ChatChunk { file: token, offset: start, messages: Vec::new() }),
        };
    }
    // 마지막 완성 줄까지만 소비
    let Some(last_nl) = buf[begin..].iter().rposition(|&b| b == b'\n').map(|i| begin + i) else {
        return Some(ChatChunk { file: token, offset: start + begin as u64, messages: Vec::new() });
    };
    let mut messages: Vec<ChatMsg> = Vec::new();
    for line in buf[begin..=last_nl].split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
            if is_codex {
                crate::codex::rollout_line_msgs(&v, &mut messages);
            } else {
                claude::line_msgs(&v, &mut messages);
            }
        }
    }
    Some(ChatChunk { file: token, offset: start + last_nl as u64 + 1, messages })
}
