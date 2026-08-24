// 앱 상태·부트스트랩·세션 수명주기.
// 나머지 책임은 파일로 분리: 초안 drafts.js / AI 세션 기록 열람 claude-sessions.js /
// 패널 레이아웃 panel-layout.js / 모달 modals.js / 사이드바·프리셋 렌더 sidebar.js·presets.js /
// 터미널 terminal-view.js. 각 파일이 Object.assign(App, ...) 으로 메서드를 붙인다.
const App = {
  state: {
    projects: [],
    presets: [],
    recipes: [],
    settings: { fontSize: 13, shell: '', notifyOnDone: true, notifyOnWaiting: true },
    sessions: [],   // { id, projectId, title, status, cwd }
    activeId: null,
    platform: '',   // 백엔드가 알려주는 OS (windows | macos | linux)
    images: {},     // sessionId → [{ path, src }] 최근 첨부 이미지
    branches: {},   // sessionId → git 브랜치명 (헤더 표시용, 2초 폴링)
    drafts: {},     // projectId/queued:<sessionId>, memo:<projectId>는 Markdown 이전 전 구버전 데이터
    projectEmptyId: null // 세션 없는 프로젝트 선택 시 '새 세션 시작' 화면 대상
  },

  // 프로젝트별 마지막 선택 세션 — 프로젝트 클릭 시 이 세션으로 복귀 (렌더러 로컬 설정)
  lastSessionByProject: JSON.parse(localStorage.getItem('ta-last-session-by-project') || '{}'),

  async boot() {
    TerminalView.init();
    // 기본 온보딩 안내(index.html 정적 마크업)를 보관 — 빈 프로젝트 화면과 번갈아 쓴다
    App._emptyDefault = document.getElementById('empty-state').innerHTML;
    const st = await ta.getState();
    Object.assign(App.state, {
      projects: st.projects, presets: st.presets, recipes: st.recipes || [], settings: st.settings, sessions: st.sessions,
      drafts: st.drafts || {}, platform: st.platform || ''
    });
    await App.cleanupDeadQueuedPrompts();
    // 사이드바 제목 우측 버전 표기
    document.getElementById('app-version').textContent = st.version ? 'v' + st.version : '';

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
      if (App.split.mode !== 'single') App.refreshPickerStatus(s); // 피커의 상태 태그만 최신화
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
    // 다른 앱에 있다가 돌아온 경우 — 활성 세션이 완료 상태면 그 시점부터 열람 카운트다운
    window.addEventListener('focus', () => App.checkDoneViewed(App.state.activeId));
    // 허가 대기 배지 클릭 → 대기 중인 세션으로 점프 (여러 개면 클릭할 때마다 순환)
    document.getElementById('waiting-indicator').onclick = () => {
      const ws = App.state.sessions.filter((x) => x.status === 'waiting');
      if (!ws.length) return;
      const i = ws.findIndex((x) => x.id === App.state.activeId);
      // toBottom: 이미 패널에 보이는 세션이라도 허가 프롬프트가 보이게 바닥으로 점프
      App.activateSession(ws[(i + 1) % ws.length].id, { toBottom: true });
    };

    document.getElementById('btn-add-project').onclick = () => App.showProjectModal();
    document.getElementById('btn-home-session').onclick = () => App.createSession(null);
    document.getElementById('btn-add-preset').onclick = () => App.showPresetManager();
    document.getElementById('btn-settings').onclick = () => App.showSettingsModal();
    document.getElementById('btn-toggle-prompts').onclick = () => App.togglePromptPanel();
    document.getElementById('btn-claude-refresh').onclick = () => App.renderClaudeList(true);
    document.getElementById('btn-plan-refresh').onclick = () => App.renderPlanList(true);
    document.getElementById('btn-memo-add').onclick = () => App.showMemoModal();
    // 시스템 메모리 폴링 (2초)
    setInterval(() => App.pollStatus(), 2000);
    App.pollStatus();
    // 코덱스 사용량 폴링 (10초 — 파일 꼬리 읽기라 가볍지만 데이터 갱신 주기도 느리다)
    setInterval(() => App.pollCodexUsage(), 10000);
    App.pollCodexUsage();
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
      if (App.split.mode !== 'single' && !App.splitVisiblePanes().includes(target.id)) {
        const fallback = App.split.panes[App.split.focused] || App.splitVisiblePanes().find(Boolean);
        const alive = fallback && restoring.find((s) => s.id === fallback);
        if (alive) target = alive;
      }
      App.activateSession(target.id);
    }

    App.renderAll();

    // 자동 업데이트 확인 (백그라운드 — 실패는 조용히 무시)
    setTimeout(() => App.checkUpdate(), 2500);
  },

  // 테마 변경 후 — JS 로 직접 칠한 색(프로젝트 이름 등)을 새 테마 기준으로 다시 계산
  refreshThemedColors() {
    if (!App.state.projects.length && !App.state.sessions.length) return;
    renderSidebar();
    App.renderTopbar();
    App.renderEmptyState();
    if (App.split && App.split.mode !== 'single') { App.renderPanePickers(); App.renderPanePresets(); }
  },

  renderAll() {
    renderSidebar();
    App.renderExplorer();
    renderPresets();
    App.renderSplit();
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
    return false;
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
    const host = App.split.mode !== 'single'
      ? document.getElementById('term-pane-' + App.split.focused)
      : document.getElementById('term-area');
    if (el.parentElement !== host) host.appendChild(el);
    const pid = App.state.projectEmptyId;
    const proj = pid && App.state.projects.find((p) => p.id === pid);
    // 선택한 프로젝트에 세션이 생겼거나 프로젝트가 삭제됐으면 선택 해제
    if (!proj || App.state.sessions.some((s) => s.projectId === pid)) {
      App.state.projectEmptyId = null;
      el.textContent = '';
      if (App.state.sessions.length) {
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
    const ids = new Set([App.state.activeId, ...App.splitVisiblePanes()].filter(Boolean));
    let changed = false;
    for (const id of ids) {
      const s = App.state.sessions.find((x) => x.id === id);
      if (!s) continue;
      try {
        const b = await ta.gitBranch(s.cwd);
        if (App.state.branches[s.id] !== b) {
          App.state.branches[s.id] = b;
          changed = true;
        }
      } catch (_) { /* 조회 실패는 무시 */ }
    }
    if (!changed) return;
    App.renderTopbar();
    if (App.split.mode !== 'single') App.renderPanePresets();
  },

  // ── 코덱스 남은 사용량 (상단바 표시) ──
  // 코덱스가 세션 기록에 남기는 rate_limits 를 읽는다. 최근 12시간 내 기록이 있을 때만 표시.
  async pollCodexUsage() {
    const el = document.getElementById('panel-codex');
    let u = null;
    try { u = await ta.codexUsage(); } catch (_) { /* 조회 실패 = 미표시 */ }
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
    el.textContent = 'Codex ' + parts.join('·');
    el.title = '남은 사용량:\n' + u.windows.map((w) =>
      `${label(w.windowMinutes)} ${(100 - w.usedPercent).toFixed(1)}% 남음` +
      (w.resetsAt ? ` (리셋 ${new Date(w.resetsAt * 1000).toLocaleString()})` : '')
    ).join('\n') + (u.plan ? `\n플랜: ${u.plan}` : '') +
      `\n마지막 갱신: ${new Date(u.mtimeMs).toLocaleTimeString()}`;
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
    renderPresets();
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

  renderImageStrip() {
    const strip = document.getElementById('image-strip');
    strip.textContent = '';
    const imgs = App.state.images[App.state.activeId] || [];
    if (!imgs.length) return;
    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = '최근 첨부:';
    strip.appendChild(label);
    for (const im of imgs.slice(0, IMAGE_STRIP_MAX)) {
      const el = document.createElement('img');
      el.className = 'strip-thumb';
      el.src = im.src;
      el.title = im.path + ' (클릭=원본 열기)';
      el.onclick = () => ta.openPath(im.path);
      strip.appendChild(el);
    }
  },

  // ── 세션 ──
  async createSession(projectId) {
    try {
      const info = await ta.createSession(projectId);
      App.state.sessions.push(info);
      TerminalView.create(info, App.state.settings.fontSize);
      App.activateSession(info.id);
      return info; // AI 세션 재개 등 후속 입력용
    } catch (e) {
      alert('세션 생성 실패: ' + e);
    }
  },

  activateSession(id, opts) {
    // 분할 중: 이미 다른 패널에 보이는 세션이면 그 패널로 포커스만 이동, 아니면 포커스 패널에 배정
    const sp = App.split;
    if (sp && sp.mode !== 'single') {
      const idx = App.splitVisiblePanes().indexOf(id);
      if (idx >= 0) sp.focused = idx;
      else sp.panes[sp.focused] = id;
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
    App.state.sessions = App.state.sessions.filter((s) => s.id !== id);
    delete App.state.images[id];
    delete App.state.branches[id];
    App.clearDoneTimers(id);
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

  // 작업 완료: 확인 추적 시작 + 보고 있지 않은 세션이면 데스크톱 알림
  onDone(s, busyMs) {
    App.clearDoneTimers(s.id);
    App.doneTimers.set(s.id, {
      view: null,
      fallback: setTimeout(() => ta.ackSession(s.id), App.DONE_FALLBACK_MS)
    });
    App.checkDoneViewed(s.id); // 이미 보고 있으면 곧장 열람 카운트다운
    const watching = s.id === App.state.activeId && document.hasFocus();
    if (!watching && App.state.settings.notifyOnDone) {
      const secs = Math.round((busyMs || 0) / 1000);
      void ta.notify('작업 완료 — ' + App.sessionLabel(s), secs + '초 동안 실행되던 작업이 끝났습니다.')
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

  // 허가 대기: 보고 있는 세션은 화면에 이미 프롬프트가 떠 있으므로 비활성 세션만 알림
  onWaiting(s) {
    const watching = s.id === App.state.activeId && document.hasFocus();
    if (!watching && App.state.settings.notifyOnWaiting) {
      void ta.notify('허가 대기 — ' + App.sessionLabel(s), 'AI 도구가 실행 허가를 기다리고 있습니다.')
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

  attachImage(id, path) {
    TerminalView.paste(id, quotePath(path) + ' ');
    if (!App.state.images[id]) App.state.images[id] = [];
    App.state.images[id].unshift({ path, src: ta.fileSrc(path) });
    if (App.state.images[id].length > IMAGE_STRIP_MAX) App.state.images[id].length = IMAGE_STRIP_MAX;
    App.renderImageStrip();
  },

  // position: Tauri drag-drop 물리 좌표 — 분할 중이면 드롭 지점 아래 패널의 세션을 대상으로
  handleDrop(paths, position) {
    let id = null;
    if (position && typeof position.x === 'number') {
      const scale = window.devicePixelRatio || 1;
      id = App.sessionAtPoint(position.x / scale, position.y / scale);
    }
    id = id || App.state.activeId;
    if (!id) return;
    if (id !== App.state.activeId) App.activateSession(id, { noFocus: true });
    for (const p of paths) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(p)) App.attachImage(id, p);
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
    TerminalView.paste(id, command);
    if (execute) ta.write(id, '\r');
    TerminalView.activate(id);
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
      }, 600);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.boot());
