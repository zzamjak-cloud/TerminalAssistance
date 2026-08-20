// AI 도구 연동 — '허가 대기' 상태의 정확한 감지를 위한 외부 설정 설치/제거 + 훅 상태 파일 열람.
//
// Claude Code: ~/.claude/settings.json 에 훅을 병합 설치. 훅 스크립트는 stdin JSON 을 받아
//   ~/.terminal-assistance/hooks/state/<TA_SESSION_ID>.json 에 상태를 기록한다.
//   (TA_SESSION_ID 는 pty.rs 가 세션 생성 시 주입 — 훅은 claude 의 자식이라 env 를 상속)
// Codex: 훅이 없어 ~/.codex/config.toml 의 [tui] notifications 를 켜고,
//   OSC 9 이스케이프를 pty.rs 리더가 직접 가로챈다 (이 모듈은 설치만 담당).
//
// 설치는 모두 opt-in 이며 기존 사용자 설정을 보존 병합하고 .bak-ta 백업을 남긴다.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// 훅 스크립트 식별 마커 — 설치 여부 판정과 제거 시 우리 항목 선별에 사용
const MARKER: &str = "ta-hook";

/// Claude Code 훅 수신기 (macOS/Linux). 어떤 실패도 Claude 실행을 막지 않도록 항상 exit 0.
const HOOK_SH: &str = r#"#!/bin/bash
# Terminal Assistance — Claude Code 훅 수신기 (자동 생성 파일, 수정하지 말 것)
[ -n "$TA_SESSION_ID" ] || exit 0
input=$(cat)
event=$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
# Claude 세션 UUID — 채팅 뷰가 어느 jsonl 을 tail 할지 아는 열쇠
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
dir="$HOME/.terminal-assistance/hooks/state"
mkdir -p "$dir" 2>/dev/null
file="$dir/$TA_SESSION_ID.json"
ts=$(($(date +%s) * 1000))
write_state() {
  tmp="$file.tmp.$$"
  printf '{"state":"%s","ts":%s,"sid":"%s"}' "$1" "$ts" "$sid" > "$tmp" 2>/dev/null && mv -f "$tmp" "$file" 2>/dev/null
}
case "$event" in
  UserPromptSubmit|PostToolUse) write_state busy ;;
  Stop) write_state done ;;
  Notification)
    # 'permission' 포함 = 진짜 허가 요청. 그 외(60초 무입력 유휴 등)는 노이즈라 무시
    printf '%s' "$input" | grep -qi 'permission' && write_state waiting ;;
  SessionEnd) rm -f "$file" 2>/dev/null ;;
esac
exit 0
"#;

/// Claude Code 훅 수신기 (Windows). HOOK_SH 와 동일한 동작.
const HOOK_PS1: &str = r#"# Terminal Assistance — Claude Code 훅 수신기 (자동 생성 파일, 수정하지 말 것)
try {
  if (-not $env:TA_SESSION_ID) { exit 0 }
  $inp = [Console]::In.ReadToEnd()
  $j = $inp | ConvertFrom-Json
  $dir = Join-Path $env:USERPROFILE ".terminal-assistance\hooks\state"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir "$($env:TA_SESSION_ID).json"
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  function Write-State($s) {
    $tmp = "$file.tmp"
    "{""state"":""$s"",""ts"":$ts,""sid"":""$($j.session_id)""}" | Set-Content -Path $tmp -Encoding utf8 -NoNewline
    Move-Item -Force $tmp $file
  }
  switch ($j.hook_event_name) {
    { $_ -in "UserPromptSubmit", "PostToolUse" } { Write-State "busy" }
    "Stop" { Write-State "done" }
    "Notification" { if ("$($j.message)" -match "permission") { Write-State "waiting" } }
    "SessionEnd" { Remove-Item -Force $file -ErrorAction SilentlyContinue }
  }
} catch {}
exit 0
"#;

/// 훅이 설치 대상으로 삼는 Claude Code 이벤트 목록
const CLAUDE_EVENTS: [&str; 5] = ["UserPromptSubmit", "PostToolUse", "Stop", "Notification", "SessionEnd"];

fn home() -> Result<PathBuf, String> {
    crate::claude::home_dir().ok_or_else(|| "홈 디렉토리를 찾을 수 없습니다".into())
}

fn hooks_dir(home: &PathBuf) -> PathBuf {
    home.join(".terminal-assistance").join("hooks")
}

pub fn state_dir() -> Option<PathBuf> {
    home().ok().map(|h| hooks_dir(&h).join("state"))
}

/// 앱 시작 시 고아 상태 파일 정리 — 세션은 앱 수명과 함께 끝나므로 남은 파일은 전부 낡은 것
pub fn clean_state_dir() {
    if let Some(dir) = state_dir() {
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
    }
}

pub fn remove_state(session_id: &str) {
    if let Some(dir) = state_dir() {
        let _ = fs::remove_file(dir.join(format!("{}.json", session_id)));
    }
}

/// 앱 시작 시 훅 스크립트를 최신 임베드 버전으로 갱신 — 이미 설치된 사용자가
/// 앱 업데이트 후 재설치 없이 새 필드(sid 등)를 얻게 한다
pub fn refresh_hook_script() {
    if let Ok(home) = home() {
        if claude_installed(&home) {
            let _ = write_hook_script(&home);
        }
    }
}

/// 훅이 기록해 둔 해당 터미널 세션의 Claude 세션 UUID (채팅 뷰의 jsonl 식별용)
#[tauri::command]
pub fn claude_session_of(session_id: String) -> Option<String> {
    let dir = state_dir()?;
    let text = fs::read_to_string(dir.join(format!("{}.json", session_id))).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v["sid"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// 훅이 기록한 세션별 최신 상태
pub struct HookState {
    pub state: String, // "busy" | "waiting" | "done"
    pub ts: u64,
}

/// 상태 디렉토리 스냅샷. dir_mtime 이 이전과 같으면 None (호출측 캐시 재사용) —
/// 500ms 폴링마다 파일을 다시 파싱하지 않기 위한 가드
pub fn read_states(last_mtime: &mut Option<SystemTime>) -> Option<HashMap<String, HookState>> {
    let dir = state_dir()?;
    let mtime = fs::metadata(&dir).and_then(|m| m.modified()).ok();
    if mtime.is_some() && mtime == *last_mtime {
        return None;
    }
    *last_mtime = mtime;
    let mut map = HashMap::new();
    let entries = fs::read_dir(&dir).ok()?;
    for e in entries.flatten() {
        let path = e.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let (Some(state), Some(ts)) = (v["state"].as_str(), v["ts"].as_u64()) else { continue };
        map.insert(id.to_string(), HookState { state: state.to_string(), ts });
    }
    Some(map)
}

// ── Claude Code: ~/.claude/settings.json 병합 설치 ──

/// settings.json 에 등록할 훅 명령 문자열 (OS 별)
fn hook_command(home: &PathBuf) -> String {
    if cfg!(windows) {
        format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            hooks_dir(home).join("ta-hook.ps1").display()
        )
    } else {
        format!("\"{}\"", hooks_dir(home).join("ta-hook.sh").display())
    }
}

/// 훅 스크립트 파일 기록 (+ unix 실행 권한)
fn write_hook_script(home: &PathBuf) -> Result<(), String> {
    let dir = hooks_dir(home);
    fs::create_dir_all(dir.join("state")).map_err(|e| e.to_string())?;
    let (name, body) = if cfg!(windows) { ("ta-hook.ps1", HOOK_PS1) } else { ("ta-hook.sh", HOOK_SH) };
    let path = dir.join(name);
    fs::write(&path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// 원자적 저장 — 병합 도중 크래시로 사용자 설정이 깨지지 않게
fn atomic_write(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("ta-tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn install_claude() -> Result<(), String> {
    let home = home()?;
    write_hook_script(&home)?;
    let path = home.join(".claude").join("settings.json");
    let mut root: Value = if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // 깨진 JSON 은 덮어쓰지 않는다 — 사용자가 직접 복구해야 할 수 있음
        serde_json::from_str(&text).map_err(|e| format!("settings.json 파싱 실패 (설치 중단): {}", e))?
    } else {
        json!({})
    };
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak-ta"));
    }
    let cmd = hook_command(&home);
    let hooks = root
        .as_object_mut()
        .ok_or("settings.json 루트가 객체가 아닙니다")?
        .entry("hooks")
        .or_insert(json!({}));
    let hooks = hooks.as_object_mut().ok_or("settings.json 의 hooks 가 객체가 아닙니다")?;
    let mut added = false;
    for ev in CLAUDE_EVENTS {
        let arr = hooks.entry(ev).or_insert(json!([]));
        let arr = arr.as_array_mut().ok_or_else(|| format!("hooks.{} 가 배열이 아닙니다", ev))?;
        // 기존 사용자 훅은 보존, 우리 항목은 중복 등록 방지
        if !arr.iter().any(|e| e.to_string().contains(MARKER)) {
            arr.push(json!({ "hooks": [{ "type": "command", "command": cmd }] }));
            added = true;
        }
    }
    if added {
        atomic_write(&path, &serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

pub fn uninstall_claude() -> Result<(), String> {
    let home = home()?;
    let path = home.join(".claude").join("settings.json");
    let Ok(text) = fs::read_to_string(&path) else { return Ok(()) };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else {
        return Err("settings.json 파싱 실패 (제거 중단)".into());
    };
    let mut changed = false;
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for ev in CLAUDE_EVENTS {
            if let Some(arr) = hooks.get_mut(ev).and_then(|a| a.as_array_mut()) {
                let before = arr.len();
                arr.retain(|e| !e.to_string().contains(MARKER)); // 우리 항목만 선별 제거
                changed |= arr.len() != before;
            }
        }
        // 우리 제거로 빈 배열이 된 이벤트 키는 정리
        let empties: Vec<String> = hooks
            .iter()
            .filter(|(k, v)| CLAUDE_EVENTS.contains(&k.as_str()) && v.as_array().is_some_and(|a| a.is_empty()))
            .map(|(k, _)| k.clone())
            .collect();
        for k in empties {
            hooks.remove(&k);
        }
    }
    if changed {
        atomic_write(&path, &serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

fn claude_installed(home: &PathBuf) -> bool {
    fs::read_to_string(home.join(".claude").join("settings.json"))
        .map(|t| t.contains(MARKER))
        .unwrap_or(false)
}

// ── Codex: ~/.codex/config.toml 의 [tui] notifications 활성화 ──

const CODEX_EVENTS: [&str; 2] = ["agent-turn-complete", "approval-requested"];

pub fn install_codex() -> Result<(), String> {
    let home = home()?;
    let path = home.join(".codex").join("config.toml");
    let text = fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut =
        text.parse().map_err(|e| format!("config.toml 파싱 실패 (설치 중단): {}", e))?;
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("toml.bak-ta"));
    }
    let tui = doc
        .entry("tui")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    let tui = tui.as_table_mut().ok_or("config.toml 의 [tui] 가 테이블이 아닙니다")?;

    // notifications = true 는 이미 전 이벤트 활성 → 손대지 않음
    if tui.get("notifications").and_then(|i| i.as_bool()) != Some(true) {
        let mut arr = toml_edit::Array::new();
        if let Some(existing) = tui.get("notifications").and_then(|i| i.as_array()) {
            for v in existing.iter() {
                if let Some(s) = v.as_str() {
                    arr.push(s); // 사용자가 켜 둔 다른 이벤트 보존
                }
            }
        }
        for want in CODEX_EVENTS {
            if !arr.iter().any(|v| v.as_str() == Some(want)) {
                arr.push(want);
            }
        }
        tui["notifications"] = toml_edit::value(arr);
    }
    // 알림이 OSC 시퀀스로 PTY 를 통과해야 우리가 가로챌 수 있다 — 미설정일 때만 지정
    if tui.get("notification_method").is_none() {
        tui["notification_method"] = toml_edit::value("osc9");
    }
    atomic_write(&path, &doc.to_string())
}

pub fn uninstall_codex() -> Result<(), String> {
    let home = home()?;
    let path = home.join(".codex").join("config.toml");
    let Ok(text) = fs::read_to_string(&path) else { return Ok(()) };
    let mut doc: toml_edit::DocumentMut =
        text.parse().map_err(|e| format!("config.toml 파싱 실패 (제거 중단): {}", e))?;
    let Some(tui) = doc.get_mut("tui").and_then(|t| t.as_table_mut()) else { return Ok(()) };
    // 우리가 추가하는 이벤트만 제거 — bool(사용자 직접 설정)은 건드리지 않음
    if let Some(arr) = tui.get_mut("notifications").and_then(|i| i.as_array_mut()) {
        arr.retain(|v| !CODEX_EVENTS.contains(&v.as_str().unwrap_or("")));
        if arr.is_empty() {
            tui.remove("notifications");
        }
    }
    atomic_write(&path, &doc.to_string())
}

fn codex_installed(home: &PathBuf) -> bool {
    let Ok(text) = fs::read_to_string(home.join(".codex").join("config.toml")) else { return false };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else { return false };
    let Some(notif) = doc.get("tui").and_then(|t| t.get("notifications")) else { return false };
    notif.as_bool() == Some(true)
        || notif
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some("approval-requested")))
}

// ── IPC 커맨드 ──

#[tauri::command]
pub fn hooks_status() -> serde_json::Value {
    let Ok(home) = home() else { return json!({ "claude": false, "codex": false }) };
    json!({ "claude": claude_installed(&home), "codex": codex_installed(&home) })
}

#[tauri::command]
pub fn set_claude_hooks(enable: bool) -> Result<(), String> {
    if enable { install_claude() } else { uninstall_claude() }
}

#[tauri::command]
pub fn set_codex_hooks(enable: bool) -> Result<(), String> {
    if enable { install_codex() } else { uninstall_codex() }
}
