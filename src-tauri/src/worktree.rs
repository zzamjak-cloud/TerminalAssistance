// git 워크트리 런처 — 같은 저장소를 브랜치별 폴더로 펼쳐 AI 에이전트를 병렬로 돌리기 위한 백엔드.
// 앱은 워크트리를 "부모 프로젝트에 종속된 프로젝트"로 등록만 하고, 실제 소유는 git 이 한다.
// 여기서는 생성 모달에 필요한 저장소 정보 조회 / 생성 / 제거 전 안전 검사 / 제거만 담당한다.
use crate::explorer::{git_cmd, git_cmd_full};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 브랜치 하나 — 생성 모달의 목록 항목
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct BranchEntry {
    /// 표시·체크아웃에 쓰는 짧은 이름 (`main`, `origin/feat/x`)
    pub name: String,
    /// 원격 추적 브랜치인가
    pub remote: bool,
    /// 이미 다른 워크트리가 체크아웃 중이면 그 경로 (선택 불가로 표시)
    #[serde(rename = "checkedOutAt", skip_serializing_if = "Option::is_none")]
    pub checked_out_at: Option<String>,
}

/// `git worktree list --porcelain` 한 항목
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct WorktreeEntry {
    pub path: String,
    /// detached HEAD 면 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 이 항목이 저장소의 원본(메인) 워크트리인가 — 목록의 첫 항목
    pub main: bool,
}

#[derive(Serialize)]
pub struct RepoInfo {
    /// 저장소 루트 절대 경로
    pub root: String,
    /// 루트 폴더 이름 (기본 경로 제안에 쓴다)
    #[serde(rename = "repoName")]
    pub repo_name: String,
    /// 루트의 상위 폴더 — 형제 폴더 방식의 기본 생성 위치
    #[serde(rename = "parentDir")]
    pub parent_dir: String,
    #[serde(rename = "currentBranch", skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub branches: Vec<BranchEntry>,
    pub worktrees: Vec<WorktreeEntry>,
}

/// 제거 전 안전 검사 결과
#[derive(Serialize)]
pub struct WorktreeCheck {
    /// 경로가 실제로 이 저장소의 워크트리인가 (아니면 앱 등록만 지우면 된다)
    #[serde(rename = "isWorktree")]
    pub is_worktree: bool,
    /// 폴더 자체가 이미 사라졌는가
    pub missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 커밋되지 않은 변경 파일 수 (미추적 포함)
    #[serde(rename = "dirtyCount")]
    pub dirty_count: usize,
    /// 업스트림에 아직 올라가지 않은 커밋 수
    pub ahead: u32,
    /// 업스트림이 없는 브랜치 — ahead 를 셀 수 없으므로 별도로 경고한다
    #[serde(rename = "noUpstream")]
    pub no_upstream: bool,
}

// ── porcelain 파싱 (순수 함수 — 테스트 대상) ──

/// `git worktree list --porcelain` 출력을 항목 목록으로 바꾼다.
/// 항목은 빈 줄로 구분되며 첫 항목이 원본 워크트리다.
fn parse_worktree_porcelain(text: &str) -> Vec<WorktreeEntry> {
    let mut out: Vec<WorktreeEntry> = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;

    // 한 항목을 닫고 결과에 넣는다
    fn flush(out: &mut Vec<WorktreeEntry>, path: &mut Option<String>, branch: &mut Option<String>) {
        if let Some(p) = path.take() {
            let main = out.is_empty();
            out.push(WorktreeEntry {
                path: p,
                branch: branch.take(),
                main,
            });
        }
        *branch = None;
    }

    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut out, &mut path, &mut branch);
        } else if let Some(v) = line.strip_prefix("worktree ") {
            // 빈 줄 없이 다음 항목이 시작되는 경우도 방어한다
            flush(&mut out, &mut path, &mut branch);
            path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("branch ") {
            branch = Some(short_ref(v));
        }
        // HEAD / detached / locked / prunable 은 표시에 쓰지 않으므로 무시
    }
    flush(&mut out, &mut path, &mut branch);
    out
}

/// `refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`
fn short_ref(full: &str) -> String {
    let full = full.trim();
    for prefix in ["refs/heads/", "refs/remotes/"] {
        if let Some(rest) = full.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    full.to_string()
}

/// `git for-each-ref --format=%(refname)` 출력을 브랜치 목록으로 바꾼다.
/// 이미 체크아웃된 브랜치에는 그 워크트리 경로를 붙이고, `origin/HEAD` 같은 심볼릭 항목은 뺀다.
fn parse_branch_refs(text: &str, worktrees: &[WorktreeEntry]) -> Vec<BranchEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let full = line.trim();
        if full.is_empty() {
            continue;
        }
        let remote = full.starts_with("refs/remotes/");
        let name = short_ref(full);
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        let checked_out_at = worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some(name.as_str()))
            .map(|w| w.path.clone());
        out.push(BranchEntry {
            name,
            remote,
            checked_out_at,
        });
    }
    out
}

/// 경로 비교용 정규화 — 구분자를 '/' 로 맞추고 끝 슬래시를 뗀다.
/// (git 은 Windows 에서도 '/' 로 출력하지만 앱이 넘기는 경로는 '\' 일 수 있다)
fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let trimmed = s.trim_end_matches('/');
    if trimmed.is_empty() {
        s
    } else {
        trimmed.to_string()
    }
}

// ── 커맨드 ──

/// 생성 모달에 필요한 저장소 정보. git 저장소가 아니면 None (버튼 자체를 숨긴다).
#[tauri::command]
pub async fn repo_info(cwd: String) -> Option<RepoInfo> {
    let root_raw = String::from_utf8_lossy(&git_cmd(&cwd, &["rev-parse", "--show-toplevel"])?)
        .trim()
        .to_string();
    if root_raw.is_empty() {
        return None;
    }
    let root_path = PathBuf::from(&root_raw);
    let repo_name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let parent_dir = root_path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_raw.clone());

    let current_branch = git_cmd(&root_raw, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o).trim().to_string())
        .filter(|s| !s.is_empty());

    let worktrees = git_cmd(&root_raw, &["worktree", "list", "--porcelain"])
        .map(|o| parse_worktree_porcelain(&String::from_utf8_lossy(&o)))
        .unwrap_or_default();

    let branches = git_cmd(
        &root_raw,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .map(|o| parse_branch_refs(&String::from_utf8_lossy(&o), &worktrees))
    .unwrap_or_default();

    Some(RepoInfo {
        root: root_raw,
        repo_name,
        parent_dir,
        current_branch,
        branches,
        worktrees,
    })
}

/// 워크트리를 만든다. `create_new` 면 `-b <branch>` 로 새 브랜치를,
/// 아니면 기존 브랜치(`origin/x` 포함)를 체크아웃한다.
/// 성공하면 실제로 만들어진 경로를 돌려준다.
#[tauri::command]
pub async fn worktree_add(
    root: String,
    path: String,
    branch: String,
    create_new: bool,
    base: Option<String>,
) -> Result<String, String> {
    let branch = branch.trim().to_string();
    let path = path.trim().to_string();
    if branch.is_empty() {
        return Err("브랜치 이름을 입력하세요".into());
    }
    if path.is_empty() {
        return Err("워크트리 경로를 입력하세요".into());
    }
    let target = Path::new(&path);
    if target.exists() {
        return Err(format!("이미 존재하는 경로입니다: {path}"));
    }
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            return Err(format!(
                "상위 폴더가 없습니다: {}",
                parent.to_string_lossy()
            ));
        }
    }

    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if create_new {
        args.push("-b".into());
        args.push(branch.clone());
        args.push(path.clone());
        // 기준 커밋이 지정되면 그 지점에서 브랜치를 딴다 (없으면 현재 HEAD)
        if let Some(b) = base.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push(b.to_string());
        }
    } else {
        args.push(path.clone());
        args.push(branch.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_cmd_full(&root, &arg_refs)?;

    // git 이 만든 실제 경로를 확인해 돌려준다 (심볼릭 링크·대소문자 차이 흡수)
    let canonical = std::fs::canonicalize(&path)
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            // Windows 의 \\?\ 확장 접두사는 그대로 두면 다른 API 에서 걸린다
            s.strip_prefix(r"\\?\").map(|r| r.to_string()).unwrap_or(s)
        })
        .unwrap_or(path);
    Ok(canonical)
}

/// 제거 전 안전 검사 — 커밋 안 된 변경과 아직 올리지 않은 커밋을 센다.
#[tauri::command]
pub async fn worktree_check(root: String, path: String) -> WorktreeCheck {
    let missing = !Path::new(&path).exists();
    let target = norm_path(&path);
    let entry = git_cmd(&root, &["worktree", "list", "--porcelain"])
        .map(|o| parse_worktree_porcelain(&String::from_utf8_lossy(&o)))
        .unwrap_or_default()
        .into_iter()
        .find(|w| norm_path(&w.path) == target);

    let Some(entry) = entry else {
        return WorktreeCheck {
            is_worktree: false,
            missing,
            branch: None,
            dirty_count: 0,
            ahead: 0,
            no_upstream: false,
        };
    };

    // 폴더가 사라졌으면 그 안에서 git 을 돌릴 수 없다 — 등록 해제만 하면 된다
    if missing {
        return WorktreeCheck {
            is_worktree: true,
            missing: true,
            branch: entry.branch,
            dirty_count: 0,
            ahead: 0,
            no_upstream: false,
        };
    }

    let dirty_count = git_cmd(&path, &["status", "--porcelain", "--untracked-files=all"])
        .map(|o| {
            String::from_utf8_lossy(&o)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        })
        .unwrap_or(0);

    // 업스트림이 없으면 rev-list 가 실패한다 — 그 자체를 경고 근거로 삼는다
    let upstream = git_cmd(
        &path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .map(|o| String::from_utf8_lossy(&o).trim().to_string())
    .filter(|s| !s.is_empty());
    let (ahead, no_upstream) = match upstream {
        Some(_) => (
            git_cmd(&path, &["rev-list", "--count", "@{u}..HEAD"])
                .map(|o| {
                    String::from_utf8_lossy(&o)
                        .trim()
                        .parse::<u32>()
                        .unwrap_or(0)
                })
                .unwrap_or(0),
            false,
        ),
        None => (0, entry.branch.is_some()),
    };

    WorktreeCheck {
        is_worktree: true,
        missing: false,
        branch: entry.branch,
        dirty_count,
        ahead,
        no_upstream,
    }
}

/// 워크트리를 제거한다. 브랜치 자체는 지우지 않는다 (되돌릴 수 없으므로 git 에 맡긴다).
#[tauri::command]
pub async fn worktree_remove(root: String, path: String, force: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    match git_cmd_full(&root, &args) {
        Ok(_) => {}
        Err(e) => {
            // 폴더가 이미 사라진 경우엔 prune 으로 등록만 정리하면 성공이다
            if !Path::new(&path).exists() {
                git_cmd(&root, &["worktree", "prune"]);
                return Ok(());
            }
            return Err(e);
        }
    }
    git_cmd(&root, &["worktree", "prune"]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_parses_entries_and_marks_main() {
        let text = "worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\n\
                    worktree /repo-feat\nHEAD def456\nbranch refs/heads/feat/login\n\n";
        let got = parse_worktree_porcelain(text);
        assert_eq!(got.len(), 2);
        assert!(got[0].main);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(!got[1].main);
        assert_eq!(got[1].path, "/repo-feat");
        assert_eq!(got[1].branch.as_deref(), Some("feat/login"));
    }

    #[test]
    fn porcelain_handles_detached_and_missing_blank_line() {
        // detached HEAD 항목은 branch 줄이 없고, 마지막 항목 뒤 빈 줄이 없을 수 있다
        let text = "worktree /repo/main\nbranch refs/heads/main\n\n\
                    worktree /repo-detached\nHEAD abc\ndetached\n";
        let got = parse_worktree_porcelain(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].branch, None);
    }

    #[test]
    fn branch_refs_mark_checked_out_and_drop_symbolic_head() {
        let worktrees = vec![WorktreeEntry {
            path: "/repo/main".into(),
            branch: Some("main".into()),
            main: true,
        }];
        let text = "refs/heads/main\nrefs/heads/feat/x\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n";
        let got = parse_branch_refs(text, &worktrees);
        assert_eq!(got.len(), 3); // origin/HEAD 제외
        assert_eq!(got[0].name, "main");
        assert_eq!(got[0].checked_out_at.as_deref(), Some("/repo/main"));
        assert!(!got[0].remote);
        assert_eq!(got[1].name, "feat/x");
        assert_eq!(got[1].checked_out_at, None);
        assert_eq!(got[2].name, "origin/main");
        assert!(got[2].remote);
    }

    #[test]
    fn norm_path_matches_across_separators() {
        assert_eq!(norm_path("C:\\work\\repo\\"), "C:/work/repo");
        assert_eq!(norm_path("/repo/main"), "/repo/main");
    }
}
