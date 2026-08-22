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

/// OS 콘솔 창이 깜빡이지 않게 git 프로세스를 실행 (windows_subsystem 빌드 대응)
fn git_cmd(cwd: &str, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
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
