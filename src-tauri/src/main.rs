// Terminal Assistance — Tauri 진입점 + IPC 커맨드 정의
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod codex;
mod explorer;
mod hooks;
mod plans;
mod pty;
mod store;
mod util;

use pty::PtyManager;
use serde_json::json;
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use store::{new_id, LaunchRecipe, Preset, Project, Store};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
#[cfg(not(any(windows, target_os = "macos")))]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use util::{plock, reorder_by_ids};

type StoreState<'a> = State<'a, Mutex<Store>>;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

// ── 초기 상태 ──
#[tauri::command]
fn get_state(store: StoreState, ptys: State<PtyManager>) -> serde_json::Value {
    let s = plock(&store);
    json!({
        "projects": s.data.projects,
        "presets": s.data.presets,
        "recipes": s.data.recipes,
        "settings": s.data.settings,
        "drafts": s.data.drafts,
        "sessions": ptys.list(),
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION") // 헤더 버전 표기용
    })
}

// ── 시스템 메모리 현황 (헤더 표시용) ──
type MemState = Mutex<sysinfo::System>;

#[tauri::command]
fn get_memory(mem: State<MemState>) -> serde_json::Value {
    let mut s = plock(&mem);
    s.refresh_memory();
    let total = s.total_memory();
    let used = s.used_memory();
    let pct = if total > 0 {
        (used as f64 / total as f64 * 100.0).round() as u32
    } else {
        0
    };
    json!({
        "pct": pct,
        "usedGb": (used as f64 / GIB * 10.0).round() / 10.0,
        "totalGb": (total as f64 / GIB * 10.0).round() / 10.0
    })
}

// ── '다음 프롬프트' 초안 (프로젝트별 영속화, 키: projectId 또는 "") ──
#[tauri::command]
fn set_drafts(store: StoreState, key: String, drafts: Vec<store::Draft>) -> Result<(), String> {
    let mut s = plock(&store);
    if drafts.is_empty() {
        s.data.drafts.remove(&key);
    } else {
        s.data.drafts.insert(key, drafts);
    }
    s.save()
}

// ── 프로젝트 ──
#[tauri::command]
fn add_project(
    store: StoreState,
    name: String,
    path: String,
    color: Option<String>,
) -> Result<Project, String> {
    let p = Project {
        id: new_id(),
        name,
        path,
        color: color.unwrap_or_else(|| "#4f8cc9".into()),
    };
    let mut s = plock(&store);
    s.data.projects.push(p.clone());
    s.save()?;
    Ok(p)
}

#[tauri::command]
fn update_project(
    store: StoreState,
    id: String,
    name: Option<String>,
    path: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let mut s = plock(&store);
    let Some(p) = s.data.projects.iter_mut().find(|p| p.id == id) else {
        return Err("프로젝트를 찾을 수 없습니다".into());
    };
    if let Some(v) = name {
        p.name = v;
    }
    if let Some(v) = path {
        p.path = v;
    }
    if let Some(v) = color {
        p.color = v;
    }
    s.save()
}

// 사이드바 드래그앤드롭 정렬 결과를 그대로 저장 (ids 순서 = 표시 순서)
#[tauri::command]
fn reorder_projects(store: StoreState, ids: Vec<String>) -> Result<(), String> {
    let mut s = plock(&store);
    reorder_by_ids(&mut s.data.projects, &ids, |p| &p.id);
    s.save()
}

#[tauri::command]
fn remove_project(store: StoreState, id: String) -> Result<(), String> {
    let mut s = plock(&store);
    s.data.projects.retain(|p| p.id != id);
    s.data
        .presets
        .retain(|p| p.project_id.as_deref() != Some(id.as_str()));
    s.data
        .recipes
        .retain(|r| r.project_id.as_deref() != Some(id.as_str()));
    s.save()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    // blocking 다이얼로그는 async 커맨드(워커 스레드)에서 호출해 UI 를 막지 않는다
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

/// 시스템 글꼴 폴더 — 글꼴 파일 선택 다이얼로그의 시작 위치
fn system_font_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    return std::env::var("WINDIR")
        .ok()
        .map(|w| std::path::PathBuf::from(w).join("Fonts"));
    #[cfg(target_os = "macos")]
    return Some(std::path::PathBuf::from("/System/Library/Fonts"));
    #[cfg(all(unix, not(target_os = "macos")))]
    return Some(std::path::PathBuf::from("/usr/share/fonts"));
}

/// 글꼴 파일의 name 테이블에서 CSS 로 지정 가능한 패밀리 이름을 추출한다
/// (16 = 조판용 패밀리 우선 — Bold 등 스타일이 빠진 순수 패밀리명, 없으면 1 = 기본 패밀리)
fn font_family_name(data: &[u8]) -> Option<String> {
    let face = ttf_parser::Face::parse(data, 0).ok()?;
    let mut family = None;
    for name in face.names() {
        let decoded = match name.to_string() {
            Some(s) if !s.trim().is_empty() => s,
            _ => continue,
        };
        if name.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY {
            return Some(decoded);
        }
        if name.name_id == ttf_parser::name_id::FAMILY && family.is_none() {
            family = Some(decoded);
        }
    }
    family
}

/// 시스템 글꼴 폴더를 열어 사용자가 고른 글꼴 파일의 패밀리 이름을 돌려준다 (취소 시 None)
#[tauri::command]
async fn pick_font(app: AppHandle) -> Result<Option<String>, String> {
    let mut dlg = app
        .dialog()
        .file()
        .add_filter("글꼴 파일", &["ttf", "otf", "ttc"]);
    if let Some(dir) = system_font_dir() {
        dlg = dlg.set_directory(dir);
    }
    let Some(picked) = dlg.blocking_pick_file() else {
        return Ok(None);
    };
    let data = std::fs::read(picked.to_string())
        .map_err(|e| format!("글꼴 파일을 읽지 못했습니다: {e}"))?;
    font_family_name(&data)
        .map(Some)
        .ok_or_else(|| "글꼴 이름(name 테이블)을 읽지 못했습니다".to_string())
}

// ── 프리셋 ──
#[tauri::command]
fn add_preset(
    store: StoreState,
    label: String,
    command: String,
    project_id: Option<String>,
) -> Result<Preset, String> {
    let p = Preset {
        id: new_id(),
        label,
        command,
        project_id,
    };
    let mut s = plock(&store);
    s.data.presets.push(p.clone());
    s.save()?;
    Ok(p)
}

#[tauri::command]
fn update_preset(
    store: StoreState,
    id: String,
    label: Option<String>,
    command: Option<String>,
    project_id: Option<String>,
    clear_project: Option<bool>,
) -> Result<(), String> {
    let mut s = plock(&store);
    let Some(p) = s.data.presets.iter_mut().find(|p| p.id == id) else {
        return Err("프리셋을 찾을 수 없습니다".into());
    };
    if let Some(v) = label {
        p.label = v;
    }
    if let Some(v) = command {
        p.command = v;
    }
    if clear_project == Some(true) {
        p.project_id = None;
    } else if project_id.is_some() {
        p.project_id = project_id;
    }
    s.save()
}

// 프리셋 드래그앤드롭 정렬 (ids 순서 = 표시 순서)
#[tauri::command]
fn reorder_presets(store: StoreState, ids: Vec<String>) -> Result<(), String> {
    let mut s = plock(&store);
    reorder_by_ids(&mut s.data.presets, &ids, |p| &p.id);
    s.save()
}

#[tauri::command]
fn remove_preset(store: StoreState, id: String) -> Result<(), String> {
    let mut s = plock(&store);
    s.data.presets.retain(|p| p.id != id);
    s.save()
}

// ── 런치 레시피 ──
#[tauri::command]
fn add_recipe(
    store: StoreState,
    label: String,
    commands: Vec<String>,
    project_id: Option<String>,
) -> Result<LaunchRecipe, String> {
    let r = LaunchRecipe {
        id: new_id(),
        label,
        commands,
        project_id,
    };
    let mut s = plock(&store);
    s.data.recipes.push(r.clone());
    s.save()?;
    Ok(r)
}

#[tauri::command]
fn update_recipe(
    store: StoreState,
    id: String,
    label: Option<String>,
    commands: Option<Vec<String>>,
    project_id: Option<String>,
    clear_project: Option<bool>,
) -> Result<(), String> {
    let mut s = plock(&store);
    let Some(r) = s.data.recipes.iter_mut().find(|r| r.id == id) else {
        return Err("런치 레시피를 찾을 수 없습니다".into());
    };
    if let Some(v) = label {
        r.label = v;
    }
    if let Some(v) = commands {
        r.commands = v;
    }
    if clear_project == Some(true) {
        r.project_id = None;
    } else if project_id.is_some() {
        r.project_id = project_id;
    }
    s.save()
}

#[tauri::command]
fn remove_recipe(store: StoreState, id: String) -> Result<(), String> {
    let mut s = plock(&store);
    s.data.recipes.retain(|r| r.id != id);
    s.save()
}

// ── 설정 ──
#[tauri::command]
fn update_settings(
    store: StoreState,
    font_size: Option<u32>,
    font_family: Option<String>,
    shell: Option<String>,
    notify_on_done: Option<bool>,
    notify_on_waiting: Option<bool>,
    line_height: Option<f32>,
    letter_spacing: Option<f32>,
    min_contrast: Option<f32>,
) -> Result<store::Settings, String> {
    let mut s = plock(&store);
    if let Some(v) = font_size {
        s.data.settings.font_size = v;
    }
    if let Some(v) = font_family {
        s.data.settings.font_family = v.trim().to_string();
    }
    if let Some(v) = shell {
        s.data.settings.shell = v;
    }
    if let Some(v) = notify_on_done {
        s.data.settings.notify_on_done = v;
    }
    if let Some(v) = notify_on_waiting {
        s.data.settings.notify_on_waiting = v;
    }
    if let Some(v) = line_height {
        s.data.settings.line_height = v.clamp(1.0, 2.0);
    }
    if let Some(v) = letter_spacing {
        s.data.settings.letter_spacing = v.clamp(0.0, 4.0);
    }
    if let Some(v) = min_contrast {
        s.data.settings.min_contrast = v.clamp(1.0, 21.0);
    }
    s.save()?;
    Ok(s.data.settings.clone())
}

// ── 세션 ──
#[tauri::command]
fn create_session(
    app: AppHandle,
    store: StoreState,
    ptys: State<PtyManager>,
    project_id: Option<String>,
) -> Result<pty::SessionInfo, String> {
    let (cwd, shell) = {
        let s = plock(&store);
        let proj = project_id
            .as_ref()
            .and_then(|pid| s.data.projects.iter().find(|p| &p.id == pid));
        (proj.map(|p| p.path.clone()), s.data.settings.shell.clone())
    };
    // 세션 제목: 같은 그룹(프로젝트 또는 홈) 안의 순번 — S1, S2…
    // 프로젝트명 중복 표기를 없애고 '프로젝트명 — S2' 형태로 식별 가능하게 한다 (표기는 프론트)
    let n = ptys
        .list()
        .iter()
        .filter(|s| s.project_id == project_id)
        .filter_map(|s| {
            s.title
                .strip_prefix('S')
                .and_then(|r| r.parse::<u32>().ok())
        })
        .max()
        .unwrap_or(0)
        + 1;
    ptys.create(app, project_id, cwd, &shell, Some(format!("S{}", n)))
}

#[tauri::command]
fn write_session(ptys: State<PtyManager>, id: String, data: String) {
    ptys.write(&id, &data);
}

#[tauri::command]
fn rename_session(ptys: State<PtyManager>, id: String, title: String) -> Result<(), String> {
    let t = title.trim();
    if t.is_empty() {
        return Err("제목이 비어 있습니다".into());
    }
    ptys.rename(&id, t);
    Ok(())
}

#[tauri::command]
fn resize_session(ptys: State<PtyManager>, id: String, cols: u16, rows: u16) {
    ptys.resize(&id, cols, rows);
}

#[tauri::command]
fn close_session(ptys: State<PtyManager>, id: String) {
    ptys.close(&id);
}

#[tauri::command]
fn ack_session(app: AppHandle, ptys: State<PtyManager>, id: String) {
    ptys.ack(&app, &id);
}

// 웹뷰 리로드/크래시 복구: 백엔드가 보관한 세션 스크롤백 스냅샷 반환
#[tauri::command]
fn get_scrollback(ptys: State<PtyManager>, id: String) -> serde_json::Value {
    ptys.scrollback(&id)
}

// 프론트의 출력 소비 확인(flow control) — xterm 기록 완료 바이트 수
#[tauri::command]
fn ack_data(ptys: State<PtyManager>, id: String, bytes: u64) {
    ptys.ack_data(&id, bytes);
}

// ── 이미지 첨부 ──
// 클립보드에 이미지가 있으면 PNG 저장 후 경로 반환, 없으면 None (프론트가 텍스트 붙여넣기로 폴백)
#[tauri::command]
fn clipboard_image(app: AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let img = app.clipboard().read_image().ok()?;
    let rgba = img.rgba().to_vec();
    let (w, h) = (img.width(), img.height());
    let buf = image::RgbaImage::from_raw(w, h, rgba)?;

    let dir = app.path().app_data_dir().ok()?.join("images");
    fs::create_dir_all(&dir).ok()?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let path = dir.join(format!("img_{}.png", ts));
    buf.save(&path).ok()?;

    // 7일 지난 스냅샷 정리 (디스크 누수 방지)
    if let Ok(entries) = fs::read_dir(&dir) {
        let cutoff = SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 3600);
        for e in entries.flatten() {
            if let Ok(md) = e.metadata() {
                if md.modified().map(|m| m < cutoff).unwrap_or(false) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
    Some(path.to_string_lossy().into_owned())
}

// WKWebView 의 navigator.clipboard 권한 문제를 피해 텍스트도 Rust 쪽에서 읽는다
#[tauri::command]
fn clipboard_text(app: AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
}

// ── 활성 세션 git 브랜치 (헤더 표시용) ──
// git 프로세스를 띄우지 않고 .git/HEAD 를 직접 읽는다 (2초 폴링에도 부담 없게)
fn read_git_head(gitdir: &std::path::Path) -> Option<String> {
    let head = fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref: refs/heads/") {
        return Some(r.to_string());
    }
    // detached HEAD → 짧은 해시로 표시
    Some(format!("({})", head.chars().take(7).collect::<String>()))
}

#[tauri::command]
fn git_branch(cwd: String) -> Option<String> {
    let mut dir = std::path::PathBuf::from(&cwd);
    loop {
        let dotgit = dir.join(".git");
        if dotgit.is_dir() {
            return read_git_head(&dotgit);
        }
        if dotgit.is_file() {
            // 워크트리/서브모듈: ".git" 파일이 "gitdir: <경로>" 포인터를 담는다
            let s = fs::read_to_string(&dotgit).ok()?;
            let p = s.trim().strip_prefix("gitdir:")?.trim();
            let gd = std::path::Path::new(p);
            let gd = if gd.is_absolute() {
                gd.to_path_buf()
            } else {
                dir.join(gd)
            };
            return read_git_head(&gd);
        }
        if !dir.pop() {
            return None; // git 저장소 아님
        }
    }
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|err| err.to_string())
}

// ── 자동 업데이트 ──
// 태그 릴리즈의 latest.json 을 확인 → 새 버전이 있으면 버전·노트를 반환하고 Update 객체를 보관
type PendingUpdate = Mutex<Option<tauri_plugin_updater::Update>>;

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
            };
            *plock(&pending) = Some(update);
            Ok(Some(info))
        }
        _ => Ok(None), // 업데이트 없음 또는 네트워크 오류 → 조용히 무시
    }
}

#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = plock(&pending).take();
    let Some(update) = update else {
        return Err("보류 중인 업데이트가 없습니다".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// ── 데스크톱 알림 — 종류별(완료/허가 대기) 게이트는 프론트가 각 설정으로 판단한다 ──
// tauri-plugin-notification 의 show() 는 알림을 띄우기만 하고 클릭 콜백을 주지 않는다.
// 그래서 알림을 눌러도 앱이 앞으로 나오지 않았다 — 플랫폼 알림 API 를 직접 써서
// "클릭 → 창 복원·포커스 → 알림을 띄운 세션 활성화"까지 잇는다.
#[tauri::command]
fn notify(
    app: AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    show_clickable_notification(&app, title, body, session_id)
}

// 알림 클릭 처리 — 창을 복원·포커스하고 프론트에 대상 세션을 알린다.
// 크래시 복구로 재생성된 창은 라벨이 "main" 이 아닐 수 있어 아무 창이나 찾는다.
fn reveal_session(app: &AppHandle, session_id: Option<String>) {
    if let Some(win) = app.webview_windows().values().next().cloned() {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(id) = session_id {
        let _ = app.emit("ta:activate-session", id);
    }
}

// Windows: 토스트의 Activated 이벤트로 클릭을 받는다. AppUserModelID 는 설치본에서만
// 유효하므로(시작 메뉴 바로가기가 등록한다) 개발 빌드는 PowerShell AUMID 로 대체한다 —
// 플러그인이 app_id 를 붙이는 조건과 동일하게 맞춘다.
#[cfg(windows)]
fn show_clickable_notification(
    app: &AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    let exe_dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let dev_build =
        exe_dir.ends_with(r"\target\debug") || exe_dir.ends_with(r"\target\release");
    let app_id = if dev_build {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };

    let handle = app.clone();
    Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated(move |_action| {
            reveal_session(&handle, session_id.clone());
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

// macOS: 클릭 응답을 받으려면 wait_for_click 로 보내야 하는데, 그러면 사용자가 누르거나
// 알림이 사라질 때까지 전송 호출이 블록된다. mac-notification-sys 는 메인 스레드 밖
// 호출을 지원하므로(콜백은 메인 런루프가 받아 조건변수로 깨운다) 전용 스레드에서 보낸다.
#[cfg(target_os = "macos")]
fn show_clickable_notification(
    app: &AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let handle = app.clone();
    let identifier = app.config().identifier.clone();
    std::thread::spawn(move || {
        // 번들 식별자 지정 — 내부적으로 최초 1회만 적용되고 이후 호출은 무시된다
        let _ = mac_notification_sys::set_application(&identifier);
        let mut n = mac_notification_sys::Notification::new();
        n.title(title.as_str())
            .message(body.as_str())
            .wait_for_click(true);
        if let Ok(mac_notification_sys::NotificationResponse::Click) = n.send() {
            reveal_session(&handle, session_id);
        }
    });
    Ok(())
}

// 그 외 플랫폼: 클릭 처리 없이 기존 플러그인 경로를 그대로 쓴다
#[cfg(not(any(windows, target_os = "macos")))]
fn show_clickable_notification(
    app: &AppHandle,
    title: String,
    body: String,
    _session_id: Option<String>,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// WebView2 프로세스가 죽으면 자동 복구한다 — 종류별로:
//  - 렌더러/GPU 사망: Reload (리로드 후 프론트 boot() 가 get_scrollback 으로 내용 복원)
//  - 브라우저 프로세스 사망: Reload 불가(브라우저 자체가 소멸) → 창을 destroy 하고 같은
//    설정으로 재생성. PTY·스크롤백은 Rust 쪽에 있어 새 창의 boot() 가 그대로 복원한다.
// 모든 ProcessFailed 이벤트는 종류·시각·조치를 app_data_dir/crash-recovery.log 에 남긴다 —
// "깜빡임"이 렌더러 크래시였는지, GPU 재시작이었는지 사후 판별용.
#[cfg(windows)]
fn install_crash_recovery(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    let app = window.app_handle().clone();
    let log_path = app.path().app_data_dir().ok().map(|d| d.join("crash-recovery.log"));

    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(
            move |sender: Option<ICoreWebView2>,
                  args: Option<ICoreWebView2ProcessFailedEventArgs>| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if let Some(a) = &args {
                    let _ = a.ProcessFailedKind(&mut kind);
                }
                // 종류 라벨 (COREWEBVIEW2_PROCESS_FAILED_KIND 정수값 기준)
                let label = match kind.0 {
                    0 => "browser_exited",       // 브라우저 프로세스 사망 — 아래에서 창 재생성
                    1 => "render_exited",        // 렌더러 사망 — 아래에서 자동 리로드
                    2 => "render_unresponsive",  // 무응답 — 스스로 회복 가능
                    3 => "frame_render_exited",
                    4 => "utility_exited",
                    5 => "sandbox_helper_exited",
                    6 => "gpu_exited",           // GPU 사망 — 컴포지팅이 깨진 채 남을 수 있어 리로드
                    _ => "other",
                };
                let reload = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED;
                let recreate = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
                if let Some(p) = &log_path {
                    let secs = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let action = if reload { "reload" } else if recreate { "recreate" } else { "none" };
                    let _ = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(p)
                        .and_then(|mut f| {
                            use std::io::Write;
                            writeln!(f, "{secs}\tkind={} ({label})\taction={action}", kind.0)
                        });
                }
                if reload {
                    if let Some(wv) = &sender {
                        let _ = wv.Reload();
                    }
                }
                if recreate {
                    // 이 콜백은 메인 스레드에서 실행되고, run_on_main_thread 는 메인 스레드에서
                    // 부르면 "즉시 동기 실행"이다(tauri-runtime-wry send_user_message). 그대로
                    // 부르면 WebView2 이벤트 디스패치 안에서 재진입해 새 environment 초기화가
                    // 끝나지 않는다(실측: 재생성 창이 about:blank 에서 멈춤) — 별도 스레드를
                    // 거쳐 다음 이벤트 루프 턴으로 미룬다.
                    CRASH_RECREATING.store(true, std::sync::atomic::Ordering::SeqCst);
                    let app_task = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let a = app_task.clone();
                        let _ = app_task.run_on_main_thread(move || recreate_main_window(&a));
                    });
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

// 크래시 복구로 창을 재생성하는 동안 true — "마지막 창 닫힘 = 앱 종료" 판정을 막는 가드.
// (destroy 와 재생성 사이에 창 개수가 0 이 되는 순간이 있다)
#[cfg(windows)]
static CRASH_RECREATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// 브라우저 프로세스 사망 시 창 재생성. 순서가 중요하다:
//  1) 죽은 창(기존 WebView2 controller/environment 참조)을 먼저 전부 destroy 로 해제 —
//     죽은 인스턴스 참조가 남은 채 새 environment 를 만들면 초기화가 끝나지 않아
//     새 창이 about:blank 에서 멈춘다(실측). MS 권고 순서도 "전부 해제 후 재생성".
//  2) 창 0개 순간의 종료 요청은 CRASH_RECREATING 가드(RunEvent 콜백)가 막는다.
//  3) 같은 라벨은 destroy 완료 전 재사용이 불가해 매번 고유 라벨을 쓴다.
#[cfg(windows)]
fn recreate_main_window(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static RECREATE_SEQ: AtomicU32 = AtomicU32::new(1);
    for w in app.webview_windows().values() {
        let _ = w.destroy();
    }
    let Some(mut cfg) = app.config().app.windows.first().cloned() else { return };
    cfg.label = format!("main-r{}", RECREATE_SEQ.fetch_add(1, Ordering::Relaxed));
    cfg.title = versioned_title(app); // 재생성 창도 버전 붙은 제목 유지
    let created = tauri::WebviewWindowBuilder::from_config(app, &cfg).and_then(|b| b.build());
    CRASH_RECREATING.store(false, Ordering::SeqCst);
    match created {
        Ok(win) => install_crash_recovery(&win),
        Err(e) => {
            // 재생성까지 실패하면 창 없는 좀비로 남지 않게 종료 (다음 실행에서 정상 복구)
            eprintln!("크래시 복구: 창 재생성 실패 — {e}");
            app.exit(1);
        }
    }
}

// 창 제목 = "Terminal Assistance v0.0.0".
// 버전 표기를 사이드바에서 OS 타이틀바로 옮긴 것 — macOS·Windows 모두 네이티브 제목 줄에 붙는다.
// 기준 문자열은 tauri.conf.json 의 창 title, 버전은 패키지 버전이라 릴리스 때 자동으로 따라간다.
fn versioned_title(app: &tauri::AppHandle) -> String {
    let base = app
        .config()
        .app
        .windows
        .first()
        .map(|w| w.title.clone())
        .unwrap_or_else(|| app.package_info().name.clone());
    format!("{} v{}", base, app.package_info().version)
}

fn main() {
    let builder = tauri::Builder::default();
    // 단일 인스턴스(릴리즈 전용, 반드시 첫 번째로 등록) — 중복 실행 시 기존 창을 앞으로.
    // dev 빌드는 제외 — 같은 identifier 를 공유해 설치본이 떠 있으면 dev 실행이 차단된다.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // 크래시 복구로 재생성된 창은 라벨이 "main" 이 아닐 수 있어 아무 창이나 찾는다
        if let Some(win) = app.webview_windows().values().next().cloned() {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PtyManager::new())
        .manage(PendingUpdate::default())
        .manage(MemState::new(sysinfo::System::new()))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(Mutex::new(Store::load(config_dir)));
            let ptys = app.state::<PtyManager>();
            ptys.start_status_thread(app.handle().clone());
            let title = versioned_title(app.handle());
            for win in app.webview_windows().values() {
                let _ = win.set_title(&title);
            }
            hooks::clean_state_dir(); // 이전 실행이 남긴 훅 상태 파일 정리
            hooks::refresh_hook_script(); // 설치된 훅 스크립트를 최신 임베드 버전으로 갱신

            // 구버전(≤0.5.x)이 남긴 종료 시 세션 스냅샷 정리 —
            // 기능 제거 후에도 평문 터미널 기록이 디스크에 남지 않게 한다
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = fs::remove_dir_all(data_dir.join("sessions"));
            }

            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                install_crash_recovery(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            add_project,
            update_project,
            reorder_projects,
            remove_project,
            pick_folder,
            pick_font,
            add_preset,
            update_preset,
            reorder_presets,
            remove_preset,
            add_recipe,
            update_recipe,
            remove_recipe,
            update_settings,
            create_session,
            write_session,
            rename_session,
            resize_session,
            close_session,
            ack_session,
            get_scrollback,
            ack_data,
            get_memory,
            set_drafts,
            clipboard_image,
            clipboard_text,
            open_path,
            open_url,
            check_update,
            install_update,
            notify,
            git_branch,
            claude::list_claude_sessions,
            claude::claude_session_messages,
            plans::list_plan_docs,
            plans::get_plan_doc,
            plans::add_plan_doc,
            plans::register_plan_file,
            plans::dismiss_plan_doc,
            plans::create_memo_doc,
            plans::update_memo_doc,
            plans::delete_memo_doc,
            explorer::list_dir,
            explorer::git_status,
            explorer::read_text_file,
            explorer::resolve_project_file,
            codex::list_codex_sessions,
            codex::codex_session_messages,
            codex::codex_usage,
            pty::list_shells,
            hooks::hooks_status,
            hooks::claude_session_of,
            hooks::set_claude_hooks,
            hooks::set_codex_hooks
        ])
        .build(tauri::generate_context!())
        .expect("Terminal Assistance 실행 실패")
        .run(|_app, _event| {
            // 크래시 복구 중(창 재생성 사이, 창 0개)의 자동 종료 요청만 무시 —
            // 사용자 종료(X 버튼, app.exit)는 그대로 진행된다.
            #[cfg(windows)]
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &_event {
                if code.is_none() && CRASH_RECREATING.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
