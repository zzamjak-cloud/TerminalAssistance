// 계획 문서: Claude Code 세션 기록(jsonl)에서 계획을 추출해 프로젝트(경로) 귀속으로 영속화.
//  - 추출 대상: ExitPlanMode 의 plan, 그리고 plan/spec 성격의 .md Write 내용
//  - 추가로 프로젝트 안의 관례적 계획 디렉토리(.omc/plans, docs/superpowers/specs 등)를
//    직접 스캔한다 — 플랜 모드를 거치지 않고(Auto 모드) 파일로만 남는 계획도 잡기 위함.
//  - Claude Code 가 오래된 jsonl 을 정리해도, 한 번 추출된 계획은 앱 데이터
//    (plans/<경로 변환>.json)에 남아 이후에도 열람·이어서 진행의 근거가 된다.
//  - 스캔은 파일별 오프셋 기반 증분 — 첫 호출 이후에는 새로 추가된 기록만 읽는다.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::Manager;

const SCAN_CHUNK: u64 = 8 * 1024 * 1024; // 호출당 파일 1개 스캔 상한 (초대형 세션 방어)
const TEXT_CAP: usize = 120_000; // 계획 1개 텍스트 상한 (chars)
const MIN_TEXT_LEN: usize = 40; // 이보다 짧으면 실질 내용 없는 계획으로 보고 제외
const MANUAL_MIN_TEXT_LEN: usize = 4; // 드래그 저장은 짧은 TODO 조각도 허용
const MAX_PLANS: usize = 200; // 프로젝트당 보관 상한 — 초과 시 오래된 것부터 제거
const TITLE_CAP: usize = 80;

/// 계획 문서가 파일로 저장되는 관례적 위치 (cwd 상대) — 도구별 대응:
/// OMC(.omc/plans), superpowers(docs/superpowers/specs), 일반 관례(docs/plans 등)
const PLAN_DIRS: &[&str] = &[
    ".omc/plans",
    ".claude/plans",
    "docs/plans",
    "docs/specs",
    "docs/superpowers/specs",
    "plans",
];
const PLAN_DIR_DEPTH: usize = 2; // 계획 디렉토리 하위 재귀 깊이 상한

#[derive(Serialize, Deserialize, Clone)]
pub struct PlanDoc {
    pub id: String, // 본문 해시(세션 추출) 또는 경로 해시(파일 스캔) — 중복 수집 방지
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "createdMs")]
    pub created_ms: u64,
    pub title: String,
    pub text: String,
    /// 파일 스캔으로 수집된 계획의 cwd 상대 경로 (세션 추출이면 빈 문자열)
    #[serde(default)]
    pub path: String,
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
    pub path: String,
}

#[derive(Serialize, Deserialize, Default)]
struct PlanStore {
    /// 세션 파일 스템 → 스캔 완료 바이트 오프셋
    #[serde(default)]
    files: HashMap<String, u64>,
    /// 계획 파일 상대 경로 → (mtime ms, 크기) — 변경 없으면 재읽기 생략
    #[serde(default)]
    disk: HashMap<String, (u64, u64)>,
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
    let ms = if s.as_bytes().get(19) == Some(&b'.') {
        num(20, 23).unwrap_or(0)
    } else {
        0
    };
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

fn plan_meta(p: &PlanDoc) -> PlanMeta {
    PlanMeta {
        id: p.id.clone(),
        session_id: p.session_id.clone(),
        created_ms: p.created_ms,
        title: p.title.clone(),
        path: p.path.clone(),
    }
}

fn save_store(path: &Path, store: &PlanStore) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|e| format!("계획 저장 직렬화 실패: {}", e))?;
    // 원자적 저장 — 쓰다 죽어도 기존 저장소가 깨지지 않게
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("계획 임시 파일 저장 실패: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("계획 저장 반영 실패: {}", e))
}

fn normalize_manual_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn insert_manual_plan(
    store: &mut PlanStore,
    session_id: String,
    text: String,
    created_ms: u64,
) -> Result<PlanMeta, String> {
    let normalized = normalize_manual_text(&text);
    if normalized.chars().count() < MANUAL_MIN_TEXT_LEN {
        return Err("계획으로 저장할 선택 영역이 너무 짧습니다".into());
    }
    let capped: String = normalized.chars().take(TEXT_CAP).collect();
    if let Some(existing) = store.plans.iter().find(|p| p.text == capped) {
        return Ok(plan_meta(existing));
    }
    let doc = PlanDoc {
        id: format!("m{}", content_hash(&capped)),
        session_id,
        created_ms,
        title: plan_title(&capped),
        text: capped,
        path: String::new(),
    };
    let meta = plan_meta(&doc);
    store.plans.retain(|p| p.id != doc.id);
    store.plans.push(doc);
    store.plans.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    if store.plans.len() > MAX_PLANS {
        store.plans.truncate(MAX_PLANS);
    }
    Ok(meta)
}

/// jsonl 레코드 1개에서 계획 추출. 서브에이전트(사이드체인) 기록도 포함한다 —
/// 플랜 전용 에이전트가 작성한 계획도 수집 대상이기 때문.
fn extract_plans(
    v: &serde_json::Value,
    session_id: &str,
    plans: &mut Vec<PlanDoc>,
    known: &mut HashSet<String>,
) -> bool {
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return false;
    }
    let Some(arr) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
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
            // 계획 성격의 마크다운 파일 작성
            // (예: docs/plan-*.md, .omc/plans/*.md, docs/superpowers/specs/*-design.md)
            Some("Write") => {
                let fp = input
                    .and_then(|i| i.get("file_path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let lower = fp.to_lowercase().replace('\\', "/");
                if lower.ends_with(".md")
                    && (lower.contains("plan") || fp.contains("계획") || lower.contains("/specs/"))
                {
                    input
                        .and_then(|i| i.get("content"))
                        .and_then(|x| x.as_str())
                } else {
                    None
                }
            }
            _ => None,
        };
        let Some(text) = text.map(str::trim) else {
            continue;
        };
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
            path: String::new(),
        });
        added = true;
    }
    added
}

/// 파일 mtime → unix ms
fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 계획 디렉토리 하나를 재귀 스캔해 .md 파일을 계획으로 수집/갱신.
/// 파일 기반 계획은 경로 해시 id 로 1파일=1항목을 유지하고, 내용이 바뀌면 제자리 갱신한다.
fn scan_plan_dir(
    dir: &Path,
    cwd: &Path,
    depth: usize,
    store: &mut PlanStore,
    known: &mut HashSet<String>,
) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut dirty = false;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < PLAN_DIR_DEPTH {
                dirty |= scan_plan_dir(&p, cwd, depth + 1, store, known);
            }
            continue;
        }
        if p.extension()
            .and_then(|x| x.to_str())
            .map(str::to_lowercase)
            != Some("md".into())
        {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let rel = p
            .strip_prefix(cwd)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| p.to_string_lossy().into_owned());
        let sig = (mtime_ms(&md), md.len());
        if store.disk.get(&rel) == Some(&sig) {
            continue; // 변경 없음 — 재읽기 생략
        }
        store.disk.insert(rel.clone(), sig);
        dirty = true;
        let Ok(raw) = fs::read_to_string(&p) else {
            continue;
        };
        let text = raw.trim();
        if text.chars().count() < MIN_TEXT_LEN {
            continue;
        }
        let capped: String = text.chars().take(TEXT_CAP).collect();
        // 세션 추출본과 내용이 같으면 중복 등록하지 않는다 (Write 로 이미 수집된 계획)
        if known.contains(&content_hash(&capped)) {
            continue;
        }
        let id = format!("f{}", content_hash(&rel)); // 경로 기반 id — 파일 수정 시 갱신 대상
        known.insert(id.clone());
        let doc = PlanDoc {
            id: id.clone(),
            session_id: String::new(),
            created_ms: sig.0,
            title: plan_title(&capped),
            text: capped,
            path: rel,
        };
        if let Some(existing) = store.plans.iter_mut().find(|x| x.id == id) {
            *existing = doc;
        } else {
            store.plans.push(doc);
        }
    }
    dirty
}

/// cwd 의 계획 문서 목록 (최신순). 호출 시 세션 기록의 새 구간을 증분 스캔해 저장소에 반영.
/// async 커맨드 → 워커 스레드에서 실행되므로 파일 파싱이 UI 를 막지 않는다.
#[tauri::command]
pub async fn list_plan_docs(app: tauri::AppHandle, cwd: String) -> Vec<PlanMeta> {
    let Some(spath) = store_path(&app, &cwd) else {
        return Vec::new();
    };
    let mut store = load_store(&spath);
    let mut known: HashSet<String> = store.plans.iter().map(|p| p.id.clone()).collect();
    let mut dirty = false;

    if let Some(home) = crate::claude::home_dir() {
        let dir = home
            .join(".claude")
            .join("projects")
            .join(crate::claude::munge_path(&cwd));
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(stem) = p.file_stem().and_then(|x| x.to_str()).map(str::to_string) else {
                    continue;
                };
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
                let Ok(mut f) = fs::File::open(&p) else {
                    continue;
                };
                if f.seek(SeekFrom::Start(off)).is_err() {
                    continue;
                }
                let want = (len - off).min(SCAN_CHUNK) as usize;
                let mut buf = vec![0u8; want];
                let Ok(n) = f.read(&mut buf) else { continue };
                buf.truncate(n);
                // 마지막 완성 줄까지만 소비 — 잘린 레코드는 다음 호출로 이월
                let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
                    continue;
                };
                const NEEDLE: &[u8] = b"\"tool_use\"";
                for line in buf[..=last_nl].split(|&b| b == b'\n') {
                    if line.len() < NEEDLE.len() || !line.windows(NEEDLE.len()).any(|w| w == NEEDLE)
                    {
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

    // 세션 기록과 별개로, 프로젝트 안의 관례적 계획 디렉토리도 직접 스캔
    // (Auto 모드 등 플랜 모드를 거치지 않고 파일로만 남는 계획 대응)
    let cwd_path = PathBuf::from(&cwd);
    for rel in PLAN_DIRS {
        dirty |= scan_plan_dir(&cwd_path.join(rel), &cwd_path, 0, &mut store, &mut known);
    }

    store.plans.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    if store.plans.len() > MAX_PLANS {
        store.plans.truncate(MAX_PLANS);
    }
    if dirty {
        let _ = save_store(&spath, &store);
    }
    store.plans.iter().map(plan_meta).collect()
}

/// 계획 문서 본문 (열람 팝업용)
#[tauri::command]
pub async fn get_plan_doc(app: tauri::AppHandle, cwd: String, id: String) -> Option<PlanDoc> {
    let spath = store_path(&app, &cwd)?;
    load_store(&spath).plans.into_iter().find(|p| p.id == id)
}

/// 사용자가 터미널에서 드래그 선택한 계획 조각을 같은 계획 저장소에 직접 추가.
#[tauri::command]
pub async fn add_plan_doc(
    app: tauri::AppHandle,
    cwd: String,
    session_id: String,
    text: String,
) -> Result<PlanMeta, String> {
    let spath =
        store_path(&app, &cwd).ok_or_else(|| "계획 저장소 경로를 만들 수 없습니다".to_string())?;
    let mut store = load_store(&spath);
    let meta = insert_manual_plan(&mut store, session_id, text, now_ms())?;
    save_store(&spath, &store)?;
    Ok(meta)
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

    #[test]
    fn extracts_specs_dir_write() {
        // superpowers 스펙처럼 파일명에 plan 이 없어도 /specs/ 경로면 수집
        let long =
            "# 설계 문서\n\n구성 요소와 데이터 흐름을 정의한다 — 충분히 긴 본문이어야 수집된다";
        let line = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": { "content": [
                { "type": "tool_use", "name": "Write",
                  "input": { "file_path": "docs/superpowers/specs/2026-01-01-topic-design.md", "content": long } }
            ]}
        });
        let mut plans = Vec::new();
        let mut known = HashSet::new();
        assert!(extract_plans(&line, "sess1", &mut plans, &mut known));
        assert_eq!(plans[0].title, "설계 문서");
    }

    #[test]
    fn disk_scan_collects_and_updates() {
        // 임시 프로젝트: .omc/plans/a.md 를 수집하고, 내용 변경 시 같은 항목을 제자리 갱신
        let tmp = std::env::temp_dir().join(format!("ta-plans-test-{}", std::process::id()));
        let dir = tmp.join(".omc").join("plans");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        fs::write(
            &file,
            "# 첫 계획\n\n1단계와 2단계를 수행한다 — 충분히 긴 본문이어야 수집된다",
        )
        .unwrap();

        let mut store = PlanStore::default();
        let mut known = HashSet::new();
        assert!(scan_plan_dir(&dir, &tmp, 0, &mut store, &mut known));
        assert_eq!(store.plans.len(), 1);
        assert_eq!(store.plans[0].title, "첫 계획");
        assert_eq!(store.plans[0].path, ".omc/plans/a.md");

        // 변경 없으면 재읽기 없음 (dirty=false)
        let mut known2: HashSet<String> = store.plans.iter().map(|p| p.id.clone()).collect();
        assert!(!scan_plan_dir(&dir, &tmp, 0, &mut store, &mut known2));

        // 내용 변경 → 같은 id 항목이 갱신되어 개수는 그대로
        fs::write(
            &file,
            "# 수정된 계획\n\n3단계를 추가로 수행한다 — 충분히 긴 본문이어야 수집된다",
        )
        .unwrap();
        // mtime 해상도 문제를 피하기 위해 크기가 달라진 것으로 변경을 감지한다
        let mut known3: HashSet<String> = store.plans.iter().map(|p| p.id.clone()).collect();
        known3.remove(&store.plans[0].id);
        scan_plan_dir(&dir, &tmp, 0, &mut store, &mut known3);
        assert_eq!(store.plans.len(), 1);
        assert_eq!(store.plans[0].title, "수정된 계획");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn manual_plan_insert_allows_short_selection_and_dedupes() {
        let mut store = PlanStore::default();
        let text = "1. 입력 버그 재현\n2. 원인 수정\n3. 빌드 검증";

        let first = insert_manual_plan(&mut store, "sess1".into(), text.into(), 10).unwrap();
        let second = insert_manual_plan(&mut store, "sess1".into(), text.into(), 20).unwrap();

        assert_eq!(store.plans.len(), 1);
        assert_eq!(first.id, second.id);
        assert_eq!(first.title, "1. 입력 버그 재현");
        assert_eq!(store.plans[0].session_id, "sess1");
    }

    #[test]
    fn manual_plan_insert_rejects_tiny_selection() {
        let mut store = PlanStore::default();
        assert!(insert_manual_plan(&mut store, "sess1".into(), "ok".into(), 10).is_err());
        assert!(store.plans.is_empty());
    }
}
