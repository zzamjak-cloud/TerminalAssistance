// 프로젝트·프리셋·설정을 앱 설정 디렉토리의 ta-config.json 에 영속화하는 저장소
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 타임스탬프+시퀀스 기반 고유 id (외부 크레이트 없이)
pub fn new_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let n = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", ts, n)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    /// git 워크트리로 만들어진 프로젝트면 부모(원본 저장소) 프로젝트 id.
    /// None 이면 일반 최상위 프로젝트 — 기존 설정 파일과의 호환을 위해 default 를 둔다.
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 워크트리가 체크아웃한 브랜치 이름 (parent_id 와 짝을 이룬다)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Preset {
    pub id: String,
    pub label: String,
    pub command: String,
    /// None 이면 전역 프리셋, Some(id) 면 해당 프로젝트 전용
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LaunchRecipe {
    pub id: String,
    pub label: String,
    /// 각 줄/항목마다 새 세션을 만들고 해당 명령을 즉시 실행한다
    pub commands: Vec<String>,
    /// None 이면 전역 레시피, Some(id) 면 해당 프로젝트 전용
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(rename = "fontSize", default = "default_font_size")]
    pub font_size: u32,
    /// 터미널 글꼴 이름 (빈 값이면 기본 글꼴 체인 사용)
    #[serde(rename = "fontFamily", default)]
    pub font_family: String,
    /// 빈 값이면 OS 기본 셸
    #[serde(default)]
    pub shell: String,
    /// 비활성 세션 작업 완료 시 데스크톱 알림
    #[serde(rename = "notifyOnDone", default = "default_true")]
    pub notify_on_done: bool,
    /// 비활성 세션이 실행 허가를 기다릴 때 데스크톱 알림
    #[serde(rename = "notifyOnWaiting", default = "default_true")]
    pub notify_on_waiting: bool,
    /// 하단 프롬프트 입력창 표시 여부 (기본 숨김)
    #[serde(rename = "showPromptInput", default)]
    pub show_prompt_input: bool,
    /// 터미널 줄 간격 배수 (1.0 = xterm 기본)
    #[serde(rename = "lineHeight", default = "default_line_height")]
    pub line_height: f32,
    /// 터미널 자간(px). 좁은 폭의 한글·기호 판독을 돕는다
    #[serde(rename = "letterSpacing", default)]
    pub letter_spacing: f32,
    /// 배경 대비 최소 명암비 — dim/회색 출력이 배경에 묻히는 것을 자동 보정 (1.0 = 끔)
    #[serde(rename = "minContrast", default = "default_min_contrast")]
    pub min_contrast: f32,
}

fn default_font_size() -> u32 {
    13
}
fn default_line_height() -> f32 {
    1.0
}
fn default_min_contrast() -> f32 {
    1.0
}
fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font_size: 13,
            font_family: String::new(),
            shell: String::new(),
            notify_on_done: true,
            notify_on_waiting: true,
            show_prompt_input: false,
            line_height: 1.0,
            letter_spacing: 0.0,
            min_contrast: 1.0,
        }
    }
}

/// '다음 프롬프트' 초안 — 프로젝트별로 영속화 (키: projectId, 홈 세션은 "")
#[derive(Serialize, Deserialize, Clone)]
pub struct Draft {
    pub id: String,
    pub text: String,
}

/// 재시작 후 되살릴 세션 한 칸. 화면 내용(스크롤백)은 저장하지 않는다 —
/// 죽은 화면을 되살리면 TUI 가 깨져 보이고, 토큰·비밀번호가 평문으로 디스크에 남는다.
/// 대신 '어느 프로젝트의 어느 경로에 무슨 이름의 세션이 있었는가'만 남기고,
/// 내용 연속성은 Claude/Codex 자신의 `--resume` 에 맡긴다.
#[derive(Serialize, Deserialize, Clone)]
pub struct SavedSession {
    /// 지난 실행의 세션 id — 분할 배치가 이 id 로 저장돼 있어 그대로 복원해야 레이아웃이 산다
    pub id: String,
    #[serde(rename = "projectId", default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    pub cwd: String,
    #[serde(rename = "createdAtMs", default)]
    pub created_at_ms: u64,
}

/// 저장된 세션을 되살릴 수 있는지 판정한다. 되살릴 수 없으면 사유를 돌려준다.
/// (사라진 작업 폴더를 홈으로 폴백시키지 않는 이유: 엉뚱한 경로에서 열린 세션은
///  복원이 아니라 혼란이고, 특히 제거된 워크트리를 조용히 홈으로 바꿔치기하게 된다)
pub fn session_restore_skip_reason(
    item: &SavedSession,
    project_ids: &std::collections::HashSet<String>,
    dir_exists: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    if let Some(pid) = item.project_id.as_ref() {
        if !project_ids.contains(pid) {
            return Some("project");
        }
    }
    if !dir_exists(&item.cwd) {
        return Some("cwd");
    }
    None
}

/// 페어링된 원격 기기. 토큰 원문은 저장하지 않는다 (SHA-256 hex 만)
#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    #[serde(rename = "tokenHash")]
    pub token_hash: String,
    #[serde(rename = "createdMs", default)]
    pub created_ms: u64,
    #[serde(rename = "lastSeenMs", default)]
    pub last_seen_ms: u64,
    /// 페어링 시 접속 IP — Tailscale 피어 온라인 상태를 찾는 열쇠
    #[serde(rename = "tailscaleIp", default, skip_serializing_if = "Option::is_none")]
    pub tailscale_ip: Option<String>,
    /// android | ios | other — 오프라인 안내 분기
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// 페어링한 출처 스킴 (http | https). 쿠키는 출처별이라 HTTPS 전환 후 http 기기는 재페어링해야 한다
    #[serde(default = "default_device_scheme")]
    pub scheme: String,
}

fn default_device_scheme() -> String {
    "http".into()
}

/// 원격 푸시 설정. kind 는 "off" | "ntfy" — 모르는 값(향후 추가 종류)도 설정 파일 전체를
/// 깨뜨리지 않도록 문자열로 받고 사용 시점에 해석한다
#[derive(Serialize, Deserialize, Clone)]
pub struct PushConfig {
    #[serde(default = "default_push_kind")]
    pub kind: String,
    #[serde(default = "default_ntfy_url")]
    pub url: String,
    /// 빈 값이면 원격 모듈이 최초 로드 시 랜덤 토픽을 발급해 저장한다
    #[serde(default)]
    pub topic: String,
    #[serde(rename = "onDone", default = "default_true")]
    pub on_done: bool,
    #[serde(rename = "onWaiting", default = "default_true")]
    pub on_waiting: bool,
    /// 알림 본문에 프로젝트명을 넣을지 — 기본은 세션 제목만 (외부 서버에 남는 정보 최소화)
    #[serde(rename = "includeProject", default)]
    pub include_project: bool,
}

fn default_push_kind() -> String {
    "off".into()
}
fn default_ntfy_url() -> String {
    "https://ntfy.sh".into()
}

impl Default for PushConfig {
    fn default() -> Self {
        PushConfig {
            kind: default_push_kind(),
            url: default_ntfy_url(),
            topic: String::new(),
            on_done: true,
            on_waiting: true,
            include_project: false,
        }
    }
}

/// 모바일 원격 제어 설정. Settings 와 분리한 이유: get_state 가 settings 를 렌더러로
/// 통째 보내므로, 여기 든 토큰 해시가 웹뷰로 새지 않게 한다
#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_remote_bind")]
    pub bind: String,
    #[serde(default = "default_remote_port")]
    pub port: u16,
    #[serde(default)]
    pub devices: Vec<RemoteDevice>,
    #[serde(default)]
    pub push: PushConfig,
}

fn default_remote_bind() -> String {
    "127.0.0.1".into()
}
fn default_remote_port() -> u16 {
    7788
}

impl Default for RemoteConfig {
    fn default() -> Self {
        RemoteConfig {
            enabled: false,
            bind: default_remote_bind(),
            port: default_remote_port(),
            devices: Vec::new(),
            push: PushConfig::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct StoreData {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub presets: Vec<Preset>,
    #[serde(default)]
    pub recipes: Vec<LaunchRecipe>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub drafts: std::collections::HashMap<String, Vec<Draft>>,
    /// 마지막으로 열려 있던 세션 목록 (재시작 복원용). 세션 생성·종료·이름변경 때만 갱신한다.
    #[serde(rename = "sessionLayout", default)]
    pub session_layout: Vec<SavedSession>,
    #[serde(default)]
    pub remote: RemoteConfig,
}

pub struct Store {
    file: PathBuf,
    pub data: StoreData,
}

impl Store {
    pub fn load(config_dir: PathBuf) -> Self {
        let file = config_dir.join("ta-config.json");
        let data = match fs::read_to_string(&file) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(d) => d,
                Err(_) => {
                    // 손상된 설정을 조용히 버리지 않는다 — 백업해 두면 수동 복구 가능
                    let _ = fs::copy(&file, file.with_extension("json.corrupt"));
                    StoreData::default()
                }
            },
            Err(_) => StoreData::default(),
        };
        Store { file, data }
    }

    /// 저장 실패를 호출부(IPC 커맨드)로 전파해 프론트가 사용자에게 알릴 수 있게 한다
    pub fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // 원자적 저장: 임시 파일에 완성한 뒤 rename — 저장 도중 크래시로 인한 설정 파일 손상 방지
        let json = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("설정 저장 실패: {}", e))?;
        fs::rename(&tmp, &self.file).map_err(|e| format!("설정 저장 실패: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn saved(id: &str, project: Option<&str>, cwd: &str) -> SavedSession {
        SavedSession {
            id: id.into(),
            project_id: project.map(|s| s.to_string()),
            title: "S1".into(),
            cwd: cwd.into(),
            created_at_ms: 1,
        }
    }

    #[test]
    fn restore_skips_deleted_project_and_missing_cwd() {
        let ids: HashSet<String> = ["p1".to_string()].into_iter().collect();
        let exists = |p: &str| p == "/live";

        // 정상: 프로젝트가 있고 폴더도 있다
        assert_eq!(
            session_restore_skip_reason(&saved("a", Some("p1"), "/live"), &ids, exists),
            None
        );
        // 프로젝트가 지워졌다
        assert_eq!(
            session_restore_skip_reason(&saved("b", Some("gone"), "/live"), &ids, exists),
            Some("project")
        );
        // 작업 폴더가 사라졌다 (제거된 워크트리 등) — 홈으로 폴백하지 않고 건너뛴다
        assert_eq!(
            session_restore_skip_reason(&saved("c", Some("p1"), "/removed"), &ids, exists),
            Some("cwd")
        );
        // 프로젝트 없는 홈 터미널도 폴더 존재 여부만 본다
        assert_eq!(
            session_restore_skip_reason(&saved("d", None, "/live"), &ids, exists),
            None
        );
    }

    #[test]
    fn saved_session_roundtrips_and_tolerates_old_config() {
        let item = saved("id1", Some("p1"), "C:/work");
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"projectId\""), "{json}");
        assert!(json.contains("\"createdAtMs\""), "{json}");
        let back: SavedSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "id1");
        assert_eq!(back.project_id.as_deref(), Some("p1"));

        // sessionLayout 이 없는 기존 설정 파일도 그대로 읽힌다
        let old: StoreData = serde_json::from_str(r#"{"projects":[],"presets":[]}"#).unwrap();
        assert!(old.session_layout.is_empty());

        // 프로젝트에 워크트리 필드가 없던 설정도 마찬가지
        let older: StoreData = serde_json::from_str(
            r##"{"projects":[{"id":"1","name":"n","path":"/p","color":"#fff"}]}"##,
        )
        .unwrap();
        assert_eq!(older.projects.len(), 1);
        assert!(older.projects[0].parent_id.is_none());
    }

    #[test]
    fn remote_config_defaults_for_old_store_and_roundtrips() {
        // remote 필드가 없던 설정 파일: 기본값(꺼짐, 127.0.0.1:7788, 푸시 off)
        let old: StoreData = serde_json::from_str(r#"{"projects":[],"settings":{"fontSize":14}}"#).unwrap();
        assert!(!old.remote.enabled);
        assert_eq!(old.remote.bind, "127.0.0.1");
        assert_eq!(old.remote.port, 7788);
        assert_eq!(old.remote.push.kind, "off");
        assert_eq!(old.remote.push.url, "https://ntfy.sh");
        assert!(old.remote.devices.is_empty());

        // 일부 필드만 있는 remote, 모르는 푸시 종류도 설정 전체를 깨뜨리지 않는다
        let partial: StoreData = serde_json::from_str(
            r#"{"remote":{"enabled":true,"push":{"kind":"telegram"},"devices":[{"id":"d","name":"폰","tokenHash":"ab"}]}}"#,
        )
        .unwrap();
        assert!(partial.remote.enabled);
        assert_eq!(partial.remote.port, 7788);
        assert_eq!(partial.remote.push.kind, "telegram");
        assert!(partial.remote.push.on_done);
        assert!(!partial.remote.push.include_project);
        assert_eq!(partial.remote.devices[0].last_seen_ms, 0);
        // 진단 필드가 없던 구버전 기기도 읽히고, 없으면 저장 시에도 쓰지 않는다
        assert!(partial.remote.devices[0].tailscale_ip.is_none() && partial.remote.devices[0].platform.is_none());
        assert!(!serde_json::to_string(&partial.remote.devices[0]).unwrap().contains("tailscaleIp"));
        assert_eq!(partial.remote.devices[0].scheme, "http", "구버전 기기는 http 로 페어링된 것");

        let json = serde_json::to_string(&partial).unwrap();
        let back: StoreData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.remote.devices[0].token_hash, "ab");
        // 토큰 해시는 settings 가 아닌 remote 에만 있다 (get_state 로 렌더러에 새지 않음)
        let settings_json = serde_json::to_string(&back.settings).unwrap();
        assert!(!settings_json.contains("tokenHash"));
    }
}
