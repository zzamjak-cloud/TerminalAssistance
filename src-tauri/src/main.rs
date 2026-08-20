// Terminal Assistance — Tauri 진입점 + IPC 커맨드 정의
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pty;
mod store;
mod util;

use pty::PtyManager;
use serde_json::json;
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use store::{new_id, Preset, Project, Store};
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
        "settings": s.data.settings,
        "drafts": s.data.drafts,
        "sessions": ptys.list(),
        "platform": std::env::consts::OS
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
    let pct = if total > 0 { (used as f64 / total as f64 * 100.0).round() as u32 } else { 0 };
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
fn add_project(store: StoreState, name: String, path: String, color: Option<String>) -> Result<Project, String> {
    let p = Project { id: new_id(), name, path, color: color.unwrap_or_else(|| "#4f8cc9".into()) };
    let mut s = plock(&store);
    s.data.projects.push(p.clone());
    s.save()?;
    Ok(p)
}

#[tauri::command]
fn update_project(store: StoreState, id: String, name: Option<String>, path: Option<String>, color: Option<String>) -> Result<(), String> {
    let mut s = plock(&store);
    let Some(p) = s.data.projects.iter_mut().find(|p| p.id == id) else {
        return Err("프로젝트를 찾을 수 없습니다".into());
    };
    if let Some(v) = name { p.name = v; }
    if let Some(v) = path { p.path = v; }
    if let Some(v) = color { p.color = v; }
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
    s.data.presets.retain(|p| p.project_id.as_deref() != Some(id.as_str()));
    s.save()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    // blocking 다이얼로그는 async 커맨드(워커 스레드)에서 호출해 UI 를 막지 않는다
    app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
}

// ── 프리셋 ──
#[tauri::command]
fn add_preset(store: StoreState, label: String, command: String, project_id: Option<String>) -> Result<Preset, String> {
    let p = Preset { id: new_id(), label, command, project_id };
    let mut s = plock(&store);
    s.data.presets.push(p.clone());
    s.save()?;
    Ok(p)
}

#[tauri::command]
fn update_preset(store: StoreState, id: String, label: Option<String>, command: Option<String>, project_id: Option<String>, clear_project: Option<bool>) -> Result<(), String> {
    let mut s = plock(&store);
    let Some(p) = s.data.presets.iter_mut().find(|p| p.id == id) else {
        return Err("프리셋을 찾을 수 없습니다".into());
    };
    if let Some(v) = label { p.label = v; }
    if let Some(v) = command { p.command = v; }
    if clear_project == Some(true) { p.project_id = None; }
    else if project_id.is_some() { p.project_id = project_id; }
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

// ── 설정 ──
#[tauri::command]
fn update_settings(store: StoreState, font_size: Option<u32>, shell: Option<String>, notify_on_done: Option<bool>) -> Result<store::Settings, String> {
    let mut s = plock(&store);
    if let Some(v) = font_size { s.data.settings.font_size = v; }
    if let Some(v) = shell { s.data.settings.shell = v; }
    if let Some(v) = notify_on_done { s.data.settings.notify_on_done = v; }
    s.save()?;
    Ok(s.data.settings.clone())
}

// ── 세션 ──
#[tauri::command]
fn create_session(app: AppHandle, store: StoreState, ptys: State<PtyManager>, project_id: Option<String>) -> Result<pty::SessionInfo, String> {
    let (cwd, title, shell) = {
        let s = plock(&store);
        let proj = project_id.as_ref().and_then(|pid| s.data.projects.iter().find(|p| &p.id == pid));
        (
            proj.map(|p| p.path.clone()),
            proj.map(|p| p.name.clone()),
            s.data.settings.shell.clone(),
        )
    };
    ptys.create(app, project_id, cwd, &shell, title)
}

#[tauri::command]
fn write_session(ptys: State<PtyManager>, id: String, data: String) {
    ptys.write(&id, &data);
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
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
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
async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo { version: update.version.clone(), notes: update.body.clone() };
            *plock(&pending) = Some(update);
            Ok(Some(info))
        }
        _ => Ok(None), // 업데이트 없음 또는 네트워크 오류 → 조용히 무시
    }
}

#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = plock(&pending).take();
    let Some(update) = update else { return Err("보류 중인 업데이트가 없습니다".into()) };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// ── 완료 알림 (설정이 켜져 있을 때만) ──
#[tauri::command]
fn notify(app: AppHandle, store: StoreState, title: String, body: String) {
    if !plock(&store).data.settings.notify_on_done {
        return;
    }
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
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(
            move |sender: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
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
    tauri::Builder::default()
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
            app.state::<PtyManager>().start_status_thread(app.handle().clone());
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
            update_settings,
            create_session,
            write_session,
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
            notify
        ])
        .run(tauri::generate_context!())
        .expect("Terminal Assistance 실행 실패");
}
