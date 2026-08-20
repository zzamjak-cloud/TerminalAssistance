// Tauri IPC 어댑터 — 렌더러의 나머지 코드는 window.ta 만 사용한다.
// (백엔드 구현이 바뀌어도 이 파일만 교체하면 되도록 격리)
(function () {
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.ta = {
    getState: () => invoke('get_state'),

    addProject: (p) => invoke('add_project', { name: p.name, path: p.path, color: p.color || null }),
    updateProject: (id, patch) => invoke('update_project', { id, name: patch.name ?? null, path: patch.path ?? null, color: patch.color ?? null }),
    removeProject: (id) => invoke('remove_project', { id }),
    reorderProjects: (ids) => invoke('reorder_projects', { ids }),
    pickFolder: () => invoke('pick_folder'),

    addPreset: (p) => invoke('add_preset', { label: p.label, command: p.command, projectId: p.projectId || null }),
    updatePreset: (id, patch) => invoke('update_preset', {
      id,
      label: patch.label ?? null,
      command: patch.command ?? null,
      projectId: patch.projectId ?? null,
      clearProject: patch.clearProject ?? null
    }),
    removePreset: (id) => invoke('remove_preset', { id }),
    reorderPresets: (ids) => invoke('reorder_presets', { ids }),

    updateSettings: (patch) => invoke('update_settings', {
      fontSize: patch.fontSize ?? null,
      shell: patch.shell ?? null,
      notifyOnDone: patch.notifyOnDone ?? null
    }),

    createSession: (projectId) => invoke('create_session', { projectId: projectId || null }),
    // Claude Code 가 저장해 둔 세션 목록 (cwd 기준) — [{ id, mtimeMs, preview }]
    listClaudeSessions: (cwd) => invoke('list_claude_sessions', { cwd }),
    write: (id, data) => invoke('write_session', { id, data }),
    resize: (id, cols, rows) => invoke('resize_session', { id, cols, rows }),
    closeSession: (id) => invoke('close_session', { id }),
    ackSession: (id) => invoke('ack_session', { id }),
    // 웹뷰 리로드/크래시 복구용 스크롤백 스냅샷 { data, off }
    getScrollback: (id) => invoke('get_scrollback', { id }),
    // 출력 소비 확인 (flow control) — xterm 기록 완료 바이트 수
    ackData: (id, bytes) => invoke('ack_data', { id, bytes }),

    // 시스템 메모리 현황 { pct, usedGb, totalGb }
    getMemory: () => invoke('get_memory'),
    // 작업 폴더의 git 브랜치 (없으면 null)
    gitBranch: (cwd) => invoke('git_branch', { cwd }),
    // 코덱스 사용량 { windows: [{windowMinutes, usedPercent, resetsAt}], plan, mtimeMs } | null
    codexUsage: () => invoke('codex_usage'),
    // '다음 프롬프트' 초안 (프로젝트별, 키: projectId 또는 "")
    setDrafts: (key, drafts) => invoke('set_drafts', { key, drafts }),

    checkUpdate: () => invoke('check_update'),
    installUpdate: () => invoke('install_update'),
    openUrl: (url) => invoke('open_url', { url }),

    clipboardImage: () => invoke('clipboard_image'),
    clipboardText: () => invoke('clipboard_text'),
    openPath: (p) => invoke('open_path', { path: p }),
    notify: (title, body) => invoke('notify', { title, body }),
    fileSrc: (p) => convertFileSrc(p),

    onData: (cb) => listen('ta:data', (e) => cb(e.payload)),
    onStatus: (cb) => listen('ta:status', (e) => cb(e.payload)),
    onExit: (cb) => listen('ta:exit', (e) => cb(e.payload)),
    // Tauri 는 파일 드롭을 웹뷰 대신 네이티브 이벤트로 준다 (실제 경로 포함)
    onFileDrop: (cb) => listen('tauri://drag-drop', (e) => cb(e.payload))
  };
})();
