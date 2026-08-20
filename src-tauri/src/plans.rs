// 계획 문서: Claude Code 세션 기록(jsonl)에서 계획을 추출해 프로젝트(경로) 귀속으로 영속화.
//  - 추출 대상: ExitPlanMode 의 plan, 그리고 plan 성격의 .md Write 내용
//  - Claude Code 가 오래된 jsonl 을 정리해도, 한 번 추출된 계획은 앱 데이터
//    (plans/<경로 변환>.json)에 남아 이후에도 열람·이어서 진행의 근거가 된다.
//  - 스캔은 파일별 오프셋 기반 증분 — 첫 호출 이후에는 새로 추가된 기록만 읽는다.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use tauri::Manager;

const SCAN_CHUNK: u64 = 8 * 1024 * 1024; // 호출당 파일 1개 스캔 상한 (초대형 세션 방어)
const TEXT_CAP: usize = 120_000; // 계획 1개 텍스트 상한 (chars)
const MIN_TEXT_LEN: usize = 40; // 이보다 짧으면 실질 내용 없는 계획으로 보고 제외
const MAX_PLANS: usize = 200; // 프로젝트당 보관 상한 — 초과 시 오래된 것부터 제거
const TITLE_CAP: usize = 80;

#[derive(Serialize, Deserialize, Clone)]
pub struct PlanDoc {
    pub id: String, // 본문 해시 — 같은 계획의 중복 수집 방지
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "createdMs")]
    pub created_ms: u64,
    pub title: String,
    pub text: String,
}

/// 목록 IPC 용 — 본문은 제외해 페이로드를 가볍게 유지 (본문은 get_plan_doc 으로)
#[derive(Serialize)]
pub struct PlanMeta {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "createdMs")]
    pub created_ms: u64,
    pub title: String,
}

#[derive(Serialize, Deserialize, Default)]
struct PlanStore {
    /// 세션 파일 스템 → 스캔 완료 바이트 오프셋
    #[serde(default)]
    files: HashMap<String, u64>,
    #[serde(default)]
    plans: Vec<PlanDoc>,
}

fn store_path(app: &tauri::AppHandle, cwd: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("plans");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{}.json", crate::claude::munge_path(cwd))))
}

fn load_store(path: &PathBuf) -> PlanStore {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// "2026-08-21T06:33:00.123Z" 류 ISO 8601(UTC) → unix ms. 외부 크레이트 없이 처리.
fn iso_ms(s: &str) -> Option<u64> {
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let ms = if s.as_bytes().get(19) == Some(&b'.') { num(20, 23).unwrap_or(0) } else { 0 };
    // 그레고리력 → 일수 (days_from_civil 알고리즘)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms).ok()
}

/// 첫 의미 있는 줄(마크다운 헤딩 우선)을 제목으로
fn plan_title(text: &str) -> String {
    for line in text.lines() {
        let t = line.trim().trim_start_matches('#').trim();
        if !t.is_empty() {
            return t.chars().take(TITLE_CAP).collect();
        }
    }
    "계획 문서".into()
}

fn content_hash(text: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// jsonl 레코드 1개에서 계획 추출. 서브에이전트(사이드체인) 기록도 포함한다 —
/// 플랜 전용 에이전트가 작성한 계획도 수집 대상이기 때문.
fn extract_plans(v: &serde_json::Value, session_id: &str, plans: &mut Vec<PlanDoc>, known: &mut HashSet<String>) -> bool {
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return false;
    }
    let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else {
        return false;
    };
    let mut added = false;
    for b in arr {
        if b.get("type").and_then(|x| x.as_str()) != Some("tool_use") {
            continue;
        }
        let input = b.get("input");
        let text = match b.get("name").and_then(|x| x.as_str()) {
            // 플랜 모드 승인 요청 — 계획 본문의 정본
            Some("ExitPlanMode") => input.and_then(|i| i.get("plan")).and_then(|x| x.as_str()),
            // 계획 성격의 마크다운 파일 작성 (예: docs/plan-*.md, .omc/plans/*.md)
            Some("Write") => {
                let fp = input.and_then(|i| i.get("file_path")).and_then(|x| x.as_str()).unwrap_or("");
                let lower = fp.to_lowercase();
                if lower.ends_with(".md") && (lower.contains("plan") || fp.contains("계획")) {
                    input.and_then(|i| i.get("content")).and_then(|x| x.as_str())
                } else {
                    None
                }
            }
            _ => None,
        };
        let Some(text) = text.map(str::trim) else { continue };
        if text.chars().count() < MIN_TEXT_LEN {
            continue;
        }
        let capped: String = text.chars().take(TEXT_CAP).collect();
        let id = content_hash(&capped);
        if !known.insert(id.clone()) {
            continue; // 같은 계획의 재기록(재승인·파일 재작성) — 중복 제외
        }
        let created = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .and_then(iso_ms)
            .unwrap_or_else(now_ms);
        plans.push(PlanDoc {
            id,
            session_id: session_id.into(),
            created_ms: created,
            title: plan_title(&capped),
            text: capped,
        });
        added = true;
    }
    added
}

/// cwd 의 계획 문서 목록 (최신순). 호출 시 세션 기록의 새 구간을 증분 스캔해 저장소에 반영.
/// async 커맨드 → 워커 스레드에서 실행되므로 파일 파싱이 UI 를 막지 않는다.
#[tauri::command]
pub async fn list_plan_docs(app: tauri::AppHandle, cwd: String) -> Vec<PlanMeta> {
    let Some(spath) = store_path(&app, &cwd) else { return Vec::new() };
    let mut store = load_store(&spath);
    let mut known: HashSet<String> = store.plans.iter().map(|p| p.id.clone()).collect();
    let mut dirty = false;

    if let Some(home) = crate::claude::home_dir() {
        let dir = home.join(".claude").join("projects").join(crate::claude::munge_path(&cwd));
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(stem) = p.file_stem().and_then(|x| x.to_str()).map(str::to_string) else { continue };
                let len = match e.metadata() {
                    Ok(md) => md.len(),
                    Err(_) => continue,
                };
                let mut off = store.files.get(&stem).copied().unwrap_or(0);
                if off > len {
                    off = 0; // 파일이 재작성(축소)됨 — 처음부터 다시 (id 해시가 중복을 걸러준다)
                }
                if len == off {
                    continue;
                }
                let Ok(mut f) = fs::File::open(&p) else { continue };
                if f.seek(SeekFrom::Start(off)).is_err() {
                    continue;
                }
                let want = (len - off).min(SCAN_CHUNK) as usize;
                let mut buf = vec![0u8; want];
                let Ok(n) = f.read(&mut buf) else { continue };
                buf.truncate(n);
                // 마지막 완성 줄까지만 소비 — 잘린 레코드는 다음 호출로 이월
                let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else { continue };
                const NEEDLE: &[u8] = b"\"tool_use\"";
                for line in buf[..=last_nl].split(|&b| b == b'\n') {
                    if line.len() < NEEDLE.len() || !line.windows(NEEDLE.len()).any(|w| w == NEEDLE) {
                        continue; // 계획이 있을 수 없는 레코드는 JSON 파싱 생략 (스캔 비용 절감)
                    }
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
                        let _ = extract_plans(&v, &stem, &mut store.plans, &mut known);
                    }
                }
                store.files.insert(stem, off + last_nl as u64 + 1);
                dirty = true; // 오프셋 갱신만으로도 저장 필요 (다음 호출의 재스캔 방지)
            }
        }
    }

    store.plans.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    if store.plans.len() > MAX_PLANS {
        store.plans.truncate(MAX_PLANS);
    }
    if dirty {
        if let Ok(json) = serde_json::to_string(&store) {
            // 원자적 저장 — 쓰다 죽어도 기존 저장소가 깨지지 않게
            let tmp = spath.with_extension("json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, &spath);
            }
        }
    }
    store
        .plans
        .iter()
        .map(|p| PlanMeta {
            id: p.id.clone(),
            session_id: p.session_id.clone(),
            created_ms: p.created_ms,
            title: p.title.clone(),
        })
        .collect()
}

/// 계획 문서 본문 (열람 팝업용)
#[tauri::command]
pub async fn get_plan_doc(app: tauri::AppHandle, cwd: String, id: String) -> Option<PlanDoc> {
    let spath = store_path(&app, &cwd)?;
    load_store(&spath).plans.into_iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_ms_parses_utc() {
        assert_eq!(iso_ms("2026-01-01T00:00:00.000Z"), Some(1_767_225_600_000));
        assert_eq!(iso_ms("2026-01-01T00:00:00Z"), Some(1_767_225_600_000));
        assert_eq!(iso_ms("깨진 값"), None);
    }

    #[test]
    fn extracts_exit_plan_mode_and_plan_md_write() {
        let long = "# 배포 계획\n\n1. 빌드\n2. 테스트\n3. 릴리즈 — 충분히 긴 본문이어야 수집된다";
        let line = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": { "content": [
                { "type": "tool_use", "name": "ExitPlanMode", "input": { "plan": long } },
                { "type": "tool_use", "name": "Write",
                  "input": { "file_path": "docs/plan-v2.md", "content": long } },
                { "type": "tool_use", "name": "Write",
                  "input": { "file_path": "src/main.rs", "content": long } }
            ]}
        });
        let mut plans = Vec::new();
        let mut known = HashSet::new();
        assert!(extract_plans(&line, "sess1", &mut plans, &mut known));
        // ExitPlanMode 1건 + plan .md Write 1건 — 하지만 본문이 같으면 해시 중복으로 1건
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].title, "배포 계획");
        assert_eq!(plans[0].created_ms, 1_767_225_600_000);
        // 일반 코드 Write 는 수집되지 않고, 같은 계획의 재기록도 중복 제외
        assert!(!extract_plans(&line, "sess1", &mut plans, &mut known));
    }
}
