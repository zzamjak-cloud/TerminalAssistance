// 프로젝트·프리셋·설정을 앱 설정 디렉토리의 ta-config.json 에 영속화하는 저장소
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 타임스탬프+시퀀스 기반 고유 id (외부 크레이트 없이)
pub fn new_id() -> String {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
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
pub struct Settings {
    #[serde(rename = "fontSize", default = "default_font_size")]
    pub font_size: u32,
    /// 빈 값이면 OS 기본 셸
    #[serde(default)]
    pub shell: String,
    /// 비활성 세션 작업 완료 시 데스크톱 알림
    #[serde(rename = "notifyOnDone", default = "default_true")]
    pub notify_on_done: bool,
}

fn default_font_size() -> u32 { 13 }
fn default_true() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Settings { font_size: 13, shell: String::new(), notify_on_done: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct StoreData {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub presets: Vec<Preset>,
    #[serde(default)]
    pub settings: Settings,
}

pub struct Store {
    file: PathBuf,
    pub data: StoreData,
}

impl Store {
    pub fn load(config_dir: PathBuf) -> Self {
        let file = config_dir.join("ta-config.json");
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store { file, data }
    }

    pub fn save(&self) {
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file, json);
        }
    }
}
