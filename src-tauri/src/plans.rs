// 통합 문서: Claude Code 계획을 앱 저장소에 수집하고, 사용자 메모는 프로젝트 내부 Markdown으로 저장한다.
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
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

const SCAN_CHUNK: u64 = 8 * 1024 * 1024; // 호출당 파일 1개 스캔 상한 (초대형 세션 방어)
const TEXT_CAP: usize = 120_000; // 계획 1개 텍스트 상한 (chars)
const MIN_TEXT_LEN: usize = 40; // 이보다 짧으면 실질 내용 없는 계획으로 보고 제외
const MANUAL_MIN_TEXT_LEN: usize = 4; // 드래그 저장은 짧은 TODO 조각도 허용
const MAX_PLANS: usize = 200; // 프로젝트당 보관 상한 — 초과 시 오래된 것부터 제거
const TITLE_CAP: usize = 80;
const PLAN_FILE_MAX_BYTES: u64 = (TEXT_CAP * 4) as u64;
const MEMO_MARKDOWN_MAX_BYTES: usize = 1024 * 1024;
const MEMO_FILE_MAX_BYTES: u64 = MEMO_MARKDOWN_MAX_BYTES as u64 + 4096;
const MEMO_TEMP_RETRIES: usize = 8;
const MEMO_KIND: &str = "memo";
const PLAN_KIND: &str = "plan";
const MEMO_HEADER_MARKER: &str = "terminal-assistance-memo";

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

fn default_plan_kind() -> String {
    PLAN_KIND.into()
}

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
    /// 구버전 저장소에는 kind가 없으므로 계획 문서로 간주한다.
    #[serde(default = "default_plan_kind")]
    pub kind: String,
    #[serde(default, rename = "updatedMs")]
    pub updated_ms: u64,
}

/// 목록 IPC 용 — 본문은 제외해 페이로드를 가볍게 유지 (본문은 get_plan_doc 으로)
#[derive(Serialize, Deserialize, Clone)]
pub struct PlanMeta {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "createdMs")]
    pub created_ms: u64,
    pub title: String,
    pub path: String,
    #[serde(default = "default_plan_kind")]
    pub kind: String,
    #[serde(rename = "updatedMs")]
    pub updated_ms: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct PlanStore {
    /// 세션 파일 스템 → 스캔 완료 바이트 오프셋
    #[serde(default)]
    files: HashMap<String, u64>,
    /// 계획 파일 상대 경로 → (mtime ms, 크기) — 변경 없으면 재읽기 생략
    #[serde(default)]
    disk: HashMap<String, (u64, u64)>,
    /// 탐색기에서 사용자가 직접 등록한 계획 파일의 canonical cwd 상대 경로.
    #[serde(default)]
    manual_files: HashSet<String>,
    /// 사용자가 목록에서 제거한 계획 id. 자동 재수집되어도 다시 노출하지 않는다.
    #[serde(default)]
    dismissed_ids: HashSet<String>,
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

fn file_plan_id(rel: &str) -> String {
    format!("f{}", content_hash(rel))
}

fn sort_and_limit_plans(store: &mut PlanStore) {
    store.plans.sort_by(|a, b| {
        b.updated_ms
            .max(b.created_ms)
            .cmp(&a.updated_ms.max(a.created_ms))
    });
    let manual_ids: HashSet<String> = store
        .manual_files
        .iter()
        .map(|rel| file_plan_id(rel))
        .collect();
    let mut automatic_count = 0usize;
    store.plans.retain(|doc| {
        if manual_ids.contains(&doc.id) {
            true
        } else if automatic_count < MAX_PLANS {
            automatic_count += 1;
            true
        } else {
            false
        }
    });
}

fn plan_meta(p: &PlanDoc) -> PlanMeta {
    PlanMeta {
        id: p.id.clone(),
        session_id: p.session_id.clone(),
        created_ms: p.created_ms,
        title: p.title.clone(),
        path: p.path.clone(),
        kind: p.kind.clone(),
        updated_ms: if p.updated_ms > 0 {
            p.updated_ms
        } else {
            p.created_ms
        },
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
    if let Some(index) = store.plans.iter().position(|p| p.text == capped) {
        let meta = plan_meta(&store.plans[index]);
        store.dismissed_ids.remove(&meta.id);
        return Ok(meta);
    }
    let doc = PlanDoc {
        id: format!("m{}", content_hash(&capped)),
        session_id,
        created_ms,
        title: plan_title(&capped),
        text: capped,
        path: String::new(),
        kind: default_plan_kind(),
        updated_ms: created_ms,
    };
    let meta = plan_meta(&doc);
    // 사용자가 같은 선택 계획을 명시적으로 다시 저장하면 목록 제거를 취소한다.
    store.dismissed_ids.remove(&doc.id);
    store.plans.retain(|p| p.id != doc.id);
    store.plans.push(doc);
    sort_and_limit_plans(store);
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
            kind: default_plan_kind(),
            updated_ms: created,
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
        let Ok(p) = fs::canonicalize(&p) else {
            continue;
        };
        if !p.starts_with(cwd) {
            continue; // 프로젝트 밖을 가리키는 symlink 파일은 자동 수집하지 않는다.
        }
        if p.extension()
            .and_then(|x| x.to_str())
            .map(str::to_lowercase)
            != Some("md".into())
        {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let Ok(rel) = p.strip_prefix(cwd) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
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
        let id = file_plan_id(&rel); // 경로 기반 id — 파일 수정 시 갱신 대상
        known.insert(id.clone());
        let doc = PlanDoc {
            id: id.clone(),
            session_id: String::new(),
            created_ms: sig.0,
            title: plan_title(&capped),
            text: capped,
            path: rel,
            kind: default_plan_kind(),
            updated_ms: sig.0,
        };
        if let Some(existing) = store.plans.iter_mut().find(|x| x.id == id) {
            *existing = doc;
        } else {
            store.plans.push(doc);
        }
    }
    dirty
}

fn read_registered_plan(cwd: &Path, path: &Path) -> Result<(PlanDoc, (u64, u64)), String> {
    let link_metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("계획 파일 정보를 읽을 수 없습니다: {e}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("심볼릭 링크는 계획 문서로 등록할 수 없습니다".into());
    }
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("계획 파일을 열 수 없습니다: {e}"))?;
    let rel = canonical
        .strip_prefix(cwd)
        .map_err(|_| "프로젝트 밖의 파일은 등록할 수 없습니다".to_string())?;
    let metadata =
        fs::metadata(&canonical).map_err(|e| format!("계획 파일 정보를 읽을 수 없습니다: {e}"))?;
    if !metadata.is_file() {
        return Err("일반 파일만 계획 문서로 등록할 수 있습니다".into());
    }
    let is_markdown = canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("md"));
    if !is_markdown {
        return Err("Markdown(.md) 파일만 계획 문서로 등록할 수 있습니다".into());
    }
    if metadata.len() > PLAN_FILE_MAX_BYTES {
        return Err(format!(
            "계획 파일이 너무 큽니다 (최대 {} KiB)",
            PLAN_FILE_MAX_BYTES / 1024
        ));
    }
    let bytes = fs::read(&canonical).map_err(|e| format!("계획 파일을 읽지 못했습니다: {e}"))?;
    let raw =
        String::from_utf8(bytes).map_err(|_| "계획 파일이 UTF-8 텍스트가 아닙니다".to_string())?;
    let text = raw.trim();
    if text.chars().count() < MIN_TEXT_LEN {
        return Err("계획 파일의 내용이 비어 있거나 너무 짧습니다".into());
    }
    let capped: String = text.chars().take(TEXT_CAP).collect();
    let rel = rel.to_string_lossy().replace('\\', "/");
    let timestamp = mtime_ms(&metadata);
    Ok((
        PlanDoc {
            id: file_plan_id(&rel),
            session_id: String::new(),
            created_ms: timestamp,
            title: plan_title(&capped),
            text: capped,
            path: rel,
            kind: default_plan_kind(),
            updated_ms: timestamp,
        },
        (timestamp, metadata.len()),
    ))
}

fn same_plan_doc(left: &PlanDoc, right: &PlanDoc) -> bool {
    left.id == right.id
        && left.session_id == right.session_id
        && left.created_ms == right.created_ms
        && left.title == right.title
        && left.text == right.text
        && left.path == right.path
        && left.kind == right.kind
        && left.updated_ms == right.updated_ms
}

fn upsert_registered_plan(store: &mut PlanStore, doc: PlanDoc, sig: (u64, u64)) -> bool {
    let mut dirty = store.disk.get(&doc.path) != Some(&sig);
    store.disk.insert(doc.path.clone(), sig);
    if let Some(existing) = store.plans.iter_mut().find(|item| item.id == doc.id) {
        if !same_plan_doc(existing, &doc) {
            *existing = doc;
            dirty = true;
        }
    } else {
        store.plans.push(doc);
        dirty = true;
    }
    dirty
}

fn remove_registered_plan(store: &mut PlanStore, rel: &str) -> bool {
    let id = file_plan_id(rel);
    let removed_manual = store.manual_files.remove(rel);
    let removed_disk = store.disk.remove(rel).is_some();
    let before = store.plans.len();
    store.plans.retain(|doc| doc.id != id);
    removed_manual || removed_disk || before != store.plans.len()
}

fn refresh_registered_plans(cwd: &Path, store: &mut PlanStore) -> bool {
    let mut dirty = false;
    let registered: Vec<String> = store.manual_files.iter().cloned().collect();
    for rel in registered {
        let rel_path = Path::new(&rel);
        let safe_relative = !rel_path.is_absolute()
            && rel_path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)));
        if !safe_relative {
            dirty |= remove_registered_plan(store, &rel);
            continue;
        }
        match read_registered_plan(cwd, &cwd.join(rel_path)) {
            Ok((doc, sig)) if doc.path == rel => {
                dirty |= upsert_registered_plan(store, doc, sig);
            }
            _ => {
                // 삭제·형식 변경·외부 symlink 치환은 등록과 캐시만 정리하고 원본은 건드리지 않는다.
                dirty |= remove_registered_plan(store, &rel);
            }
        }
    }
    dirty
}

fn register_plan_in_store(
    cwd: &Path,
    path: &Path,
    store: &mut PlanStore,
) -> Result<PlanMeta, String> {
    let (doc, sig) = read_registered_plan(cwd, path)?;
    // 탐색기에서 다시 드롭한 파일은 사용자의 명시적 복구 의사로 본다.
    store.dismissed_ids.remove(&doc.id);
    store.manual_files.insert(doc.path.clone());
    upsert_registered_plan(store, doc.clone(), sig);
    sort_and_limit_plans(store);
    Ok(plan_meta(&doc))
}

fn valid_plan_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// tombstone 대상 계획을 저장 목록에서 제거한다. 파일 원본은 절대 건드리지 않는다.
fn dismiss_plan_in_store(store: &mut PlanStore, id: &str) -> Result<(), String> {
    if !valid_plan_id(id) {
        return Err("계획 문서 식별자가 올바르지 않습니다".into());
    }
    let Some(index) = store.plans.iter().position(|doc| doc.id == id) else {
        return Err("제거할 계획 문서를 찾을 수 없습니다".into());
    };
    if store.plans[index].kind != PLAN_KIND {
        return Err("계획 문서만 목록에서 제거할 수 있습니다".into());
    }
    let doc = store.plans.remove(index);
    store.dismissed_ids.insert(doc.id);
    if !doc.path.is_empty() {
        store.manual_files.remove(&doc.path);
        store.disk.remove(&doc.path);
    }
    Ok(())
}

fn filter_dismissed_plans(store: &mut PlanStore) -> bool {
    let before = store.plans.len();
    let dismissed = &store.dismissed_ids;
    store
        .plans
        .retain(|doc| doc.kind != PLAN_KIND || !dismissed.contains(&doc.id));
    before != store.plans.len()
}

fn validated_cwd(cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() || cwd.len() > 4096 {
        return Err("프로젝트 경로가 올바르지 않습니다".into());
    }
    let path = fs::canonicalize(cwd).map_err(|e| format!("프로젝트 경로를 열 수 없습니다: {e}"))?;
    if !path.is_dir() {
        return Err("프로젝트 경로가 디렉터리가 아닙니다".into());
    }
    Ok(path)
}

/// symlink가 전용 저장소를 프로젝트 밖으로 돌리는 경우를 단계별로 차단한다.
fn memo_dir(cwd: &str, create: bool) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let root = validated_cwd(cwd)?;
    let mut current = root.clone();
    for name in [".terminal-assistance", "memos"] {
        let candidate = current.join(name);
        if !candidate.exists() {
            if !create {
                return Ok(None);
            }
            fs::create_dir(&candidate)
                .map_err(|e| format!("메모 디렉터리를 만들지 못했습니다: {e}"))?;
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|e| format!("메모 디렉터리를 확인하지 못했습니다: {e}"))?;
        if !canonical.starts_with(&root) || !canonical.is_dir() {
            return Err("메모 디렉터리가 프로젝트 밖을 가리킵니다".into());
        }
        current = canonical;
    }
    Ok(Some((root, current)))
}

fn valid_memo_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn normalize_memo_title(title: &str) -> Result<String, String> {
    let normalized = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    let count = normalized.chars().count();
    if count == 0 {
        return Err("메모 제목을 입력해 주세요".into());
    }
    if count > TITLE_CAP {
        return Err(format!("메모 제목은 {TITLE_CAP}자 이하여야 합니다"));
    }
    if normalized.chars().any(char::is_control) {
        return Err("메모 제목에 제어 문자를 사용할 수 없습니다".into());
    }
    Ok(normalized)
}

fn normalize_memo_markdown(markdown: &str) -> Result<String, String> {
    if markdown.len() > MEMO_MARKDOWN_MAX_BYTES {
        return Err("메모 본문이 너무 큽니다 (최대 1 MiB)".into());
    }
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.trim().is_empty() {
        return Err("메모 본문을 입력해 주세요".into());
    }
    Ok(normalized)
}

fn hex_encode(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(text.len() * 2);
    for byte in text.as_bytes() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn hex_decode(value: &str) -> Option<String> {
    if value.len() % 2 != 0 || value.len() > TITLE_CAP * 8 {
        return None;
    }
    let nibble = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        bytes.push(nibble(pair[0])? * 16 + nibble(pair[1])?);
    }
    String::from_utf8(bytes).ok()
}

fn memo_header(id: &str, title: &str, created_ms: u64, updated_ms: u64) -> String {
    format!(
        "<!-- {MEMO_HEADER_MARKER} id={id} titleHex={} createdMs={created_ms} updatedMs={updated_ms} -->",
        hex_encode(title)
    )
}

fn parse_memo_file(raw: &str, rel: String) -> Option<PlanDoc> {
    let (header, body) = raw.split_once('\n')?;
    let header = header.strip_prefix("<!-- ")?.strip_suffix(" -->")?;
    let mut parts = header.split_whitespace();
    if parts.next()? != MEMO_HEADER_MARKER {
        return None;
    }
    let mut id = None;
    let mut title = None;
    let mut created_ms = None;
    let mut updated_ms = None;
    for part in parts {
        if let Some(value) = part.strip_prefix("id=") {
            id = Some(value.to_string());
        } else if let Some(value) = part.strip_prefix("titleHex=") {
            title = hex_decode(value);
        } else if let Some(value) = part.strip_prefix("createdMs=") {
            created_ms = value.parse().ok();
        } else if let Some(value) = part.strip_prefix("updatedMs=") {
            updated_ms = value.parse().ok();
        }
    }
    let id = id.filter(|value| valid_memo_id(value))?;
    let title = normalize_memo_title(&title?).ok()?;
    let created_ms = created_ms?;
    let updated_ms = updated_ms.unwrap_or(created_ms);
    let text = body.strip_prefix('\n').unwrap_or(body).to_string();
    if text.len() > MEMO_MARKDOWN_MAX_BYTES || text.trim().is_empty() {
        return None;
    }
    Some(PlanDoc {
        id,
        session_id: String::new(),
        created_ms,
        title,
        text,
        path: rel,
        kind: MEMO_KIND.into(),
        updated_ms,
    })
}

fn scan_memo_docs(cwd: &str) -> Result<Vec<(PlanDoc, PathBuf)>, String> {
    let Some((root, dir)) = memo_dir(cwd, false)? else {
        return Ok(Vec::new());
    };
    let entries = fs::read_dir(&dir).map_err(|e| format!("메모 목록을 읽지 못했습니다: {e}"))?;
    let mut docs = Vec::new();
    // 비메모 파일 수와 순서 때문에 뒤쪽의 정상 메모가 list/get/delete에서 사라지면 안 된다.
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MEMO_FILE_MAX_BYTES {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(&path) else {
            continue;
        };
        if !canonical.starts_with(&dir) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&canonical) else {
            continue;
        };
        let Ok(rel) = canonical.strip_prefix(&root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if let Some(doc) = parse_memo_file(&raw, rel) {
            docs.push((doc, canonical));
        }
    }
    Ok(docs)
}

fn safe_memo_filename(title: &str, id: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in title.chars() {
        let safe = ch.is_alphanumeric() || ch == '_' || ch == '-';
        if safe {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
        if slug.chars().count() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "메모" } else { slug };
    format!("{slug}-{id}.md")
}

fn open_new_memo_temp(
    path: &Path,
    file_name: &str,
    suffix: &str,
) -> std::io::Result<(PathBuf, fs::File)> {
    let tmp = path.with_file_name(format!(".{file_name}.{suffix}.tmp"));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    Ok((tmp, file))
}

fn atomic_write_memo(path: &Path, content: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "메모 파일명이 올바르지 않습니다".to_string())?;
    let mut created = None;
    for _ in 0..MEMO_TEMP_RETRIES {
        match open_new_memo_temp(path, file_name, &crate::store::new_id()) {
            Ok(value) => {
                created = Some(value);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("메모 임시 파일 생성 실패: {error}")),
        }
    }
    let Some((tmp, mut file)) = created else {
        return Err("메모 임시 파일 이름 충돌이 반복되어 저장하지 못했습니다".into());
    };
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&tmp);
        return Err(format!("메모 임시 파일 저장 실패: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("메모 저장 반영 실패: {error}"));
    }
    Ok(())
}

fn create_memo_file(
    cwd: &str,
    title: &str,
    markdown: &str,
    legacy_id: Option<&str>,
    timestamp: u64,
) -> Result<PlanMeta, String> {
    let title = normalize_memo_title(title)?;
    let markdown = normalize_memo_markdown(markdown)?;
    if let Some(id) = legacy_id {
        if !valid_memo_id(id) {
            return Err("기존 메모 식별자가 올바르지 않습니다".into());
        }
        if let Some((existing, _)) = scan_memo_docs(cwd)?
            .into_iter()
            .find(|(doc, _)| doc.id == id)
        {
            return Ok(plan_meta(&existing));
        }
    }
    let id = legacy_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("memo-{}", crate::store::new_id()));
    if !valid_memo_id(&id) {
        return Err("메모 식별자를 만들지 못했습니다".into());
    }
    let Some((root, dir)) = memo_dir(cwd, true)? else {
        return Err("메모 디렉터리를 만들지 못했습니다".into());
    };
    let path = dir.join(safe_memo_filename(&title, &id));
    if path.exists() {
        return Err("같은 메모 파일이 이미 존재합니다".into());
    }
    let content = format!(
        "{}\n\n{}",
        memo_header(&id, &title, timestamp, timestamp),
        markdown
    );
    atomic_write_memo(&path, &content)?;
    let rel = path
        .strip_prefix(&root)
        .map_err(|_| "메모 경로가 프로젝트 밖입니다".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(plan_meta(&PlanDoc {
        id,
        session_id: String::new(),
        created_ms: timestamp,
        title,
        text: markdown,
        path: rel,
        kind: MEMO_KIND.into(),
        updated_ms: timestamp,
    }))
}

fn delete_memo_file(cwd: &str, id: &str) -> Result<(), String> {
    if !valid_memo_id(id) {
        return Err("메모 식별자가 올바르지 않습니다".into());
    }
    let Some((doc, path)) = scan_memo_docs(cwd)?
        .into_iter()
        .find(|(doc, _)| doc.id == id)
    else {
        return Err("삭제할 메모를 찾을 수 없습니다".into());
    };
    if doc.kind != MEMO_KIND {
        return Err("메모 문서만 삭제할 수 있습니다".into());
    }
    fs::remove_file(path).map_err(|e| format!("메모를 삭제하지 못했습니다: {e}"))
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
    if let Ok(cwd_path) = validated_cwd(&cwd) {
        for rel in PLAN_DIRS {
            dirty |= scan_plan_dir(&cwd_path.join(rel), &cwd_path, 0, &mut store, &mut known);
        }
        dirty |= refresh_registered_plans(&cwd_path, &mut store);
    }

    dirty |= filter_dismissed_plans(&mut store);
    sort_and_limit_plans(&mut store);
    if dirty {
        let _ = save_store(&spath, &store);
    }
    let mut docs: Vec<PlanMeta> = store.plans.iter().map(plan_meta).collect();
    if let Ok(memos) = scan_memo_docs(&cwd) {
        docs.extend(memos.iter().map(|(doc, _)| plan_meta(doc)));
    }
    docs.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    docs
}

/// 계획 문서 본문 (열람 팝업용)
#[tauri::command]
pub async fn get_plan_doc(app: tauri::AppHandle, cwd: String, id: String) -> Option<PlanDoc> {
    let spath = store_path(&app, &cwd)?;
    let mut store = load_store(&spath);
    if store.dismissed_ids.contains(&id) {
        return scan_memo_docs(&cwd)
            .ok()?
            .into_iter()
            .find(|(doc, _)| doc.id == id)
            .map(|(doc, _)| doc);
    }
    if !store.manual_files.is_empty() {
        if let Ok(cwd_path) = validated_cwd(&cwd) {
            if refresh_registered_plans(&cwd_path, &mut store) {
                sort_and_limit_plans(&mut store);
                let _ = save_store(&spath, &store);
            }
        } else {
            let manual_ids: HashSet<String> = store
                .manual_files
                .iter()
                .map(|rel| file_plan_id(rel))
                .collect();
            store.plans.retain(|doc| !manual_ids.contains(&doc.id));
        }
    }
    if store.dismissed_ids.contains(&id) {
        return scan_memo_docs(&cwd)
            .ok()?
            .into_iter()
            .find(|(doc, _)| doc.id == id)
            .map(|(doc, _)| doc);
    }
    if let Some(doc) = store.plans.into_iter().find(|p| p.id == id) {
        return Some(doc);
    }
    scan_memo_docs(&cwd)
        .ok()?
        .into_iter()
        .find(|(doc, _)| doc.id == id)
        .map(|(doc, _)| doc)
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

/// 탐색기에서 드롭한 프로젝트 내부 Markdown 파일을 계획 문서 source-of-truth로 등록한다.
#[tauri::command]
pub async fn register_plan_file(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
) -> Result<PlanMeta, String> {
    let cwd_path = validated_cwd(&cwd)?;
    let requested = PathBuf::from(path);
    let requested = if requested.is_absolute() {
        requested
    } else {
        cwd_path.join(requested)
    };
    let spath =
        store_path(&app, &cwd).ok_or_else(|| "계획 저장소 경로를 만들 수 없습니다".to_string())?;
    let mut store = load_store(&spath);
    let meta = register_plan_in_store(&cwd_path, &requested, &mut store)?;
    save_store(&spath, &store)?;
    Ok(meta)
}

/// 계획을 앱의 문서 목록에서만 숨긴다. 연결된 원본 파일과 세션 기록은 보존한다.
#[tauri::command]
pub async fn dismiss_plan_doc(
    app: tauri::AppHandle,
    cwd: String,
    id: String,
) -> Result<(), String> {
    if !valid_plan_id(&id) {
        return Err("계획 문서 식별자가 올바르지 않습니다".into());
    }
    let spath =
        store_path(&app, &cwd).ok_or_else(|| "계획 저장소 경로를 만들 수 없습니다".to_string())?;
    let mut store = load_store(&spath);
    if let Ok(cwd_path) = validated_cwd(&cwd) {
        let _ = refresh_registered_plans(&cwd_path, &mut store);
    }
    if store.plans.iter().all(|doc| doc.id != id)
        && scan_memo_docs(&cwd)
            .unwrap_or_default()
            .iter()
            .any(|(doc, _)| doc.id == id)
    {
        return Err("메모는 메모 삭제 기능을 사용해야 합니다".into());
    }
    dismiss_plan_in_store(&mut store, &id)?;
    save_store(&spath, &store)
}

/// 사용자가 작성한 메모를 프로젝트 내부의 실제 Markdown 파일로 저장한다.
#[tauri::command]
pub async fn create_memo_doc(
    cwd: String,
    title: String,
    markdown: String,
    legacy_id: Option<String>,
) -> Result<PlanMeta, String> {
    create_memo_file(&cwd, &title, &markdown, legacy_id.as_deref(), now_ms())
}

/// 계획 문서는 삭제할 수 없고, 메모 전용 디렉터리에서 식별자가 일치한 파일만 제거한다.
#[tauri::command]
pub async fn delete_memo_doc(cwd: String, id: String) -> Result<(), String> {
    delete_memo_file(&cwd, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ta-memos-{label}-{}-{}",
            std::process::id(),
            crate::store::new_id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_doc(id: &str, kind: &str, path: &str) -> PlanDoc {
        PlanDoc {
            id: id.into(),
            session_id: "session-test".into(),
            created_ms: 1,
            title: "테스트 계획".into(),
            text: "자동 재수집 이후에도 목록 제거 상태를 유지해야 하는 충분히 긴 테스트 본문이다."
                .into(),
            path: path.into(),
            kind: kind.into(),
            updated_ms: 1,
        }
    }

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
        fs::create_dir_all(&tmp).unwrap();
        // macOS의 /var → /private/var 별칭도 실제 프로젝트 경로와 같은 기준으로 비교한다.
        let tmp = fs::canonicalize(&tmp).unwrap();
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

    #[test]
    fn manual_file_registers_and_refreshes_same_id() {
        let project = temp_project("manual-plan-refresh");
        let cwd = fs::canonicalize(&project).unwrap();
        let file = project.join("custom-plan.md");
        fs::write(
            &file,
            "# 첫 계획\n\n프로젝트 내부 Markdown 파일을 수동 계획으로 등록하는 충분히 긴 본문이다.",
        )
        .unwrap();
        let mut store = PlanStore::default();
        let first = register_plan_in_store(&cwd, &file, &mut store).unwrap();
        assert_eq!(first.path, "custom-plan.md");
        assert!(store.manual_files.contains("custom-plan.md"));

        fs::write(
            &file,
            "# 수정 계획\n\n같은 원본 파일을 수정하면 동일한 식별자로 본문과 제목이 갱신되어야 한다.",
        )
        .unwrap();
        assert!(refresh_registered_plans(&cwd, &mut store));
        assert_eq!(store.plans.len(), 1);
        assert_eq!(store.plans[0].id, first.id);
        assert_eq!(store.plans[0].title, "수정 계획");
        assert!(store.plans[0].text.contains("동일한 식별자"));

        fs::remove_file(&file).unwrap();
        assert!(refresh_registered_plans(&cwd, &mut store));
        assert!(store.plans.is_empty());
        assert!(store.manual_files.is_empty());
        assert!(!store.disk.contains_key("custom-plan.md"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn manual_file_and_automatic_plan_dir_do_not_duplicate() {
        let project = temp_project("manual-plan-dedupe");
        let cwd = fs::canonicalize(&project).unwrap();
        let dir = project.join(".omc").join("plans");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("same.md");
        fs::write(
            &file,
            "# 중복 없는 계획\n\n자동 계획 폴더와 수동 드롭 등록이 같은 문서를 한 번만 보여야 한다.",
        )
        .unwrap();
        let mut store = PlanStore::default();
        let mut known = HashSet::new();
        assert!(scan_plan_dir(&dir, &cwd, 0, &mut store, &mut known));
        let automatic_id = store.plans[0].id.clone();
        let manual = register_plan_in_store(&cwd, &file, &mut store).unwrap();
        assert_eq!(manual.id, automatic_id);
        assert_eq!(store.plans.len(), 1);
        assert!(store.manual_files.contains(".omc/plans/same.md"));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn dismissed_session_and_selection_plans_only_return_after_explicit_save() {
        let mut store = PlanStore::default();
        let session = test_doc("sessionabc123", PLAN_KIND, "");
        store.plans.push(session.clone());
        dismiss_plan_in_store(&mut store, &session.id).unwrap();
        assert!(store.dismissed_ids.contains(&session.id));

        // 세션 자동 추출이 같은 항목을 다시 넣어도 tombstone 필터가 제거한다.
        store.plans.push(session.clone());
        assert!(filter_dismissed_plans(&mut store));
        assert!(store.plans.is_empty());
        assert!(store.dismissed_ids.contains(&session.id));

        let text = "1. 입력 흐름 수정\n2. 회귀 테스트 추가\n3. 실제 앱 동작 검증";
        let saved = insert_manual_plan(&mut store, "session-test".into(), text.into(), 10).unwrap();
        dismiss_plan_in_store(&mut store, &saved.id).unwrap();
        let restored =
            insert_manual_plan(&mut store, "session-test".into(), text.into(), 20).unwrap();
        assert_eq!(restored.id, saved.id);
        assert!(!store.dismissed_ids.contains(&saved.id));
        assert!(store.plans.iter().any(|doc| doc.id == saved.id));
    }

    #[test]
    fn dismissed_file_plan_stays_hidden_until_manual_reregister() {
        let project = temp_project("dismissed-file-plan");
        let cwd = fs::canonicalize(&project).unwrap();
        let dir = project.join(".omc").join("plans");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hidden.md");
        fs::write(
            &file,
            "# 숨길 계획\n\n자동 스캔 파일을 목록에서 제거해도 실제 원본은 그대로 남아야 한다.",
        )
        .unwrap();
        let mut store = PlanStore::default();
        let registered = register_plan_in_store(&cwd, &file, &mut store).unwrap();
        dismiss_plan_in_store(&mut store, &registered.id).unwrap();
        assert!(file.exists());
        assert!(store.manual_files.is_empty());
        assert!(!store.disk.contains_key(".omc/plans/hidden.md"));

        fs::write(
            &file,
            "# 수정해도 숨김\n\n원본 파일의 내용이 바뀌고 자동 스캔되어도 목록에는 다시 나타나지 않아야 한다.",
        )
        .unwrap();
        let mut known = HashSet::new();
        assert!(scan_plan_dir(&dir, &cwd, 0, &mut store, &mut known));
        assert!(filter_dismissed_plans(&mut store));
        assert!(store.plans.is_empty());
        assert!(fs::read_to_string(&file).unwrap().contains("수정해도 숨김"));

        let restored = register_plan_in_store(&cwd, &file, &mut store).unwrap();
        assert_eq!(restored.id, registered.id);
        assert!(!store.dismissed_ids.contains(&registered.id));
        assert!(store.plans.iter().any(|doc| doc.id == registered.id));
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn dismiss_rejects_memo_and_memo_delete_does_not_touch_plan_file() {
        let mut store = PlanStore::default();
        store
            .plans
            .push(test_doc("memo-collision", MEMO_KIND, "memo.md"));
        assert!(dismiss_plan_in_store(&mut store, "memo-collision").is_err());
        assert_eq!(store.plans.len(), 1);
        assert!(store.dismissed_ids.is_empty());

        let project = temp_project("delete-plan-as-memo");
        let plan = project.join("plan.md");
        fs::write(
            &plan,
            "# 계획\n\n메모 삭제 API가 계획 원본을 제거해서는 안 된다.",
        )
        .unwrap();
        let cwd = project.to_string_lossy().into_owned();
        assert!(delete_memo_file(&cwd, "f1234567890abcdef").is_err());
        assert!(plan.exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn manual_file_rejects_invalid_sources() {
        let project = temp_project("manual-plan-invalid");
        let outside_dir = temp_project("manual-plan-outside");
        let cwd = fs::canonicalize(&project).unwrap();
        let outside = outside_dir.join("outside.md");
        fs::write(
            &outside,
            "# 외부 계획\n\n프로젝트 밖의 충분히 긴 Markdown 파일은 등록할 수 없어야 한다.",
        )
        .unwrap();
        let directory = project.join("folder.md");
        fs::create_dir_all(&directory).unwrap();
        let text_file = project.join("plan.txt");
        fs::write(
            &text_file,
            "# 잘못된 확장자\n\n내용이 길어도 md 파일이 아니면 거부되어야 한다.",
        )
        .unwrap();
        let short = project.join("short.md");
        fs::write(&short, "짧음").unwrap();
        let invalid_utf8 = project.join("binary.md");
        fs::write(&invalid_utf8, vec![0xff; 64]).unwrap();
        let oversized = project.join("large.md");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(PLAN_FILE_MAX_BYTES + 1)
            .unwrap();
        let uppercase = project.join("UPPER.MD");
        fs::write(
            &uppercase,
            "# 대문자 확장자\n\n대소문자와 관계없이 Markdown 확장자를 허용해야 하는 충분히 긴 본문이다.",
        )
        .unwrap();
        assert!(read_registered_plan(&cwd, &uppercase).is_ok());

        for invalid in [
            &outside,
            &directory,
            &text_file,
            &short,
            &invalid_utf8,
            &oversized,
        ] {
            assert!(
                read_registered_plan(&cwd, invalid).is_err(),
                "{}",
                invalid.display()
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = project.join("external-link.md");
            symlink(&outside, &link).unwrap();
            assert!(read_registered_plan(&cwd, &link).is_err());
        }

        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(outside_dir);
    }

    #[cfg(unix)]
    #[test]
    fn manual_file_rejects_internal_symlink_and_removes_replaced_registration() {
        use std::os::unix::fs::symlink;

        let project = temp_project("manual-plan-internal-symlink");
        let cwd = fs::canonicalize(&project).unwrap();
        let target = project.join("target.md");
        fs::write(
            &target,
            "# 내부 원본\n\n프로젝트 안의 정상 파일이어도 링크 자체는 수동 계획으로 등록할 수 없다.",
        )
        .unwrap();
        let link = project.join("linked.md");
        symlink(&target, &link).unwrap();
        assert!(read_registered_plan(&cwd, &link).is_err());

        let registered = project.join("registered.md");
        fs::write(
            &registered,
            "# 등록 계획\n\n처음에는 일반 파일이므로 수동 계획 문서로 정상 등록되어야 한다.",
        )
        .unwrap();
        let mut store = PlanStore::default();
        register_plan_in_store(&cwd, &registered, &mut store).unwrap();
        assert!(store.manual_files.contains("registered.md"));

        fs::remove_file(&registered).unwrap();
        symlink(&target, &registered).unwrap();
        assert!(refresh_registered_plans(&cwd, &mut store));
        assert!(store.manual_files.is_empty());
        assert!(store.plans.is_empty());
        assert!(!store.disk.contains_key("registered.md"));
        assert!(target.exists());

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn old_plan_doc_defaults_to_plan_kind() {
        let raw = r#"{
            "id":"old","sessionId":"s","createdMs":10,
            "title":"이전 계획","text":"본문","path":""
        }"#;
        let doc: PlanDoc = serde_json::from_str(raw).unwrap();
        assert_eq!(doc.kind, PLAN_KIND);
        assert_eq!(doc.updated_ms, 0);
        assert_eq!(plan_meta(&doc).updated_ms, 10);
        let meta: PlanMeta = serde_json::from_str(
            r#"{"id":"old","sessionId":"s","createdMs":10,"title":"이전 계획","path":"","updatedMs":10}"#,
        )
        .unwrap();
        assert_eq!(meta.kind, PLAN_KIND);
        let store: PlanStore =
            serde_json::from_str(r#"{"files":{},"disk":{},"plans":[]}"#).unwrap();
        assert!(store.manual_files.is_empty());
        assert!(store.dismissed_ids.is_empty());
    }

    #[test]
    fn memo_header_roundtrip_preserves_safe_metadata() {
        let title = "배포 --> 확인 / 메모";
        let raw = format!(
            "{}\n\n# 본문\n<span style=\"color:red\">색</span>\n",
            memo_header("legacy-safe_1", title, 10, 20)
        );
        let doc = parse_memo_file(&raw, ".terminal-assistance/memos/a.md".into()).unwrap();
        assert_eq!(doc.id, "legacy-safe_1");
        assert_eq!(doc.title, title);
        assert_eq!(doc.created_ms, 10);
        assert_eq!(doc.updated_ms, 20);
        assert_eq!(doc.kind, MEMO_KIND);
        assert!(doc.text.starts_with("# 본문"));
    }

    #[test]
    fn memo_create_is_idempotent_and_delete_is_scoped() {
        let project = temp_project("roundtrip");
        let cwd = project.to_string_lossy().into_owned();
        let first = create_memo_file(
            &cwd,
            "첫 메모",
            "# 본문\n\n안전하게 저장한다.",
            Some("legacy-abc_123"),
            100,
        )
        .unwrap();
        let second = create_memo_file(
            &cwd,
            "다시 시도",
            "중복 생성되면 안 된다.",
            Some("legacy-abc_123"),
            200,
        )
        .unwrap();
        assert_eq!(first.id, second.id);
        let docs = scan_memo_docs(&cwd).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].0.title, "첫 메모");
        assert!(docs[0].0.path.starts_with(".terminal-assistance/memos/"));
        assert!(create_memo_file(&cwd, "제목", "본문", Some("../escape"), 1).is_err());
        assert!(delete_memo_file(&cwd, "없는-plan-id").is_err());
        delete_memo_file(&cwd, "legacy-abc_123").unwrap();
        assert!(scan_memo_docs(&cwd).unwrap().is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn memo_scan_does_not_hide_document_after_many_non_memo_files() {
        let project = temp_project("many-noise-files");
        let cwd = project.to_string_lossy().into_owned();
        let memo_dir = project.join(".terminal-assistance").join("memos");
        fs::create_dir_all(&memo_dir).unwrap();
        // 필터 전에 500개 상한을 적용하던 구현에서 정상 메모가 누락될 수 있던 상황을 재현한다.
        for index in 0..520 {
            fs::write(memo_dir.join(format!("noise-{index:04}.txt")), b"noise").unwrap();
        }
        let created = create_memo_file(
            &cwd,
            "대량 파일 뒤 메모",
            "# 정상 메모\n\n비메모 파일 수와 관계없이 접근되어야 한다.",
            Some("legacy-after-noise"),
            100,
        )
        .unwrap();

        let docs = scan_memo_docs(&cwd).unwrap();
        assert!(docs.iter().any(|(doc, _)| doc.id == created.id));
        delete_memo_file(&cwd, &created.id).unwrap();
        assert!(!scan_memo_docs(&cwd)
            .unwrap()
            .iter()
            .any(|(doc, _)| doc.id == created.id));

        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn memo_limits_title_and_markdown() {
        let project = temp_project("limits");
        let cwd = project.to_string_lossy().into_owned();
        assert!(create_memo_file(&cwd, "", "본문", None, 1).is_err());
        assert!(create_memo_file(&cwd, &"가".repeat(TITLE_CAP + 1), "본문", None, 1).is_err());
        assert!(create_memo_file(
            &cwd,
            "제목",
            &"a".repeat(MEMO_MARKDOWN_MAX_BYTES + 1),
            None,
            1
        )
        .is_err());
        let _ = fs::remove_dir_all(project);
    }

    #[cfg(unix)]
    #[test]
    fn memo_directory_symlink_cannot_escape_project() {
        use std::os::unix::fs::symlink;
        let project = temp_project("symlink-project");
        let outside = temp_project("symlink-outside");
        symlink(&outside, project.join(".terminal-assistance")).unwrap();
        let cwd = project.to_string_lossy().into_owned();
        assert!(create_memo_file(&cwd, "제목", "본문", None, 1).is_err());
        assert!(!outside.join("memos").exists());
        let _ = fs::remove_file(project.join(".terminal-assistance"));
        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn memo_temp_create_new_does_not_follow_symlink_trap() {
        use std::os::unix::fs::symlink;
        let project = temp_project("temp-symlink-project");
        let outside = temp_project("temp-symlink-outside").join("target.txt");
        fs::write(&outside, "외부 원본").unwrap();
        let final_path = project.join("memo.md");
        let trap = project.join(".memo.md.trap.tmp");
        symlink(&outside, &trap).unwrap();

        let error = open_new_memo_temp(&final_path, "memo.md", "trap").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "외부 원본");
        assert!(fs::symlink_metadata(&trap)
            .unwrap()
            .file_type()
            .is_symlink());

        let outside_dir = outside.parent().unwrap().to_path_buf();
        let _ = fs::remove_file(trap);
        let _ = fs::remove_dir_all(project);
        let _ = fs::remove_dir_all(outside_dir);
    }
}
