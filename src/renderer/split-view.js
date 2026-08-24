// 터미널 분할화면: 단일 / 좌우 / 상하 / 2×2 그리드 뷰.
// 상태는 App.split 이 단독 소유하고, holder 배치·표시는 TerminalView.syncLayout 이 수행한다.
// 분할 후 세션 미배정 패널에는 피커가 떠서 사용자가 직접 세션을 골라 배정한다.
// 각 패널의 동작(프롬프트 입력·프리셋·검색 등)은 분할 전과 동일 — 활성 세션 = 포커스 패널.
const SPLIT_PANE_COUNT = { single: 1, horizontal: 2, vertical: 2, grid: 4 };

Object.assign(App, {
  split: {
    mode: 'single',                  // single | horizontal(좌우) | vertical(상하) | grid(2×2)
    panes: [null, null, null, null], // 패널별 배정 세션 id
    focused: 0,
    colRatio: 0.5,                   // 좌측 열 너비 비율 (0.2~0.8)
    rowRatio: 0.5                    // 상단 행 높이 비율 (0.2~0.8)
  },

  splitPaneCount() { return SPLIT_PANE_COUNT[App.split.mode] || 1; },

  // 현재 모드에서 화면에 보이는 패널들의 세션 배정 (인덱스 = 패널 번호)
  splitVisiblePanes() { return App.split.panes.slice(0, App.splitPaneCount()); },

  saveSplitState() {
    const s = App.split;
    localStorage.setItem('ta-split-mode', s.mode);
    localStorage.setItem('ta-split-col', String(s.colRatio));
    localStorage.setItem('ta-split-row', String(s.rowRatio));
    localStorage.setItem('ta-split-panes', JSON.stringify(s.panes));
    localStorage.setItem('ta-split-focused', String(s.focused));
  },

  // 부팅 시 복원 — 세션 목록(App.state.sessions)이 채워진 뒤에 호출해야 한다
  restoreSplitState() {
    const s = App.split;
    const mode = localStorage.getItem('ta-split-mode');
    if (SPLIT_PANE_COUNT[mode]) s.mode = mode;
    const cr = Number(localStorage.getItem('ta-split-col'));
    const rr = Number(localStorage.getItem('ta-split-row'));
    if (cr >= 0.2 && cr <= 0.8) s.colRatio = cr;
    if (rr >= 0.2 && rr <= 0.8) s.rowRatio = rr;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('ta-split-panes') || '[]'); } catch (_) {}
    // 죽은 세션·중복 배정은 버린다 (해당 패널은 피커로 복원됨)
    const seen = new Set();
    s.panes = [0, 1, 2, 3].map((i) => {
      const id = saved[i];
      if (!id || seen.has(id) || !App.state.sessions.some((x) => x.id === id)) return null;
      seen.add(id);
      return id;
    });
    const f = Number(localStorage.getItem('ta-split-focused'));
    if (Number.isInteger(f) && f >= 0 && f < App.splitPaneCount()) s.focused = f;
  },

  setSplitMode(mode) {
    const s = App.split;
    if (!SPLIT_PANE_COUNT[mode] || s.mode === mode) return;
    // 이전 모드에서 보이던 세션들 (단일 모드는 활성 세션 하나)
    const prevVisible = s.mode === 'single'
      ? (App.state.activeId ? [App.state.activeId] : [])
      : App.splitVisiblePanes().filter(Boolean);
    // 축소 시 세션들의 패널 인덱스가 앞으로 당겨지므로, 포커스는 세션 id 기준으로 재계산한다
    const prevFocusedId = s.mode === 'single' ? App.state.activeId : s.panes[s.focused];
    s.mode = mode;
    const n = App.splitPaneCount();
    if (mode === 'single') {
      // 포커스 패널의 세션을 단일 화면으로 유지 (없으면 배정된 첫 세션)
      const keep = s.panes[s.focused] || prevVisible[0] || App.state.activeId || null;
      s.panes = [keep, null, null, null];
      s.focused = 0;
      App.saveSplitState();
      if (keep) { App.activateSession(keep); return; } // renderAll → renderSplit 포함
    } else {
      // 확장은 기존 배정 유지, 축소는 앞쪽 패널로 압축
      const next = [null, null, null, null];
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

  // 패널 클릭(캡처) = 포커스 이동. 터미널 클릭·선택을 방해하지 않게 프롬프트 포커스는 뺏지 않는다.
  focusPane(paneIdx) {
    const s = App.split;
    if (s.mode === 'single' || paneIdx >= App.splitPaneCount() || s.focused === paneIdx) return;
    s.focused = paneIdx;
    App.saveSplitState();
    const id = s.panes[paneIdx];
    if (id) App.activateSession(id, { noFocus: true });
    else App.renderSplit();
  },

  // 화면 좌표 아래 패널에 배정된 세션 id (단일 모드·패널 밖·미배정이면 null) — 드롭 대상 판별용
  sessionAtPoint(x, y) {
    if (App.split.mode === 'single') return null;
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
  renderSplit() {
    const s = App.split;
    const area = document.getElementById('term-area');
    area.classList.toggle('split-h', s.mode === 'horizontal');
    area.classList.toggle('split-v', s.mode === 'vertical');
    area.classList.toggle('split-grid', s.mode === 'grid');
    area.style.setProperty('--split-col', (s.colRatio * 100).toFixed(2) + '%');
    area.style.setProperty('--split-row', (s.rowRatio * 100).toFixed(2) + '%');
    for (let i = 0; i < 4; i++) {
      // 포커스 링은 세션이 배정된 패널에만 — 빈 패널은 프롬프트 대상이 아니므로 오해를 막는다
      document.getElementById('term-pane-' + i)
        .classList.toggle('focused', s.mode !== 'single' && s.focused === i && !!s.panes[i]);
    }
    const btns = { single: 'btn-split-single', horizontal: 'btn-split-h', vertical: 'btn-split-v', grid: 'btn-split-grid' };
    for (const [m, bid] of Object.entries(btns)) {
      document.getElementById(bid).classList.toggle('active', s.mode === m);
    }
    App.renderPanePickers();
    App.renderPanePresets();
  },

  // 패널별 프리셋 바: 전역 + 그 패널 세션 프로젝트의 프리셋 칩 (분할 중에만).
  // 클릭 대상은 해당 패널 세션 — 상단 고정바 칩과 동작 규칙(클릭/Shift/우클릭)은 동일.
  renderPanePresets() {
    const s = App.split;
    const n = App.splitPaneCount();
    let layoutChanged = false;
    for (let i = 0; i < 4; i++) {
      const pane = document.getElementById('term-pane-' + i);
      let bar = pane.querySelector('.pane-preset-bar');
      const sid = s.mode !== 'single' && i < n ? s.panes[i] : null;
      const sess = sid && App.state.sessions.find((x) => x.id === sid);
      let chips = [];
      if (sess) {
        const globals = App.state.presets.filter((p) => !p.projectId);
        const projs = App.state.presets.filter((p) => p.projectId && p.projectId === sess.projectId);
        chips = [...globals.map((p) => [p, true]), ...projs.map((p) => [p, false])];
      }
      if (!chips.length) {
        if (bar) { bar.remove(); layoutChanged = true; }
        if (pane.classList.contains('with-presets')) { pane.classList.remove('with-presets'); layoutChanged = true; }
        continue;
      }
      // 내용이 같으면 재생성하지 않는다 — mousedown~click 사이 재렌더는 클릭을 씹는다.
      // 그룹 플래그(g/p)도 포함해 전역↔프로젝트 전환 시 .global 스타일이 stale 로 남지 않게 한다.
      const sig = sid + '|' + chips.map(([p, g]) => p.id + ':' + p.label + ':' + p.command + ':' + (g ? 'g' : 'p')).join(',');
      if (bar && bar.dataset.sig === sig) continue;
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'pane-preset-bar';
        pane.appendChild(bar);
        // 상단 고정바와 같은 규칙의 드래그 정렬 (전역↔프로젝트 그룹 간 이동 금지).
        // 바가 재생성될 때마다 새 엘리먼트에 다시 배선된다.
        makeSortable({
          container: bar,
          itemSelector: '.preset-chip[data-id]',
          axis: 'x',
          canDrop: (srcEl, dstEl) => srcEl.classList.contains('global') === dstEl.classList.contains('global'),
          onDrop: (srcId, dstId, before) => App.movePreset(srcId, dstId, before)
        });
      }
      if (!pane.classList.contains('with-presets')) { pane.classList.add('with-presets'); layoutChanged = true; }
      bar.dataset.sig = sig;
      bar.textContent = '';
      for (const [p, isGlobal] of chips) {
        const el = document.createElement('button');
        el.className = 'preset-chip mini' + (isGlobal ? ' global' : '');
        el.dataset.id = p.id; // 드래그 정렬 좌표
        el.title = p.command + '\n(클릭=즉시 실행, Shift+클릭=입력만, 우클릭=수정)';
        el.textContent = p.label;
        el.onclick = ((preset, targetSid) => (e) => App.runPreset(preset, !e.shiftKey, targetSid))(p, sid);
        el.oncontextmenu = ((preset) => (e) => { e.preventDefault(); App.showPresetModal(preset); })(p);
        bar.appendChild(el);
      }
    }
    if (layoutChanged) TerminalView.fitActive(); // 바 유무가 holder 높이를 바꾼다
  },

  // 세션 미배정 패널의 세션 선택 피커 (다른 패널에 이미 표시 중인 세션은 제외)
  renderPanePickers() {
    const s = App.split;
    const n = App.splitPaneCount();
    for (let i = 0; i < 4; i++) {
      const pane = document.getElementById('term-pane-' + i);
      let picker = pane.querySelector('.pane-picker');
      const need = s.mode !== 'single' && i < n && !s.panes[i];
      if (!need) { if (picker) picker.remove(); continue; }
      if (!picker) {
        picker = document.createElement('div');
        picker.className = 'pane-picker';
        pane.appendChild(picker);
      }
      picker.textContent = '';
      const h = document.createElement('h3');
      h.textContent = '표시할 세션 선택';
      picker.appendChild(h);
      const taken = App.splitVisiblePanes().filter(Boolean);
      const candidates = App.state.sessions.filter((x) => !taken.includes(x.id));
      if (!candidates.length) {
        const p = document.createElement('p');
        p.textContent = '선택할 수 있는 세션이 없습니다.\n사이드바에서 새 세션을 시작하세요.';
        picker.appendChild(p);
        continue;
      }
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
  },

  // 상태 전이 시 피커의 해당 세션 태그만 교체 — 피커 전체 재생성은 진행 중인 클릭을 씹는다
  refreshPickerStatus(s) {
    document.querySelectorAll(`.pane-pick-item[data-sid="${s.id}"] .status-tag`)
      .forEach((tag) => tag.replaceWith(statusTag(s.status)));
  },

  initSplitUI() {
    document.getElementById('btn-split-single').onclick = () => App.setSplitMode('single');
    document.getElementById('btn-split-h').onclick = () => App.setSplitMode('horizontal');
    document.getElementById('btn-split-v').onclick = () => App.setSplitMode('vertical');
    document.getElementById('btn-split-grid').onclick = () => App.setSplitMode('grid');
    for (let i = 0; i < 4; i++) {
      document.getElementById('term-pane-' + i).addEventListener('mousedown', (e) => {
        // 피커/프리셋 칩 클릭은 assignPaneSession·runPreset 이 포커스까지 처리한다.
        // 여기서 focusPane → renderSplit 을 타면 대상이 재생성돼 mousedown 타깃이 분리되고
        // click 이 발화하지 않아 첫 클릭이 씹힌다. (칩이 아닌 프리셋 바 여백은 포커스 이동 허용 —
        // sig 가 같아 바는 재생성되지 않으므로 안전)
        if (e.target.closest('.pane-picker') || e.target.closest('.preset-chip')) return;
        App.focusPane(i);
      }, true);
    }
    // 스플리터 드래그 — QuickFolder 와 같이 컨테이너 rect 기준 비율 계산, 0.2~0.8 클램프
    const wireDivider = (el, key, clientProp, sizeProp, rectStart) => {
      el.onmousedown = (e) => {
        e.preventDefault();
        el.classList.add('active');
        const area = document.getElementById('term-area');
        const cssVar = key === 'colRatio' ? '--split-col' : '--split-row';
        const move = (ev) => {
          const rect = area.getBoundingClientRect();
          const ratio = (ev[clientProp] - rect[rectStart]) / rect[sizeProp];
          App.split[key] = Math.max(0.2, Math.min(0.8, ratio));
          area.style.setProperty(cssVar, (App.split[key] * 100).toFixed(2) + '%');
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
    wireDivider(document.getElementById('split-divider-v'), 'colRatio', 'clientX', 'width', 'left');
    wireDivider(document.getElementById('split-divider-h'), 'rowRatio', 'clientY', 'height', 'top');
  }
});
