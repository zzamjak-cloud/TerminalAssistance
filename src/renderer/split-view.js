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
      // 이름 인라인 편집 중에는 재생성하지 않는다 — 편집 중이던 입력이 날아가는 것 방지
      if (bar && bar.querySelector('.ppl-rename')) continue;
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
      const sig = [sid, App.sessionLabel(sess), branch, (proj && proj.color) || '', Theme.state.id,
        globals.concat(projs).map((p) => p.id + ':' + p.label + ':' + p.command).join(',')].join('|');
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
      label.appendChild(statusTag(sess.status));
      const nameEl = document.createElement('span');
      nameEl.className = 'ppl-name';
      nameEl.textContent = App.sessionLabel(sess);
      // 더블클릭 = 세션 이름 인라인 변경 — 사이드바를 접어 둔 상태에서도 수정할 수 있다
      nameEl.title = '더블클릭으로 세션 이름 변경';
      nameEl.ondblclick = (e) => { e.stopPropagation(); App.startPaneRename(nameEl, sid); };
      label.appendChild(nameEl);
      if (branch) {
        const brEl = document.createElement('span');
        brEl.className = 'ppl-branch';
        brEl.textContent = '⎇ ' + branch;
        label.appendChild(brEl);
      }
      bar.appendChild(label);

      // ── 프리셋 드롭다운 (전역 + 프로젝트 전용, 우측 정렬) ──
      bar.appendChild(App.buildPanePresetMenu(globals, projs, sid, sess.projectId));
    }
    if (layoutChanged) TerminalView.fitActive(); // 바 유무가 holder 높이를 바꾼다
  },

  // 패널 헤더 제목의 인라인 이름 변경 — 사이드바(startRename)와 같은 규칙:
  // Enter/포커스 이탈 = 확정, Esc = 취소, 빈 값 = 원복. 편집 대상은 세션 제목(title)만.
  startPaneRename(nameEl, sid) {
    const sess = App.state.sessions.find((x) => x.id === sid);
    if (!sess) return;
    const bar = nameEl.closest('.pane-preset-bar');
    if (bar && bar.querySelector('.ppl-rename')) return; // 이미 편집 중
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ppl-rename';
    input.value = sess.title;
    input.maxLength = 40;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    // 편집 중 클릭이 패널 포커스 이동/드래그로 새지 않게
    input.onclick = (ev) => ev.stopPropagation();
    input.onmousedown = (ev) => ev.stopPropagation();
    let done = false; // Enter → blur 이중 확정 방지
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      // 입력 요소를 먼저 제거해야 renderPanePresets 의 '편집 중 재생성 금지' 가드
      // (.ppl-rename 존재 시 스킵)가 풀려 제목 span 으로 복원된다 — 안 지우면 편집 화면에 갇힌다
      input.remove();
      if (commit && title && title !== sess.title) {
        try {
          await ta.renameSession(sid, title);
          sess.title = title;
          renderSidebar();
          App.renderTopbar();
        } catch (err) {
          console.warn('세션 이름 변경 실패:', err);
        }
      }
      if (bar) delete bar.dataset.sig; // 서명을 지워 강제 재생성 (Esc/실패 시 원래 제목으로 복원)
      App.renderPanePresets();
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation(); // 전역 단축키(Cmd+1~9 등)로 새지 않게
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
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
      picker.textContent = '';
      const taken = App.splitVisiblePanes().filter(Boolean);
      const candidates = App.state.sessions.filter((x) => !taken.includes(x.id));
      const h = document.createElement('h3');
      h.textContent = candidates.length ? '표시할 세션 선택' : '세션이 없습니다';
      picker.appendChild(h);
      if (candidates.length) {
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
        }
        picker.appendChild(list);
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
      `.pane-pick-item[data-sid="${s.id}"] .status-tag, .pane-preset-label[data-sid="${s.id}"] .status-tag`
    ).forEach((tag) => tag.replaceWith(statusTag(s.status)));
  },

  initSplitUI() {
    document.getElementById('btn-split').onclick = (e) => { e.stopPropagation(); App.toggleSplitMenu(); };
    // 드롭다운 바깥 클릭·Esc 로 닫기
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#split-controls')) App.closeSplitMenu();
    }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') App.closeSplitMenu(); });
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      document.getElementById('term-pane-' + i).addEventListener('mousedown', (e) => {
        // 피커/프리셋 드롭다운 클릭은 assignPaneSession·runPreset 이 포커스까지 처리한다.
        // 여기서 focusPane → renderSplit 을 타면 대상이 재생성돼 mousedown 타깃이 분리되고
        // click 이 발화하지 않아 첫 클릭이 씹힌다. (드롭다운이 아닌 헤더 바 여백은 포커스 이동 허용 —
        // sig 가 같아 바는 재생성되지 않으므로 안전)
        if (e.target.closest('.pane-picker') || e.target.closest('.pane-preset-dd')) return;
        App.focusPane(i);
      }, true);
    }
    // 드롭다운 바깥 클릭 = 닫기 (캡처 단계에서 받아 패널 포커스 이동과 순서 무관하게 동작)
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.pane-preset-dd')) App.closePanePresetMenus();
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
