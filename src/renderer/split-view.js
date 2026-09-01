// 터미널 분할화면: 열×행 그리드 9종 (1×1 ~ 4×1 · 3×2 · 2×3, 최대 6분할).
// 상태는 App.split 이 단독 소유하고, holder 배치·표시는 TerminalView.syncLayout 이 수행한다.
// 분할 후 세션 미배정 패널에는 피커가 떠서 사용자가 직접 세션을 골라 배정한다.
// 각 패널의 동작(프롬프트 입력·프리셋·검색 등)은 분할 전과 동일 — 활성 세션 = 포커스 패널.
// 패널 번호는 행 우선(row-major): idx = row * cols + col.

// 모드 id 는 '열x행'. 순서 = 헤더 드롭다운 표시 순서.
const SPLIT_MODES = [
  { id: '1x1', cols: 1, rows: 1, label: '단일 화면' },
  { id: '2x1', cols: 2, rows: 1, label: '좌우 2분할' },
  { id: '1x2', cols: 1, rows: 2, label: '상하 2분할' },
  { id: '2x2', cols: 2, rows: 2, label: '2×2 4분할' },
  { id: '3x1', cols: 3, rows: 1, label: '좌우 3분할' },
  { id: '1x3', cols: 1, rows: 3, label: '상하 3분할' },
  { id: '4x1', cols: 4, rows: 1, label: '좌우 4분할' },
  { id: '3x2', cols: 3, rows: 2, label: '3×2 6분할' },
  { id: '2x3', cols: 2, rows: 3, label: '2×3 6분할' }
];
// v0.11.6 이전 저장값 호환 (단일/좌우/상하/2×2)
const SPLIT_LEGACY_MODES = { single: '1x1', horizontal: '2x1', vertical: '1x2', grid: '2x2' };
const splitMode = (id) => SPLIT_MODES.find((m) => m.id === id) || SPLIT_MODES[0];

// 패널 인덱스 0..SPLIT_MAX_PANES-1 (DOM·배열 순회 공용)
const SPLIT_PANE_IDX = Array.from({ length: SPLIT_MAX_PANES }, (_, i) => i);
const emptyPanes = () => new Array(SPLIT_MAX_PANES).fill(null);
// 트랙 n 개를 균등 분할했을 때의 스플리터 누적 위치 (예: 3 → [0.333, 0.667])
const evenSplits = (n) => Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);

Object.assign(App, {
  split: {
    mode: '1x1',          // SPLIT_MODES 의 id ('열x행')
    panes: emptyPanes(),  // 패널별 배정 세션 id
    focused: 0,
    // 스플리터 위치는 트랙 수별로 따로 기억한다 — 2열에서 맞춰 둔 비율이
    // 3열로 갔다가 돌아왔을 때 흐트러지지 않게.
    colPos: { 2: evenSplits(2), 3: evenSplits(3), 4: evenSplits(4) }, // 열 스플리터 누적 위치 (좌 기준)
    rowPos: { 2: evenSplits(2), 3: evenSplits(3) }                    // 행 스플리터 누적 위치 (상 기준)
  },

  // 스플리터끼리·가장자리와의 최소 간격 — 트랙이 0 으로 찌그러지는 것을 막는다
  SPLIT_MIN_TRACK: 0.12,

  splitCols() { return splitMode(App.split.mode).cols; },
  splitRows() { return splitMode(App.split.mode).rows; },
  splitPaneCount() { const m = splitMode(App.split.mode); return m.cols * m.rows; },

  // 분할 중인가 (패널 2개 이상) — 단일 화면과 동작이 갈리는 지점에서 쓴다
  isSplit() { return App.splitPaneCount() > 1; },

  // 현재 모드에서 화면에 보이는 패널들의 세션 배정 (인덱스 = 패널 번호)
  splitVisiblePanes() { return App.split.panes.slice(0, App.splitPaneCount()); },

  // 패널이 담당하는 세션 — 단일 화면은 0번 패널이 활성 세션을 맡는다.
  // 패널마다 독립된 프롬프트 작성기의 전송 대상 판별에 쓴다.
  paneSessionId(paneIdx) {
    if (!App.isSplit()) return paneIdx === 0 ? App.state.activeId : null;
    return paneIdx < App.splitPaneCount() ? App.split.panes[paneIdx] : null;
  },

  // 세션이 보이는 패널 번호 (화면에 없으면 -1)
  paneIndexForSession(sessionId) {
    if (!sessionId) return -1;
    if (!App.isSplit()) return sessionId === App.state.activeId ? 0 : -1;
    return App.splitVisiblePanes().indexOf(sessionId);
  },

  saveSplitState() {
    const s = App.split;
    localStorage.setItem('ta-split-mode', s.mode);
    localStorage.setItem('ta-split-colpos', JSON.stringify(s.colPos));
    localStorage.setItem('ta-split-rowpos', JSON.stringify(s.rowPos));
    localStorage.setItem('ta-split-panes', JSON.stringify(s.panes));
    localStorage.setItem('ta-split-focused', String(s.focused));
  },

  // 부팅 시 복원 — 세션 목록(App.state.sessions)이 채워진 뒤에 호출해야 한다
  restoreSplitState() {
    const s = App.split;
    const savedMode = localStorage.getItem('ta-split-mode');
    const mode = SPLIT_LEGACY_MODES[savedMode] || savedMode;
    if (SPLIT_MODES.some((m) => m.id === mode)) s.mode = mode;
    // 스플리터 위치: 오름차순·간격이 모두 유효할 때만 복원 (하나라도 깨지면 균등 분할)
    const readPos = (key, target) => {
      let obj = null;
      try { obj = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return; }
      if (!obj) return;
      // 트랙 수는 열/행이 다르다 (열 2~4, 행 2~3) — 기본값에 있는 키만 복원한다
      for (const n of Object.keys(target).map(Number)) {
        const arr = obj[n];
        if (!Array.isArray(arr) || arr.length !== n - 1) continue;
        if (App.validSplitPositions(arr)) target[n] = arr.slice();
      }
    };
    readPos('ta-split-colpos', s.colPos);
    readPos('ta-split-rowpos', s.rowPos);
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('ta-split-panes') || '[]'); } catch (_) {}
    // 죽은 세션·중복 배정은 버린다 (해당 패널은 피커로 복원됨)
    const seen = new Set();
    s.panes = SPLIT_PANE_IDX.map((i) => {
      const id = saved[i];
      if (!id || seen.has(id) || !App.state.sessions.some((x) => x.id === id)) return null;
      seen.add(id);
      return id;
    });
    const f = Number(localStorage.getItem('ta-split-focused'));
    if (Number.isInteger(f) && f >= 0 && f < App.splitPaneCount()) s.focused = f;
  },

  // 스플리터 위치 배열이 유효한가 (오름차순 + 트랙 최소 폭 확보)
  validSplitPositions(arr) {
    const gap = App.SPLIT_MIN_TRACK;
    let prev = 0;
    for (const v of arr) {
      if (!(typeof v === 'number') || !(v - prev >= gap)) return false;
      prev = v;
    }
    return 1 - prev >= gap;
  },

  setSplitMode(mode) {
    const s = App.split;
    if (!SPLIT_MODES.some((m) => m.id === mode) || s.mode === mode) return;
    const wasSplit = App.isSplit();
    // 이전 모드에서 보이던 세션들 (단일 모드는 활성 세션 하나)
    const prevVisible = wasSplit
      ? App.splitVisiblePanes().filter(Boolean)
      : (App.state.activeId ? [App.state.activeId] : []);
    // 축소 시 세션들의 패널 인덱스가 앞으로 당겨지므로, 포커스는 세션 id 기준으로 재계산한다
    const prevFocusedId = wasSplit ? s.panes[s.focused] : App.state.activeId;
    s.mode = mode;
    const n = App.splitPaneCount();
    if (n === 1) {
      // 포커스 패널의 세션을 단일 화면으로 유지 (없으면 배정된 첫 세션)
      const keep = s.panes[s.focused] || prevVisible[0] || App.state.activeId || null;
      s.panes = emptyPanes();
      s.panes[0] = keep;
      s.focused = 0;
      App.saveSplitState();
      if (keep) { App.activateSession(keep); return; } // renderAll → renderSplit 포함
    } else {
      // 확장은 기존 배정 유지, 축소는 앞쪽 패널로 압축
      const next = emptyPanes();
      prevVisible.slice(0, n).forEach((id, i) => { next[i] = id; });
      if (!next.includes(App.state.activeId) && App.state.activeId && !next[0]) next[0] = App.state.activeId;
      s.panes = next;
      const fi = prevFocusedId ? next.indexOf(prevFocusedId) : -1;
      if (fi >= 0) s.focused = fi;
      else {
        const first = next.findIndex(Boolean);
        s.focused = first >= 0 ? first : 0;
      }
      App.saveSplitState();
      const focusedId = s.panes[s.focused];
      if (focusedId && focusedId !== App.state.activeId) { App.activateSession(focusedId); return; }
    }
    App.renderSplit();
    TerminalView.syncLayout();
    // 세션이 하나도 없으면 activateSession 경로를 타지 않는다 —
    // 분할 여부에 따라 온보딩 오버레이 표시/숨김을 여기서 갱신한다
    App.renderEmptyState();
  },

  // 피커에서 세션 선택 → 해당 패널에 배정 + 포커스
  assignPaneSession(paneIdx, id) {
    const s = App.split;
    if (paneIdx >= App.splitPaneCount()) return;
    if (App.splitVisiblePanes().includes(id)) return; // 이미 다른 패널에 표시 중 (피커에서 제외되지만 방어)
    s.panes[paneIdx] = id;
    s.focused = paneIdx;
    App.saveSplitState();
    App.activateSession(id);
  },

  // 앞에서부터 훑은 첫 빈 패널 번호 (죽은 세션이 남은 자리도 빈 것으로 본다). 없으면 -1
  firstEmptyPane() {
    const n = App.splitPaneCount();
    for (let i = 0; i < n; i++) {
      const id = App.split.panes[i];
      if (!id || !App.state.sessions.some((x) => x.id === id)) return i;
    }
    return -1;
  },

  // Tab = 다음(Shift+Tab = 이전) 패널로 순회 이동하며 그 패널 프롬프트 입력창에 커서.
  // 세션이 없거나 죽은 패널은 입력창이 잠겨 있으므로 건너뛴다.
  // 터미널 안에서의 Tab 은 셸 자동완성이라 가로채지 않는다.
  cyclePaneFocus(dir) {
    const s = App.split;
    const n = App.splitPaneCount();
    if (!App.isSplit()) return false;
    const step = dir < 0 ? -1 : 1;
    for (let k = 1; k <= n; k++) {
      const i = ((s.focused + step * k) % n + n) % n;
      const sid = s.panes[i];
      if (!sid || !TerminalView.views.has(sid)) continue;
      const c = TerminalView.composers[i];
      if (!c || !c.input) continue;
      App.focusPane(i); // 활성 세션·포커스 링 갱신 (입력창 포커스는 아래에서)
      c.input.focus();
      return true;
    }
    return false;
  },

  // 패널 클릭(캡처) = 포커스 이동. 터미널 클릭·선택을 방해하지 않게 프롬프트 포커스는 뺏지 않는다.
  focusPane(paneIdx) {
    const s = App.split;
    if (!App.isSplit() || paneIdx >= App.splitPaneCount() || s.focused === paneIdx) return;
    s.focused = paneIdx;
    App.saveSplitState();
    const id = s.panes[paneIdx];
    if (id) App.activateSession(id, { noFocus: true });
    else App.renderSplit();
  },

  // ── 헤더 제목 바 드래그로 패널 위치 변경 ──
  // 삽입 위치는 파란 점선(.drop-indicator)으로 표시하고, 드롭하면 그 자리로 옮기며
  // 사이의 패널들은 한 칸씩 밀린다(목록 정렬과 같은 규칙). 세션 없는 빈 패널도 대상이다.

  // 포인터 아래 패널의 삽입 지점. 결과가 제자리인 위치는 null 로 걸러 표시도 하지 않는다.
  paneDropTarget(x, y, srcIdx) {
    const n = App.splitPaneCount();
    const vertical = App.splitCols() > 1; // 열이 둘 이상이면 좌우 삽입(세로 점선)
    for (let i = 0; i < n; i++) {
      const r = document.getElementById('term-pane-' + i).getBoundingClientRect();
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
      const before = vertical ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
      const insert = before ? i : i + 1;
      if (insert === srcIdx || insert === srcIdx + 1) return null;
      return { insert, before, rect: r, vertical };
    }
    return null;
  },

  startPaneDrag(paneIdx, e) {
    if (e.button !== 0 || !App.isSplit()) return;
    const bar = document.getElementById('term-pane-' + paneIdx).querySelector('.pane-preset-bar');
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, indicator = null, drop = null;
    e.preventDefault(); // 드래그 중 텍스트 선택 방지 (click 은 그대로 발생)

    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return; // 클릭과 구분
        dragging = true;
        App.closeSessionSwitchMenus();
        App.closePanePresetMenus();
        if (bar) bar.classList.add('dragging');
        document.body.classList.add('sorting');
        indicator = document.createElement('div');
        indicator.className = 'drop-indicator';
        document.body.appendChild(indicator);
      }
      drop = App.paneDropTarget(ev.clientX, ev.clientY, paneIdx);
      if (!drop) { indicator.style.display = 'none'; return; }
      const r = drop.rect;
      indicator.className = 'drop-indicator' + (drop.vertical ? ' vert' : '');
      indicator.style.display = 'block';
      if (drop.vertical) {
        indicator.style.left = (drop.before ? r.left : r.right - 2) + 'px';
        indicator.style.top = r.top + 'px';
        indicator.style.height = r.height + 'px';
        indicator.style.width = '0px';
      } else {
        indicator.style.left = r.left + 'px';
        indicator.style.width = r.width + 'px';
        indicator.style.top = (drop.before ? r.top : r.bottom - 2) + 'px';
        indicator.style.height = '0px';
      }
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragging) return;
      if (bar) bar.classList.remove('dragging');
      if (indicator) indicator.remove();
      document.body.classList.remove('sorting');
      if (drop) App.movePaneSession(paneIdx, drop.insert);
      // 드래그를 끝낸 mouseup 과 같은 틱의 click 만 삼킨다 — 제목 드롭다운이 열리지 않게
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  // from 패널의 배정을 insert 지점으로 옮긴다 (insert = 삽입 전 기준 인덱스)
  movePaneSession(from, insert) {
    const s = App.split;
    const n = App.splitPaneCount();
    const arr = s.panes.slice(0, n);
    const [moved] = arr.splice(from, 1);
    const at = from < insert ? insert - 1 : insert;
    arr.splice(at, 0, moved);
    s.panes = arr.concat(s.panes.slice(n));
    s.focused = at;
    App.saveSplitState();
    if (moved) App.activateSession(moved, { noFocus: true }); // renderAll → renderSplit 포함
    else App.renderSplit();
    TerminalView.syncLayout();
  },

  // 화면 좌표 아래 패널에 배정된 세션 id (단일 모드·패널 밖·미배정이면 null) — 드롭 대상 판별용
  sessionAtPoint(x, y) {
    if (!App.isSplit()) return null;
    const n = App.splitPaneCount();
    for (let i = 0; i < n; i++) {
      const r = document.getElementById('term-pane-' + i).getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return App.split.panes[i];
    }
    return null;
  },

  // 세션 종료 시 패널 배정 해제 — 빈 패널은 피커로 돌아간다
  releasePaneSession(id) {
    const s = App.split;
    let changed = false;
    s.panes = s.panes.map((sid) => {
      if (sid === id) { changed = true; return null; }
      return sid;
    });
    if (changed) App.saveSplitState();
  },

  // 분할 관련 DOM 갱신 (컨테이너 클래스·비율·포커스 표시·버튼 상태·피커) — fit 은 하지 않는다
  // 스플리터 두께(4px)를 뺀 grid 트랙 문자열. 마지막 트랙은 1fr 로 남은 폭을 채운다.
  splitTracks(positions, count) {
    if (count < 2) return '1fr';
    const parts = [];
    let prev = 0;
    for (let i = 0; i < count - 1; i++) {
      const size = ((positions[i] - prev) * 100).toFixed(2);
      parts.push(`calc(${size}% - ${i === 0 ? 2 : 4}px)`, '4px');
      prev = positions[i];
    }
    parts.push('1fr');
    return parts.join(' ');
  },

  renderSplit() {
    const s = App.split;
    const m = splitMode(s.mode);
    const area = document.getElementById('term-area');
    const split = App.isSplit();
    area.classList.toggle('split', split);
    area.style.gridTemplateColumns = App.splitTracks(s.colPos[m.cols] || [], m.cols);
    area.style.gridTemplateRows = App.splitTracks(s.rowPos[m.rows] || [], m.rows);

    // 패널: 행 우선으로 grid 트랙에 배치 (트랙 번호는 1-based, 스플리터가 짝수 트랙)
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const pane = document.getElementById('term-pane-' + i);
      const on = i < m.cols * m.rows;
      pane.style.display = on ? 'flex' : '';
      if (on) pane.style.gridArea = `${2 * Math.floor(i / m.cols) + 1} / ${2 * (i % m.cols) + 1}`;
      // 포커스 링은 세션이 배정된 패널에만 — 빈 패널은 프롬프트 대상이 아니므로 오해를 막는다
      pane.classList.toggle('focused', split && s.focused === i && !!s.panes[i]);
    }
    // 스플리터: 세로는 열 사이(최대 3개), 가로는 행 사이(최대 2개). 쓰지 않는 것은 감춘다.
    for (let k = 0; k < 3; k++) {
      const v = document.getElementById('split-divider-v' + k);
      v.style.display = k < m.cols - 1 ? 'block' : '';
      if (k < m.cols - 1) v.style.gridArea = `1 / ${2 * k + 2} / -1 / ${2 * k + 3}`;
    }
    for (let k = 0; k < 2; k++) {
      const h = document.getElementById('split-divider-h' + k);
      h.style.display = k < m.rows - 1 ? 'block' : '';
      if (k < m.rows - 1) h.style.gridArea = `${2 * k + 2} / 1 / ${2 * k + 3} / -1`;
    }
    App.renderSplitMenu();
    App.renderPanePickers();
    App.renderPanePresets();
  },

  // 모드 아이콘 — 테두리 사각형 + 열·행 경계선. 8종을 같은 규칙으로 그린다.
  splitModeIcon(cols, rows, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const px = size || 14;
    svg.setAttribute('width', px);
    svg.setAttribute('height', px);
    svg.setAttribute('viewBox', '0 0 16 16');
    const line = (x1, y1, x2, y2) => {
      const el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', x1.toFixed(2));
      el.setAttribute('y1', y1.toFixed(2));
      el.setAttribute('x2', x2.toFixed(2));
      el.setAttribute('y2', y2.toFixed(2));
      el.setAttribute('stroke', 'currentColor');
      el.setAttribute('stroke-width', '1.5');
      svg.appendChild(el);
    };
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '1.5');
    rect.setAttribute('y', '1.5');
    rect.setAttribute('width', '13');
    rect.setAttribute('height', '13');
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.5');
    svg.appendChild(rect);
    for (let c = 1; c < cols; c++) line(1.5 + (13 * c) / cols, 1.5, 1.5 + (13 * c) / cols, 14.5);
    for (let r = 1; r < rows; r++) line(1.5, 1.5 + (13 * r) / rows, 14.5, 1.5 + (13 * r) / rows);
    return svg;
  },

  // 헤더 버튼 아이콘(현재 모드) + 드롭다운 목록. 목록은 최초 1회만 만들고 강조만 갱신한다.
  renderSplitMenu() {
    const s = App.split;
    const m = splitMode(s.mode);
    const btn = document.getElementById('btn-split');
    btn.textContent = '';
    btn.appendChild(App.splitModeIcon(m.cols, m.rows));
    btn.title = `화면 분할 — 현재 ${m.label}`;
    const menu = document.getElementById('split-menu');
    if (!menu.childElementCount) {
      for (const mode of SPLIT_MODES) {
        const item = document.createElement('button');
        item.className = 'split-item';
        item.dataset.mode = mode.id;
        item.setAttribute('role', 'menuitem');
        item.appendChild(App.splitModeIcon(mode.cols, mode.rows));
        const label = document.createElement('span');
        label.textContent = mode.label;
        item.appendChild(label);
        item.onclick = () => { App.closeSplitMenu(); App.setSplitMode(mode.id); };
        menu.appendChild(item);
      }
    }
    menu.querySelectorAll('.split-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.mode === s.mode);
    });
  },

  toggleSplitMenu() {
    const menu = document.getElementById('split-menu');
    if (menu.classList.contains('hidden')) {
      menu.classList.remove('hidden');
      document.getElementById('btn-split').setAttribute('aria-expanded', 'true');
    } else {
      App.closeSplitMenu();
    }
  },

  closeSplitMenu() {
    document.getElementById('split-menu').classList.add('hidden');
    document.getElementById('btn-split').setAttribute('aria-expanded', 'false');
  },

  // 패널별 헤더 바: '상태태그 + 프로젝트명 — 세션명 ⎇브랜치' + 프리셋 드롭다운(우측 정렬).
  // 단일 화면에도 표시된다 — 0번 패널이 활성 세션의 헤더를 맡는다.
  // 제목은 프로젝트 색으로 칠해 여러 패널을 띄웠을 때 어느 프로젝트인지 한눈에 구분되게 한다.
  // 프리셋은 칩을 늘어놓으면 좁은 패널 폭을 다 먹으므로 드롭다운 하나로 접어 두고,
  // 전역 프리셋 + 그 세션 프로젝트 전용 프리셋을 모두 담는다 (실행 대상 = 그 패널 세션).
  renderPanePresets() {
    const n = App.splitPaneCount();
    let layoutChanged = false;
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const pane = document.getElementById('term-pane-' + i);
      let bar = pane.querySelector('.pane-preset-bar');
      const sid = i < n ? App.paneSessionId(i) : null; // 단일 화면은 0번 = 활성 세션
      const sess = sid ? App.state.sessions.find((x) => x.id === sid) : null;
      if (!sess) {
        if (bar) { bar.remove(); layoutChanged = true; }
        if (pane.classList.contains('with-presets')) { pane.classList.remove('with-presets'); layoutChanged = true; }
        continue;
      }
      const proj = App.state.projects.find((p) => p.id === sess.projectId);
      const branch = App.state.branches[sess.id] || '';
      const globals = App.state.presets.filter((p) => !p.projectId);
      const projs = App.state.presets.filter((p) => p.projectId && p.projectId === sess.projectId);
      // 내용이 같으면 재생성하지 않는다 — mousedown~click 사이 재렌더는 클릭을 씹고,
      // 열려 있는 드롭다운도 닫혀 버린다. 상태는 서명에서 제외하고 태그만 교체한다(refreshPickerStatus).
      const switchSig = App.state.projects.map((p) => `${p.id}:${p.name}:${p.color || ''}`)
        .concat(App.state.sessions.map((s) => `${s.id}:${s.projectId || ''}:${s.title}:${s.status}`))
        .join(',');
      const git = App.state.gitRemote[sess.cwd];
      // Pull 버튼 상태(저장소 여부·behind 개수·진행 중)도 서명에 넣어야 fetch 결과가 반영된다
      const gitSig = git === undefined ? '?' : git === null ? 'none'
        : [git.hasUpstream ? 1 : 0, git.behind, git.ahead, git.fetchFailed ? 1 : 0].join(':');
      const sig = [sid, App.sessionLabel(sess), branch, (proj && proj.color) || '', Theme.state.id, switchSig,
        gitSig, App._gitPulling === sess.cwd ? 'pulling' : '',
        globals.concat(projs).map((p) => p.id + ':' + p.label + ':' + p.command).join(',')].join('|');
      // 세션 전환 드롭다운이 열려 있는 동안엔 바를 다시 만들지 않는다 — 상태 태그가 바뀔 때마다
      // 재생성되면 검색어를 치던 도중에 메뉴가 닫힌다. 닫힌 뒤 다음 렌더에서 반영된다.
      if (bar && bar.querySelector('.pane-session-menu:not(.hidden)')) continue;
      if (bar && bar.dataset.sig === sig) continue;
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'pane-preset-bar';
        pane.appendChild(bar);
      }
      if (!pane.classList.contains('with-presets')) { pane.classList.add('with-presets'); layoutChanged = true; }
      bar.dataset.sig = sig;
      bar.textContent = '';

      // ── 헤더 라벨 (상태 태그 + 제목 + 브랜치) ──
      const label = document.createElement('span');
      label.className = 'pane-preset-label';
      label.dataset.sid = sid; // 상태 전이 시 태그만 교체하기 위한 좌표
      if (proj && proj.color) label.style.color = Theme.adjustText(proj.color);
      label.title = [App.sessionLabel(sess), branch && '⎇ ' + branch, sess.cwd].filter(Boolean).join('\n');
      label.title += '\n(제목 바를 끌어 패널 위치 변경)';
      label.addEventListener('mousedown', (e) => App.startPaneDrag(i, e));
      label.appendChild(statusTag(sess.status));
      const nameEl = document.createElement('span');
      nameEl.className = 'ppl-name';
      nameEl.textContent = App.sessionLabel(sess);
      nameEl.title = '프로젝트 및 세션 변경';
      nameEl.onclick = (e) => {
        e.stopPropagation();
        App.toggleSessionSwitchMenu(bar, i);
      };
      label.appendChild(nameEl);
      if (branch) {
        const brEl = document.createElement('span');
        brEl.className = 'ppl-branch';
        brEl.textContent = '⎇ ' + branch;
        label.appendChild(brEl);
      }
      bar.appendChild(label);

      // ── Pull 버튼 (git 저장소일 때만) + 프리셋 드롭다운 (우측 정렬) ──
      bar.appendChild(App.buildSessionSwitchMenu(i, sid));
      const pull = App.buildPullButton(sess.cwd, git);
      if (pull) bar.appendChild(pull);
      bar.appendChild(App.buildPanePresetMenu(globals, projs, sid, sess.projectId));
    }
    if (layoutChanged) TerminalView.fitActive(); // 바 유무가 holder 높이를 바꾼다
  },

  buildSessionSwitchMenu(paneIdx, activeSid) {
    const menu = document.createElement('div');
    menu.className = 'pane-session-menu hidden';
    menu.dataset.pane = String(paneIdx);

    // ── 최상단 검색창 ── 프로젝트 단위로 거른다: 프로젝트 이름이 걸리면 그 프로젝트의
    // 세션 전체와 "+ 새 세션" 항목을 함께 보여준다 (목적이 프로젝트 찾기이므로).
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'pane-session-search';
    search.placeholder = '프로젝트·세션 검색';
    search.spellcheck = false;
    search.autocomplete = 'off';
    menu.appendChild(search);

    const extras = []; // 검색 중에는 감추는 항목(푸터)
    const groups = []; // 프로젝트 단위 묶음 { el, fields, rows, addEl }
    let group = null;

    const addGroup = (name, color, path) => {
      const el = document.createElement('div');
      el.className = 'pane-session-group';
      el.textContent = name;
      if (color) el.style.color = color;
      menu.appendChild(el);
      group = { el, fields: [name, path || ''], rows: [], addEl: null };
      groups.push(group);
    };
    const addItem = (label, title, onclick, opts) => {
      const item = document.createElement('button');
      item.className = 'pane-session-item' + (opts && opts.active ? ' active' : '') + (opts && opts.empty ? ' empty' : '');
      item.textContent = label;
      item.title = title || label;
      item.onclick = (e) => {
        e.stopPropagation();
        App.closeSessionSwitchMenus();
        onclick();
      };
      menu.appendChild(item);
      if (opts && opts.empty && group) group.addEl = item; // 그룹의 "+ 새 세션" — 그룹과 함께 보이고 숨는다
      return item;
    };
    const appendSession = (sess) => {
      const item = addItem(App.sessionLabel(sess), sess.cwd, () => App.switchPaneSession(paneIdx, sess.id), {
        active: sess.id === activeSid
      });
      item.dataset.sid = sess.id;
      item.prepend(statusTag(sess.status));
      if (group) group.rows.push({ el: item, fields: [App.sessionLabel(sess), sess.cwd] });
    };

    const knownProjects = new Set(App.state.projects.map((p) => p.id));
    const homeSessions = App.state.sessions.filter((s) => !s.projectId || !knownProjects.has(s.projectId));
    addGroup('일반 터미널');
    homeSessions.forEach(appendSession);
    // 세션이 이미 있어도 그룹 끝에 항상 새 세션 항목을 둔다 — 추가 생성 경로가 사라지지 않게.
    addItem('+ 새 일반 터미널', '홈 디렉토리에서 새 세션 시작', () => App.createPaneSession(paneIdx, null), { empty: true });

    for (const p of App.state.projects) {
      addGroup(p.name, p.color ? Theme.adjustText(p.color) : '', p.path);
      App.state.sessions.filter((s) => s.projectId === p.id).forEach(appendSession);
      addItem('+ 새 세션 시작', p.path, () => App.createPaneSession(paneIdx, p.id), { empty: true });
    }

    const noHit = document.createElement('div');
    noHit.className = 'pane-session-nohit';
    noHit.textContent = '일치하는 프로젝트가 없습니다';
    noHit.hidden = true;
    menu.appendChild(noHit);

    const footer = document.createElement('button');
    footer.className = 'pane-session-add';
    footer.textContent = '+ 현재 프로젝트에 새 세션';
    footer.onclick = (e) => {
      e.stopPropagation();
      App.closeSessionSwitchMenus();
      const sess = App.state.sessions.find((s) => s.id === activeSid);
      App.createPaneSession(paneIdx, sess ? sess.projectId || null : null);
    };
    menu.appendChild(footer);
    extras.push(footer);

    // 프로젝트 이름이 걸리면 그 프로젝트 전체를, 아니면 일치하는 세션만 남긴다.
    // 세션이 하나도 없는 프로젝트도 이름만 맞으면 "+ 새 세션"과 함께 보여야 한다.
    const applyFilter = () => {
      const q = search.value.trim();
      let hits = 0;
      for (const g of groups) {
        const projHit = fuzzyMatch(g.fields, q);
        let shown = 0;
        for (const r of g.rows) {
          const ok = !q || projHit || fuzzyMatch(r.fields, q);
          r.el.hidden = !ok;
          if (ok) shown++;
        }
        const visible = !q || projHit || shown > 0;
        g.el.hidden = !visible;
        if (g.addEl) g.addEl.hidden = !visible;
        if (visible && q) hits++;
      }
      for (const el of extras) el.hidden = !!q;
      noHit.hidden = !q || hits > 0;
    };
    search.oninput = applyFilter;
    search.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // 보이는 첫 세션으로 전환하고, 세션이 없으면 첫 일치 프로젝트에 새 세션을 연다
      for (const g of groups) {
        if (g.el.hidden) continue;
        const row = g.rows.find((r) => !r.el.hidden);
        if (row) { row.el.click(); return; }
        if (g.addEl && !g.addEl.hidden) { g.addEl.click(); return; }
      }
    };
    menu._resetSearch = () => { search.value = ''; applyFilter(); };
    menu._focusSearch = () => search.focus();
    return menu;
  },

  toggleSessionSwitchMenu(bar, paneIdx) {
    const menu = bar && bar.querySelector(`.pane-session-menu[data-pane="${paneIdx}"]`);
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    App.closePanePresetMenus();
    App.closeSessionSwitchMenus();
    menu.classList.toggle('hidden', !willOpen);
    const label = bar.querySelector('.ppl-name');
    if (label) label.classList.toggle('open', willOpen);
    // 열 때마다 이전 검색어를 지우고 바로 타이핑할 수 있게 검색창에 포커스를 준다.
    // (mousedown 직후라 포커스가 되돌려질 수 있어 다음 틱에 준다)
    if (willOpen && menu._resetSearch) {
      menu._resetSearch();
      setTimeout(() => menu._focusSearch(), 0);
    }
  },

  closeSessionSwitchMenus() {
    document.querySelectorAll('.pane-session-menu').forEach((m) => {
      m.classList.add('hidden');
      if (m._resetSearch) m._resetSearch();
    });
    document.querySelectorAll('.ppl-name.open').forEach((el) => el.classList.remove('open'));
  },

  switchPaneSession(paneIdx, sid) {
    if (!sid || !App.state.sessions.some((s) => s.id === sid)) return;
    if (App.isSplit()) {
      const duplicate = App.split.panes.findIndex((id, i) => id === sid && i !== paneIdx);
      if (duplicate >= 0) App.split.panes[duplicate] = null;
      App.split.panes[paneIdx] = sid;
      App.split.focused = paneIdx;
      App.saveSplitState();
    }
    App.activateSession(sid);
  },

  // 대상 패널을 createSession 에 넘겨야 한다 — 생략하면 배정 로직이 포커스 패널(다른 패널)의
  // 세션을 새 세션으로 갈아끼운 뒤 이 자리에도 넣어 같은 세션이 두 패널에 뜬다.
  async createPaneSession(paneIdx, projectId) {
    const sess = await App.createSession(projectId, { paneIdx });
    if (sess && App.isSplit()) {
      App.renderSplit();
      TerminalView.syncLayout();
    }
    return sess;
  },

  // Pull 버튼 — git 저장소인 세션에서만 렌더한다 (저장소가 아니면 null 을 돌려 아예 감춘다).
  // 세션 시작 시 fetch 로 받아둔 상태를 그대로 쓴다: 받을 커밋이 없으면 비활성,
  // 있으면 활성 + 우측 상단 원형 배지에 개수를 표시한다.
  buildPullButton(cwd, git) {
    if (!git) return null; // undefined(조회 전) / null(git 저장소 아님) 모두 비표시
    const wrap = document.createElement('span');
    wrap.className = 'pane-pull';

    const btn = document.createElement('button');
    btn.className = 'pane-pull-btn';
    const pulling = App._gitPulling === cwd;
    const behind = git.behind || 0;
    btn.textContent = pulling ? 'Pull…' : 'Pull';
    const disabled = pulling || !git.hasUpstream || behind === 0;
    btn.disabled = disabled;
    if (behind > 0 && git.hasUpstream) btn.classList.add('has-updates');

    if (!git.hasUpstream) {
      btn.title = '업스트림 브랜치가 없어 pull 대상이 없습니다' + (git.branch ? ` (${git.branch})` : '');
    } else if (behind > 0) {
      btn.title = `원격에 새 커밋 ${behind}개 — 클릭하면 git pull --ff-only 실행`
        + (git.ahead ? `
(로컬 앞선 커밋 ${git.ahead}개)` : '');
    } else {
      btn.title = git.fetchFailed
        ? '원격 확인에 실패했습니다 (오프라인·인증) — 마지막으로 받아둔 기준으로는 최신입니다'
        : '이미 최신 상태입니다';
    }
    btn.onclick = () => App.runGitPull(cwd);
    wrap.appendChild(btn);

    if (behind > 0 && git.hasUpstream) {
      const badge = document.createElement('span');
      badge.className = 'pane-pull-badge';
      badge.textContent = behind > 99 ? '99+' : String(behind);
      wrap.appendChild(badge);
    }
    return wrap;
  },

  // 프리셋 드롭다운 (패널 헤더용) — 전역(파랑 배경, 맨앞) + 프로젝트 전용 + '+ 프리셋 추가'.
  // 클릭=즉시 실행, Shift+클릭=입력만, 우클릭=수정. 드래그로 같은 그룹 내 순서 변경.
  buildPanePresetMenu(globals, projs, sid, projectId) {
    const wrap = document.createElement('span');
    wrap.className = 'pane-preset-dd';

    const total = globals.length + projs.length;
    const btn = document.createElement('button');
    btn.className = 'pane-preset-toggle';
    btn.textContent = total ? `프리셋 ${total} ▾` : '프리셋 ▾';
    btn.title = '명령 프리셋 (전역 + 프로젝트 전용) — 이 패널의 세션에 실행';
    wrap.appendChild(btn);

    const menu = document.createElement('div');
    menu.className = 'pane-preset-menu hidden';
    const makeItem = (p, isGlobal) => {
      const item = document.createElement('button');
      item.className = 'pane-preset-item' + (isGlobal ? ' global' : '');
      item.dataset.id = p.id; // 드래그 정렬 좌표
      item.title = p.command + '\n(클릭=즉시 실행, Shift+클릭=입력만, 우클릭=수정)';
      item.textContent = p.label;
      item.onclick = (e) => { App.closePanePresetMenus(); App.runPreset(p, !e.shiftKey, sid); };
      item.oncontextmenu = (e) => { e.preventDefault(); App.closePanePresetMenus(); App.showPresetModal(p); };
      return item;
    };
    for (const p of globals) menu.appendChild(makeItem(p, true)); // 전역은 항상 맨앞
    for (const p of projs) menu.appendChild(makeItem(p, false));

    // '+ 프리셋 추가' — 관리 팝업을 이 패널 세션의 프로젝트 기준으로 연다
    const add = document.createElement('button');
    add.className = 'pane-preset-add';
    add.textContent = '+ 프리셋 추가';
    add.title = '프리셋 관리 (추가·수정·삭제)';
    add.onclick = () => { App.closePanePresetMenus(); App.showPresetManager(projectId || null); };
    menu.appendChild(add);

    makeSortable({
      container: menu,
      itemSelector: '.pane-preset-item[data-id]',
      axis: 'y',
      // 전역(global)↔프로젝트 그룹 간 이동 금지
      canDrop: (srcEl, dstEl) => srcEl.classList.contains('global') === dstEl.classList.contains('global'),
      onDrop: (srcId, dstId, before) => App.movePreset(srcId, dstId, before)
    });
    wrap.appendChild(menu);

    btn.onclick = () => {
      const willOpen = menu.classList.contains('hidden');
      App.closePanePresetMenus();
      menu.classList.toggle('hidden', !willOpen);
      btn.classList.toggle('open', willOpen);
    };
    return wrap;
  },

  closePanePresetMenus() {
    document.querySelectorAll('.pane-preset-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.pane-preset-toggle.open').forEach((b) => b.classList.remove('open'));
  },

  // 세션 미배정 패널의 세션 선택 피커 (다른 패널에 이미 표시 중인 세션은 제외)
  renderPanePickers() {
    const s = App.split;
    const n = App.splitPaneCount();
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const pane = document.getElementById('term-pane-' + i);
      let picker = pane.querySelector('.pane-picker');
      const need = App.isSplit() && i < n && !s.panes[i];
      if (!need) { if (picker) picker.remove(); continue; }
      if (!picker) {
        picker = document.createElement('div');
        picker.className = 'pane-picker';
        pane.appendChild(picker);
      }
      // 재렌더로 목록을 다시 그려도 치던 검색어·포커스는 살린다 (세션 상태 변화가 잦다)
      const oldSearch = picker.querySelector('.pane-picker-search');
      const prevQuery = oldSearch ? oldSearch.value : '';
      const hadFocus = oldSearch && document.activeElement === oldSearch;
      picker.textContent = '';
      const taken = App.splitVisiblePanes().filter(Boolean);
      const candidates = App.state.sessions.filter((x) => !taken.includes(x.id));
      const emptyProjects = App.state.projects.filter((p) => !App.state.sessions.some((s) => s.projectId === p.id));
      const h = document.createElement('h3');
      h.textContent = candidates.length || emptyProjects.length ? '표시할 세션 선택' : '세션이 없습니다';
      picker.appendChild(h);
      if (candidates.length || emptyProjects.length) {
        // 제목 드롭다운과 같은 방식의 검색창 — 프로젝트 이름이 걸리면 그 프로젝트의 세션도 함께 남는다
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'pane-picker-search';
        search.placeholder = '프로젝트·세션 검색';
        search.spellcheck = false;
        search.autocomplete = 'off';
        picker.appendChild(search);

        const rows = []; // { el, fields }
        const list = document.createElement('div');
        list.className = 'pane-picker-list';
        for (const sess of candidates) {
          const btn = document.createElement('button');
          btn.className = 'pane-pick-item';
          const proj = App.state.projects.find((p) => p.id === sess.projectId);
          const name = document.createElement('span');
          name.className = 'pane-pick-name';
          name.textContent = App.sessionLabel(sess);
          if (proj && proj.color) name.style.color = Theme.adjustText(proj.color);
          btn.dataset.sid = sess.id; // 상태 전이 시 태그만 교체하기 위한 좌표
          btn.appendChild(name);
          btn.appendChild(statusTag(sess.status));
          btn.onclick = ((paneIdx, sid) => () => App.assignPaneSession(paneIdx, sid))(i, sess.id);
          list.appendChild(btn);
          rows.push({ el: btn, fields: [App.sessionLabel(sess), sess.cwd, proj ? proj.name : '', proj ? proj.path : ''] });
        }
        for (const proj of emptyProjects) {
          const btn = document.createElement('button');
          btn.className = 'pane-pick-item';
          const name = document.createElement('span');
          name.className = 'pane-pick-name';
          name.textContent = proj.name;
          if (proj.color) name.style.color = Theme.adjustText(proj.color);
          const tag = document.createElement('span');
          tag.className = 'status-tag idle';
          tag.textContent = '새 세션';
          btn.title = proj.path;
          btn.appendChild(name);
          btn.appendChild(tag);
          btn.onclick = ((paneIdx, projectId) => () => {
            App.createSession(projectId, { paneIdx });
          })(i, proj.id);
          list.appendChild(btn);
          rows.push({ el: btn, fields: [proj.name, proj.path] });
        }
        picker.appendChild(list);

        const noHit = document.createElement('div');
        noHit.className = 'pane-picker-nohit';
        noHit.textContent = '일치하는 프로젝트가 없습니다';
        noHit.hidden = true;
        picker.appendChild(noHit);

        const applyFilter = () => {
          const q = search.value.trim();
          let hits = 0;
          for (const r of rows) {
            const ok = fuzzyMatch(r.fields, q);
            r.el.hidden = !ok;
            if (ok) hits++;
          }
          list.hidden = !!q && hits === 0;
          noHit.hidden = !q || hits > 0;
        };
        search.oninput = applyFilter;
        search.onkeydown = (e) => {
          if (e.key !== 'Enter') return;
          const first = rows.find((r) => !r.el.hidden);
          if (first) { e.preventDefault(); first.el.click(); }
        };
        if (prevQuery) { search.value = prevQuery; applyFilter(); }
        if (hadFocus) {
          search.focus();
          search.setSelectionRange(prevQuery.length, prevQuery.length);
        }
      }
      // '+ 세션 추가' — 프로젝트를 골라 이 패널에 새 세션을 연다 (세션이 있어도 상주)
      const addBtn = document.createElement('button');
      addBtn.className = 'pane-add-session';
      addBtn.textContent = '+ 세션 추가';
      addBtn.title = '프로젝트를 선택해 이 패널에 새 세션을 시작';
      addBtn.onclick = ((paneIdx) => () => App.showSessionAddModal(paneIdx))(i);
      picker.appendChild(addBtn);
    }
  },

  // 상태 전이 시 피커·패널 헤더의 해당 세션 태그만 교체 — 전체 재생성은 진행 중인 클릭을 씹는다
  refreshPickerStatus(s) {
    document.querySelectorAll(
      `.pane-pick-item[data-sid="${s.id}"] .status-tag, .pane-preset-label[data-sid="${s.id}"] .status-tag, .pane-session-item[data-sid="${s.id}"] .status-tag`
    ).forEach((tag) => tag.replaceWith(statusTag(s.status)));
  },

  initSplitUI() {
    document.getElementById('btn-split').onclick = (e) => { e.stopPropagation(); App.toggleSplitMenu(); };
    // 드롭다운 바깥 클릭·Esc 로 닫기
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#split-controls')) App.closeSplitMenu();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        App.closeSplitMenu();
        App.closeSessionSwitchMenus();
      }
    });
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      document.getElementById('term-pane-' + i).addEventListener('mousedown', (e) => {
        // 피커/프리셋 드롭다운 클릭은 assignPaneSession·runPreset 이 포커스까지 처리한다.
        // 여기서 focusPane → renderSplit 을 타면 대상이 재생성돼 mousedown 타깃이 분리되고
        // click 이 발화하지 않아 첫 클릭이 씹힌다. (드롭다운이 아닌 헤더 바 여백은 포커스 이동 허용 —
        // sig 가 같아 바는 재생성되지 않으므로 안전)
        if (e.target.closest('.pane-picker') || e.target.closest('.pane-preset-dd') || e.target.closest('.pane-session-menu') || e.target.closest('.ppl-name')) return;
        App.focusPane(i);
      }, true);
    }
    // 드롭다운 바깥 클릭 = 닫기 (캡처 단계에서 받아 패널 포커스 이동과 순서 무관하게 동작)
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.pane-preset-dd')) App.closePanePresetMenus();
    }, true);
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.pane-session-menu') && !e.target.closest('.ppl-name')) App.closeSessionSwitchMenus();
    }, true);
    // 스플리터 드래그 — QuickFolder 와 같이 컨테이너 rect 기준 비율 계산, 0.2~0.8 클램프
    // 스플리터 드래그 — 컨테이너 rect 기준 비율 계산.
    // 인접 스플리터(와 가장자리)로부터 SPLIT_MIN_TRACK 만큼 떨어지도록 클램프한다.
    const wireDivider = (el, axis, k) => {
      const horizontal = axis === 'col';
      el.onmousedown = (e) => {
        e.preventDefault();
        el.classList.add('active');
        const area = document.getElementById('term-area');
        const gap = App.SPLIT_MIN_TRACK;
        const move = (ev) => {
          const m = splitMode(App.split.mode);
          const count = horizontal ? m.cols : m.rows;
          const pos = (horizontal ? App.split.colPos : App.split.rowPos)[count];
          if (!pos || k >= pos.length) return;
          const rect = area.getBoundingClientRect();
          const ratio = horizontal
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;
          const min = (k === 0 ? 0 : pos[k - 1]) + gap;
          const max = (k === pos.length - 1 ? 1 : pos[k + 1]) - gap;
          pos[k] = Math.max(min, Math.min(max, ratio));
          const tracks = App.splitTracks(pos, count);
          if (horizontal) area.style.gridTemplateColumns = tracks;
          else area.style.gridTemplateRows = tracks;
          TerminalView.fitActive(); // rAF 코얼레싱 + 치수 변경 시에만 리사이즈 IPC
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          el.classList.remove('active');
          App.saveSplitState();
          TerminalView.fitActive();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };
    };
    for (let k = 0; k < 3; k++) wireDivider(document.getElementById('split-divider-v' + k), 'col', k);
    for (let k = 0; k < 2; k++) wireDivider(document.getElementById('split-divider-h' + k), 'row', k);
  }
});
