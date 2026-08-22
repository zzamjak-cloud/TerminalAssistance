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
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
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
    shell: Option<String>,
    notify_on_done: Option<bool>,
    notify_on_waiting: Option<bool>,
) -> Result<store::Settings, String> {
    let mut s = plock(&store);
    if let Some(v) = font_size {
        s.data.settings.font_size = v;
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
fn open_path(app: AppHandle, path: String) {
    let _ = app.opener().open_path(path, None::<String>);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    let _ = app.opener().open_url(url, None::<String>);
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
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// WebView2 렌더러 프로세스가 죽으면(메모리 부족 등) 자동 리로드해 화면을 복구한다.
// 리로드 후 프론트 boot() 가 get_scrollback 으로 세션 내용을 복원하므로 데이터 손실이 없다.
// (PTY 와 자식 프로세스는 Rust 쪽에 있어 렌더러 크래시의 영향을 받지 않는다)
#[cfg(windows)]
fn install_crash_recovery(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    let _ = window.with_webview(|webview| unsafe {
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
                // 렌더러 프로세스 사망일 때만 리로드 (Unresponsive 등은 스스로 회복 가능)
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    if let Some(wv) = &sender {
                        let _ = wv.Reload();
                    }
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

fn main() {
    let builder = tauri::Builder::default();
    // 단일 인스턴스(릴리즈 전용, 반드시 첫 번째로 등록) — 중복 실행 시 기존 창을 앞으로.
    // dev 빌드는 제외 — 같은 identifier 를 공유해 설치본이 떠 있으면 dev 실행이 차단된다.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(win) = app.get_webview_window("main") {
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
            explorer::list_dir,
            explorer::git_status,
            explorer::read_text_file,
            codex::list_codex_sessions,
            codex::codex_session_messages,
            codex::codex_usage,
            hooks::hooks_status,
            hooks::claude_session_of,
            hooks::set_claude_hooks,
            hooks::set_codex_hooks
        ])
        .run(tauri::generate_context!())
        .expect("Terminal Assistance 실행 실패");
}
