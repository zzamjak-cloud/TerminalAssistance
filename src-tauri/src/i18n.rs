// 백엔드가 만들어 화면에 보이는 문자열의 한국어/영어 전환.
// 프런트(src/renderer/i18n.js)가 부팅 때 set_ui_language 로 언어를 알려 준다. 기본은 한국어(원문 그대로).
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

static LANG: AtomicU8 = AtomicU8::new(0); // 0 = ko, 1 = en

#[tauri::command]
pub fn set_ui_language(lang: String) {
    LANG.store(if lang == "en" { 1 } else { 0 }, Ordering::Relaxed);
    // 앱 메뉴는 언어를 알기 전(setup)에 만들어지므로 여기서 다시 맞춘다
    #[cfg(target_os = "macos")]
    crate::refresh_menu_language();
}

fn table() -> &'static HashMap<&'static str, &'static str> {
    static T: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    T.get_or_init(|| EN.iter().copied().collect())
}

fn tr_in(lang: u8, ko: &'static str) -> &'static str {
    if lang == 1 {
        table().get(ko).copied().unwrap_or(ko)
    } else {
        ko
    }
}

// 한 번 훑으며 치환한다 — 앞서 넣은 값 안의 `{이름}` 이 다시 치환되지 않게
fn fill(s: String, args: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let hit = after.find('}').and_then(|close| {
            let name = &after[..close];
            args.iter().find(|(n, _)| *n == name).map(|(_, v)| (close, v.to_string()))
        });
        match hit {
            Some((close, v)) => {
                out.push_str(&v);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 한국어 원문 → 현재 언어 문구. 영어 표에 없으면 원문.
pub fn tr(ko: &'static str) -> &'static str {
    tr_in(LANG.load(Ordering::Relaxed), ko)
}

/// tr 후 `{이름}` 자리표시자를 args 로 치환한다.
pub fn trf(ko: &'static str, args: &[(&str, &dyn Display)]) -> String {
    fill(tr(ko).to_string(), args)
}

// 키 = 코드에서 tr/trf 에 넘기는 한국어 원문(그대로).
const EN: &[(&str, &str)] = &[
    ("Terminal Assistance 종료", "Quit Terminal Assistance"),
    // 세션 미리보기·기본 이름
    ("대화 내용 미리보기 없음", "No conversation preview"),
    ("대화 내용 없음", "No conversation"),
    ("도구", "Tool"),
    // 탐색기·파일
    ("폴더를 읽을 수 없습니다: {e}", "Cannot read folder: {e}"),
    ("git 을 실행할 수 없습니다: {e}", "Cannot run git: {e}"),
    ("git 실행에 실패했습니다", "Failed to run git"),
    ("완료", "Done"),
    ("git 저장소가 아닙니다", "Not a git repository"),
    ("되돌리기를 실행할 수 없습니다: {e}", "Cannot run revert: {e}"),
    ("빈 경로", "Empty path"),
    ("저장소 안의 상대 경로가 아닙니다", "Not a relative path inside the repository"),
    ("파일을 읽을 수 없습니다: {e}", "Cannot read file: {e}"),
    ("파일이 아닙니다", "Not a file"),
    ("파일을 열 수 없습니다: {e}", "Cannot open file: {e}"),
    ("읽기 실패: {e}", "Read failed: {e}"),
    ("텍스트 파일이 아닙니다", "Not a text file"),
    ("폴더에는 저장할 수 없습니다", "Cannot save to a folder"),
    ("상위 폴더를 찾을 수 없습니다", "Parent folder not found"),
    ("파일 이름이 올바르지 않습니다", "Invalid file name"),
    ("임시 파일 저장 실패: {e}", "Failed to save temp file: {e}"),
    ("저장 반영 실패: {e}", "Failed to apply save: {e}"),
    ("대상 폴더가 없습니다", "Target folder does not exist"),
    ("같은 이름의 파일이 이미 있습니다", "A file with the same name already exists"),
    ("파일을 만들 수 없습니다: {e}", "Cannot create file: {e}"),
    ("파일을 찾을 수 없습니다: {e}", "File not found: {e}"),
    ("폴더는 삭제할 수 없습니다", "Cannot delete a folder"),
    ("삭제하지 못했습니다: {e}", "Failed to delete: {e}"),
    ("같은 이름의 항목이 이미 있습니다", "An item with the same name already exists"),
    ("폴더를 만들 수 없습니다: {e}", "Cannot create folder: {e}"),
    ("원본을 찾을 수 없습니다", "Source not found"),
    ("대상 위치에 같은 이름이 이미 있습니다", "The same name already exists at the destination"),
    ("대상 폴더를 찾을 수 없습니다", "Target folder not found"),
    ("폴더를 자기 하위로 옮길 수 없습니다", "Cannot move a folder into itself"),
    ("옮기지 못했습니다: {e}", "Failed to move: {e}"),
    ("이름을 입력하세요", "Enter a name"),
    ("이름에 경로 구분자를 쓸 수 없습니다", "Name cannot contain path separators"),
    // 훅 설치
    ("홈 디렉토리를 찾을 수 없습니다", "Home directory not found"),
    ("settings.json 파싱 실패 (설치 중단): {e}", "Failed to parse settings.json (install aborted): {e}"),
    ("settings.json 루트가 객체가 아닙니다", "settings.json root is not an object"),
    ("settings.json 의 hooks 가 객체가 아닙니다", "\"hooks\" in settings.json is not an object"),
    ("hooks.{ev} 가 배열이 아닙니다", "hooks.{ev} is not an array"),
    ("settings.json 파싱 실패 (제거 중단)", "Failed to parse settings.json (removal aborted)"),
    ("config.toml 파싱 실패 (설치 중단): {e}", "Failed to parse config.toml (install aborted): {e}"),
    ("config.toml 의 [tui] 가 테이블이 아닙니다", "[tui] in config.toml is not a table"),
    ("config.toml 파싱 실패 (제거 중단): {e}", "Failed to parse config.toml (removal aborted): {e}"),
    // 앱 공통 커맨드
    ("프로젝트를 찾을 수 없습니다", "Project not found"),
    ("글꼴 파일", "Font files"),
    ("글꼴 파일을 읽지 못했습니다: {e}", "Failed to read font file: {e}"),
    ("글꼴 이름(name 테이블)을 읽지 못했습니다", "Failed to read the font name (name table)"),
    ("프리셋을 찾을 수 없습니다", "Preset not found"),
    ("런치 레시피를 찾을 수 없습니다", "Launch recipe not found"),
    ("세션이 너무 많습니다 (최대 {max}개)", "Too many sessions (max {max})"),
    ("세션이 너무 많습니다 (최대 {MAX_SESSIONS}개)", "Too many sessions (max {MAX_SESSIONS})"),
    ("제목이 비어 있습니다", "Title is empty"),
    ("보류 중인 업데이트가 없습니다", "No pending update"),
    // 고아 프로세스
    ("종료 대상이 없습니다", "Nothing to terminate"),
    ("이미 종료되었거나 목록에 없는 프로세스입니다", "Process already exited or not in the list"),
    ("종료되지 않은 프로세스: {left}", "Processes still running: {left}"),
    ("이 OS 에서는 지원하지 않습니다", "Not supported on this OS"),
    // 계획·메모
    ("계획 문서", "Plan document"),
    ("계획 저장 직렬화 실패: {e}", "Failed to serialize plans: {e}"),
    ("계획 임시 파일 저장 실패: {e}", "Failed to save plan temp file: {e}"),
    ("계획 저장 반영 실패: {e}", "Failed to apply plan save: {e}"),
    ("계획으로 저장할 선택 영역이 너무 짧습니다", "The selection is too short to save as a plan"),
    ("계획 파일 정보를 읽을 수 없습니다: {e}", "Cannot read plan file info: {e}"),
    ("심볼릭 링크는 계획 문서로 등록할 수 없습니다", "Symbolic links cannot be registered as plan documents"),
    ("계획 파일을 열 수 없습니다: {e}", "Cannot open plan file: {e}"),
    ("프로젝트 밖의 파일은 등록할 수 없습니다", "Files outside the project cannot be registered"),
    ("일반 파일만 계획 문서로 등록할 수 있습니다", "Only regular files can be registered as plan documents"),
    ("Markdown(.md) 파일만 계획 문서로 등록할 수 있습니다", "Only Markdown (.md) files can be registered as plan documents"),
    ("계획 파일이 너무 큽니다 (최대 {kib} KiB)", "Plan file is too large (max {kib} KiB)"),
    ("계획 파일을 읽지 못했습니다: {e}", "Failed to read plan file: {e}"),
    ("계획 파일이 UTF-8 텍스트가 아닙니다", "Plan file is not UTF-8 text"),
    ("계획 파일의 내용이 비어 있거나 너무 짧습니다", "Plan file is empty or too short"),
    ("계획 문서 식별자가 올바르지 않습니다", "Invalid plan document ID"),
    ("제거할 계획 문서를 찾을 수 없습니다", "Plan document to remove not found"),
    ("계획 문서만 목록에서 제거할 수 있습니다", "Only plan documents can be removed from the list"),
    ("프로젝트 경로가 올바르지 않습니다", "Invalid project path"),
    ("프로젝트 경로를 열 수 없습니다: {e}", "Cannot open project path: {e}"),
    ("프로젝트 경로가 디렉터리가 아닙니다", "Project path is not a directory"),
    ("메모 디렉터리를 만들지 못했습니다: {e}", "Failed to create memo directory: {e}"),
    ("메모 디렉터리를 확인하지 못했습니다: {e}", "Failed to check memo directory: {e}"),
    ("메모 디렉터리가 프로젝트 밖을 가리킵니다", "Memo directory points outside the project"),
    ("메모 제목을 입력해 주세요", "Enter a memo title"),
    ("메모 제목은 {TITLE_CAP}자 이하여야 합니다", "Memo title must be {TITLE_CAP} characters or fewer"),
    ("메모 제목에 제어 문자를 사용할 수 없습니다", "Memo title cannot contain control characters"),
    ("메모 본문이 너무 큽니다 (최대 1 MiB)", "Memo body is too large (max 1 MiB)"),
    ("메모 본문을 입력해 주세요", "Enter the memo body"),
    ("메모 목록을 읽지 못했습니다: {e}", "Failed to read memo list: {e}"),
    ("메모 파일명이 올바르지 않습니다", "Invalid memo file name"),
    ("메모 임시 파일 생성 실패: {error}", "Failed to create memo temp file: {error}"),
    ("메모 임시 파일 이름 충돌이 반복되어 저장하지 못했습니다", "Could not save: memo temp file names kept colliding"),
    ("메모 임시 파일 저장 실패: {error}", "Failed to save memo temp file: {error}"),
    ("메모 저장 반영 실패: {error}", "Failed to apply memo save: {error}"),
    ("기존 메모 식별자가 올바르지 않습니다", "Invalid existing memo ID"),
    ("메모 식별자를 만들지 못했습니다", "Failed to create memo ID"),
    ("메모 디렉터리를 만들지 못했습니다", "Failed to create memo directory"),
    ("같은 메모 파일이 이미 존재합니다", "The same memo file already exists"),
    ("메모 경로가 프로젝트 밖입니다", "Memo path is outside the project"),
    ("메모 식별자가 올바르지 않습니다", "Invalid memo ID"),
    ("수정할 메모를 찾을 수 없습니다", "Memo to edit not found"),
    ("삭제할 메모를 찾을 수 없습니다", "Memo to delete not found"),
    ("메모 문서만 삭제할 수 있습니다", "Only memo documents can be deleted"),
    ("메모를 삭제하지 못했습니다: {e}", "Failed to delete memo: {e}"),
    ("계획 저장소 경로를 만들 수 없습니다", "Cannot build the plan store path"),
    ("메모는 메모 삭제 기능을 사용해야 합니다", "Memos must be deleted with the memo delete function"),
    // 셸 목록·오류
    ("OS 기본", "OS default"),
    ("명령 프롬프트 (cmd)", "Command Prompt (cmd)"),
    ("OS 기본 ({sys})", "OS default ({sys})"),
    (
        "Git Bash 를 찾을 수 없습니다 — 설정의 셸에 bash.exe 전체 경로를 입력하세요 (예: C:\\Program Files\\Git\\bin\\bash.exe). 입력값: {shell}",
        "Git Bash not found — enter the full path to bash.exe in the Shell setting (e.g. C:\\Program Files\\Git\\bin\\bash.exe). Input: {shell}",
    ),
    // 모바일 원격
    ("잘못된 바인드 주소: {bind}", "Invalid bind address: {bind}"),
    ("{url} 바인드 실패: {e}", "Failed to bind {url}: {e}"),
    ("원격 서버 리스너 생성 실패: {e}", "Failed to create remote server listener: {e}"),
    ("원격 서버가 중단되었습니다: {e}", "Remote server stopped: {e}"),
    ("원격 서버가 예기치 않게 종료되었습니다", "Remote server exited unexpectedly"),
    (
        "ntfy 서버 주소가 http:// 입니다 — 알림 내용과 토픽이 암호화되지 않은 채 전송됩니다.",
        "The ntfy server address is http:// — notification content and topic are sent unencrypted.",
    ),
    ("바인드 주소는 IP 또는 auto 여야 합니다: {bind}", "Bind address must be an IP or auto: {bind}"),
    ("포트는 1~65535 사이여야 합니다", "Port must be between 1 and 65535"),
    ("지원하지 않는 푸시 종류: {kind}", "Unsupported push type: {kind}"),
    ("ntfy 서버 주소는 http(s):// 로 시작해야 합니다", "The ntfy server address must start with http(s)://"),
    ("ntfy 토픽은 영문·숫자·-·_ 64자 이내여야 합니다", "The ntfy topic must be up to 64 letters, digits, - or _"),
    ("원격 서버가 실행 중이 아닙니다", "Remote server is not running"),
    ("접속 주소를 찾을 수 없습니다", "Connection address not found"),
    ("{label} — 폰에서 열기", "{label} — open on phone"),
    ("세션", "Session"),
    ("Terminal Assistance — 폰에서 열기", "Terminal Assistance — open on phone"),
    ("이 OS 에서는 Tailscale 앱을 직접 열어 주세요", "On this OS, open the Tailscale app manually"),
    ("Tailscale 열기 실패: {e}", "Failed to open Tailscale: {e}"),
    ("QR 로 만들 수 없는 주소입니다", "This address cannot be made into a QR code"),
    ("푸시가 꺼져 있습니다", "Push is turned off"),
    ("ntfy 토픽이 올바르지 않습니다", "Invalid ntfy topic"),
    ("테스트 알림 — 원격 푸시가 연결되었습니다", "Test notification — remote push is connected"),
    (
        "Tailscale 미연결 — 이 컴퓨터에서 Tailscale 에 로그인하면 자동으로 다시 시도합니다",
        "Tailscale not connected — sign in to Tailscale on this computer and it will retry automatically",
    ),
    ("{label} — 작업 완료", "{label} — task done"),
    ("{label} — 허가 대기 중", "{label} — waiting for permission"),
    ("푸시 전송 실패: {e}", "Failed to send push: {e}"),
    (
        "tailscale serve 설정 실패 — Tailscale 관리 페이지에서 HTTPS 가 켜져 있는지 확인하세요",
        "tailscale serve setup failed — check that HTTPS is enabled in the Tailscale admin console",
    ),
    // 바인드 주소 위험도 경고
    (
        "⚠ 모든 네트워크 인터페이스에 공개됩니다. 같은 네트워크(공용 Wi-Fi 포함)나 인터넷의 누구나 접속을 시도할 수 있고, 통신은 암호화되지 않은 HTTP 입니다. Tailscale IP 바인드를 권장합니다.",
        "⚠ Exposed on all network interfaces. Anyone on the same network (including public Wi-Fi) or the internet can try to connect, and traffic is unencrypted HTTP. Binding to the Tailscale IP is recommended.",
    ),
    (
        "Tailscale(100.64/10) 대역 주소입니다. tailnet 안의 기기만 접근할 수 있고 전송은 Tailscale 이 암호화합니다. 서버 자체는 HTTP 평문입니다.",
        "This is a Tailscale (100.64/10) address. Only devices in your tailnet can reach it and Tailscale encrypts the traffic. The server itself speaks plain HTTP.",
    ),
    (
        "사설 네트워크(LAN) 주소입니다. 같은 네트워크의 기기가 접속을 시도할 수 있고, 통신은 암호화되지 않은 HTTP 라 같은 망에서 엿볼 수 있습니다.",
        "This is a private network (LAN) address. Devices on the same network can try to connect, and the traffic is unencrypted HTTP that others on that network can read.",
    ),
    (
        "⚠ 공인 IP 입니다. 인터넷 어디서나 접속을 시도할 수 있고 통신은 암호화되지 않습니다. 사용을 권장하지 않습니다 — Tailscale IP 바인드를 쓰세요.",
        "⚠ This is a public IP. Anyone on the internet can try to connect and traffic is unencrypted. Not recommended — bind to the Tailscale IP instead.",
    ),
    // 설정 저장·워크트리
    ("설정 저장 실패: {e}", "Failed to save settings: {e}"),
    ("브랜치 이름을 입력하세요", "Enter a branch name"),
    ("워크트리 경로를 입력하세요", "Enter a worktree path"),
    ("이미 존재하는 경로입니다: {path}", "Path already exists: {path}"),
    ("상위 폴더가 없습니다: {dir}", "Parent folder does not exist: {dir}"),
];

#[cfg(test)]
mod tests {
    use super::*;

    // 전역 LANG 을 en 으로 바꾸는 테스트는 두지 않는다 — 병렬로 도는 다른 테스트의 한국어 단언이 깨진다.
    // 영어 경로는 언어를 인자로 받는 tr_in 으로 검증한다.
    #[test]
    fn 기본은_한국어_원문() {
        set_ui_language("ko".into());
        assert_eq!(tr("이름을 입력하세요"), "이름을 입력하세요");
        set_ui_language("fr".into());
        assert_eq!(tr("이름을 입력하세요"), "이름을 입력하세요");
        set_ui_language("ko".into());
    }

    #[test]
    fn 영어면_표의_번역을_쓴다() {
        assert_eq!(tr_in(1, "이름을 입력하세요"), "Enter a name");
        assert_eq!(tr_in(0, "이름을 입력하세요"), "이름을 입력하세요");
    }

    #[test]
    fn 자리표시자를_치환한다() {
        let max = 8;
        let ko = trf("세션이 너무 많습니다 (최대 {max}개)", &[("max", &max)]);
        assert_eq!(ko, "세션이 너무 많습니다 (최대 8개)");
        let en = fill(tr_in(1, "세션이 너무 많습니다 (최대 {max}개)").to_string(), &[("max", &max)]);
        assert_eq!(en, "Too many sessions (max 8)");
    }

    #[test]
    fn 표에_없는_키는_원문() {
        assert_eq!(tr_in(1, "표에 없는 문장"), "표에 없는 문장");
        assert_eq!(trf("표에 없는 {x}", &[("x", &1)]), "표에 없는 1");
    }

    #[test]
    fn 표_키_중복_없음() {
        let mut keys: Vec<_> = EN.iter().map(|(k, _)| *k).collect();
        keys.sort_unstable();
        let n = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), n);
    }
}
