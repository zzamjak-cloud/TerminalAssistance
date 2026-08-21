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
    /// 빈 값이면 OS 기본 셸
    #[serde(default)]
    pub shell: String,
    /// 비활성 세션 작업 완료 시 데스크톱 알림
    #[serde(rename = "notifyOnDone", default = "default_true")]
    pub notify_on_done: bool,
    /// 비활성 세션이 실행 허가를 기다릴 때 데스크톱 알림
    #[serde(rename = "notifyOnWaiting", default = "default_true")]
    pub notify_on_waiting: bool,
}

fn default_font_size() -> u32 {
    13
}
fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font_size: 13,
            shell: String::new(),
            notify_on_done: true,
            notify_on_waiting: true,
        }
    }
}

/// '다음 프롬프트' 초안 — 프로젝트별로 영속화 (키: projectId, 홈 세션은 "")
#[derive(Serialize, Deserialize, Clone)]
pub struct Draft {
    pub id: String,
    pub text: String,
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
