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

    addRecipe: (r) => invoke('add_recipe', { label: r.label, commands: r.commands, projectId: r.projectId || null }),
    updateRecipe: (id, patch) => invoke('update_recipe', {
      id,
      label: patch.label ?? null,
      commands: patch.commands ?? null,
      projectId: patch.projectId ?? null,
      clearProject: patch.clearProject ?? null
    }),
    removeRecipe: (id) => invoke('remove_recipe', { id }),

    updateSettings: (patch) => invoke('update_settings', {
      fontSize: patch.fontSize ?? null,
      shell: patch.shell ?? null,
      notifyOnDone: patch.notifyOnDone ?? null,
      notifyOnWaiting: patch.notifyOnWaiting ?? null,
      lineHeight: patch.lineHeight ?? null,
      letterSpacing: patch.letterSpacing ?? null,
      minContrast: patch.minContrast ?? null
    }),

    // AI 도구 연동 상태 { claude, codex } / 설치·제거 (허가 대기 감지)
    hooksStatus: () => invoke('hooks_status'),
    setClaudeHooks: (enable) => invoke('set_claude_hooks', { enable }),
    setCodexHooks: (enable) => invoke('set_codex_hooks', { enable }),

    createSession: (projectId) => invoke('create_session', { projectId: projectId || null }),
    // Claude Code 가 저장해 둔 세션 목록 (cwd 기준) — [{ id, mtimeMs, preview }]
    listClaudeSessions: (cwd) => invoke('list_claude_sessions', { cwd }),
    // 세션 열람 팝업용: 저장된 세션 기록 → 대화 메시지 [{ role, kind, text }]
    claudeSessionMessages: (cwd, id) => invoke('claude_session_messages', { cwd, id }),
    // Codex 가 저장해 둔 세션 목록 (cwd 기준) — [{ id, mtimeMs, preview }]
    listCodexSessions: (cwd) => invoke('list_codex_sessions', { cwd }),
    // 세션 열람 팝업용: 저장된 Codex 기록 → 대화 메시지 [{ role, kind, text }]
    codexSessionMessages: (cwd, id) => invoke('codex_session_messages', { cwd, id }),
    // 통합 문서 (계획 + 프로젝트 내부 Markdown 메모)
    listPlanDocs: (cwd) => invoke('list_plan_docs', { cwd }),
    getPlanDoc: (cwd, id) => invoke('get_plan_doc', { cwd, id }),
    addPlanDoc: (cwd, sessionId, text) => invoke('add_plan_doc', { cwd, sessionId, text }),
    registerPlanFile: (cwd, path) => invoke('register_plan_file', { cwd, path }),
    dismissPlanDoc: (cwd, id) => invoke('dismiss_plan_doc', { cwd, id }),
    createMemoDoc: (cwd, title, markdown, legacyId) => invoke('create_memo_doc', {
      cwd, title, markdown, legacyId: legacyId || null
    }),
    deleteMemoDoc: (cwd, id) => invoke('delete_memo_doc', { cwd, id }),
    // 탐색기: 디렉토리 1단계 목록 [{ name, path, isDir }] (지연 로딩)
    listDir: (path) => invoke('list_dir', { path }),
    // git 변경 파일 { root, files: { 상대경로: 상태문자 } } | null (저장소 아님)
    gitStatus: (cwd) => invoke('git_status', { cwd }),
    // 미리보기용 텍스트 읽기 { content, truncated, size } — 바이너리면 reject
    readTextFile: (path) => invoke('read_text_file', { path }),
    write: (id, data) => invoke('write_session', { id, data }),
    resize: (id, cols, rows) => invoke('resize_session', { id, cols, rows }),
    closeSession: (id) => invoke('close_session', { id }),
    renameSession: (id, title) => invoke('rename_session', { id, title }),
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
    // 초안·예약 저장소. memo:<projectId>는 실제 Markdown 파일로 이전할 구버전 데이터다.
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
