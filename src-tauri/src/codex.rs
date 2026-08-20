// 코덱스(Codex CLI) 사용량 조회 — ~/.codex/sessions/<년>/<월>/<일>/rollout-*.jsonl 의
// 마지막 token_count 이벤트에 담긴 rate_limits(사용률·윈도우·리셋 시각)를 읽는다.
// 코덱스가 세션 중 주기적으로 기록하므로, 최신 파일의 꼬리만 읽으면 현재 사용량이 나온다.
// 읽기 전용 — 코덱스 저장소를 건드리지 않는다.
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
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
