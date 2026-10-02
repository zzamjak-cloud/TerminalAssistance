// 모바일 원격 웹앱 — 페어링 · 세션 대시보드 · 세션 뷰(xterm) · 입력창 · 특수키 · 프리셋.
// 순수 로직은 remote-core.js / dashboard-core.js 에 있고, 여기는 DOM·네트워크 접착만 한다.

const TERM_FONT = 'Menlo, Consolas, "D2Coding", "Cascadia Mono", monospace';
const PING_TIMEOUT_MS = 4000;

const Remote = {
  state: { projects: [], presets: [], sessions: [] },
  lastChangeAt: new Map(), // sessionId → 상태가 바뀐 시각 (카드의 '마지막 활동' 표기)
  ws: null,
  wsAttempt: 0,
  reconnectTimer: null,
  pingTimer: null,
  stopped: false, // 기기 폐기·미인증 — 재연결하지 않는다
  viewId: null, // 세션 뷰에 띄운 세션
  snapOff: null, // 현재 구독의 스냅샷 끝 오프셋 (null = 스냅샷 대기 중)
  term: null,
  termCols: 0,
  termRows: 0,
  pendingCreate: undefined, // 새 세션 요청한 projectId (생성되면 바로 연다)
  dashTimer: null,

  // ── 부팅 ──
  async boot() {
    Remote.bindViewport();
    Remote.bindUi();
    if ('serviceWorker' in navigator) {
      // 보안 컨텍스트(HTTPS·localhost)가 아니면 등록이 거부된다 — 앱은 그대로 동작한다
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const code = pairCodeFromHash(location.hash);
    let me = null;
    try { me = await Remote.api('GET', '/api/me'); } catch (_) {}
    if (me && !code) { Remote.start(); return; }
    Remote.showPair(code);
  },

  async api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  // ── 페어링 ──
  showPair(code) {
    Remote.show('pair');
    const codeEl = document.getElementById('pair-code');
    const nameEl = document.getElementById('pair-name');
    if (code) codeEl.value = code;
    if (!nameEl.value) nameEl.value = guessDeviceName();
    (code ? nameEl : codeEl).focus();
  },

  async submitPair(ev) {
    ev.preventDefault();
    const btn = document.getElementById('pair-submit');
    const errEl = document.getElementById('pair-error');
    const code = normalizePairCode(document.getElementById('pair-code').value);
    const deviceName = document.getElementById('pair-name').value.trim() || guessDeviceName();
    if (!code) return;
    btn.disabled = true;
    errEl.textContent = '';
    try {
      await Remote.api('POST', '/api/pair', { code, deviceName });
      // 1회용 코드가 주소창·방문 기록에 남지 않게 지운다
      history.replaceState(null, '', location.pathname);
      Remote.stopped = false;
      Remote.start();
    } catch (e) {
      errEl.textContent = e.status === 401 ? '코드가 틀렸거나 만료되었습니다. 데스크톱에서 새 코드를 받으세요.'
        : e.status === 429 ? '시도가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : '연결 실패 — 데스크톱 앱의 원격 서버가 켜져 있는지 확인하세요.';
    } finally {
      btn.disabled = false;
    }
  },

  // ── 시작: 상태 조회 → WS 연결 ──
  async start() {
    Remote.show('dash');
    await Remote.loadState();
    Remote.connect();
    if (!Remote.dashTimer) {
      // '방금 / n분 전' 표기만 갱신 — 화면에 보일 때만
      Remote.dashTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !Remote.viewId) Remote.renderDash();
      }, 30000);
    }
  },

  async loadState() {
    try {
      const st = await Remote.api('GET', '/api/state');
      Remote.state.projects = st.projects || [];
      Remote.state.presets = st.presets || [];
      Remote.setSessions(st.sessions || []);
    } catch (e) {
      if (e.status === 401) { Remote.unauthorized(); return; }
      Remote.toast('상태 조회 실패', true);
    }
  },

  unauthorized() {
    Remote.stopped = true;
    Remote.closeWs();
    Remote.closeView(true);
    Remote.showPair(null);
    document.getElementById('pair-error').textContent = '이 기기의 연결이 해제되었습니다. 다시 페어링하세요.';
  },

  // ── WebSocket ──
  connect() {
    if (Remote.stopped) return;
    clearTimeout(Remote.reconnectTimer);
    Remote.closeWs();
    Remote.setConn('connecting');
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    Remote.ws = ws;
    ws.onopen = () => {
      if (Remote.ws !== ws) return;
      Remote.wsAttempt = 0;
      Remote.setConn('online');
      // 재연결 시 보던 세션을 다시 구독 → 스냅샷으로 끊긴 동안의 출력을 재동기화
      if (Remote.viewId) Remote.subscribe(Remote.viewId);
    };
    ws.onmessage = (ev) => {
      if (Remote.ws !== ws) return;
      const msg = parseServerMessage(ev.data);
      if (msg) Remote.handle(msg);
    };
    ws.onclose = (ev) => {
      if (Remote.ws !== ws) return;
      Remote.ws = null;
      clearTimeout(Remote.pingTimer);
      Remote.setConn('offline');
      if (ev.code === 4001) { Remote.unauthorized(); return; }
      Remote.scheduleReconnect();
    };
  },

  closeWs() {
    const ws = Remote.ws;
    Remote.ws = null;
    clearTimeout(Remote.pingTimer);
    if (ws) { try { ws.close(); } catch (_) {} }
  },

  async scheduleReconnect() {
    if (Remote.stopped) return;
    const delay = reconnectDelay(Remote.wsAttempt++);
    clearTimeout(Remote.reconnectTimer);
    Remote.reconnectTimer = setTimeout(async () => {
      // WS 업그레이드 거부(401)는 close 코드로 구분되지 않는다 — 몇 번 실패하면 인증을 확인한다
      if (Remote.wsAttempt >= 3) {
        try { await Remote.api('GET', '/api/me'); } catch (e) {
          if (e.status === 401) { Remote.unauthorized(); return; }
        }
      }
      Remote.connect();
    }, delay);
  },

  send(msg) {
    const ws = Remote.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  },

  // 백그라운드에서 돌아오면 소켓이 살아 있는 척하는 경우가 있다 (iOS) — ping 으로 확인
  checkAlive() {
    if (!Remote.ws || Remote.ws.readyState !== WebSocket.OPEN) {
      Remote.wsAttempt = 0;
      Remote.connect();
      return;
    }
    clearTimeout(Remote.pingTimer);
    Remote.pingTimer = setTimeout(() => { Remote.wsAttempt = 0; Remote.connect(); }, PING_TIMEOUT_MS);
    Remote.send({ t: 'ping' });
  },

  handle(msg) {
    switch (msg.t) {
      case 'pong':
        clearTimeout(Remote.pingTimer);
        break;
      case 'sessions':
        Remote.setSessions(msg.list || []);
        break;
      case 'status': {
        const s = Remote.findSession(msg.id);
        if (!s) break;
        if (s.status !== msg.status) Remote.lastChangeAt.set(s.id, Date.now());
        s.status = msg.status;
        // 보고 있는 세션이 완료·대기로 바뀌면 이미 본 것으로 처리한다
        if (msg.id === Remote.viewId && document.visibilityState === 'visible') Remote.ackIfNeeded(s);
        Remote.refresh();
        break;
      }
      case 'created': {
        const info = msg.session;
        if (!info || !info.id) break;
        Remote.state.sessions = upsertSession(Remote.state.sessions, info);
        Remote.lastChangeAt.set(info.id, Date.now());
        Remote.refresh();
        if (Remote.pendingCreate !== undefined && (info.projectId || null) === Remote.pendingCreate) {
          Remote.pendingCreate = undefined;
          Remote.openView(info.id);
        }
        break;
      }
      case 'exited': {
        const s = Remote.findSession(msg.id);
        if (s) { s.status = 'exited'; Remote.lastChangeAt.set(s.id, Date.now()); }
        if (msg.id === Remote.viewId && Remote.term) {
          Remote.term.write('\r\n\x1b[31m[세션 종료됨]\x1b[0m\r\n');
        }
        Remote.refresh();
        break;
      }
      case 'snap':
        if (msg.id !== Remote.viewId || !Remote.term) break;
        Remote.term.reset();
        Remote.resizeTerm(msg.cols, msg.rows);
        Remote.snapOff = msg.off;
        if (msg.data) Remote.term.write(msg.data, () => Remote.term && Remote.term.scrollToBottom());
        break;
      case 'data':
        // 스냅샷 전 도착분은 스냅샷에 포함된다 — 버린다
        if (msg.id !== Remote.viewId || !Remote.term || Remote.snapOff === null) break;
        if (!shouldKeepChunk(msg.off, Remote.snapOff)) break;
        Remote.term.write(msg.data);
        break;
      case 'resize':
        if (msg.id === Remote.viewId) Remote.resizeTerm(msg.cols, msg.rows);
        break;
      case 'error':
        Remote.toast(msg.msg || '오류', true);
        break;
    }
  },

  findSession(id) {
    return Remote.state.sessions.find((s) => s.id === id) || null;
  },

  setSessions(list) {
    const now = Date.now();
    for (const s of list) if (!Remote.lastChangeAt.has(s.id)) Remote.lastChangeAt.set(s.id, now);
    Remote.state.sessions = list.slice();
    Remote.refresh();
  },

  refresh() {
    Remote.renderDash();
    if (Remote.viewId) Remote.renderTermHeader();
  },

  setConn(kind) {
    for (const id of ['conn-dash', 'conn-term']) {
      const el = document.getElementById(id);
      el.className = 'conn' + (kind === 'online' ? ' online' : kind === 'connecting' ? ' connecting' : '');
      el.title = kind === 'online' ? '연결됨' : kind === 'connecting' ? '연결 중…' : '연결 끊김 — 재시도 중';
    }
  },

  // ── 대시보드 ──
  renderDash() {
    const list = document.getElementById('dash-list');
    const sessions = Remote.state.sessions;
    const projects = Remote.state.projects;
    document.getElementById('dash-count').textContent = sessions.length ? sessions.length + '개' : '';
    list.textContent = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'dash-empty';
      empty.textContent = '열린 세션이 없습니다. + 새 세션으로 시작하세요.';
      list.appendChild(empty);
      return;
    }
    const ctx = {
      projectIndex: new Map(projects.map((p, i) => [p.id, i])),
      lastChangeAt: Remote.lastChangeAt
    };
    const now = Date.now();
    const groups = sortGroupsForDashboard(groupSessionsByProject(sessions, projects), 'status', ctx);
    for (const g of groups) {
      const box = document.createElement('section');
      box.className = 'dash-group';
      const head = document.createElement('div');
      head.className = 'dash-group-head';
      const swatch = document.createElement('span');
      swatch.className = 'dash-group-swatch';
      if (g.project && g.project.color) swatch.style.background = g.project.color;
      const name = document.createElement('span');
      name.className = 'dash-group-name';
      name.textContent = g.project ? g.project.name : '홈 터미널';
      head.append(swatch, name);
      if (g.project && g.project.parentId && g.project.branch) {
        const br = document.createElement('span');
        br.className = 'dash-group-branch';
        br.textContent = '⎇ ' + g.project.branch;
        head.appendChild(br);
      }
      box.appendChild(head);
      for (const s of sortSessionsForDashboard(g.sessions, 'status', ctx)) {
        box.appendChild(Remote.sessionCard(s, now));
      }
      list.appendChild(box);
    }
  },

  sessionCard(s, now) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'dash-card s-' + s.status;
    const main = document.createElement('div');
    main.className = 'card-main';
    const title = document.createElement('div');
    title.className = 'card-title ellipsis';
    title.textContent = s.title;
    const meta = document.createElement('div');
    meta.className = 'card-meta ellipsis';
    const at = Remote.lastChangeAt.get(s.id);
    meta.textContent = at ? formatSinceChange(now, at) : '';
    main.append(title, meta);
    card.append(main, statusTagEl(s.status));
    card.onclick = () => Remote.openView(s.id);
    return card;
  },

  // ── 새 세션 ──
  showNewSessionSheet() {
    const body = Remote.openSheet('새 세션 — 프로젝트 선택');
    const items = [{ id: null, name: '홈 터미널', path: '', color: '' }].concat(Remote.state.projects);
    for (const p of items) {
      const row = document.createElement('div');
      row.className = 'sheet-item';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      if (p.color) sw.style.background = p.color;
      const main = document.createElement('div');
      main.className = 'item-main';
      const label = document.createElement('div');
      label.className = 'item-label ellipsis';
      label.textContent = p.name;
      main.appendChild(label);
      if (p.path) {
        const sub = document.createElement('div');
        sub.className = 'item-sub';
        sub.textContent = p.path;
        main.appendChild(sub);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = '시작';
      btn.onclick = () => {
        if (!Remote.send({ t: 'create', projectId: p.id })) { Remote.toast('연결이 끊겨 있습니다', true); return; }
        Remote.pendingCreate = p.id;
        Remote.closeSheet();
        Remote.toast('세션 만드는 중…');
      };
      row.append(sw, main, btn);
      body.appendChild(row);
    }
  },

  // ── 세션 뷰 ──
  openView(id) {
    const s = Remote.findSession(id);
    if (!s) return;
    Remote.viewId = id;
    Remote.snapOff = null;
    Remote.show('term');
    Remote.ensureTerm();
    Remote.term.reset();
    Remote.renderTermHeader();
    Remote.subscribe(id);
    Remote.ackIfNeeded(s);
  },

  closeView(silent) {
    if (!Remote.viewId) return;
    Remote.viewId = null;
    Remote.snapOff = null;
    Remote.send({ t: 'unsub' });
    if (!silent) { Remote.show('dash'); Remote.renderDash(); }
  },

  subscribe(id) {
    Remote.snapOff = null;
    Remote.send({ t: 'sub', id });
  },

  ackIfNeeded(s) {
    if (s && (s.status === 'done' || s.status === 'waiting')) Remote.send({ t: 'ack', id: s.id });
  },

  renderTermHeader() {
    const s = Remote.findSession(Remote.viewId);
    const tag = document.getElementById('term-status');
    const title = document.getElementById('term-title');
    if (!s) { tag.className = 'status-tag'; tag.textContent = ''; title.textContent = ''; return; }
    tag.className = 'status-tag s-' + s.status;
    tag.textContent = DASH_STATUS_TEXT[s.status] || s.status;
    const project = Remote.state.projects.find((p) => p.id === s.projectId) || null;
    title.textContent = remoteSessionLabel(s, project);
  },

  ensureTerm() {
    if (Remote.term) return;
    const term = new Terminal({
      cols: 100,
      rows: 30,
      fontFamily: TERM_FONT,
      fontSize: REMOTE_FONT_MAX,
      scrollback: 3000,
      // 폰 키보드가 터미널 탭마다 올라오지 않게 — 입력은 아래 입력창·특수키 바로 한다
      disableStdin: true,
      cursorBlink: false,
      allowProposedApi: false,
      theme: { background: '#0f1116', foreground: '#d5d9e4', cursor: '#d5d9e4' }
    });
    term.open(document.getElementById('term'));
    Remote.term = term;
    Remote.termCols = 100;
    Remote.termRows = 30;
    Remote.fitFont();
  },

  // 폰은 PTY 크기를 바꾸지 않는다 (resize 미전송) — 데스크톱이 정한 크기에 xterm 을 고정한다
  resizeTerm(cols, rows) {
    if (!Remote.term || !(cols > 0) || !(rows > 0)) return;
    if (cols !== Remote.termCols || rows !== Remote.termRows) {
      Remote.term.resize(cols, rows);
      Remote.termCols = cols;
      Remote.termRows = rows;
    }
    Remote.fitFont();
  },

  fitFont() {
    if (!Remote.term) return;
    const wrap = document.getElementById('term-wrap');
    const style = getComputedStyle(wrap);
    const avail = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const fit = fitTerminalFont(avail, Remote.termCols, measureCellRatio());
    if (Remote.term.options.fontSize !== fit.fontSize) Remote.term.options.fontSize = fit.fontSize;
    // xterm 은 셀 폭을 기기 픽셀로 반올림한다 — 캔버스 추정이 모자라 넘치면 반 단계씩 더 줄인다
    let tries = 6;
    const refine = () => {
      const screen = document.querySelector('#term .xterm-screen');
      const size = Remote.term && Remote.term.options.fontSize;
      if (!screen || !size || tries-- <= 0) return;
      if (screen.offsetWidth > avail && size > REMOTE_FONT_MIN) {
        Remote.term.options.fontSize = Math.max(REMOTE_FONT_MIN, size - 0.5);
        requestAnimationFrame(refine);
      }
    };
    requestAnimationFrame(refine);
  },

  // ── 입력 ──
  write(data) {
    if (!Remote.viewId || !data) return;
    if (!Remote.send({ t: 'write', id: Remote.viewId, data })) Remote.toast('연결이 끊겨 있습니다', true);
  },

  submitComposer(ev) {
    if (ev) ev.preventDefault();
    const input = document.getElementById('composer-input');
    const bracketed = !!(Remote.term && Remote.term.modes && Remote.term.modes.bracketedPasteMode);
    const writes = buildPromptWrites(input.value, bracketed);
    if (!writes.length || !Remote.viewId) return;
    const id = Remote.viewId;
    for (const w of writes) {
      if (!w.delayMs) Remote.write(w.data);
      else setTimeout(() => { if (Remote.viewId === id) Remote.write(w.data); }, w.delayMs);
    }
    input.value = '';
    autoGrow(input);
  },

  renderKeybar() {
    const bar = document.getElementById('keybar');
    for (const k of REMOTE_KEY_BAR) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = k.label;
      // pointerdown 기본 동작을 막아 입력창 포커스(=키보드)를 유지한다
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.onclick = () => Remote.write(remoteKeySequence(k.key));
      bar.appendChild(b);
    }
  },

  // ── 프리셋 ──
  showPresetSheet() {
    const s = Remote.findSession(Remote.viewId);
    const body = Remote.openSheet('프리셋');
    const presets = presetsForSession(Remote.state.presets, s);
    if (!presets.length) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = '이 세션에 쓸 수 있는 프리셋이 없습니다.';
      body.appendChild(empty);
      return;
    }
    for (const p of presets) {
      const row = document.createElement('div');
      row.className = 'sheet-item';
      const main = document.createElement('div');
      main.className = 'item-main';
      const label = document.createElement('div');
      label.className = 'item-label ellipsis';
      label.textContent = p.label;
      const sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = p.command;
      main.append(label, sub);
      const fill = document.createElement('button');
      fill.type = 'button';
      fill.textContent = '입력';
      fill.onclick = () => Remote.runPreset(p, false);
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'primary';
      run.textContent = '실행';
      run.onclick = () => Remote.runPreset(p, true);
      row.append(main, fill, run);
      body.appendChild(row);
    }
  },

  async runPreset(preset, execute) {
    const id = Remote.viewId;
    const s = Remote.findSession(id);
    if (!s) return;
    const project = Remote.state.projects.find((p) => p.id === s.projectId) || null;
    Remote.closeSheet();
    const command = await expandRemotePreset(preset.command, {
      session: s, project, branch: project && project.branch ? project.branch : ''
    }, (label) => Promise.resolve(window.prompt(label, '')));
    if (command === null || Remote.viewId !== id) return;
    if (execute) {
      Remote.write(command + '\r');
    } else {
      const input = document.getElementById('composer-input');
      input.value = command;
      autoGrow(input);
      input.focus();
    }
  },

  // ── 시트 · 토스트 · 화면 전환 ──
  openSheet(title) {
    document.getElementById('sheet-title').textContent = title;
    const body = document.getElementById('sheet-body');
    body.textContent = '';
    document.getElementById('sheet-backdrop').classList.remove('hidden');
    return body;
  },

  closeSheet() {
    document.getElementById('sheet-backdrop').classList.add('hidden');
  },

  toast(text, isError) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(Remote._toastTimer);
    Remote._toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
  },

  show(name) {
    for (const n of ['pair', 'dash', 'term']) {
      document.getElementById('screen-' + n).classList.toggle('hidden', n !== name);
    }
    if (name === 'term') requestAnimationFrame(() => Remote.fitFont());
  },

  bindUi() {
    document.getElementById('pair-form').onsubmit = (e) => Remote.submitPair(e);
    document.getElementById('btn-new').onclick = () => Remote.showNewSessionSheet();
    document.getElementById('btn-back').onclick = () => Remote.closeView(false);
    document.getElementById('btn-presets').onclick = () => Remote.showPresetSheet();
    document.getElementById('sheet-close').onclick = () => Remote.closeSheet();
    document.getElementById('sheet-backdrop').onclick = (e) => {
      if (e.target.id === 'sheet-backdrop') Remote.closeSheet();
    };
    document.getElementById('composer').onsubmit = (e) => Remote.submitComposer(e);
    const input = document.getElementById('composer-input');
    input.oninput = () => autoGrow(input);
    Remote.renderKeybar();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Remote.stopped) return;
      if (document.getElementById('screen-pair').classList.contains('hidden')) {
        // 백그라운드 동안 놓친 상태·출력을 다시 맞춘다
        void Remote.loadState();
        if (Remote.ws && Remote.ws.readyState === WebSocket.OPEN && Remote.viewId) Remote.subscribe(Remote.viewId);
        Remote.checkAlive();
      }
    });
    window.addEventListener('online', () => {
      if (!Remote.stopped && !Remote.ws) { Remote.wsAttempt = 0; Remote.connect(); }
    });
    window.addEventListener('hashchange', () => {
      const code = pairCodeFromHash(location.hash);
      if (code) Remote.showPair(code);
    });
  },

  // 키보드가 올라오면 visualViewport 가 줄어든다 — 앱 높이를 거기에 맞춰 입력창이 가려지지 않게 한다
  bindViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const fullHeight = window.innerHeight;
    const apply = () => {
      document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      document.body.classList.toggle('kb-open', vv.height < fullHeight * 0.8);
      // iOS 는 포커스 시 문서를 밀어 올린다 — 고정 레이아웃이므로 되돌린다
      if (window.scrollY) window.scrollTo(0, 0);
      Remote.fitFont();
    };
    vv.addEventListener('resize', apply);
    window.addEventListener('orientationchange', () => setTimeout(apply, 300));
    apply();
  }
};

function statusTagEl(status) {
  const el = document.createElement('span');
  el.className = 'status-tag s-' + status;
  el.textContent = DASH_STATUS_TEXT[status] || status;
  return el;
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

// 글꼴 1px 당 셀 폭 — xterm 내부 측정값에 의존하지 않고 캔버스로 직접 잰다
let cellRatioCache = 0;
function measureCellRatio() {
  if (cellRatioCache) return cellRatioCache;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 0.6;
  ctx.font = '100px ' + TERM_FONT;
  const w = ctx.measureText('W'.repeat(10)).width / 10;
  cellRatioCache = w > 0 ? w / 100 : 0.6;
  return cellRatioCache;
}

function guessDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
  if (android) return android[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return 'Android';
  return '모바일 브라우저';
}

document.addEventListener('DOMContentLoaded', () => { void Remote.boot(); });
