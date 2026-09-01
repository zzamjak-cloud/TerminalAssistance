// 탐색기: 프로젝트 파일 트리(지연 로딩) + git 변경 상태 + 미리보기용 텍스트 읽기.
// 렌더러에는 fs 플러그인이 없으므로 파일 접근은 전부 이 모듈의 커맨드를 거친다.
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;

const PREVIEW_CAP: u64 = 2 * 1024 * 1024; // 미리보기 텍스트 읽기 상한 (2MB)

fn is_unity_meta_file_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".meta")
}

fn is_unity_meta_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(is_unity_meta_file_name)
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

/// 디렉토리 1단계 목록 — 트리에서 폴더를 펼칠 때마다 호출하는 지연 로딩.
/// async 커맨드 → 워커 스레드 실행이라 대형 폴더(node_modules 등)도 UI 를 막지 않는다.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| format!("폴더를 읽을 수 없습니다: {}", e))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for e in rd.flatten() {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_dir && is_unity_meta_file_name(&name) {
            continue;
        }
        out.push(DirEntry {
            name,
            path: e.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    // 폴더 우선 + 이름순(대소문자 무시) — 일반 코드 에디터와 같은 정렬
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 터미널 파일 링크용: cwd 기준 상대 경로를 실제 파일로 해석한다.
/// ① cwd/rel 이 존재하면 그대로. ② 구분자 없는 단독 파일명이면 프로젝트를 너비 우선
/// 탐색해 가장 얕은 동명 파일을 찾는다 (숨김 폴더·의존성/빌드 폴더 제외, 비용 상한 있음).
#[tauri::command]
pub async fn resolve_project_file(cwd: String, rel: String) -> Option<String> {
    let root = Path::new(&cwd);
    if !root.is_dir() || rel.is_empty() {
        return None;
    }
    let direct = root.join(&rel);
    if direct.is_file() {
        return Some(direct.to_string_lossy().into_owned());
    }
    // 구분자가 있는 경로는 직접 대응이 전부 — 파일명 검색은 단독 이름만 수행한다
    if rel.contains('/') || rel.contains('\\') {
        return None;
    }
    let want = rel.to_lowercase();
    const SKIP_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        "out",
        "vendor",
        "library", // Unity Library/Temp/Obj — 대형 생성물 폴더
        "temp",
        "obj",
        "logs",
    ];
    const MAX_DEPTH: usize = 6;
    const MAX_ENTRIES: usize = 30_000;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), 0usize));
    let mut seen = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return None; // 대형 프로젝트 안전판 — 못 찾은 것으로 처리
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth < MAX_DEPTH
                    && !name.starts_with('.')
                    && !SKIP_DIRS.contains(&name.to_lowercase().as_str())
                {
                    queue.push_back((e.path(), depth + 1));
                }
            } else if name.to_lowercase() == want {
                return Some(e.path().to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// OS 콘솔 창이 깜빡이지 않게 git 프로세스를 실행 (windows_subsystem 빌드 대응)
fn git_cmd(cwd: &str, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    // 자격증명 입력 프롬프트로 프로세스가 멈추지 않게 한다 (fetch/pull 이 네트워크를 탄다)
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(out.stdout)
}

#[derive(Serialize)]
pub struct GitStatus {
    /// 저장소 루트 (트리 노드의 절대 경로와 상대 경로를 잇는 기준)
    pub root: String,
    /// 저장소 상대 경로('/' 구분) → 상태 문자 (M 수정 / A 추가 / U 미추적 / D 삭제 / R 이름변경)
    pub files: HashMap<String, String>,
}

/// git 변경 파일 목록. 저장소가 아니거나 git 이 없으면 None (탐색기는 표시 생략).
#[tauri::command]
pub async fn git_status(cwd: String) -> Option<GitStatus> {
    let root = String::from_utf8_lossy(&git_cmd(&cwd, &["rev-parse", "--show-toplevel"])?)
        .trim()
        .to_string();
    // -z: 경로에 개행·공백이 있어도 안전, --untracked-files=all: 새 폴더도 파일 단위로 나열
    let out = git_cmd(
        &cwd,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    )?;
    let mut files = HashMap::new();
    let mut it = out.split(|&b| b == 0).filter(|s| !s.is_empty());
    while let Some(entry) = it.next() {
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry[0] as char, entry[1] as char);
        let path = String::from_utf8_lossy(&entry[3..]).into_owned();
        // 이름변경/복사는 다음 토큰이 원본 경로 — 소비만 하고 버린다
        if x == 'R' || x == 'C' {
            let _ = it.next();
        }
        if is_unity_meta_path(&path) {
            continue;
        }
        let status = match (x, y) {
            ('?', '?') => 'U',
            ('!', '!') => continue, // ignored 는 표시하지 않는다
            // 워크트리 상태(Y) 우선, 스테이지만 된 경우 인덱스 상태(X)
            _ => {
                if y != ' ' {
                    y
                } else {
                    x
                }
            }
        };
        files.insert(path, status.to_string());
    }
    Some(GitStatus { root, files })
}

/// 원격 대비 로컬 브랜치 상태 (헤더 Pull 버튼 표시용)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteState {
    /// 현재 브랜치명 (detached HEAD 면 빈 문자열)
    pub branch: String,
    /// 업스트림 추적 브랜치가 설정되어 있는지 (없으면 pull 대상이 없다)
    pub has_upstream: bool,
    /// 원격에만 있는 커밋 수 = pull 로 받아야 할 개수
    pub behind: u32,
    /// 로컬에만 있는 커밋 수 (툴팁 참고용)
    pub ahead: u32,
    /// fetch 를 시도했고 실패했는지 (오프라인·인증 필요 등)
    pub fetch_failed: bool,
}

/// git 저장소 여부 + 원격과의 커밋 격차를 센다.
/// 저장소가 아니거나 git 이 없으면 None — 프론트는 Pull 버튼 자체를 감춘다.
/// `fetch=true` 면 네트워크를 타므로 세션 시작 등 명시적 시점에만 켠다.
#[tauri::command]
pub async fn git_remote_state(cwd: String, fetch: bool) -> Option<GitRemoteState> {
    // git 호출은 블로킹이라 async 런타임 스레드를 잡지 않도록 분리한다
    tauri::async_runtime::spawn_blocking(move || {
        // 저장소 여부 먼저 판정 — 아니면 버튼 비표시
        git_cmd(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
        let mut fetch_failed = false;
        if fetch {
            // 실패해도(오프라인·인증 필요) 로컬에 이미 받아둔 기준으로 카운트는 계속한다
            fetch_failed = git_cmd(&cwd, &["fetch", "--quiet", "--no-tags"]).is_none();
        }
        let branch = git_cmd(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .unwrap_or_default();
        let branch = if branch == "HEAD" { String::new() } else { branch };
        // "<behind>	<ahead>" — 업스트림이 없으면 명령이 실패하므로 그대로 판정에 쓴다
        let (has_upstream, behind, ahead) =
            match git_cmd(&cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
                Some(o) => {
                    let s = String::from_utf8_lossy(&o);
                    let mut it = s.split_whitespace();
                    let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    let a = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                    (true, b, a)
                }
                None => (false, 0, 0),
            };
        Some(GitRemoteState {
            branch,
            has_upstream,
            behind,
            ahead,
            fetch_failed,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Pull 실행 결과 (토스트 문구용)
#[derive(Serialize)]
pub struct GitPullResult {
    pub ok: bool,
    pub message: String,
}

/// `git pull --ff-only` 실행. 터미널 세션에 명령을 흘려보내지 않으므로
/// AI 에이전트가 돌고 있는 패널에서도 프롬프트를 방해하지 않는다.
#[tauri::command]
pub async fn git_pull(cwd: String) -> GitPullResult {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        // advice.* 안내문을 끄면 토스트에 실패 원인 한 줄만 남는다
        cmd.arg("-C")
            .arg(&cwd)
            .args(["-c", "advice.diverging=false", "pull", "--ff-only"]);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GCM_INTERACTIVE", "never");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
    })
    .await;
    let out = match res {
        Ok(Ok(o)) => o,
        _ => {
            return GitPullResult {
                ok: false,
                message: "git 실행에 실패했습니다".into(),
            }
        }
    };
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = err;
    } else if !err.is_empty() {
        text = format!("{}
{}", text, err);
    }
    // 토스트 한 줄용 — diffstat 수십 줄 대신 요약/오류 줄만 골라낸다
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let keep: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| {
            let low = l.to_lowercase();
            low.starts_with("updating")
                || low.starts_with("fast-forward")
                || low.starts_with("already up to date")
                || low.contains("files changed")
                || low.contains("file changed")
                || low.starts_with("error")
                || low.starts_with("fatal")
                || low.starts_with("conflict")
        })
        .collect();
    // 아무것도 못 골랐으면 마지막 2줄로 대체 (예상 못 한 메시지도 보이게)
    let picked = if keep.is_empty() {
        lines[lines.len().saturating_sub(2)..].to_vec()
    } else {
        keep
    };
    let mut message = picked.join(" / ");
    // 토스트 한 줄에 들어가도록 길이를 제한한다
    if message.chars().count() > 220 {
        message = message.chars().take(220).collect::<String>() + "…";
    }
    GitPullResult {
        ok: out.status.success(),
        message: if message.is_empty() {
            "완료".into()
        } else {
            message
        },
    }
}

/// 미리보기용 텍스트 파일 읽기. 바이너리(NUL 포함)면 오류 — 프론트가 '미지원' 안내로 처리.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<serde_json::Value, String> {
    let md = fs::metadata(&path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
    if !md.is_file() {
        return Err("파일이 아닙니다".into());
    }
    let mut f = fs::File::open(&path).map_err(|e| format!("파일을 열 수 없습니다: {}", e))?;
    let want = md.len().min(PREVIEW_CAP) as usize;
    let mut buf = vec![0u8; want];
    let mut read = 0;
    while read < want {
        match f.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(e) => return Err(format!("읽기 실패: {}", e)),
        }
    }
    buf.truncate(read);
    // 앞부분에 NUL 이 있으면 텍스트가 아니라고 판단 (일반적인 바이너리 판별 휴리스틱)
    if buf.iter().take(8000).any(|&b| b == 0) {
        return Err("텍스트 파일이 아닙니다".into());
    }
    let content = String::from_utf8_lossy(&buf).into_owned();
    Ok(serde_json::json!({
        "content": content,
        "truncated": md.len() > PREVIEW_CAP,
        "size": md.len()
    }))
}

/// 탐색기 편집기 저장 — 임시 파일에 쓴 뒤 rename 으로 갈아끼워 중간 상태를 남기지 않는다.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        return Err("폴더에는 저장할 수 없습니다".into());
    }
    let dir = p.parent().ok_or("상위 폴더를 찾을 수 없습니다")?;
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("파일 이름이 올바르지 않습니다")?;
    let tmp = dir.join(format!(".{name}.ta-tmp"));
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("임시 파일 저장 실패: {}", e))?;
    if let Err(e) = fs::rename(&tmp, p) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("저장 반영 실패: {}", e));
    }
    Ok(())
}

/// 탐색기 '+' 버튼 — 지정한 폴더에 빈 파일을 만든다. 이미 있으면 오류(덮어쓰기 방지).
#[tauri::command]
pub async fn create_file(dir: String, name: String) -> Result<String, String> {
    let name = name.trim();
    valid_entry_name(name)?;
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Err("대상 폴더가 없습니다".into());
    }
    let target = base.join(name);
    if target.exists() {
        return Err("같은 이름의 파일이 이미 있습니다".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("파일을 만들 수 없습니다: {}", e))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 탐색기 컨텍스트 메뉴 '삭제하기' — 파일만 지운다(폴더는 거부). 되돌릴 수 없으므로
/// 프론트에서 2단계 확인을 거친 뒤에만 호출한다.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let md = fs::metadata(p).map_err(|e| format!("파일을 찾을 수 없습니다: {}", e))?;
    if md.is_dir() {
        return Err("폴더는 삭제할 수 없습니다".into());
    }
    fs::remove_file(p).map_err(|e| format!("삭제하지 못했습니다: {}", e))
}

/// 탐색기 '새로 만들기' — 폴더 생성. 이미 있으면 오류.
#[tauri::command]
pub async fn create_dir(dir: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if let Err(e) = valid_entry_name(name) {
        return Err(e);
    }
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Err("대상 폴더가 없습니다".into());
    }
    let target = base.join(name);
    if target.exists() {
        return Err("같은 이름의 항목이 이미 있습니다".into());
    }
    fs::create_dir(&target).map_err(|e| format!("폴더를 만들 수 없습니다: {}", e))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 탐색기 드래그 이동 · F2 이름 변경 공통 — from 을 to 로 옮긴다(덮어쓰기 금지).
#[tauri::command]
pub async fn move_path(from: String, to: String) -> Result<String, String> {
    let src = Path::new(&from);
    let dst = Path::new(&to);
    if !src.exists() {
        return Err("원본을 찾을 수 없습니다".into());
    }
    if src == dst {
        return Ok(to);
    }
    // 대소문자만 다른 이름 변경(macOS/Windows 의 대소문자 무시 파일시스템)은 exists() 가
    // 참이라 덮어쓰기로 오인된다 — 경로가 다르면서 실제로 같은 항목인 경우만 통과시킨다.
    let same_entry = dst.exists()
        && fs::canonicalize(src).ok() == fs::canonicalize(dst).ok()
        && fs::canonicalize(src).is_ok();
    if dst.exists() && !same_entry {
        return Err("대상 위치에 같은 이름이 이미 있습니다".into());
    }
    let parent = dst.parent().ok_or("대상 폴더를 찾을 수 없습니다")?;
    if !parent.is_dir() {
        return Err("대상 폴더가 없습니다".into());
    }
    // 폴더를 자기 자신의 하위로 옮기면 트리가 끊긴다
    if src.is_dir() {
        if let (Ok(s), Ok(p)) = (fs::canonicalize(src), fs::canonicalize(parent)) {
            if p.starts_with(&s) {
                return Err("폴더를 자기 하위로 옮길 수 없습니다".into());
            }
        }
    }
    fs::rename(src, dst).map_err(|e| format!("옮기지 못했습니다: {}", e))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 새 파일·폴더 이름과 F2 이름 변경에 공통으로 쓰는 검사 (경로 구분자·특수 이름 금지)
fn valid_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("이름을 입력하세요".into());
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("이름에 경로 구분자를 쓸 수 없습니다".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn porcelain_status_mapping() {
        // ('?','?')→U, 워크트리 우선, 스테이지 전용은 인덱스 문자
        let pick = |x: char, y: char| match (x, y) {
            ('?', '?') => 'U',
            _ => {
                if y != ' ' {
                    y
                } else {
                    x
                }
            }
        };
        assert_eq!(pick('?', '?'), 'U');
        assert_eq!(pick(' ', 'M'), 'M');
        assert_eq!(pick('M', ' '), 'M');
        assert_eq!(pick('A', ' '), 'A');
        assert_eq!(pick('A', 'M'), 'M');
    }

    #[test]
    fn unity_meta_file_detection() {
        assert!(super::is_unity_meta_file_name("Player.prefab.meta"));
        assert!(super::is_unity_meta_path("Assets/Scenes/Main.unity.meta"));
        assert!(!super::is_unity_meta_file_name("metadata.json"));
        assert!(!super::is_unity_meta_path("Assets/MetaFolder/Scene.unity"));
    }
}
