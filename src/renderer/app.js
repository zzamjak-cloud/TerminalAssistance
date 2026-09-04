// 앱 상태·부트스트랩·세션 수명주기.
// 나머지 책임은 파일로 분리: 초안 drafts.js / AI 세션 기록 열람 claude-sessions.js /
// 패널 레이아웃 panel-layout.js / 모달 modals.js / 사이드바 렌더 sidebar.js /
// 분할·패널 헤더(프리셋 드롭다운) split-view.js /
// 터미널 terminal-view.js. 각 파일이 Object.assign(App, ...) 으로 메서드를 붙인다.
const GIT_REMOTE_FETCH_MIN_MS = 15_000;
const GIT_REMOTE_POLL_MS = 60_000;

const App = {
  state: {
    projects: [],
    presets: [],
    recipes: [],
    settings: {
      fontSize: 13, fontFamily: '', shell: '', notifyOnDone: true, notifyOnWaiting: true,
      lineHeight: 1, letterSpacing: 0, minContrast: 1
    },
    sessions: [],   // { id, projectId, title, status, cwd }
    activeId: null,
    platform: '',   // 백엔드가 알려주는 OS (windows | macos | linux)
    images: {},     // sessionId → [{ path, src }] 최근 첨부 이미지
    imageStripFolded: JSON.parse(localStorage.getItem('ta-image-strip-fold') || '{}'), // sessionId → 참조 이미지 접힘 상태
    branches: {},   // sessionId → git 브랜치명 (헤더 표시용, 2초 폴링)
    gitRemote: {},  // cwd → { branch, hasUpstream, behind, ahead, fetchFailed } | null(=git 저장소 아님)
                    // 보이는 cwd 만 공유하며 브랜치 전환·앱 복귀·저빈도 폴링 때 갱신한다
    drafts: {},     // projectId/queued:<sessionId>, memo:<projectId>는 Markdown 이전 전 구버전 데이터
    projectEmptyId: null // 세션 없는 프로젝트 선택 시 '새 세션 시작' 화면 대상
  },

  // 프로젝트별 마지막 선택 세션 — 프로젝트 클릭 시 이 세션으로 복귀 (렌더러 로컬 설정)
  lastSessionByProject: JSON.parse(localStorage.getItem('ta-last-session-by-project') || '{}'),

  async boot() {
    // 크래시 복구 감지 — sessionStorage 는 렌더러 리로드에는 살아남고 새 프로세스에선 비어 있다.
    // 값이 이미 있으면 이번 boot 는 리로드(크래시 자동 복구 또는 수동 새로고침)다.
    const recovered = sessionStorage.getItem('ta-booted') === '1';
    sessionStorage.setItem('ta-booted', '1');
    TerminalView.init();
    // 기본 온보딩 안내(index.html 정적 마크업)를 보관 — 빈 프로젝트 화면과 번갈아 쓴다
    App._emptyDefault = document.getElementById('empty-state').innerHTML;
    const st = await ta.getState();
    Object.assign(App.state, {
      projects: st.projects, presets: st.presets, recipes: st.recipes || [], settings: st.settings, sessions: st.sessions,
      drafts: st.drafts || {}, platform: st.platform || ''
    });
    await App.cleanupDeadQueuedPrompts();
    App.restoreComposerTexts(); // 리로드·재시작 전 작성 중이던 프롬프트 복원
    // 리로드·종료 직전 작성 중 텍스트를 즉시 저장 (스로틀 대기분 포함)
    window.addEventListener('pagehide', () => App.flushComposerPersists());

    // 웹뷰 리로드/크래시 복구: 백엔드에 살아있는 세션의 터미널 뷰를 먼저 frozen 으로 만들어
    // 리스너 등록 후 도착하는 라이브 출력을 큐에 담아 두고, 스크롤백 주입 뒤 이어붙인다.
    const restoring = st.sessions.slice();
    for (const s of restoring) {
      TerminalView.create(s, App.state.settings.fontSize, { frozen: true });
    }

    ta.onData((p) => TerminalView.feed(p));
    ta.onStatus(({ sessionId, status, busyMs }) => {
      const s = App.state.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      const prevStatus = s.status;
      s.status = status;
      if (status === 'done') {
        App.onDone(s, busyMs);
        // 반복 done 이벤트가 다음 예약까지 소진하지 않도록 실제 실행 완료 전이만 처리한다.
        if (prevStatus === 'running') App.handleQueuedDone(sessionId);
      } else {
        App.clearDoneTimers(sessionId); // 새 작업 시작/입력 등으로 done 이탈 → 확인 추적 취소
      }
      if (status === 'waiting') App.onWaiting(s);
      updateSessionStatus(s); // 전체 재구축 대신 해당 행만 갱신 (호버·드래그 유지)
      App.refreshPickerStatus(s); // 피커·패널 헤더의 상태 태그만 최신화 (단일 화면 헤더 포함)
      App.renderTopbar();
      App.renderComposerQueue(); // 보이는 패널 전부의 예약 목록 갱신
    });
    ta.onExit(({ sessionId }) => {
      TerminalView.write(sessionId, '\r\n\x1b[31m[세션 종료됨 — 닫기(✕)로 정리]\x1b[0m\r\n');
    });
    ta.onFileDrop((payload) => {
      const paths = payload && payload.paths ? payload.paths : [];
      if (paths.length) App.handleDrop(paths, payload.position);
    });
    // 데스크톱 알림 클릭 → 창은 백엔드가 이미 앞으로 올렸고, 여기서 세션을 화면에 띄운다
    ta.onActivateSession((sessionId) => App.revealSession(sessionId));
    // 다른 앱에 있다가 돌아오거나 숨었던 창이 다시 보이면, 보이는 저장소의 Pull 상태도 갱신한다.
    // macOS 웹뷰는 focus와 visibilitychange를 연달아 보낼 수 있어 cwd별 fetch TTL로 합친다.
    const refreshAfterAppResume = () => {
      App.checkDoneViewed(App.state.activeId);
      void App.refreshBranch();
      App.refreshVisibleGitRemote({ fetch: true });
    };
    window.addEventListener('focus', refreshAfterAppResume);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshAfterAppResume();
    });
    window.addEventListener('online', () => {
      App.refreshVisibleGitRemote({ fetch: true, forceFetch: true });
    });
    // 허가 대기 배지 클릭 → 대기 중인 세션으로 점프 (여러 개면 클릭할 때마다 순환)
    document.getElementById('waiting-indicator').onclick = () => {
      const ws = App.state.sessions.filter((x) => x.status === 'waiting');
      if (!ws.length) return;
      const i = ws.findIndex((x) => x.id === App.state.activeId);
      // toBottom: 이미 패널에 보이는 세션이라도 허가 프롬프트가 보이게 바닥으로 점프
      App.activateSession(ws[(i + 1) % ws.length].id, { toBottom: true });
    };

    document.getElementById('btn-add-project').onclick = () => App.showProjectModal();
    document.getElementById('btn-settings').onclick = () => App.showSettingsModal();
    document.getElementById('btn-help').onclick = () => App.showHelpModal();
    document.getElementById('btn-toggle-prompts').onclick = () => App.togglePromptPanel();
    document.getElementById('btn-claude-refresh').onclick = () => App.renderClaudeList(true);
    document.getElementById('btn-plan-refresh').onclick = () => App.renderPlanList(true);
    document.getElementById('btn-memo-add').onclick = () => App.showMemoModal();
    // 시스템 메모리 폴링 (2초)
    setInterval(() => App.pollStatus(), 2000);
    App.pollStatus();
    // 앱을 계속 열어 둔 동안 생긴 원격 변경도 놓치지 않는다. 숨김 상태에서는 네트워크를 쓰지 않는다.
    setInterval(() => {
      if (document.visibilityState === 'visible') App.refreshVisibleGitRemote({ fetch: true });
    }, GIT_REMOTE_POLL_MS);
    // 코덱스 사용량 폴링 (10초 — 파일 꼬리 읽기라 가볍지만 데이터 갱신 주기도 느리다)
    setInterval(() => App.pollCodexUsage(), 10000);
    App.pollCodexUsage();
    // Claude Code 사용량 폴링 (30초 — 실제 API 호출은 Rust 쪽에서 1분 캐시로 묶인다)
    setInterval(() => App.pollClaudeUsage(), 30000);
    App.pollClaudeUsage();
    if (localStorage.getItem('ta-prompt-panel') === '1') {
      document.getElementById('prompt-panel').classList.remove('hidden');
    }
    App.initPanelUI();
    App.initSplitUI();
    App.restoreSplitState(); // 세션 목록이 채워진 뒤 분할 모드·패널 배정 복원
    App.initExplorer();
    App.initTerminalSearchUI();

    // 터미널 밖에 포커스가 있을 때의 단축키
    window.addEventListener('keydown', (ev) => {
      App.handleAppShortcut(ev);
    });

    // 세션 내용 복원: 스냅샷을 병렬 조회하고 도착 즉시 주입 (세션 간 순서 의존성 없음)
    await Promise.all(restoring.map(async (s) => {
      try {
        const snap = await ta.getScrollback(s.id);
        TerminalView.restore(s.id, snap);
      } catch (_) {
        TerminalView.restore(s.id, null); // 스냅샷 실패해도 라이브 출력은 살린다
      }
    }));
    if (restoring.length) {
      // 리로드 전 활성 세션 우선, 없으면 마지막 세션
      const saved = localStorage.getItem('ta-active-session');
      let target = restoring.find((s) => s.id === saved) || restoring[restoring.length - 1];
      // 분할 복원 중: 저장된 활성 세션이 패널 배정에 없으면 배정된 세션을 우선한다
      // (activateSession 이 포커스 패널 배정을 덮어써 복원 레이아웃이 유실되는 것 방지)
      if (App.isSplit() && !App.splitVisiblePanes().includes(target.id)) {
        const fallback = App.split.panes[App.split.focused] || App.splitVisiblePanes().find(Boolean);
        const alive = fallback && restoring.find((s) => s.id === fallback);
        if (alive) target = alive;
      }
      App.activateSession(target.id);
    }

    App.renderAll();
    if (recovered) App.noteRecovery(); // UI 가 그려진 뒤 복구 사실을 알린다
    App.refreshVisibleGitRemote({ fetch: true }); // 복원 뒤 실제로 보이는 cwd만 fetch

    // 자동 업데이트 확인 (백그라운드 — 실패는 조용히 무시)
    setTimeout(() => App.checkUpdate(), 2500);
  },

  // ── 크래시 복구 가시화 ──
  // 리로드 복구가 일어났음을 토스트로 알리고 누적 횟수·시각을 기록한다.
  // (수동 새로고침도 같은 경로로 감지되지만, 알림이 무해하므로 구분하지 않는다)
  noteRecovery() {
    let count = 0;
    try {
      count = (parseInt(localStorage.getItem('ta-recovery-count'), 10) || 0) + 1;
      localStorage.setItem('ta-recovery-count', String(count));
      // 최근 복구 시각 30건 보관 — 깜빡임 원인 추적용 (콘솔에서 ta-recovery-log 조회)
      let log = [];
      try { log = JSON.parse(localStorage.getItem('ta-recovery-log') || '[]'); } catch (_) {}
      log.push(new Date().toISOString());
      localStorage.setItem('ta-recovery-log', JSON.stringify(log.slice(-30)));
    } catch (_) {}
    App.showToast(`⟳ 화면이 복구되었습니다 — 작성 중이던 프롬프트는 보존됩니다${count ? ` (누적 ${count}회)` : ''}`);
  },

  // 하단 중앙 토스트 — 자동으로 사라진다 (복구 알림 등 가벼운 공지용)
  showToast(message, ms) {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => el.classList.remove('show'), ms || 7000);
  },

  // 테마 변경 후 — JS 로 직접 칠한 색(프로젝트 이름 등)을 새 테마 기준으로 다시 계산
  refreshThemedColors() {
    if (!App.state.projects.length && !App.state.sessions.length) return;
    renderSidebar();
    App.renderTopbar();
    App.renderEmptyState();
    App.renderPanePickers();
    App.renderPanePresets(); // 패널 헤더는 단일 화면에도 있다
  },

  renderAll() {
    renderSidebar();
    App.renderExplorer();
    App.renderSplit(); // renderPanePresets(패널 헤더·프리셋 드롭다운) 포함
    App.renderTopbar();
    App.renderImageStrip();
    App.renderClaudeList();
    App.renderPlanList();
    void App.migrateLegacyMemos();
    App.renderComposerQueue();
    App.renderEmptyState();
  },

  isOverlayOpen(id) {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  },

  isShortcutBlocked(ev, opts) {
    if (ev.isComposing || ev.keyCode === 229) return true;
    if (App.isOverlayOpen('modal-backdrop')) return true;
    if (opts && opts.fromTerminal) return false;
    const t = ev.target;
    return !!(t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)));
  },

  handleAppShortcut(ev, opts) {
    // Tab/Shift+Tab = 분할 패널 순회 + 그 패널 프롬프트 입력창 포커스.
    // 터미널 안에서는 셸 자동완성이 우선이므로 가로채지 않는다.
    if (ev.key === 'Tab' && !ev.metaKey && !ev.ctrlKey && !ev.altKey
        && !(opts && opts.fromTerminal) && !App.isShortcutBlocked(ev, opts)) {
      if (App.cyclePaneFocus(ev.shiftKey ? -1 : 1)) { ev.preventDefault(); return true; }
      return false;
    }
    const mod = App.state.platform === 'macos' ? ev.metaKey : ev.ctrlKey;
    if (!mod || ev.altKey || ev.shiftKey) return false;
    if (App.isShortcutBlocked(ev, opts)) return false;
    const key = ev.key.toLowerCase();
    if (key === 'f') {
      ev.preventDefault();
      App.openTerminalSearch();
      return true;
    }
    if (ev.key >= '1' && ev.key <= '9') {
      ev.preventDefault();
      App.activateByIndex(Number(ev.key) - 1);
      return true;
    }
    if (key === 't') {
      ev.preventDefault();
      App.newSessionInActiveProject();
      return true;
    }
    // 패널 폴딩 토글 3종 — P: 우측 패널, I: 좌측 프로젝트 사이드바, O: 탐색기
    // (preventDefault 로 브라우저 기본 동작(인쇄/파일 열기)을 막는다)
    if (key === 'p') {
      ev.preventDefault();
      App.togglePromptPanel();
      return true;
    }
    if (key === 'i') {
      ev.preventDefault();
      App.toggleLeftSidebar();
      return true;
    }
    if (key === 'o') {
      ev.preventDefault();
      App.toggleExplorer();
      return true;
    }
    // J: 현재 패널의 터미널 ↔ 프롬프트 입력창 커서 토글
    if (key === 'j') {
      ev.preventDefault();
      App.toggleTerminalPromptFocus();
      return true;
    }
    return false;
  },

  // 프롬프트 입력창(textarea) 안에서만 유효한 단축키 —
  // 이 입력창의 keydown 은 xterm 과 섞이지 않게 stopPropagation 되므로
  // 전역 핸들러가 보지 못한다. 여기서 화이트리스트로 직접 처리한다.
  handleComposerShortcut(ev) {
    if (ev.isComposing || ev.keyCode === 229) return false;
    const mod = App.state.platform === 'macos' ? ev.metaKey : ev.ctrlKey;
    if (!mod || ev.altKey || ev.shiftKey) return false;
    const key = ev.key.toLowerCase();
    // 패널 폴딩 3종(P 우측 패널 · I 좌측 사이드바 · O 탐색기) + J(터미널↔입력창 커서)
    const actions = {
      p: App.togglePromptPanel,
      i: App.toggleLeftSidebar,
      o: App.toggleExplorer,
      j: App.toggleTerminalPromptFocus
    };
    const run = actions[key];
    if (!run) return false;
    ev.preventDefault();
    ev.stopPropagation();
    run.call(App);
    return true;
  },

  // ── 터미널 ↔ 프롬프트 입력창 커서 토글 (Cmd/Ctrl+J) ──
  // 대상은 항상 "현재 포커스된 패널"의 세션이다 (분할 모드의 패널 간 이동은 Tab 이 담당).
  // 이 단축키의 본래 용도는 "터미널에 실수로 프롬프트를 치다가 아차 싶을 때" 라서,
  // 터미널에서 넘어올 때는 커서만 옮기지 않고 치던 내용을 잘라내 입력창으로 가져온다.
  // (잘라내기는 추적이 확실할 때만 — 확신이 없으면 터미널 내용을 건드리지 않고 커서만 옮긴다)
  // 프롬프트 입력창에 있으면 터미널로 되돌리고, 그 밖(사이드바·탐색기 등)에 있으면
  // 입력창으로 들여보낸다. 세션이 죽어 입력창이 잠긴 경우에만 터미널로 보낸다.
  toggleTerminalPromptFocus() {
    const id = (App.isSplit() ? App.paneSessionId(App.split.focused) : null) || App.state.activeId;
    if (!id || !TerminalView.views.has(id)) return false;
    const c = TerminalView.composerForSession(id);
    const usable = !!(c && !c.input.disabled);
    const ae = document.activeElement;
    if (usable && ae === c.input) {
      TerminalView.focusTerminal(id);
      return true;
    }
    if (!usable) {
      TerminalView.focusTerminal(id);
      return true;
    }
    // 터미널 본문(xterm 헬퍼 textarea)에서 넘어올 때만 잘라내기 — 사이드바 등에서 누른
    // Cmd/Ctrl+J 가 터미널 입력 라인을 지우면 의도와 다르다.
    const fromTerminal = !!(ae && ae.classList && ae.classList.contains('xterm-helper-textarea'));
    const cut = fromTerminal ? TerminalView.cutTypedLine(id) : '';
    if (cut) {
      App.insertComposerText(c, id, cut); // 커서 위치 삽입 + 입력창 포커스
      App.showToast('✂ 터미널에 치던 내용을 프롬프트 입력창으로 옮겼습니다', 4000);
      return true;
    }
    c.input.focus();
    const why = fromTerminal ? TerminalView.cutFailReason(id) : '';
    if (why === 'invalid') {
      App.showToast('커서만 옮겼습니다 — 방향키·Tab 등으로 입력 라인을 따라갈 수 없어 터미널 내용은 그대로 뒀습니다', 5000);
    } else if (why === 'mismatch') {
      App.showToast('커서만 옮겼습니다 — 터미널 화면과 추적 내용이 달라 안전하게 그대로 뒀습니다', 5000);
    }
    return true;
  },

  bindPlanCaptureButton(id) {
    const btn = document.getElementById(id);
    const holdSelection = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      TerminalView.rememberSelectionSoon(App.state.activeId);
    };
    btn.onmousedown = holdSelection;
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void App.captureSelectionAsPlan();
    };
  },

  // ── 메인 영역 빈 화면 ──
  // 세션 없는 프로젝트를 선택하면 해당 프로젝트의 '새 세션 시작' 화면,
  // 세션이 하나도 없으면 기본 온보딩 안내, 그 외에는 숨김.
  showProjectEmpty(projectId) {
    App.state.projectEmptyId = projectId;
    App.renderAll();
  },

  renderEmptyState() {
    const el = document.getElementById('empty-state');
    // 분할 중에는 오버레이가 화면 전체(다른 패널 터미널)를 덮지 않게 포커스 패널 안으로 이동
    const host = App.isSplit()
      ? document.getElementById('term-pane-' + App.split.focused)
      : document.getElementById('term-area');
    if (el.parentElement !== host) host.appendChild(el);
    const pid = App.state.projectEmptyId;
    const proj = pid && App.state.projects.find((p) => p.id === pid);
    // 선택한 프로젝트에 세션이 생겼거나 프로젝트가 삭제됐으면 선택 해제
    if (!proj || App.state.sessions.some((s) => s.projectId === pid)) {
      App.state.projectEmptyId = null;
      el.textContent = '';
      // 분할 중에는 세션이 하나도 없어도 온보딩 오버레이를 띄우지 않는다 —
      // 각 패널의 피커('+ 세션 추가' 포함)가 빈 화면 안내를 대신한다.
      if (App.state.sessions.length || App.isSplit()) {
        el.style.display = 'none';
      } else {
        el.style.display = 'flex';
        el.innerHTML = App._emptyDefault;
      }
      return;
    }
    el.style.display = 'flex';
    el.textContent = '';
    const h = document.createElement('h2');
    h.textContent = proj.name;
    h.style.color = proj.color ? Theme.adjustText(proj.color) : '';
    const p = document.createElement('p');
    p.textContent = '아직 이 프로젝트에 세션이 없습니다.';
    const btn = document.createElement('button');
    btn.id = 'btn-empty-new';
    btn.textContent = '＋ 새 세션 시작';
    btn.onclick = () => App.createSession(proj.id); // activateSession 이 화면을 터미널로 전환
    el.append(h, p, btn);
  },

  // 화면에 보이는 세션(활성 + 분할 패널)의 브랜치 갱신 — 값이 바뀐 경우에만 재렌더.
  // 분할 패널 헤더도 브랜치를 표시하므로 활성 세션 하나만 폴링하면 나머지가 비어 보인다.
  async refreshBranch() {
    const sessions = App.visibleGitSessions();
    const byCwd = new Map();
    for (const s of sessions) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd).push(s);
    }
    let changed = false;
    await Promise.all([...byCwd.entries()].map(async ([cwd, cwdSessions]) => {
      try {
        const branch = await ta.gitBranch(cwd);
        const cachedRemote = App.state.gitRemote[cwd];
        // 처음 화면에 올라온 세션이어도 cwd 공유 캐시가 다른 브랜치를 가리키면 stale 상태다.
        let branchChanged = !!(cachedRemote && cachedRemote.branch !== branch);
        for (const s of cwdSessions) {
          if (App.state.branches[s.id] !== branch) {
            branchChanged = branchChanged || App.state.branches[s.id] !== undefined;
            App.state.branches[s.id] = branch;
            changed = true;
          }
        }
        // GitFork·터미널 등 외부 checkout은 기존 원격 캐시의 branch/behind가 더는 유효하지 않다.
        if (branchChanged) {
          delete App.state.gitRemote[cwd]; // 새 브랜치에 이전 브랜치의 Pull 배지를 잠시라도 표시하지 않는다
          void App.refreshGitRemote(cwd, { fetch: true, forceFetch: true });
        }
      } catch (_) { /* 조회 실패는 무시 */ }
    }));
    if (!changed) return;
    App.renderTopbar();
    App.renderPanePresets(); // 패널 헤더의 ⎇브랜치 갱신 (단일 화면 포함)
  },

  // ── git 원격 상태 (패널 헤더 Pull 버튼) ──
  // 활성 + 분할 패널에 보이는 세션만 고르고 같은 cwd는 한 번만 조회한다.
  visibleGitSessions() {
    const paneIds = App.isSplit && App.isSplit() ? App.splitVisiblePanes() : [];
    const ids = new Set([App.state.activeId, ...paneIds].filter(Boolean));
    return [...ids]
      .map((id) => App.state.sessions.find((s) => s.id === id))
      .filter((s) => s && s.cwd);
  },

  refreshVisibleGitRemote(opts) {
    const seen = new Set();
    for (const s of App.visibleGitSessions()) {
      if (seen.has(s.cwd)) continue;
      seen.add(s.cwd);
      void App.refreshGitRemote(s.cwd, opts);
    }
  },

  // 네트워크 fetch는 cwd별 TTL로 제한하고, 로컬 카운트 재계산(fetch=false)은 즉시 수행한다.
  // fetch=false 진행 중 fetch=true가 들어오면 기존 작업 뒤에 강한 요청을 이어서 실행한다.
  async refreshGitRemote(cwd, opts) {
    if (!cwd) return;
    let fetch = !!(opts && opts.fetch);
    const forceFetch = !!(opts && opts.forceFetch);
    let preserveFetchFailure = false;
    App._gitRemoteInflight = App._gitRemoteInflight || new Map();
    App._gitRemoteLastFetchAt = App._gitRemoteLastFetchAt || new Map();
    if (fetch && !forceFetch) {
      const lastFetchAt = App._gitRemoteLastFetchAt.get(cwd) || 0;
      if (Date.now() - lastFetchAt < GIT_REMOTE_FETCH_MIN_MS) {
        // focus·visibility 이벤트가 겹쳐도 네트워크만 생략하고, 외부 pull/reset 등 로컬 변화는 즉시 센다.
        fetch = false;
        preserveFetchFailure = true;
      }
    }
    const running = App._gitRemoteInflight.get(cwd);
    if (running) {
      // 강제 요청(브랜치 변경)은 기존 fetch가 있더라도 그 응답보다 뒤에서 다시 확인해야 한다.
      if (fetch && (!running.fetch || forceFetch)) running.followUpFetch = true;
      return running.promise;
    }
    if (fetch) App._gitRemoteLastFetchAt.set(cwd, Date.now());
    const entry = { promise: null, fetch, followUpFetch: false };
    const job = (async () => {
      let st = null;
      try { st = await ta.gitRemoteState(cwd, fetch); } catch (_) { return; } // 조회 실패 = 상태 유지
      const prev = App.state.gitRemote[cwd];
      const knownBranch = App.visibleGitSessions().find((s) => s.cwd === cwd);
      const currentBranch = knownBranch && App.state.branches[knownBranch.id];
      // 조회 중 checkout이 일어나 이전 브랜치 결과가 돌아오면 표시하지 않고 새 fetch를 이어 붙인다.
      if (st && currentBranch && st.branch !== currentBranch) {
        entry.followUpFetch = true;
        return;
      }
      if (st && preserveFetchFailure && prev && prev.fetchFailed) st.fetchFailed = true;
      App.state.gitRemote[cwd] = st || null;
      if (JSON.stringify(prev) !== JSON.stringify(st || null)) App.renderPanePresets();
    })();
    entry.promise = job;
    App._gitRemoteInflight.set(cwd, entry);
    try {
      await job;
    } finally {
      if (App._gitRemoteInflight.get(cwd) === entry) App._gitRemoteInflight.delete(cwd);
      if (entry.followUpFetch) void App.refreshGitRemote(cwd, { fetch: true, forceFetch: true });
    }
  },

  // 새 세션 생성 시 해당 cwd의 최신 상태 확인
  refreshGitRemoteForSessions(sessions) {
    const seen = new Set();
    for (const s of sessions) {
      if (!s || !s.cwd || seen.has(s.cwd)) continue;
      seen.add(s.cwd);
      void App.refreshGitRemote(s.cwd, { fetch: true });
    }
  },

  // Pull 버튼 클릭 — 터미널에 명령을 흘리지 않고 백그라운드로 실행한 뒤 결과를 토스트로 알린다
  async runGitPull(cwd) {
    if (!cwd || App._gitPulling === cwd) return;
    App._gitPulling = cwd;
    App.renderPanePresets(); // 진행 중 표시
    try {
      const r = await ta.gitPull(cwd);
      App.showToast((r && r.ok ? '⬇ Pull 완료 — ' : '⚠ Pull 실패 — ') + ((r && r.message) || ''));
    } catch (e) {
      App.showToast('⚠ Pull 실패 — ' + e);
    } finally {
      App._gitPulling = null;
    }
    // pull 직후는 이미 최신 원격 정보를 갖고 있으므로 fetch 없이 카운트만 다시 센다
    await App.refreshGitRemote(cwd, { fetch: false });
    App.refreshBranch();
    App.renderPanePresets();
  },

  // ── AI 도구 남은 사용량 (상단바 표시) ──
  // 코덱스·Claude Code 각각 최근 사용 흔적이 있을 때만 표시한다. 조회 실패는 미표시.
  // u 형태: { windows: [{windowMinutes, usedPercent, resetsAt}], plan, mtimeMs }
  renderUsageGauge(elId, name, u) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!u || !u.windows.length || Date.now() - u.mtimeMs > 12 * 3600 * 1000) {
      el.className = 'hidden';
      return;
    }
    const label = (m) => m === 300 ? '5시간' : m === 10080 ? '주간' : Math.round(m / 60) + '시간';
    const parts = u.windows.map((w) => `${label(w.windowMinutes)} ${Math.max(0, 100 - Math.round(w.usedPercent))}%`);
    const worstLeft = Math.min(...u.windows.map((w) => 100 - w.usedPercent));
    let cls = 'ok';                      // > 50% 남음 : 여유 (녹색)
    if (worstLeft <= 10) cls = 'crit';   // ≤ 10% 남음 : 소진 임박 (빨강)
    else if (worstLeft <= 25) cls = 'warn';
    else if (worstLeft <= 50) cls = 'mid';
    el.className = 'gauge ' + cls;
    el.textContent = name + ' ' + parts.join('·');
    el.title = name + ' 남은 사용량:\n' + u.windows.map((w) =>
      `${label(w.windowMinutes)} ${(100 - w.usedPercent).toFixed(1)}% 남음` +
      (w.resetsAt ? ` (리셋 ${new Date(w.resetsAt * 1000).toLocaleString()})` : '')
    ).join('\n') + (u.plan ? `\n플랜: ${u.plan}` : '') +
      `\n마지막 갱신: ${new Date(u.mtimeMs).toLocaleTimeString()}`;
  },

  // 코덱스가 세션 기록에 남기는 rate_limits 를 읽는다. 최근 12시간 내 기록이 있을 때만 표시.
  async pollCodexUsage() {
    let u = null;
    try { u = await ta.codexUsage(); } catch (_) { /* 조회 실패 = 미표시 */ }
    App.renderUsageGauge('panel-codex', 'Codex', u);
  },

  // Claude Code 는 사용률을 로컬에 남기지 않아 Rust 쪽에서 Anthropic 사용량 API 를 조회한다.
  // 최근 12시간 내 Claude Code 사용 흔적이 없거나 토큰이 만료면 null → 미표시.
  async pollClaudeUsage() {
    let u = null;
    try { u = await ta.claudeUsage(); } catch (_) { /* 조회 실패 = 미표시 */ }
    App.renderUsageGauge('panel-claude', 'Claude', u);
  },

  // ── 시스템 메모리 폴링 (상단바 표시) ──
  async pollStatus() {
    App.refreshBranch(); // 같은 2초 주기에 브랜치도 함께 갱신 (checkout 반영)
    try {
      const m = await ta.getMemory();
      let cls = 'ok';                       // < 60% : 원활 (녹색)
      if (m.pct >= 85) cls = 'crit';        // ≥ 85% : 위험 (빨강, 점멸)
      else if (m.pct >= 75) cls = 'warn';   // ≥ 75% : 버거움 (주황)
      else if (m.pct >= 60) cls = 'mid';    // ≥ 60% : 주의 (노랑)
      const el = document.getElementById('panel-mem');
      el.className = 'gauge ' + cls;
      el.textContent = `mem ${m.pct}%`;
      el.title = `시스템 메모리 ${m.usedGb} / ${m.totalGb} GB`;
    } catch (_) { /* 조회 실패는 무시 */ }
  },

  // ── 프리셋/프로젝트 드래그 정렬 ──
  async movePreset(srcId, targetId, before) {
    const arr = App.state.presets;
    const from = arr.findIndex((p) => p.id === srcId);
    if (from < 0) return;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex((p) => p.id === targetId);
    if (to < 0) { arr.splice(from, 0, moved); return; }
    if (!before) to += 1;
    arr.splice(to, 0, moved);
    App.renderPanePresets();
    await ta.reorderPresets(arr.map((p) => p.id)).catch((e) => console.warn('프리셋 순서 저장 실패:', e));
  },

  async moveProject(srcId, targetId, before) {
    const arr = App.state.projects;
    const from = arr.findIndex((p) => p.id === srcId);
    if (from < 0) return;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex((p) => p.id === targetId);
    if (to < 0) { arr.splice(from, 0, moved); return; }
    if (!before) to += 1;
    arr.splice(to, 0, moved);
    renderSidebar();
    await ta.reorderProjects(arr.map((p) => p.id)).catch((e) => console.warn('프로젝트 순서 저장 실패:', e));
  },

  // '프로젝트명 — S2' 형태의 세션 식별 라벨 (헤더·알림·팬아웃 공용)
  sessionLabel(s) {
    const proj = App.state.projects.find((p) => p.id === s.projectId);
    return proj ? proj.name + ' — ' + s.title : s.title;
  },

  renderTopbar() {
    // 허가 대기 집계 배지 — 어느 세션을 보고 있든 대기 발생을 놓치지 않게 헤더에 상시 표시
    const waiting = App.state.sessions.filter((x) => x.status === 'waiting');
    const wi = document.getElementById('waiting-indicator');
    wi.classList.toggle('hidden', !waiting.length);
    if (waiting.length) wi.textContent = '허가 대기 ' + waiting.length;
    const el = document.getElementById('active-info');
    // 분할 중에는 패널마다 헤더 바(상태·프로젝트명 — 세션명 ⎇브랜치)가 따로 붙으므로
    // 루트 헤더의 활성 세션 표기는 생략한다 — 같은 정보를 두 곳에 중복해 두지 않는다.
    if (App.isSplit && App.isSplit()) { el.textContent = ''; el.title = ''; return; }
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (!s) { el.textContent = '세션 없음'; el.title = ''; return; }
    el.textContent = '';
    el.title = s.cwd; // 경로는 표시 대신 호버 툴팁으로
    el.appendChild(statusTag(s.status));
    const t = document.createElement('span');
    t.textContent = App.sessionLabel(s);
    el.appendChild(t);
    const b = App.state.branches[s.id];
    if (b) {
      const g = document.createElement('span');
      g.style.cssText = 'color:var(--fg-dim);font-weight:400;font-size:11px';
      g.textContent = '⎇ ' + b;
      el.appendChild(g);
    }
  },

  // 최근 첨부 이미지 — 패널 작성기 안에 그린다 (창 하단 고정 스트립은 입력창을 가렸다)
  renderImageStrip() {
    let layoutChanged = false;
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const c = TerminalView.composers[i];
      if (c && App.renderPaneImages(c, App.paneSessionId(i))) layoutChanged = true;
    }
    if (layoutChanged) TerminalView.fitActive(); // 스트립 유무가 터미널 높이를 바꾼다
  },

  // 스트립 표시 여부가 바뀌면 true (터미널 재fit 필요)
  renderPaneImages(c, sessionId) {
    const strip = c.images;
    strip.textContent = '';
    const imgs = (sessionId && App.state.images[sessionId]) || [];
    const folded = !!(sessionId && App.state.imageStripFolded[sessionId]);
    const was = strip.classList.contains('hidden');
    const wasFolded = strip.classList.contains('folded');
    strip.classList.toggle('hidden', !imgs.length);
    strip.classList.toggle('folded', folded);
    const changed = was !== strip.classList.contains('hidden') || wasFolded !== folded;
    if (!imgs.length) return changed;
    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = `참조 이미지 ${imgs.length}개`;
    strip.appendChild(label);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'strip-fold-btn';
    toggle.textContent = folded ? '펼치기' : '접기';
    toggle.title = folded ? '참조 이미지 펼치기' : '참조 이미지 접기';
    toggle.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      App.state.imageStripFolded[sessionId] = !folded;
      localStorage.setItem('ta-image-strip-fold', JSON.stringify(App.state.imageStripFolded));
      App.renderImageStrip();
    };
    strip.appendChild(toggle);
    if (folded) return changed;
    for (const im of imgs.slice(0, IMAGE_STRIP_MAX)) {
      const el = document.createElement('img');
      el.className = 'strip-thumb';
      el.src = im.src;
      el.title = im.path + ' (클릭=원본 열기)';
      el.onclick = () => ta.openPath(im.path);
      strip.appendChild(el);
    }
    return changed;
  },

  // ── 세션 ──
  async createSession(projectId, opts) {
    try {
      const info = await ta.createSession(projectId);
      App.state.sessions.push(info);
      App.refreshGitRemoteForSessions([info]); // 세션 시작 시 1회 fetch → Pull 버튼 상태 결정
      TerminalView.create(info, App.state.settings.fontSize);
      const targetPane = opts && Number.isInteger(opts.paneIdx) ? opts.paneIdx : -1;
      if (App.isSplit() && targetPane >= 0 && targetPane < App.splitPaneCount()) {
        App.split.panes[targetPane] = info.id;
        App.split.focused = targetPane;
        App.saveSplitState();
        App.activateSession(info.id);
        return info; // AI 세션 재개 등 후속 입력용
      }
      // 분할 중 새 세션은 빈 패널부터 채운다 — 포커스 패널이 이미 차 있으면 첫 빈 패널로
      // 포커스를 옮겨, activateSession 이 그 자리에 배정 + 선택하게 한다.
      // (포커스 패널 자체가 빈 패널이면 그대로 — 피커의 '+ 세션 추가'가 지정한 자리 유지)
      if (App.isSplit()) {
        const panes = App.splitVisiblePanes();
        if (panes[App.split.focused]) {
          const empty = panes.indexOf(null);
          if (empty >= 0) App.split.focused = empty;
        }
      }
      App.activateSession(info.id);
      return info; // AI 세션 재개 등 후속 입력용
    } catch (e) {
      alert('세션 생성 실패: ' + e);
    }
  },

  activateSession(id, opts) {
    // 분할 중: 이미 다른 패널에 보이는 세션이면 그 패널로 포커스만 이동, 아니면 포커스 패널에 배정
    const sp = App.split;
    if (App.isSplit && App.isSplit()) {
      const idx = App.splitVisiblePanes().indexOf(id);
      if (idx >= 0) sp.focused = idx;
      else {
        // 새로 보여줄 세션은 0번 패널부터 훑어 첫 빈 패널에 넣는다 —
        // 포커스가 뒤쪽 패널에 있어도 화면이 앞에서부터 순서대로 채워진다.
        // 빈 패널이 없을 때만 포커스 패널의 세션을 교체한다.
        const slot = App.firstEmptyPane();
        const target = slot >= 0 ? slot : sp.focused;
        sp.panes[target] = id;
        sp.focused = target;
      }
      App.saveSplitState();
    }
    App.state.activeId = id;
    App.state.projectEmptyId = null; // 세션 활성화 = 빈 프로젝트 시작 화면 해제
    localStorage.setItem('ta-active-session', id); // 웹뷰 리로드 복구 시 활성 세션 유지용
    const cur = App.state.sessions.find((x) => x.id === id);
    if (cur && cur.projectId) {
      App.lastSessionByProject[cur.projectId] = id;
      localStorage.setItem('ta-last-session-by-project', JSON.stringify(App.lastSessionByProject));
    }
    TerminalView.activate(id, opts);
    App.checkDoneViewed(id); // 즉시 해제 대신 열람 카운트다운 — 무엇이 끝났는지 볼 시간을 준다
    App.renderAll();
    App.refreshBranch(); // 전환 즉시 브랜치 표시 (다음 폴링까지 기다리지 않게)
    App.refreshVisibleGitRemote({ fetch: true }); // 새로 활성화된 패널의 Pull 상태도 TTL 범위에서 갱신
    if (App.isOverlayOpen && App.isOverlayOpen('term-search')) App.updateTerminalSearch();
  },

  activateByIndex(i) {
    const s = App.state.sessions[i];
    if (s) App.activateSession(s.id);
  },

  newSessionInActiveProject() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    App.createSession(s ? s.projectId : null);
  },

  async closeSession(id) {
    await ta.closeSession(id);
    await App.clearQueuedPrompts(id);
    App._composerTexts.delete(id);
    App.dropComposerPersist(id); // 저장분·예약 타이머 정리
    App.state.sessions = App.state.sessions.filter((s) => s.id !== id);
    delete App.state.images[id];
    delete App.state.branches[id];
    App.clearDoneTimers(id);
    App._lastNotifyAt.delete(id);
    App.releasePaneSession(id); // 분할 패널 배정 해제 — 빈 패널은 피커로 복귀
    TerminalView.dispose(id);
    if (App.state.activeId === id) {
      const next = App.state.sessions[App.state.sessions.length - 1];
      App.state.activeId = null;
      if (next) App.activateSession(next.id);
    }
    App.renderAll();
  },

  ackIfDone(id) {
    const s = App.state.sessions.find((x) => x.id === id);
    if (s && s.status === 'done') ta.ackSession(id);
  },

  // ── 완료 배지 확인 추적 ──
  // 단순 타임아웃이 아니라 "사용자가 봤는가"가 기준: 열람(활성 세션 + 창 포커스)하면
  // 그때부터 DONE_VIEW_MS 후 해제, 끝내 안 보면 DONE_FALLBACK_MS 폴백 해제.
  // 키 입력(ackIfDone)은 여전히 즉시 해제, 새 작업 시작은 추적 자체를 취소한다.
  DONE_VIEW_MS: 5000,
  DONE_FALLBACK_MS: 5 * 60 * 1000,
  doneTimers: new Map(), // sessionId → { view, fallback }

  // 같은 세션에 이 간격 안에서 완료 알림을 두 번 보내지 않는다 — 백엔드가 상태를
  // 오판했더라도(짧은 running↔done 왕복) 팝업이 연달아 뜨는 것을 막는 안전망.
  NOTIFY_GAP_MS: 15000,
  _lastNotifyAt: new Map(), // sessionId → 마지막 완료 알림 시각

  // 작업 완료: 확인 추적 시작 + 보고 있지 않은 세션이면 데스크톱 알림
  onDone(s, busyMs) {
    App.clearDoneTimers(s.id);
    App.doneTimers.set(s.id, {
      view: null,
      fallback: setTimeout(() => ta.ackSession(s.id), App.DONE_FALLBACK_MS)
    });
    App.checkDoneViewed(s.id); // 이미 보고 있으면 곧장 열람 카운트다운
    const watching = s.id === App.state.activeId && document.hasFocus();
    const now = Date.now();
    const last = App._lastNotifyAt.get(s.id) || 0;
    if (!watching && App.state.settings.notifyOnDone && now - last >= App.NOTIFY_GAP_MS) {
      App._lastNotifyAt.set(s.id, now);
      const secs = Math.round((busyMs || 0) / 1000);
      void ta.notify('작업 완료 — ' + App.sessionLabel(s), secs + '초 동안 실행되던 작업이 끝났습니다.', s.id)
        .catch((error) => console.warn('완료 알림 전송 실패:', error));
    }
  },

  // 완료 세션이 열람 중이면 해제 카운트다운 시작 (세션 전환·창 포커스 복귀 시 호출)
  checkDoneViewed(id) {
    const s = App.state.sessions.find((x) => x.id === id);
    if (!s || s.status !== 'done') return;
    if (!(id === App.state.activeId && document.hasFocus())) return;
    const t = App.doneTimers.get(id);
    if (!t || t.view) return; // 추적 없음(비정상) 또는 이미 카운트다운 중
    t.view = setTimeout(() => ta.ackSession(id), App.DONE_VIEW_MS);
  },

  clearDoneTimers(id) {
    const t = App.doneTimers.get(id);
    if (t) {
      clearTimeout(t.view);
      clearTimeout(t.fallback);
      App.doneTimers.delete(id);
    }
  },

  // 알림 클릭으로 지목된 세션 띄우기 — 이미 닫힌 세션이면 무시한다.
  // toBottom: 완료·허가 프롬프트가 보이도록 바닥으로 붙인다.
  revealSession(sessionId) {
    if (!sessionId) return;
    const s = App.state.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    App.activateSession(sessionId, { toBottom: true });
  },

  // 허가 대기: 보고 있는 세션은 화면에 이미 프롬프트가 떠 있으므로 비활성 세션만 알림
  onWaiting(s) {
    const watching = s.id === App.state.activeId && document.hasFocus();
    if (!watching && App.state.settings.notifyOnWaiting) {
      void ta.notify('허가 대기 — ' + App.sessionLabel(s), 'AI 도구가 실행 허가를 기다리고 있습니다.', s.id)
        .catch((error) => console.warn('허가 대기 알림 전송 실패:', error));
    }
  },

  // ── 붙여넣기 / 드롭 / 이미지 ──
  async pasteToSession(id) {
    const imgPath = await ta.clipboardImage();
    if (imgPath) { App.attachImage(id, imgPath); return; }
    const text = await ta.clipboardText();
    if (text) TerminalView.paste(id, text);
  },

  // 패널 입력창에 붙여넣기 — 클립보드에 이미지가 있으면 경로 첨부, 아니면 텍스트 삽입
  async pasteToComposer(sessionId, composer, clipboardText) {
    if (!sessionId || !composer) return;
    let imgPath = null;
    try { imgPath = await ta.clipboardImage(); } catch (_) { /* 이미지 없음 */ }
    if (imgPath) { App.attachImage(sessionId, imgPath, composer); return; }
    let text = clipboardText;
    if (!text) text = await ta.clipboardText().catch(() => '');
    if (text) App.insertComposerText(composer, sessionId, text);
  },

  // 커서 위치에 텍스트 삽입 + 작성 중 내용 기억 + 높이 재조정
  insertComposerText(composer, sessionId, text) {
    const el = composer.input;
    if (el.disabled) return;
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.selectionStart = el.selectionEnd = caret;
    App.rememberComposerText(sessionId, el.value);
    TerminalView.resizeComposer(composer);
    el.focus();
  },

  // 활성 세션의 프롬프트 입력창에 경로 삽입 — 입력창이 없거나 잠겨 있으면 터미널로 대체
  insertPathToActiveInput(path) {
    const id = App.state.activeId;
    if (!id) return;
    const composer = TerminalView.composerForSession(id);
    if (composer && !composer.input.disabled) App.insertComposerText(composer, id, quotePath(path) + ' ');
    else TerminalView.paste(id, quotePath(path) + ' ');
  },

  // 화면 좌표 아래의 패널 작성기 (입력창·이미지 스트립 등 작성기 영역 전체)
  composerAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const root = el && el.closest ? el.closest('.pane-prompt') : null;
    if (!root) return null;
    return TerminalView.composers.find((c) => c.root === root) || null;
  },

  // composer 를 주면 그 입력창에, 없으면 터미널에 경로를 넣는다
  attachImage(id, path, composer) {
    if (composer) App.insertComposerText(composer, id, quotePath(path) + ' ');
    else TerminalView.paste(id, quotePath(path) + ' ');
    if (!App.state.images[id]) App.state.images[id] = [];
    App.state.images[id].unshift({ path, src: ta.fileSrc(path) });
    if (App.state.images[id].length > IMAGE_STRIP_MAX) App.state.images[id].length = IMAGE_STRIP_MAX;
    App.renderImageStrip();
  },

  // position: Tauri drag-drop 물리 좌표 — 분할 중이면 드롭 지점 아래 패널의 세션을 대상으로
  handleDrop(paths, position) {
    let id = null;
    let composer = null;
    if (position && typeof position.x === 'number') {
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale, y = position.y / scale;
      // 프롬프트 입력창 위에 놓았으면 그 패널 작성기에, 터미널 위면 터미널에 삽입한다
      composer = App.composerAtPoint(x, y);
      id = composer ? App.paneSessionId(composer.paneIdx) : App.sessionAtPoint(x, y);
    }
    id = id || App.state.activeId;
    if (!id) return;
    if (id !== App.state.activeId) App.activateSession(id, { noFocus: true });
    for (const p of paths) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(p)) App.attachImage(id, p, composer);
      else if (composer) App.insertComposerText(composer, id, quotePath(p) + ' ');
      else TerminalView.paste(id, quotePath(p) + ' ');
    }
  },

  // sessionId 지정 시 해당 세션 기준으로 {branch}/{projectPath} 등 치환 (분할 패널 프리셋용)
  async expandPresetCommand(command, slotValues, sessionId) {
    const s = App.state.sessions.find((x) => x.id === (sessionId || App.state.activeId));
    const project = s && App.state.projects.find((p) => p.id === s.projectId);
    const clipboard = command.includes('{clipboard}') ? (await ta.clipboardText().catch(() => '') || '') : '';
    let out = command.replace(/\{(branch|projectPath|projectName|session|clipboard)\}/g, (_, name) => {
      if (name === 'branch') return s ? (App.state.branches[s.id] || '') : '';
      if (name === 'projectPath') return s ? s.cwd : '';
      if (name === 'projectName') return project ? project.name : '';
      if (name === 'session') return s ? App.sessionLabel(s) : '';
      if (name === 'clipboard') return clipboard;
      return '';
    });
    const labels = [...new Set([...out.matchAll(/\{input:([^{}]+)\}/g)].map((m) => m[1].trim()).filter(Boolean))];
    for (const label of labels) {
      const value = slotValues && Object.prototype.hasOwnProperty.call(slotValues, label)
        ? slotValues[label]
        : await App.promptPresetSlot(label);
      if (value === null) return null;
      if (slotValues) slotValues[label] = value;
      out = out.replaceAll('{input:' + label + '}', value);
    }
    return out;
  },

  promptPresetSlot(label) {
    return new Promise((resolve) => {
      let done = false;
      App.modal(`
        <h3>프리셋 입력값</h3>
        <label>${escapeHtml(label)}</label><input type="text" id="m-slot-value">
        <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-save">계속</button></div>`,
        (m, close) => {
          const input = m.querySelector('#m-slot-value');
          const finish = (value) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', esc);
            close();
            resolve(value);
          };
          const esc = (ev) => { if (ev.key === 'Escape') finish(null); };
          document.addEventListener('keydown', esc);
          m.querySelector('#m-cancel').onclick = () => finish(null);
          m.querySelector('#m-save').onclick = () => finish(input.value);
          input.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              finish(input.value);
            }
          };
          input.focus();
        });
    });
  },

  // sessionId 지정 시 그 세션에 실행 (분할 패널 프리셋 바) — 대상 패널로 포커스도 이동
  async runPreset(preset, execute, sessionId) {
    const id = sessionId || App.state.activeId;
    if (!id) return;
    if (id !== App.state.activeId) App.activateSession(id, { noFocus: true });
    const command = await App.expandPresetCommand(preset.command, undefined, id);
    if (command === null) return;
    if (execute) {
      ta.write(id, command + '\r');
      TerminalView.resetTypedLine(id);
    } else {
      TerminalView.paste(id, command);
    }
    // 프리셋 클릭 후에는 작성기가 아니라 터미널에 포커스를 둔다 —
    // /model 처럼 즉시 방향키 선택이 필요한 대화형 명령이 바로 조작 가능해야 한다.
    TerminalView.activate(id, { noFocus: true });
    TerminalView.focusTerminal(id);
  },

  async runRecipe(recipe) {
    const commands = (recipe.commands || []).map((c) => c.trim()).filter(Boolean);
    if (!commands.length) return;
    const active = App.state.sessions.find((s) => s.id === App.state.activeId);
    const projectId = recipe.projectId || (active ? active.projectId : null);
    const slotValues = {};
    for (const raw of commands) {
      const info = await App.createSession(projectId);
      if (!info) continue;
      const command = await App.expandPresetCommand(raw, slotValues);
      if (command === null) return;
      setTimeout(() => {
        TerminalView.paste(info.id, command);
        ta.write(info.id, '\r');
        TerminalView.resetTypedLine(info.id);
      }, 600);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.boot());
