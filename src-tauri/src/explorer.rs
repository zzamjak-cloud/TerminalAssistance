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

/// OS 콘솔 창이 깜빡이지 않게 git 프로세스를 실행 (windows_subsystem 빌드 대응).
/// 성공(exit 0) 시에만 stdout 을 돌려준다 — 실패 사유가 필요하면 `git_cmd_full` 을 쓴다.
pub(crate) fn git_cmd(cwd: &str, args: &[&str]) -> Option<Vec<u8>> {
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

/// `git_cmd` 와 같은 실행 조건이되 실패 사유(stderr)까지 돌려준다.
/// 워크트리 생성·제거처럼 사용자에게 실패 원인을 그대로 보여줘야 하는 곳에서 쓴다.
pub(crate) fn git_cmd_full(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git 을 실행할 수 없습니다: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // git 은 실패 사유를 stderr 에 쓰지만, 비어 있으면 stdout 이라도 보여준다
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[derive(Serialize)]
pub struct GitStatus {
    /// 저장소 루트 (트리 노드의 절대 경로와 상대 경로를 잇는 기준)
    pub root: String,
    /// 저장소 상대 경로('/' 구분) → 상태 문자 (M 수정 / A 추가 / U 미추적 / D 삭제 / R 이름변경)
    pub files: HashMap<String, String>,
}

/// `git status --porcelain -z` 를 (저장소 상대 경로, X=인덱스 상태, Y=워크트리 상태) 로 읽는다.
/// ignored(`!!`) 는 제외하고, 이름변경·복사의 원본 경로 토큰은 소비만 하고 버린다.
/// 탐색기 표시와 pull 되돌리기가 같은 판정을 쓰도록 한 곳에 모아 둔다.
fn porcelain_entries(cwd: &str) -> Option<Vec<(String, char, char)>> {
    // -z: 경로에 개행·공백이 있어도 안전, --untracked-files=all: 새 폴더도 파일 단위로 나열
    // core.quotepath=false: 한글 등 비ASCII 경로가 8진 이스케이프로 오지 않게 한다
    let out = git_cmd(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    let mut entries = Vec::new();
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
        if x == '!' && y == '!' {
            continue; // ignored 는 표시하지 않는다
        }
        entries.push((path, x, y));
    }
    Some(entries)
}

/// 탐색기·팝업 표시용 상태 문자 (M 수정 / A 추가 / D 삭제 / R 이름변경 / U 미추적).
fn display_status(x: char, y: char) -> char {
    if x == '?' && y == '?' {
        return 'U';
    }
    // 워크트리 상태(Y) 우선, 스테이지만 된 경우 인덱스 상태(X)
    if y != ' ' {
        y
    } else {
        x
    }
}

/// git 변경 파일 목록. 저장소가 아니거나 git 이 없으면 None (탐색기는 표시 생략).
#[tauri::command]
pub async fn git_status(cwd: String) -> Option<GitStatus> {
    let root = String::from_utf8_lossy(&git_cmd(&cwd, &["rev-parse", "--show-toplevel"])?)
        .trim()
        .to_string();
    let mut files = HashMap::new();
    for (path, x, y) in porcelain_entries(&cwd)? {
        if is_unity_meta_path(&path) {
            continue;
        }
        files.insert(path, display_status(x, y).to_string());
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

/// pull 을 막은 파일 하나 — 팝업 목록의 한 줄.
#[derive(Serialize)]
pub struct GitBlockedFile {
    /// 저장소 루트 기준 상대 경로 ('/' 구분)
    pub path: String,
    /// 표시용 상태 문자 (M 수정 / A 추가 / D 삭제 / U 미추적 / ? 판정 불가)
    pub status: String,
    /// 미추적 파일 — '되돌리기'가 복원이 아니라 삭제가 된다
    pub untracked: bool,
}

/// Pull 실행 결과. 실패 시에는 원인 유형과 막은 파일 목록까지 실어 보내
/// 프론트가 토스트 대신 팝업으로 안내할 수 있게 한다.
#[derive(Serialize)]
pub struct GitPullResult {
    pub ok: bool,
    /// 한 줄 요약 (성공 토스트 · 팝업 헤더)
    pub message: String,
    /// 실패 유형 — "" 성공 / local_changes 로컬 수정 충돌 / untracked 미추적 파일 충돌
    /// / conflict 병합 충돌 / diverged 원격과 갈라짐 / other 그 밖의 실패
    pub kind: String,
    /// pull 을 막은 파일들 (유형에 따라 비어 있을 수 있다)
    pub files: Vec<GitBlockedFile>,
    /// git 원본 출력 — 팝업의 '원본 출력 보기'
    pub raw: String,
}

/// `git pull --ff-only` 실행. 터미널 세션에 명령을 흘려보내지 않으므로
/// AI 에이전트가 돌고 있는 패널에서도 프롬프트를 방해하지 않는다.
#[tauri::command]
pub async fn git_pull(cwd: String) -> GitPullResult {
    let target = cwd.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        // advice.* 안내문을 끄면 요약 한 줄에 실패 원인만 남는다
        // core.quotepath=false: 실패 메시지의 비ASCII 경로를 그대로 받아 되돌리기에 쓴다
        cmd.arg("-C").arg(&target).args([
            "-c",
            "advice.diverging=false",
            "-c",
            "core.quotepath=false",
            "pull",
            "--ff-only",
        ]);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GCM_INTERACTIVE", "never");
        // 실패 메시지를 문장 패턴으로 파싱하므로 로케일을 영어로 고정한다
        cmd.env("LC_ALL", "C");
        cmd.env("LANG", "C");
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
                kind: "other".into(),
                files: Vec::new(),
                raw: String::new(),
            }
        }
    };
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = err;
    } else if !err.is_empty() {
        text = format!("{}\n{}", text, err);
    }
    let ok = out.status.success();
    let message = summarize_pull_output(&text, ok);
    let (kind, paths) = if ok {
        (String::new(), Vec::new())
    } else {
        parse_pull_blockers(&text)
    };
    let files = if paths.is_empty() {
        Vec::new()
    } else {
        describe_blocked_files(&cwd, paths).await
    };
    GitPullResult {
        ok,
        message: if message.is_empty() {
            "완료".into()
        } else {
            message
        },
        kind,
        files,
        raw: text,
    }
}

/// pull 실패 출력에서 뽑은 경로들에 현재 워크트리 상태(M/A/D/U)를 붙인다.
/// 상태를 못 읽으면 '?' 로 남기고 추적 파일로 취급한다 — 되돌리기가 삭제로 오작동하지 않게.
async fn describe_blocked_files(cwd: &str, paths: Vec<String>) -> Vec<GitBlockedFile> {
    let target = cwd.to_string();
    let entries = tauri::async_runtime::spawn_blocking(move || porcelain_entries(&target))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let mut by_path = HashMap::new();
    for (path, x, y) in entries {
        by_path.insert(path, (x, y));
    }
    paths
        .into_iter()
        .map(|path| match by_path.get(&path) {
            Some(&(x, y)) => GitBlockedFile {
                status: display_status(x, y).to_string(),
                untracked: x == '?',
                path,
            },
            None => GitBlockedFile {
                path,
                status: "?".into(),
                untracked: false,
            },
        })
        .collect()
}

/// pull 실패 출력에서 '무엇이 막았는지'를 읽어 (유형, 저장소 상대 경로들) 로 돌려준다.
/// git 의 실제 문구를 기준으로 한다:
///   - "error: Your local changes to the following files would be overwritten by merge:" + 들여쓴 목록
///   - "error: The following untracked working tree files would be overwritten by merge:" + 들여쓴 목록
///   - "error: Untracked working tree file 'x' would be overwritten by merge." (단일 파일 형태)
///   - "CONFLICT (content): Merge conflict in <path>"
///   - "fatal: Not possible to fast-forward, aborting." (파일이 아니라 갈라진 히스토리가 원인)
fn parse_pull_blockers(text: &str) -> (String, Vec<String>) {
    let mut kind = String::new();
    let mut paths: Vec<String> = Vec::new();
    let mut collecting = false;
    for line in text.lines() {
        let trimmed = line.trim();
        let low = trimmed.to_lowercase();
        // 목록 머리글 — 다음 줄부터 들여쓴 경로가 이어진다
        if low.ends_with(':') && low.contains("would be overwritten by") {
            if kind.is_empty() {
                kind = if low.contains("untracked") {
                    "untracked".into()
                } else {
                    "local_changes".into()
                };
            }
            collecting = true;
            continue;
        }
        if collecting {
            // 들여쓰기가 곧 목록의 범위다 — "Please commit your changes..." 안내에서 끝난다
            if line.starts_with('\t') || line.starts_with("  ") {
                if !trimmed.is_empty() {
                    paths.push(trimmed.to_string());
                }
                continue;
            }
            collecting = false;
        }
        if let Some(rest) = trimmed.strip_prefix("CONFLICT") {
            kind = "conflict".into();
            if let Some(i) = rest.find(" in ") {
                let p = rest[i + 4..].trim();
                if !p.is_empty() {
                    paths.push(p.to_string());
                }
            }
            continue;
        }
        // 단일 파일 형태는 경로가 따옴표 안에 들어온다
        if low.contains("would be overwritten") {
            if let (Some(i), Some(j)) = (trimmed.find('\''), trimmed.rfind('\'')) {
                if j > i + 1 {
                    if kind.is_empty() {
                        kind = if low.contains("untracked") {
                            "untracked".into()
                        } else {
                            "local_changes".into()
                        };
                    }
                    paths.push(trimmed[i + 1..j].to_string());
                }
            }
            continue;
        }
        if kind.is_empty()
            && (low.contains("not possible to fast-forward")
                || low.contains("diverging branches")
                || low.contains("need to specify how to reconcile"))
        {
            kind = "diverged".into();
        }
    }
    if kind.is_empty() {
        kind = "other".into();
    }
    // 같은 경로가 여러 줄에 걸쳐 나올 수 있다 (목록 + 충돌 표시)
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    (kind, paths)
}

/// 되돌리기 결과 — 경로 단위로 성공/실패를 알려 준다 (일부만 실패해도 나머지는 반영됨).
#[derive(Serialize)]
pub struct GitDiscardResult {
    pub ok: bool,
    /// 되돌린 경로
    pub done: Vec<String>,
    /// 되돌리지 못한 경로와 사유
    pub failed: Vec<GitDiscardFailure>,
}

#[derive(Serialize)]
pub struct GitDiscardFailure {
    pub path: String,
    pub message: String,
}

/// 지정한 경로들의 로컬 수정을 버린다 (pull 충돌 팝업의 '되돌리기').
/// 복구할 수 없는 작업이므로 프론트에서 확인을 받은 뒤에만 호출한다.
///
/// 경로는 git 이 알려 준 저장소 루트 기준 상대 경로다. 세션 cwd 가 하위 폴더일 수 있으므로
/// 항상 저장소 루트에서 실행한다.
#[tauri::command]
pub async fn git_discard_paths(
    cwd: String,
    paths: Vec<String>,
) -> Result<GitDiscardResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git_cmd(&cwd, &["rev-parse", "--show-toplevel"])
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "git 저장소가 아닙니다".to_string())?;
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for path in paths {
            if let Err(message) = discard_one(&root, &path) {
                failed.push(GitDiscardFailure { path, message });
            } else {
                done.push(path);
            }
        }
        Ok(GitDiscardResult {
            ok: failed.is_empty(),
            done,
            failed,
        })
    })
    .await
    .map_err(|e| format!("되돌리기를 실행할 수 없습니다: {e}"))?
}

/// 경로 한 개 되돌리기.
/// 스테이지에 올라간 변경까지 함께 버려야 pull 이 다시 진행되므로 인덱스를 먼저 되돌린다.
/// HEAD 에 없는 파일(새로 추가·미추적)은 복원할 원본이 없으니 삭제로 처리한다.
fn discard_one(root: &str, path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("빈 경로".into());
    }
    // 경로는 git 이 알려 준 저장소 상대 경로여야 한다 — 절대 경로·상위 참조는 거부
    if path.starts_with('/') || path.starts_with('\\') || path.contains("..") || path.contains(':')
    {
        return Err("저장소 안의 상대 경로가 아닙니다".into());
    }
    if git_cmd(root, &["cat-file", "-e", &format!("HEAD:{path}")]).is_some() {
        // 인덱스를 HEAD 로 되돌린 뒤 워크트리를 복원한다 (충돌 표시도 이 순서로 풀린다)
        git_cmd_full(root, &["reset", "-q", "HEAD", "--", path])?;
        git_cmd_full(root, &["checkout", "-q", "--", path])?;
        return Ok(());
    }
    // 미추적 또는 새로 추가된 파일 — 인덱스에서 내린 뒤 파일을 지운다
    let _ = git_cmd_full(root, &["reset", "-q", "HEAD", "--", path]);
    git_cmd_full(root, &["clean", "-q", "-f", "-d", "--", path])?;
    Ok(())
}

/// git pull 출력에서 토스트 한 줄에 담을 요약을 만든다.
/// 실패 시에는 원인 줄을 통째로 살린다 — 예전에는 "error:" 로 시작하는 첫 줄만 남겨서
/// 정작 중요한 대상 파일명과 해결 안내("Please commit your changes...")가 잘려나가고,
/// "Updating a..b" 진행 줄만 뒤에 붙어 실패인지 성공인지도 헷갈렸다.
fn summarize_pull_output(text: &str, ok: bool) -> String {
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let picked: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| {
            let low = l.to_lowercase();
            if ok {
                // 성공 시에는 diffstat 수십 줄 대신 요약 줄만 골라낸다
                low.starts_with("updating")
                    || low.starts_with("fast-forward")
                    || low.starts_with("already up to date")
                    || low.contains("files changed")
                    || low.contains("file changed")
            } else {
                // 실패 시에는 진행 상황·fetch 로그·CRLF 경고만 걷어내고 나머지를 모두 남긴다
                !(low.starts_with("updating")
                    || low.starts_with("fast-forward")
                    || low.starts_with("from ")
                    || low.starts_with("remote:")
                    || low.starts_with("warning:")
                    || low.starts_with("aborting")
                    || low.contains("->"))
            }
        })
        .collect();
    // 아무것도 못 골랐으면 마지막 2줄로 대체 (예상 못 한 메시지도 보이게)
    let picked = if picked.is_empty() {
        lines[lines.len().saturating_sub(2)..].to_vec()
    } else {
        picked
    };
    let mut message = picked.join(" / ");
    // 토스트 한 줄에 들어가도록 길이를 제한한다
    if message.chars().count() > 220 {
        message = message.chars().take(220).collect::<String>() + "…";
    }
    message
}

#[cfg(test)]
mod git_pull_tests {
    use super::{parse_pull_blockers, summarize_pull_output};

    /// 로컬 수정본 때문에 ff-only pull 이 거부됐을 때의 실제 git 출력
    #[test]
    fn failure_keeps_cause_file_and_hint() {
        let out = "From C:/tmp/up
   107263b..686d381  master     -> origin/master
error: Your local changes to the following files would be overwritten by merge:
	src/renderer/app.js
Please commit your changes or stash them before you merge.
Updating 107263b..686d381
Aborting";
        let m = summarize_pull_output(out, false);
        assert!(m.contains("src/renderer/app.js"), "대상 파일명이 사라졌다: {}", m);
        assert!(m.contains("stash"), "해결 안내가 사라졌다: {}", m);
        assert!(!m.contains("Updating"), "진행 줄이 실패 메시지에 섞였다: {}", m);
    }

    #[test]
    fn success_keeps_summary_only() {
        let out = "Updating accbe5e..285e9b0
Fast-forward
 CHANGELOG.md | 9 +
 11 files changed, 612 insertions(+), 6 deletions(-)";
        let m = summarize_pull_output(out, true);
        assert!(m.contains("Fast-forward"), "{}", m);
        assert!(m.contains("11 files changed"), "{}", m);
        assert!(!m.contains("CHANGELOG.md |"), "diffstat 줄이 남았다: {}", m);
    }

    #[test]
    fn already_up_to_date_passthrough() {
        assert_eq!(summarize_pull_output("Already up to date.", true), "Already up to date.");
    }

    #[test]
    fn unexpected_output_is_not_dropped() {
        let m = summarize_pull_output("fatal: not a git repository", false);
        assert!(m.contains("fatal"), "{}", m);
        assert_eq!(summarize_pull_output("", false), "");
    }

    /// 로컬 수정본이 막은 경우 — 파일 목록만 뽑고 안내 문구는 목록에 섞이지 않아야 한다
    #[test]
    fn blockers_from_local_changes_list() {
        let out = "From C:/tmp/up
   107263b..686d381  master     -> origin/master
error: Your local changes to the following files would be overwritten by merge:
\tsrc/renderer/app.js
\tsrc/renderer/styles.css
Please commit your changes or stash them before you merge.
Aborting";
        let (kind, paths) = parse_pull_blockers(out);
        assert_eq!(kind, "local_changes");
        assert_eq!(paths, vec!["src/renderer/app.js", "src/renderer/styles.css"]);
    }

    /// 실제 git 출력: 두 머리글이 한 번에 나올 수 있다 (수정 파일 + 미추적 파일)
    /// 두 목록의 파일이 모두 남아야 팝업에서 한 번에 정리할 수 있다
    #[test]
    fn blockers_from_both_lists() {
        let out = "From C:/tmp/up
   5205c15..ef333c7  master     -> origin/master
error: Your local changes to the following files would be overwritten by merge:
	a.txt
Please commit your changes or stash them before you merge.
error: The following untracked working tree files would be overwritten by merge:
	added.txt
Please move or remove them before you merge.
Updating 5205c15..ef333c7
Aborting";
        let (kind, paths) = parse_pull_blockers(out);
        assert_eq!(kind, "local_changes");
        assert_eq!(paths, vec!["a.txt", "added.txt"]);
    }

    /// 미추적 파일이 막은 경우 — 되돌리기가 삭제로 갈라지므로 유형이 구분돼야 한다
    #[test]
    fn blockers_from_untracked_list() {
        let out = "error: The following untracked working tree files would be overwritten by merge:
\tdocs/new.md
Please move or remove them before you merge.";
        let (kind, paths) = parse_pull_blockers(out);
        assert_eq!(kind, "untracked");
        assert_eq!(paths, vec!["docs/new.md"]);
    }

    /// 단일 파일 형태는 경로가 따옴표 안에 온다
    #[test]
    fn blockers_from_quoted_single_file() {
        let (kind, paths) =
            parse_pull_blockers("error: Untracked working tree file 'a/b.txt' would be overwritten by merge.");
        assert_eq!(kind, "untracked");
        assert_eq!(paths, vec!["a/b.txt"]);
    }

    /// 히스토리가 갈라진 실패는 파일 원인이 없다 — 팝업이 다른 안내를 해야 한다
    #[test]
    fn diverged_has_no_files() {
        let (kind, paths) = parse_pull_blockers("fatal: Not possible to fast-forward, aborting.");
        assert_eq!(kind, "diverged");
        assert!(paths.is_empty());
    }

    /// 병합 충돌 표시에서 경로를 뽑고, 목록과 중복돼도 한 번만 남는다
    #[test]
    fn conflict_paths_are_deduped() {
        let out = "error: Your local changes to the following files would be overwritten by merge:
\tsrc/a.js
CONFLICT (content): Merge conflict in src/a.js";
        let (kind, paths) = parse_pull_blockers(out);
        assert_eq!(kind, "conflict"); // 더 구체적인 신호가 유형을 덮는다
        assert_eq!(paths, vec!["src/a.js"]);
    }

    /// 예상 못 한 실패도 유형이 비지 않아야 한다 (팝업은 원본 출력으로 안내)
    #[test]
    fn unknown_failure_is_other() {
        let (kind, paths) = parse_pull_blockers("fatal: could not read Username for 'https://x'");
        assert_eq!(kind, "other");
        assert!(paths.is_empty());
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
