// 전 세션 대시보드 — 세션이 분할 최대치(6개)를 넘어갈 때
// "무엇이 돌고, 무엇이 나를 기다리는가"를 한 화면에서 보는 읽기 전용 뷰.
//
// 카드는 프로젝트 단위로 묶는다. 터미널 출력 미리보기는 넣지 않는다 —
// 좁은 타일에 잘린 TUI 출력은 판단에 쓸 수 없는 정보였고, 매초 버퍼를 읽는 비용만 남았다.
// 대신 판단에 실제로 쓰는 것만 남긴다: 상태 · 진행 시간 · 마지막 활동 · 브랜치.
//
// 화면은 #term-area 위에 덮는 오버레이다 — 홀더를 숨기거나 옮기지 않으므로
// xterm 리플로우·fit 재계산이 발생하지 않고, 껐다 켜도 터미널·분할 배치가 그대로다.

const DASH_REFRESH_MS = 1000;
const DASH_ORPHAN_SCAN_MS = 10_000; // 백그라운드 프로세스 재조회 (ps 호출이라 1초 주기에 섞지 않는다)

// 정렬·묶기·표기 순수 함수는 dashboard-core.js (모바일 원격 웹앱과 공용)

Object.assign(App, {
  _dashOpen: false,
  _dashTimer: null,
  _dashTiles: new Map(),  // sessionId → { root, nameEl, timeEl, tagEl, sinceEl, status }
  _dashGroups: new Map(), // groupKey → { root, countEl, chipsEl, sessions }
  _dashSig: null,
  _dashKeyHandler: null,
  _dashMenu: null,
  _dashOrphanTimer: null,
  _dashOrphanSig: null,
  _runStartedAt: new Map(),  // sessionId → running 진입 시각 (진행 시간 표시용)
  _lastStatus: new Map(),    // sessionId → 마지막으로 기록한 상태
  _lastChangeAt: new Map(),  // sessionId → 상태가 실제로 바뀐 시각 ('최근 활동' 정렬용)
  _dashSort: localStorage.getItem('ta-dash-sort') || 'status',

  // 상태 전이 기록 — 대시보드가 닫혀 있어도 진행 시작 시각은 알고 있어야
  // 열었을 때 경과 시간을 바로 보여줄 수 있다 (Map 쓰기 1회 — 무시할 수 있는 비용)
  noteStatusForDashboard(sessionId, status) {
    if (status === 'running') {
      if (!App._runStartedAt.has(sessionId)) App._runStartedAt.set(sessionId, Date.now());
    } else {
      App._runStartedAt.delete(sessionId);
    }
    // 같은 상태가 반복 통보되는 경우(진행 중 재통보)는 '활동'으로 세지 않는다 —
    // 그러면 진행 중 세션이 매초 최상단으로 튀어 목록이 요동친다
    if (App._lastStatus.get(sessionId) !== status) {
      App._lastStatus.set(sessionId, status);
      App._lastChangeAt.set(sessionId, Date.now());
    }
    if (App._dashOpen) App.refreshDashboard();
  },

  setDashboardSort(mode) {
    App._dashSort = mode;
    localStorage.setItem('ta-dash-sort', mode);
    App.refreshDashboard();
  },

  toggleDashboard() {
    if (App._dashOpen) App.closeDashboard();
    else App.openDashboard();
  },

  openDashboard() {
    const root = document.getElementById('dashboard');
    if (!root) return;
    App._dashOpen = true;
    root.classList.remove('hidden');
    document.getElementById('btn-dashboard').classList.add('on');
    // 정렬 드롭다운은 열 때 한 번만 채운다
    const sortEl = document.getElementById('dashboard-sort');
    if (sortEl && !sortEl.options.length) {
      for (const opt of DASH_SORTS) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = opt.label;
        sortEl.appendChild(o);
      }
      sortEl.onchange = () => App.setDashboardSort(sortEl.value);
    }
    if (sortEl) sortEl.value = App._dashSort;
    App.renderDashboard();
    void App.scanOrphans(); // 결과가 오면 scanOrphans 가 백그라운드 섹션을 다시 그린다
    App._dashOrphanTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void App.scanOrphans();
    }, DASH_ORPHAN_SCAN_MS);
    App._dashTimer = setInterval(() => {
      // 창이 숨겨져 있으면 갱신하지 않는다 (pollStatus 등 기존 관례와 동일)
      if (document.visibilityState === 'visible') App.refreshDashboard();
    }, DASH_REFRESH_MS);
    // Esc 로 닫기 — 모달이 열려 있으면 모달의 Esc 를 빼앗지 않는다
    App._dashKeyHandler = (ev) => {
      if (ev.key !== 'Escape') return;
      const backdrop = document.getElementById('modal-backdrop');
      if (backdrop && !backdrop.classList.contains('hidden')) return;
      // 카드 메뉴가 열려 있으면 Esc 는 메뉴 몫이다 — 이 핸들러가 먼저 등록돼 있어 직접 양보한다
      if (App._dashMenu) return;
      ev.preventDefault();
      App.closeDashboard();
    };
    document.addEventListener('keydown', App._dashKeyHandler, true);
  },

  closeDashboard() {
    App._dashOpen = false;
    App.closeDashboardTileMenu();
    const root = document.getElementById('dashboard');
    if (root) root.classList.add('hidden');
    const btn = document.getElementById('btn-dashboard');
    if (btn) btn.classList.remove('on');
    clearInterval(App._dashTimer);
    App._dashTimer = null;
    clearInterval(App._dashOrphanTimer);
    App._dashOrphanTimer = null;
    App._dashOrphanSig = null;
    if (App._dashKeyHandler) {
      document.removeEventListener('keydown', App._dashKeyHandler, true);
      App._dashKeyHandler = null;
    }
    App._dashTiles.clear();
    App._dashGroups.clear();
    App._dashSig = null;
    const grid = document.getElementById('dashboard-grid');
    if (grid) grid.textContent = '';
  },

  // 세션을 프로젝트 단위로 묶는다. 프로젝트가 없는 홈 터미널은 하나의 그룹으로 몰아 준다.
  // index 는 그룹의 첫 등장 순서 — 동순위 정렬의 마지막 기준이다.
  groupSessionsForDashboard() {
    return groupSessionsByProject(App.state.sessions, App.state.projects);
  },

  // 골격을 프로젝트 그룹 → 세션 카드 순서로 만든다 (세션 집합·표기가 바뀔 때만 호출)
  renderDashboard() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    grid.textContent = '';
    App._dashTiles.clear();
    App._dashGroups.clear();

    const sessions = App.state.sessions;
    App._dashSig = dashboardSignature(sessions, App.state.projects);
    // 닫힌 세션의 추적 기록을 정리한다 (세션 집합이 바뀔 때만 도는 자리라 비용이 없다)
    const alive = new Set(sessions.map((s) => s.id));
    for (const map of [App._runStartedAt, App._lastStatus, App._lastChangeAt]) {
      for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
    }
    document.getElementById('dashboard-count').textContent =
      sessions.length ? tr('세션 {n}개', { n: sessions.length }) : '';

    App._dashOrphanSig = null; // grid 를 비웠으니 백그라운드 섹션도 다시 만든다
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'dash-empty';
      empty.textContent = tr('열려 있는 세션이 없습니다. 좌측에서 프로젝트를 클릭해 터미널을 시작하세요.');
      grid.appendChild(empty);
      App.renderDashboardOrphans();
      return;
    }

    for (const g of App.groupSessionsForDashboard()) {
      const box = document.createElement('section');
      box.className = 'dash-group';

      const head = document.createElement('div');
      head.className = 'dash-group-head';
      // 프로젝트 색 — 사이드바에서 쓰는 그 색을 그대로 띠로 세운다 (같은 프로젝트를 눈으로 잇는 단서)
      const swatch = document.createElement('span');
      swatch.className = 'dash-group-swatch';
      if (g.project && g.project.color) swatch.style.background = g.project.color;
      const title = document.createElement('span');
      title.className = 'dash-group-name';
      title.textContent = g.project ? g.project.name : tr('홈 터미널');
      head.append(swatch, title);
      // 워크트리 프로젝트는 어느 브랜치인지가 곧 정체성이다 (글리프는 글꼴 의존이라 텍스트로)
      if (g.project && g.project.parentId && g.project.branch) {
        const branch = document.createElement('span');
        branch.className = 'dash-group-branch';
        branch.textContent = g.project.branch;
        head.appendChild(branch);
      }
      const chips = document.createElement('span');
      chips.className = 'dash-group-chips';
      const count = document.createElement('span');
      count.className = 'dash-group-count';
      head.append(chips, count);

      const tiles = document.createElement('div');
      tiles.className = 'dash-group-tiles';
      for (const s of g.sessions) tiles.appendChild(App.buildDashboardTile(s));

      box.append(head, tiles);
      grid.appendChild(box);
      App._dashGroups.set(g.key, { root: box, countEl: count, chipsEl: chips, sessions: g.sessions });
    }
    App.renderDashboardOrphans();
    App.refreshDashboard();
  },

  // ── 백그라운드 프로세스 섹션 — 사이드바 '백그라운드' 와 같은 목록(App._orphans)을 카드로 보여 준다.
  // 세션 그룹 뒤(order 최대)에 두고, 목록이 실제로 바뀌었을 때만 다시 만든다.
  renderDashboardOrphans() {
    if (!App._dashOpen) return;
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    const list = App._orphans || [];
    const nameOf = (o) => {
      const tab = o.liveTab ? App.state.sessions.find((x) => x.id === o.sessionId) : null;
      const p = App.state.projects.find((x) => x.id === o.projectId);
      return (tab ? tab.title : '') + '\u001f' + (p ? p.name : '');
    };
    const sig = JSON.stringify(list.map((o) => [o.pgid, o.liveTab, o.sessionId, Math.round(o.cpu || 0), o.rssKb, o.ports, nameOf(o)]));
    if (sig === App._dashOrphanSig && grid.querySelector('.dash-bg')) return;
    App._dashOrphanSig = sig;
    const old = grid.querySelector('.dash-bg');
    if (old) old.remove();
    if (!list.length) return;

    // 닫힌 탭·이전 실행이 남긴 것을 먼저, 그다음 열린 탭 소속
    const sorted = [...list].sort((a, b) => Number(!!a.liveTab) - Number(!!b.liveTab) || (b.rssKb || 0) - (a.rssKb || 0));
    const box = document.createElement('section');
    box.className = 'dash-group dash-bg';
    box.style.order = '99999';
    const head = document.createElement('div');
    head.className = 'dash-group-head';
    const title = document.createElement('span');
    title.className = 'dash-group-name';
    title.textContent = tr('백그라운드 프로세스');
    const chips = document.createElement('span');
    chips.className = 'dash-group-chips';
    const left = list.filter((o) => !o.liveTab).length;
    if (left) {
      const c = document.createElement('span');
      c.className = 'status-tag waiting';
      c.textContent = tr('남은 것 {n}', { n: left });
      chips.appendChild(c);
    }
    const count = document.createElement('span');
    count.className = 'dash-group-count';
    count.textContent = tr('{n}개', { n: list.length }) + ' · ' + formatMemKb(orphanMemKb(list));
    head.append(title, chips, count);
    const tiles = document.createElement('div');
    tiles.className = 'dash-group-tiles';
    for (const o of sorted) tiles.appendChild(App.buildDashboardOrphanTile(o));
    box.append(head, tiles);
    grid.appendChild(box);
  },

  buildDashboardOrphanTile(o) {
    const tile = document.createElement('article');
    tile.className = 'dash-tile dash-orphan' + (o.liveTab ? ' live' : ' leftover');
    tile.title = o.command + (o.cwd ? '\n' + o.cwd : '') + '\n' + tr('(우클릭=종료)');
    const head = document.createElement('div');
    head.className = 'dash-head';
    const dot = document.createElement('span');
    dot.className = 'dash-dot';
    const name = document.createElement('span');
    name.className = 'dash-name';
    name.textContent = o.command;
    head.append(dot, name);

    const p = App.state.projects.find((x) => x.id === o.projectId);
    const tab = o.liveTab ? App.state.sessions.find((x) => x.id === o.sessionId) : null;
    const where = tab ? tr('탭 {title}', { title: tab.title }) : (o.projectId ? (p ? p.name : tr('프로젝트 밖')) : (o.cwd || tr('경로 모름')));
    const meta = document.createElement('div');
    meta.className = 'dash-meta';
    const tag = document.createElement('span');
    tag.className = 'status-tag ' + (o.liveTab ? 'idle' : 'waiting');
    tag.textContent = o.liveTab ? tr('탭 소속') : tr('남음');
    const info = document.createElement('span');
    info.className = 'dash-since';
    info.textContent = [where, `CPU ${Math.round(o.cpu || 0)}%`, formatMemKb(o.rssKb || 0),
      o.ports && o.ports.length ? tr('포트 {ports}', { ports: o.ports.join(',') }) : ''].filter(Boolean).join(' · ');
    meta.append(tag, info);
    tile.append(head, meta);

    // 클릭 = 소속 탭으로 이동 (남은 프로세스는 갈 탭이 없다)
    tile.onclick = () => {
      if (!tab) return;
      App.closeDashboard();
      App.activateSession(tab.id);
    };
    tile.oncontextmenu = (ev) => {
      ev.preventDefault();
      App.showDashboardOrphanMenu(ev, o);
    };
    return tile;
  },

  // 메뉴 항목 — 두 번 눌러야 실행되는 위험 동작(종료)용. 첫 클릭은 문구만 바꾸고 메뉴를 열어 둔다.
  _dashMenuItem(text, onRun, armedText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'term-context-item' + (armedText ? ' danger' : '');
    btn.textContent = text;
    let armed = false;
    btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
    btn.onclick = (e) => {
      e.stopPropagation();
      if (armedText && !armed) {
        armed = true;
        btn.textContent = armedText;
        btn.classList.add('confirm');
        return;
      }
      App.closeDashboardTileMenu();
      onRun();
    };
    return btn;
  },

  showDashboardOrphanMenu(ev, o) {
    App.closeDashboardTileMenu();
    const menu = document.createElement('div');
    menu.className = 'term-context-menu';
    const label = document.createElement('div');
    label.className = 'term-context-label';
    label.textContent = o.command.length > 60 ? o.command.slice(0, 60) + '…' : o.command;
    menu.appendChild(label);
    const tab = o.liveTab ? App.state.sessions.find((x) => x.id === o.sessionId) : null;
    if (tab) {
      menu.appendChild(App._dashMenuItem(tr('소속 탭으로 이동'), () => {
        App.closeDashboard();
        App.activateSession(tab.id);
      }));
    }
    const n = o.pids && o.pids.length > 1 ? tr(' (프로세스 {n}개)', { n: o.pids.length }) : '';
    menu.appendChild(App._dashMenuItem(tr('■ 프로세스 종료') + n, async () => {
      try {
        await ta.killOrphan(Number(o.pgid));
        // 신호 직후의 ps 에는 아직 보일 수 있어 목록에서 먼저 걷고, 잠시 뒤 다시 조회한다
        App._orphans = App._orphans.filter((x) => x.pgid !== o.pgid);
        App.renderOrphanBadge();
        App.renderDashboardOrphans();
      } catch (e) { App.showToast(tr('종료하지 못했습니다: {e}', { e })); }
      setTimeout(() => { void App.scanOrphans(); }, 500);
    }, tr('한 번 더 눌러 종료')));
    App._openDashMenu(ev, menu);
  },

  // 세션 카드 하나 — 상태색 헤더와 한 줄짜리 정보 행으로만 이루어진다
  buildDashboardTile(s) {
    const tile = document.createElement('article');
    tile.className = 'dash-tile';
    tile.dataset.sid = s.id;
    tile.title = s.cwd || '';

    const head = document.createElement('div');
    head.className = 'dash-head';
    const dot = document.createElement('span');
    dot.className = 'dash-dot';
    const name = document.createElement('span');
    name.className = 'dash-name';
    // 프로젝트명은 그룹 머리에 이미 있다 — 카드에는 세션 이름만 둔다
    name.textContent = s.title;
    const time = document.createElement('span');
    time.className = 'dash-time';
    head.append(dot, name, time);

    const meta = document.createElement('div');
    meta.className = 'dash-meta';
    const tag = document.createElement('span');
    tag.className = 'status-tag';
    const since = document.createElement('span');
    since.className = 'dash-since';
    meta.append(tag, since);

    tile.append(head, meta);
    // 클릭 = 그 세션으로 전환 (대시보드는 읽기 전용이므로 전환 후 닫는다)
    tile.onclick = () => {
      App.closeDashboard();
      App.activateSession(s.id);
    };
    // 우클릭 = 분할 패널 배정 — 여러 세션을 훑어 배치하는 흐름이므로 대시보드는 열어 둔다
    tile.oncontextmenu = (ev) => {
      ev.preventDefault();
      App.showDashboardTileMenu(ev, s.id);
    };
    App._dashTiles.set(s.id, { root: tile, nameEl: name, timeEl: time, tagEl: tag, sinceEl: since, status: null });
    return tile;
  },

  closeDashboardTileMenu() {
    const menu = App._dashMenu;
    if (!menu) return;
    App._dashMenu = null;
    menu.cleanup();
    menu.el.remove();
  },

  // 카드 우클릭 메뉴 — 이 세션을 어느 분할 패널에 띄울지 고른다.
  // 분할이 아니면 지정할 자리가 없으므로 그 사실만 알려 준다.
  showDashboardTileMenu(ev, sessionId) {
    App.closeDashboardTileMenu();
    const session = App.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const menu = document.createElement('div');
    menu.className = 'term-context-menu';

    const label = document.createElement('div');
    label.className = 'term-context-label';
    label.textContent = App.sessionLabel(session);
    menu.appendChild(label);

    const phone = document.createElement('button');
    phone.type = 'button';
    phone.className = 'term-context-item';
    phone.textContent = tr('📱 폰에서 열기');
    phone.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
    phone.onclick = (e) => {
      e.stopPropagation();
      App.closeDashboardTileMenu();
      void App.openOnPhone(sessionId);
    };
    menu.appendChild(phone);

    if (!App.isSplit()) {
      const hint = document.createElement('div');
      hint.className = 'term-context-hint';
      hint.textContent = tr('분할 화면에서만 패널을 지정할 수 있습니다 (상단바 분할 버튼)');
      menu.appendChild(hint);
    } else {
      const count = App.splitPaneCount();
      for (let i = 0; i < count; i++) {
        const held = App.split.panes[i];
        const heldSession = held ? App.state.sessions.find((s) => s.id === held) : null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'term-context-item';
        const here = held === sessionId;
        // 세션 라벨 자체에 '—' 가 들어가므로(프로젝트명 — S2) 구분은 괄호로 한다
        const holds = here ? tr('여기 표시 중') : (heldSession ? tr('현재: {label}', { label: App.sessionLabel(heldSession) }) : tr('비어 있음'));
        btn.textContent = tr('{n}번 패널 ({holds})', { n: i + 1, holds });
        btn.disabled = here;
        btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        btn.onclick = (e) => {
          e.stopPropagation();
          App.closeDashboardTileMenu();
          // switchPaneSession 이 같은 세션을 쓰던 다른 패널을 비워 중복 표시를 막는다
          App.switchPaneSession(i, sessionId);
          App.refreshDashboard(); // 배정 결과(활성 카드)를 즉시 반영 — 대시보드는 열어 둔다
        };
        menu.appendChild(btn);
      }
    }

    const sep = document.createElement('div');
    sep.className = 'term-context-sep';
    menu.appendChild(sep);
    menu.appendChild(App._dashMenuItem(tr('■ 세션 종료'), async () => {
      try { await App.closeSession(sessionId); }
      catch (e) { App.showToast(tr('세션을 닫지 못했습니다: {e}', { e })); return; }
      // 닫힌 탭이 띄운 작업은 이제 '남은 프로세스' — 탭 소속 표시를 바로 바꾼다
      void App.scanOrphans();
    }, tr('한 번 더 눌러 종료')));

    App._openDashMenu(ev, menu);
  },

  // 메뉴를 포인터 위치에 띄우고 바깥 클릭·Esc·스크롤·창 전환 시 닫히게 한다
  _openDashMenu(ev, menu) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(ev.clientX, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(0, Math.min(ev.clientY, window.innerHeight - rect.height - 6)) + 'px';

    const closeOnOutside = (e) => { if (!menu.contains(e.target)) App.closeDashboardTileMenu(); };
    const closeOnKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); App.closeDashboardTileMenu(); } };
    const closeNow = () => App.closeDashboardTileMenu();
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnKey, true);
    window.addEventListener('blur', closeNow);
    window.addEventListener('wheel', closeNow, { passive: true });
    App._dashMenu = {
      el: menu,
      cleanup: () => {
        document.removeEventListener('mousedown', closeOnOutside, true);
        document.removeEventListener('keydown', closeOnKey, true);
        window.removeEventListener('blur', closeNow);
        window.removeEventListener('wheel', closeNow);
      }
    };
  },

  // 매 tick 갱신 — DOM 은 값이 실제로 달라졌을 때만 건드린다
  refreshDashboard() {
    if (!App._dashOpen) return;
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    // 세션이 열리거나 닫혔거나 이름·소속이 바뀌었으면 골격부터 다시 만든다
    if (dashboardSignature(App.state.sessions, App.state.projects) !== App._dashSig) {
      App.renderDashboard();
      return;
    }

    const now = Date.now();
    const projectIndex = new Map(App.state.projects.map((p, i) => [p.id, i]));
    const ctx = { projectIndex, lastChangeAt: App._lastChangeAt };
    // 선택한 기준으로 표시 순서를 계산한다 — 인덱스를 CSS order 로 주므로 DOM 은 그대로다
    const groups = App.groupSessionsForDashboard();
    const groupOrder = new Map(sortGroupsForDashboard(groups, App._dashSort, ctx).map((g, i) => [g.key, i]));

    for (const g of groups) {
      const box = App._dashGroups.get(g.key);
      if (!box) continue;
      const order = String(groupOrder.get(g.key) || 0);
      if (box.root.style.order !== order) box.root.style.order = order;

      // 그룹 요약 — 상태별 개수 칩. 이 프로젝트를 열어 볼지가 여기서 갈린다.
      const counts = {};
      for (const s of g.sessions) counts[s.status] = (counts[s.status] || 0) + 1;
      const chipSig = DASH_CHIP_ORDER.map((st) => counts[st] || 0).join(',');
      if (box.chipsEl.dataset.sig !== chipSig) {
        box.chipsEl.dataset.sig = chipSig;
        box.chipsEl.textContent = '';
        for (const st of DASH_CHIP_ORDER) {
          if (!counts[st]) continue;
          const chip = document.createElement('span');
          chip.className = 'status-tag ' + st;
          chip.textContent = (DASH_STATUS_TEXT[st] || st) + ' ' + counts[st];
          box.chipsEl.appendChild(chip);
        }
      }
      const countText = tr('{n}개', { n: g.sessions.length });
      if (box.countEl.textContent !== countText) box.countEl.textContent = countText;

      // 그룹 안 카드 순서 — 같은 기준을 그대로 적용한다
      const inner = sortSessionsForDashboard(g.sessions, App._dashSort, ctx);
      const tileOrder = new Map(inner.map((s, i) => [s.id, i]));

      for (const s of g.sessions) {
        const tile = App._dashTiles.get(s.id);
        if (!tile) continue;

        // 상태 — 카드 테두리·헤더 배경색이 여기서 갈린다 (한눈에 읽히는 게 목적)
        if (tile.status !== s.status) {
          tile.status = s.status;
          tile.root.classList.remove('s-idle', 's-running', 's-waiting', 's-done', 's-exited');
          tile.root.classList.add('s-' + s.status);
          tile.tagEl.className = 'status-tag ' + s.status;
          tile.tagEl.textContent = DASH_STATUS_TEXT[s.status] || s.status;
        }
        const tOrder = String(tileOrder.get(s.id) || 0);
        if (tile.root.style.order !== tOrder) tile.root.style.order = tOrder;
        if (tile.root.classList.contains('active') !== (s.id === App.state.activeId)) {
          tile.root.classList.toggle('active', s.id === App.state.activeId);
        }

        // 진행 시간 (진행 중일 때만)
        const startedAt = App._runStartedAt.get(s.id);
        const timeText = s.status === 'running' && startedAt
          ? formatRunElapsed(now - startedAt)
          : '';
        if (tile.timeEl.textContent !== timeText) tile.timeEl.textContent = timeText;

        // 마지막 활동 — 상태가 실제로 바뀐 시점. 관측된 전이가 없으면(앱 시작 직후) 비워 둔다.
        const changedAt = App._lastChangeAt.get(s.id);
        const sinceText = changedAt ? formatSinceChange(now, changedAt) : '';
        if (tile.sinceEl.textContent !== sinceText) tile.sinceEl.textContent = sinceText;
      }
    }
  }
});
