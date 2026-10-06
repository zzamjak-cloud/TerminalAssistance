// 모바일 원격 웹앱 — 페어링 · 세션 대시보드 · 세션 뷰(xterm) · 입력창 · 특수키 · 프리셋.
// 순수 로직은 remote-core.js / dashboard-core.js 에 있고, 여기는 DOM·네트워크 접착만 한다.

const TERM_FONT = 'Menlo, Consolas, "D2Coding", "Cascadia Mono", monospace';
const PING_TIMEOUT_MS = 4000;
const ME_TIMEOUT_MS = 6000;

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
  pendingCreate: null, // { reqId, timer } — 내가 요청한 새 세션 (createResult 로 오면 바로 연다)
  termGen: 0, // 터미널을 비울 때마다 증가 — 그 전에 건 write 콜백을 무시한다
  deviceId: null, // 이 기기 id (/api/me·/api/pair) — 제어권 보유 판정용
  controls: new Map(), // sessionId → { holder, deviceName, cols, rows }
  controlTimer: null,
  controlWanted: null, // 이 탭이 직접 가져온 세션 (탭 로컬 — 같은 기기의 다른 탭과 구분)
  controlPending: null, // { id, timer } — control 요청 후 응답 대기
  controlReleasing: null, // { id, timer } — release 후 응답 대기
  uploading: false,
  dashTimer: null,
  pendingSession: null, // 알림 링크(#session=)로 열 세션
  stateLoaded: false, // 세션 목록을 한 번이라도 받았는가 (#session 열기 조건)
  entering: false,
  offlineAttempt: 0,
  offlineTimer: null,

  // ── 부팅 ──
  async boot() {
    Remote.bindViewport();
    Remote.bindUi();
    if ('serviceWorker' in navigator) {
      // 보안 컨텍스트(HTTPS·localhost)가 아니면 등록이 거부된다 — 앱은 그대로 동작한다
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    Remote.pendingSession = sessionFromHash(location.hash);
    await Remote.enter();
    if (window.__taBootDone) window.__taBootDone();
  },

  // /api/me 로 상태를 보고 첫 화면을 고른다 — 오프라인 화면의 재시도도 이 경로
  async enter() {
    // 자동 재시도와 버튼이 겹쳐 /api/me 를 동시에 여러 번 부르지 않게
    if (Remote.entering) return;
    Remote.entering = true;
    try { await Remote.enterOnce(); } finally { Remote.entering = false; }
  },

  async enterOnce() {
    const code = pairCodeFromHash(location.hash);
    let me = null;
    let netFail = false;
    try { me = await Remote.api('GET', '/api/me', null, ME_TIMEOUT_MS); } catch (e) {
      if (e.moved) return; // 이동 안내 화면을 이미 띄웠다
      netFail = !e.status;
    }
    if (me) Remote.deviceId = me.deviceId || null;
    const route = bootRoute(me, netFail, code);
    // 셸은 캐시에서 떴지만 서버에 닿지 않는 경우 — 대개 폰의 Tailscale 이 꺼져 있다
    if (route === 'offline') { Remote.showOffline(); return; }
    Remote.offlineAttempt = 0;
    clearTimeout(Remote.offlineTimer);
    if (route === 'start') { void Remote.start(); return; }
    Remote.showPair(code);
  },

  showMoved(url) {
    Remote.stopped = true; // 옛 주소로 재연결을 계속하지 않는다
    Remote.closeWs();
    clearTimeout(Remote.offlineTimer);
    Remote.show('moved');
    document.getElementById('moved-url').textContent = url;
    document.getElementById('moved-go').onclick = () => { location.href = url; };
  },

  showOffline() {
    Remote.show('offline');
    clearTimeout(Remote.offlineTimer);
    const delay = offlineRetryDelay(Remote.offlineAttempt++);
    const el = document.getElementById('offline-retry-note');
    let left = Math.round(delay / 1000);
    const tick = () => {
      el.textContent = left > 0 ? left + '초 후 자동으로 다시 시도합니다' : '다시 시도하는 중…';
      if (left-- <= 0) { void Remote.enter(); return; }
      Remote.offlineTimer = setTimeout(tick, 1000);
    };
    tick();
  },

  // 알림(#session=)으로 들어왔으면 그 세션을 바로 연다 — 목록에 없으면(닫힘) 대시보드에 머문다
  // 세션 목록을 받은 뒤에만 연다 — 아직이면 pending 으로 두고 start() 가 다시 부른다
  openPendingSession() {
    const id = Remote.pendingSession;
    if (!id || !Remote.stateLoaded) return;
    Remote.pendingSession = null;
    history.replaceState(null, '', location.pathname + location.search + stripSessionHash(location.hash));
    if (Remote.findSession(id)) Remote.openView(id);
    else Remote.toast('세션이 이미 닫혔습니다', true);
  },

  standalone() {
    const mq = window.matchMedia ? window.matchMedia('(display-mode: standalone)').matches : false;
    return isStandaloneMode(navigator.standalone, mq);
  },

  // timeoutMs: VPN 이 꺼져 있으면 연결이 오래 매달리므로 부팅 확인은 짧게 끊는다
  async api(method, path, body, timeoutMs) {
    const ctl = timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      // HTTPS 전환 후 옛 http 주소 — 서버가 410 {moved} 로 새 주소를 알려 준다
      if (res.status === 410) {
        let body = null;
        try { body = await res.json(); } catch (_) {}
        err.moved = movedTarget(res.status, body);
        if (err.moved) Remote.showMoved(err.moved);
      }
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
    // 홈 화면 앱에서는 QR 을 찍을 수 없으니 코드 입력만 크게 — 기기 이름은 자동으로 채운다
    const simple = Remote.standalone() && !code;
    document.getElementById('screen-pair').classList.toggle('pair-simple', simple);
    document.getElementById('pair-help').textContent = simple
      ? '데스크톱 앱 상단의 📱 버튼에 표시된 8자 코드를 입력하세요.'
      : '데스크톱 앱 상단의 📱 버튼을 누르고, 표시된 QR 을 찍거나 8자 코드를 입력하세요.';
    document.getElementById('pair-net-hint').classList.add('hidden');
    if (code) codeEl.value = code;
    if (!nameEl.value) nameEl.value = guessDeviceName();
    (code ? nameEl : codeEl).focus();
  },

  showPairNetError(text) {
    document.getElementById('pair-error').textContent = text;
    document.getElementById('pair-net-hint').classList.remove('hidden');
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
      const paired = await Remote.api('POST', '/api/pair', { code, deviceName });
      Remote.deviceId = (paired && paired.deviceId) || null;
      // 1회용 코드가 주소창·방문 기록에 남지 않게 지운다
      history.replaceState(null, '', location.pathname);
      Remote.stopped = false;
      Remote.start();
      Remote.maybeShowInstallSheet();
    } catch (e) {
      if (e.status === 401 || e.status === 429) {
        errEl.textContent = e.status === 401 ? '코드가 틀렸거나 만료되었습니다. 데스크톱에서 새 코드를 받으세요.'
          : '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
      } else {
        Remote.showPairNetError('연결 실패 — 데스크톱 앱이 켜져 있는지 확인하세요.');
      }
    } finally {
      btn.disabled = false;
    }
  },

  // ── 홈 화면에 추가 안내 ──
  maybeShowInstallSheet() {
    let dismissed = false;
    try { dismissed = localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch (_) {}
    const platform = installPlatform(navigator.userAgent, navigator.maxTouchPoints);
    const showInstall = shouldShowInstallSheet(Remote.standalone(), dismissed);
    const showVpn = shouldShowVpnTips(platform, dismissed);
    if (!showInstall && !showVpn) return;
    const body = Remote.openSheet(showInstall ? '홈 화면에 추가' : '끊김 없이 쓰려면');
    const p = (text, cls) => {
      const el = document.createElement('p');
      el.className = cls || 'install-text';
      el.textContent = text;
      body.appendChild(el);
      return el;
    };
    if (showInstall) {
      p('홈 화면에 추가하면 앱처럼 전체 화면으로 열리고, 다음부터 아이콘 한 번으로 접속합니다.');
      if (platform === 'ios') {
        const steps = document.createElement('ol');
        steps.className = 'install-steps';
        const step = (html) => { const li = document.createElement('li'); li.innerHTML = html; steps.appendChild(li); };
        // 정적 문구만 innerHTML 로 — 사용자 값은 섞지 않는다
        step('Safari 의 <b>공유</b> 버튼 <span class="share-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3v12M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 11v9h14v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span> 을 누릅니다 (아이폰은 화면 아래, 아이패드는 위).');
        step('목록을 내려 <b>홈 화면에 추가</b> <span class="add-ico" aria-hidden="true">＋</span> 를 고릅니다.');
        step('오른쪽 위 <b>추가</b> 를 누르면 끝.');
        body.appendChild(steps);
      } else if (platform === 'android' && window.__taInstallPrompt) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'primary install-btn';
        btn.textContent = '앱 설치';
        btn.onclick = async () => {
          const ev = window.__taInstallPrompt;
          window.__taInstallPrompt = null; // prompt() 는 이벤트당 한 번만 쓸 수 있다
          Remote.closeSheet();
          if (!ev) return;
          try { await ev.prompt(); } catch (_) {}
        };
        body.appendChild(btn);
      } else if (platform === 'android') {
        p('크롬 오른쪽 위 메뉴(⋮) → \'홈 화면에 추가\' 또는 \'앱 설치\' 를 누르세요.');
      } else {
        p('브라우저 메뉴에서 \'홈 화면에 추가\' 를 선택하세요.');
      }
    }
    if (showVpn) Remote.renderVpnTips(body, platform);
    const actions = document.createElement('div');
    actions.className = 'install-actions';
    const never = document.createElement('button');
    never.type = 'button';
    never.textContent = '다시 보지 않기';
    never.onclick = () => {
      try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch (_) {}
      Remote.closeSheet();
    };
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    close.onclick = () => Remote.closeSheet();
    actions.append(never, close);
    body.appendChild(actions);
  },

  // 폰이 VPN 을 놓치면 PC 에 닿지 않는다 — 기기별 설정 경로를 단계로 보여 준다 (정적 문구만)
  renderVpnTips(body, platform) {
    const head = document.createElement('p');
    head.className = 'install-text vpn-head';
    head.textContent = '끊김 없이 쓰려면 Tailscale 이 항상 켜져 있게 하세요.';
    body.appendChild(head);
    for (const group of vpnTipSteps(platform)) {
      const title = document.createElement('div');
      title.className = 'vpn-title';
      title.textContent = group.title;
      const ol = document.createElement('ol');
      ol.className = 'vpn-steps';
      for (const st of group.steps) {
        const li = document.createElement('li');
        const ico = document.createElement('span');
        ico.className = 'vpn-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = st.icon;
        const t = document.createElement('span');
        t.textContent = st.text;
        li.append(ico, t);
        ol.appendChild(li);
      }
      body.append(title, ol);
    }
  },

  // ── 시작: 상태 조회 → WS 연결 ──
  async start() {
    Remote.show('dash');
    await Remote.loadState();
    Remote.connect();
    Remote.openPendingSession();
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
      Remote.stateLoaded = true;
    } catch (e) {
      if (e.moved) return;
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
      // 연결이 끊기면 서버가 보유를 자동 반환한다 — 이 탭이 쥐고 있던 것이면 새 연결로 다시 가져온다
      if (Remote.wantsControl()) Remote.requestControl();
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
        break;
      }
      case 'createResult': {
        if (!isReplyTo(Remote.pendingCreate, msg)) break;
        Remote.clearPendingCreate();
        const info = msg.session;
        if (!info || !info.id) break;
        Remote.state.sessions = upsertSession(Remote.state.sessions, info);
        Remote.lastChangeAt.set(info.id, Date.now());
        Remote.refresh();
        Remote.openView(info.id);
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
      case 'snap': {
        if (msg.id !== Remote.viewId || !Remote.term) break;
        Remote.resizeTerm(msg.cols, msg.rows);
        Remote.snapOff = msg.off;
        if ('controlHolder' in msg) Remote.noteControlHolder(msg.id, msg.controlHolder);
        const gen = ++Remote.termGen;
        Remote.term.write(SNAP_RESET + (msg.data || '') + snapModeSuffix(msg), () => {
          if (Remote.term && Remote.termGen === gen) Remote.term.scrollToBottom();
        });
        break;
      }
      case 'data':
        // 스냅샷 전 도착분은 스냅샷에 포함된다 — 버린다
        if (msg.id !== Remote.viewId || !Remote.term || Remote.snapOff === null) break;
        if (!shouldKeepChunk(msg.off, Remote.snapOff)) break;
        Remote.term.write(msg.data);
        break;
      case 'resize':
        if (msg.id === Remote.viewId) Remote.resizeTerm(msg.cols, msg.rows);
        break;
      case 'control':
        Remote.applyControl(msg);
        break;
      case 'error':
        if (isReplyTo(Remote.pendingCreate, msg)) Remote.clearPendingCreate();
        else if (Remote.controlPending) Remote.failControlRequest();
        Remote.toast(msg.msg || '오류', true);
        break;
    }
  },

  findSession(id) {
    return Remote.state.sessions.find((s) => s.id === id) || null;
  },

  setSessions(list) {
    const now = Date.now();
    for (const s of list) {
      if ('controlHolder' in s) {
        Remote.noteControlHolder(s.id, s.controlHolder, { deviceName: s.controlDeviceName, cols: s.cols, rows: s.rows });
      }
    }
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
        const reqId = newReqId();
        if (!Remote.send({ t: 'create', projectId: p.id, reqId })) { Remote.toast('연결이 끊겨 있습니다', true); return; }
        Remote.clearPendingCreate();
        Remote.pendingCreate = {
          reqId,
          timer: setTimeout(() => {
            if (!Remote.pendingCreate || Remote.pendingCreate.reqId !== reqId) return;
            Remote.pendingCreate = null;
            Remote.toast('세션 생성 응답이 없습니다', true);
          }, CREATE_TIMEOUT_MS)
        };
        Remote.closeSheet();
        Remote.toast('세션 만드는 중…');
      };
      row.append(sw, main, btn);
      body.appendChild(row);
    }
  },

  clearPendingCreate() {
    if (Remote.pendingCreate) clearTimeout(Remote.pendingCreate.timer);
    Remote.pendingCreate = null;
  },

  // ── 세션 뷰 ──
  openView(id) {
    const s = Remote.findSession(id);
    if (!s) return;
    Remote.viewId = id;
    Remote.snapOff = null;
    Remote.show('term');
    Remote.ensureTerm();
    Remote.termGen++;
    Remote.term.write(SNAP_RESET);
    Remote.renderTermHeader();
    Remote.renderControlButton();
    Remote.subscribe(id);
    Remote.ackIfNeeded(s);
  },

  closeView(silent) {
    // 목록으로 돌아간 뒤 늦게 온 생성 응답이 화면을 다시 끌고 가지 않게 한다
    Remote.clearPendingCreate();
    if (!Remote.viewId) return;
    // 폰 크기로 묶인 PTY 를 두고 떠나면 데스크톱이 좁은 화면을 떠안는다 — 나가면서 돌려준다
    if (Remote.isHolding()) Remote.send({ t: 'release', id: Remote.viewId });
    clearTimeout(Remote.controlTimer);
    Remote.controlWanted = null;
    Remote.clearControlPending();
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

  // ── 제어권 ──
  isHolding(id) {
    return holdsControl(Remote.controls.get(id || Remote.viewId), Remote.deviceId);
  },

  // sessions 에는 보유자·이름·크기가, snap 에는 보유자만 온다 — 빠진 값은 이전 것을 쓴다
  noteControlHolder(id, holder, extra) {
    const prev = Remote.controls.get(id) || {};
    const e = extra || {};
    const next = {
      id,
      holder: holder || null,
      deviceName: holder ? (e.deviceName || prev.deviceName || null) : null,
      cols: e.cols || prev.cols,
      rows: e.rows || prev.rows
    };
    if ((prev.holder || null) === next.holder && prev.deviceName === next.deviceName
      && prev.cols === next.cols && prev.rows === next.rows) return;
    Remote.applyControl(next);
  },

  applyControl(msg) {
    const prev = Remote.controls.get(msg.id) || null;
    const next = { holder: msg.holder || null, deviceName: msg.deviceName || null, cols: msg.cols, rows: msg.rows };
    Remote.controls.set(msg.id, next);
    const mine = holdsControl(next, Remote.deviceId);
    const pending = Remote.controlPending && Remote.controlPending.id === msg.id;
    const releasing = Remote.controlReleasing && Remote.controlReleasing.id === msg.id;
    if (mine && pending) Remote.clearControlPending();
    if (!mine && next.holder) {
      // 다른 기기가 가져갔다 — 이 탭의 재보유 의사도 접는다 (서로 빼앗는 핑퐁 방지)
      if (Remote.controlWanted === msg.id) Remote.controlWanted = null;
      if (pending) Remote.clearControlPending();
    }
    if (!next.holder && releasing) Remote.clearControlReleasing();
    if (msg.id !== Remote.viewId) return;
    const lost = controlLostText(prev, next, Remote.deviceId);
    // 내가 반환했거나, 재연결로 서버가 자동 반환한 직후 다시 가져오는 중이면 알리지 않는다
    if (lost && !releasing && !(pending && !next.holder)) Remote.toast(lost);
    Remote.renderControlButton();
    Remote.fitFont();
  },

  renderControlButton() {
    const btn = document.getElementById('btn-control');
    const holding = Remote.isHolding();
    btn.textContent = holding ? '최적 해제' : '최적보기';
    btn.classList.toggle('holding', holding);
  },

  toggleControl() {
    const id = Remote.viewId;
    if (!id) return;
    if (Remote.isHolding()) {
      Remote.controlWanted = null;
      Remote.clearControlPending();
      Remote.clearControlReleasing();
      // 응답(holder:null)이 오지 않아도 표시가 영구히 막히지 않게 시간 제한을 둔다
      Remote.controlReleasing = {
        id, timer: setTimeout(() => Remote.clearControlReleasing(), CONTROL_REPLY_TIMEOUT_MS)
      };
      Remote.send({ t: 'release', id });
      return;
    }
    Remote.controlWanted = id;
    Remote.requestControl();
  },

  clearControlPending() {
    if (Remote.controlPending) clearTimeout(Remote.controlPending.timer);
    Remote.controlPending = null;
  },

  clearControlReleasing() {
    if (Remote.controlReleasing) clearTimeout(Remote.controlReleasing.timer);
    Remote.controlReleasing = null;
  },

  // 요청이 거절(error)되거나 답이 없으면 제어용 글꼴을 거두고 화면 맞춤으로 돌아간다
  failControlRequest() {
    if (!Remote.controlPending) return;
    const id = Remote.controlPending.id;
    Remote.clearControlPending();
    if (Remote.controlWanted === id && !Remote.isHolding(id)) Remote.controlWanted = null;
    Remote.fitFont();
  },

  // 가독 글꼴로 셀 크기를 실측한 뒤 화면에 들어가는 cols/rows 를 요청한다
  requestControl() {
    if (!Remote.term || !Remote.viewId) return;
    const id = Remote.viewId;
    // 대기 표시는 즉시 — 재연결 직후 먼저 도착하는 '보유자 없음' 목록을 반환 알림으로 오인하지 않게
    Remote.clearControlPending();
    Remote.controlPending = {
      id, timer: setTimeout(() => Remote.failControlRequest(), CONTROL_REPLY_TIMEOUT_MS)
    };
    Remote.term.options.fontSize = CONTROL_FONT_SIZE;
    requestAnimationFrame(() => {
      if (Remote.viewId !== id || !Remote.term) { Remote.failControlRequest(); return; }
      const screen = document.querySelector('#term .xterm-screen');
      const wrap = document.getElementById('term-wrap');
      if (!screen || !wrap) { Remote.failControlRequest(); return; }
      const style = getComputedStyle(wrap);
      const availW = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availH = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const size = controlSize(availW, availH, screen.offsetWidth / Remote.term.cols, screen.offsetHeight / Remote.term.rows);
      if (!Remote.send({ t: 'control', id, cols: size.cols, rows: size.rows })) {
        Remote.toast('연결이 끊겨 있습니다', true);
        Remote.failControlRequest();
      }
    });
  },

  // 회전·키보드로 화면이 바뀌면 보유 중인 크기를 다시 맞춘다 (연속 변화는 한 번으로).
  // 이 탭이 직접 가져온 경우에만 — 같은 기기의 다른 탭이 서로 크기를 빼앗지 않게
  scheduleControlResend() {
    if (!Remote.wantsControl()) return;
    clearTimeout(Remote.controlTimer);
    Remote.controlTimer = setTimeout(() => { if (Remote.wantsControl()) Remote.requestControl(); }, 400);
  },

  wantsControl() {
    return !!Remote.viewId && Remote.controlWanted === Remote.viewId && Remote.isHolding();
  },

  // ── 이미지 첨부 ──
  async attachImage(file) {
    const id = Remote.viewId;
    if (!file || !id || Remote.uploading) return;
    Remote.uploading = true;
    Remote.setUpload('이미지 준비 중…', 0);
    try {
      const blob = await prepareImage(file);
      const res = await uploadImage(id, blob, (ratio) => Remote.setUpload('이미지 올리는 중 ' + Math.round(ratio * 100) + '%', ratio));
      const input = document.getElementById('composer-input');
      const next = insertAtCaret(input.value, input.selectionStart, input.selectionEnd, quoteRemotePath(res.path) + ' ');
      input.value = next.value;
      input.selectionStart = input.selectionEnd = next.caret;
      autoGrow(input);
      Remote.setUpload(null);
    } catch (e) {
      Remote.setUpload(uploadErrorText(e), null, true);
      setTimeout(() => Remote.setUpload(null), 4000);
    } finally {
      Remote.uploading = false;
    }
  },

  setUpload(text, ratio, isError) {
    const box = document.getElementById('upload-status');
    if (text === null) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.classList.toggle('error', !!isError);
    document.getElementById('upload-text').textContent = text;
    document.getElementById('upload-fill').style.width = Math.round((ratio || 0) * 100) + '%';
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
    // 터미널을 탭하면 xterm 숨은 textarea 가 포커스를 받아 키보드가 올라온다 — 막는다
    if (term.textarea) {
      term.textarea.setAttribute('inputmode', 'none');
      term.textarea.readOnly = true;
      term.textarea.tabIndex = -1;
    }
    Remote.term = term;
    Remote.termCols = 100;
    Remote.termRows = 30;
    Remote.bindTermZoom();
    Remote.fitFont();
  },

  // 저장된 확대 배율 — 처음 한 번만 읽는다
  termZoom: null,
  getTermZoom() {
    if (Remote.termZoom === null) {
      let raw = null;
      try { raw = localStorage.getItem(TERM_ZOOM_KEY); } catch (_) {}
      Remote.termZoom = parseStoredZoom(raw);
    }
    return Remote.termZoom;
  },

  // 배율을 바꾸고 글꼴에 반영한다. persist 가 true 면 저장하고 크기를 토스트로 알린다
  setTermZoom(zoom, persist) {
    const z = clampZoom(zoom);
    const changed = z !== Remote.termZoom;
    Remote.termZoom = z;
    if (changed) Remote.fitFont();
    if (persist) {
      try { localStorage.setItem(TERM_ZOOM_KEY, String(z)); } catch (_) {}
      if (Remote.term) Remote.toast(z === TERM_ZOOM_MIN ? '글꼴 화면 맞춤' : '글꼴 ' + Remote.term.options.fontSize + 'px');
    }
  },

  // 현재 화면이 대체 버퍼(전체 화면 TUI)인가
  inAltBuffer() {
    try { return !!(Remote.term && Remote.term.buffer.active.type === 'alternate'); } catch (_) { return false; }
  },

  // 스와이프를 xterm 의 휠 처리에 태운다 — xterm 이 TUI 의 마우스 트래킹 여부에 따라 마우스
  // 리포트 또는 방향키로 변환해 준다(데스크톱 휠과 같은 경로). 폰 터미널은 disableStdin 이라
  // 그 출력이 막히므로, 디스패치하는 동안만 열고 onData 로 받아 PTY 에 쓴다.
  forwardWheel(deltaY, clientX, clientY) {
    const term = Remote.term;
    const screen = document.querySelector('#term .xterm-screen');
    if (!term || !screen || !Remote.viewId) return;
    if (!Remote._wheelTap) Remote._wheelTap = term.onData((d) => { if (Remote._wheelOpen) Remote.write(d); });
    Remote._wheelOpen = true;
    term.options.disableStdin = false;
    try {
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX, clientY, bubbles: true, cancelable: true }));
    } catch (_) {}
    term.options.disableStdin = true;
    Remote._wheelOpen = false;
  },

  // 두 손가락 벌리기 = 터미널 글꼴만 확대 · 두 번 탭 = 화면 맞춤으로 복귀.
  // 브라우저 페이지 확대는 막는다 — 하단 특수키·입력창까지 커져 화면을 가리기 때문.
  bindTermZoom() {
    const wrap = document.getElementById('term-wrap');
    if (!wrap || wrap.dataset.zoomBound) return;
    wrap.dataset.zoomBound = '1';
    let pinch = null; // { startDist, startZoom }
    let swipe = null; // { x, y, locked } — 한 손가락 스와이프 (locked: 이번 제스처는 TUI 로 보내는 중)
    let lastTap = null;
    let raf = 0;
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = { startDist: touchDistance(e.touches[0], e.touches[1]), startZoom: Remote.getTermZoom() };
        lastTap = null;
        e.preventDefault();
        return;
      }
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const now = Date.now();
        swipe = { y: t.clientY, x: t.clientX, locked: false };
        if (isDoubleTap(lastTap, now, t.clientX, t.clientY)) {
          lastTap = null;
          if (Remote.getTermZoom() !== TERM_ZOOM_MIN) { Remote.setTermZoom(TERM_ZOOM_MIN, true); e.preventDefault(); }
          return;
        }
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
    }, { passive: false });
    wrap.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && swipe && !pinch) {
        const t = e.touches[0];
        const dy = wheelDeltaFromTouch(swipe.y, t.clientY);
        if (!dy) return;
        const atTop = wrap.scrollTop <= 0;
        const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 1;
        if (swipeTarget(Remote.inAltBuffer(), dy, atTop, atBottom, swipe.locked) === 'tui') {
          swipe.locked = true;
          e.preventDefault();
          Remote.forwardWheel(dy, t.clientX, t.clientY);
        }
        swipe.y = t.clientY;
        swipe.x = t.clientX;
        return;
      }
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const z = pinchZoom(pinch.startZoom, pinch.startDist, dist);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; Remote.setTermZoom(z, false); });
    }, { passive: false });
    const end = () => {
      swipe = null;
      if (!pinch) return;
      pinch = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      Remote.setTermZoom(Remote.getTermZoom(), true);
    };
    wrap.addEventListener('touchend', (e) => { if (e.touches.length < 2) end(); });
    wrap.addEventListener('touchcancel', end);
    // iOS 는 viewport 의 user-scalable=no 를 무시한다 — 제스처 이벤트로 페이지 확대를 막는다
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
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
    // 제어권 보유 중엔 PTY 가 이 화면 크기다 — 줄이지 않고 제어용 글꼴 그대로 보여 준다
    const zoom = Remote.getTermZoom();
    if (Remote.isHolding()) {
      const size = zoomedFontSize(CONTROL_FONT_SIZE, zoom);
      if (Remote.term.options.fontSize !== size) Remote.term.options.fontSize = size;
      return;
    }
    const wrap = document.getElementById('term-wrap');
    const style = getComputedStyle(wrap);
    const avail = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const fit = fitTerminalFont(avail, Remote.termCols, measureCellRatio());
    const size = zoomedFontSize(fit.fontSize, zoom);
    if (Remote.term.options.fontSize !== size) Remote.term.options.fontSize = size;
    // 확대 중엔 넘치는 게 의도다 (가로 스크롤) — 아래 보정은 맞춤 배율일 때만
    if (zoom !== TERM_ZOOM_MIN) return;
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
    for (const n of ['pair', 'dash', 'term', 'offline', 'moved']) {
      document.getElementById('screen-' + n).classList.toggle('hidden', n !== name);
    }
    if (name === 'term') requestAnimationFrame(() => Remote.fitFont());
  },

  bindUi() {
    document.getElementById('pair-form').onsubmit = (e) => Remote.submitPair(e);
    const codeEl = document.getElementById('pair-code');
    // autocapitalize 를 무시하는 키보드도 있어 직접 대문자로 맞춘다 (커서 위치 유지)
    codeEl.addEventListener('input', () => {
      const up = codeEl.value.toUpperCase();
      if (up === codeEl.value) return;
      const pos = codeEl.selectionStart;
      codeEl.value = up;
      try { codeEl.setSelectionRange(pos, pos); } catch (_) {}
    });
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
    document.getElementById('btn-control').onclick = () => Remote.toggleControl();
    const imageInput = document.getElementById('image-input');
    // pointerdown 기본 동작을 막아 입력창 포커스(=키보드)를 유지한다
    document.getElementById('btn-image').addEventListener('pointerdown', (e) => e.preventDefault());
    document.getElementById('btn-image').onclick = () => imageInput.click();
    imageInput.onchange = () => {
      const file = imageInput.files && imageInput.files[0];
      imageInput.value = ''; // 같은 파일을 다시 골라도 change 가 오게
      void Remote.attachImage(file);
    };

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
      const sid = sessionFromHash(location.hash);
      // pair+session 이 함께 오면 페어링 후 열도록 기억해 둔다
      if (sid) Remote.pendingSession = sid;
      if (code) { Remote.showPair(code); return; }
      // 앱이 열린 채로 다른 세션 알림을 누른 경우 — 목록이 아직이면 start() 가 연다
      if (sid && document.getElementById('screen-pair').classList.contains('hidden')) Remote.openPendingSession();
    });
    document.getElementById('offline-retry').onclick = () => {
      clearTimeout(Remote.offlineTimer);
      document.getElementById('offline-retry-note').textContent = '다시 시도하는 중…';
      void Remote.enter();
    };
  },

  // 키보드가 올라오면 visualViewport 가 줄어든다 — 앱 높이를 거기에 맞춰 입력창이 가려지지 않게 한다
  bindViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    let baseline = null;
    const apply = () => {
      // 회전하면 폭이 바뀌므로 기준 높이를 그 방향에서 새로 잰다
      baseline = nextViewportBaseline(baseline, Math.round(vv.width), Math.max(vv.height, window.innerHeight));
      document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      document.body.classList.toggle('kb-open', isKeyboardOpen(baseline, vv.height));
      // iOS 는 포커스 시 문서를 밀어 올린다 — 고정 레이아웃이므로 되돌린다
      if (window.scrollY) window.scrollTo(0, 0);
      Remote.fitFont();
      Remote.scheduleControlResend();
    };
    vv.addEventListener('resize', apply);
    // iOS 는 키보드가 뜰 때 크기 대신 오프셋만 바꾸기도 한다
    vv.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', () => setTimeout(apply, 300));
    apply();
  }
};

// 디코드해 보고 필요하면 캔버스로 줄여 다시 굽는다 (HEIC·초대형 사진 대응)
async function prepareImage(file) {
  let bitmap = null;
  try { bitmap = await createImageBitmap(file); } catch (_) {}
  if (!bitmap) {
    const action = undecodableAction(file);
    if (action === 'raw') return file;
    throw Object.assign(new Error('decode'), { kind: action === 'heic' ? 'heic' : 'decode' });
  }
  const info = { type: file.type, size: file.size, width: bitmap.width, height: bitmap.height };
  if (!imageNeedsReencode(info)) { if (bitmap.close) bitmap.close(); return file; }
  const size = scaledImageSize(bitmap.width, bitmap.height, IMAGE_MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
  let blob = null;
  if (reencodeType(file.type) === 'image/png') {
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    blob = await encode('image/png');
  }
  // PNG 로 구워도 너무 크면 JPEG 로 — 투명 영역은 검게 뭉개지지 않게 흰 바탕을 깐다
  if (!blob || blob.size > IMAGE_MAX_BYTES) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    blob = await encode('image/jpeg');
  }
  if (bitmap.close) bitmap.close();
  if (!blob) throw Object.assign(new Error('encode'), { kind: 'decode' });
  if (blob.size > IMAGE_MAX_BYTES) throw Object.assign(new Error('size'), { status: 413 });
  return blob;
}

// fetch 는 업로드 진행률을 주지 않는다 — XHR 로 보낸다
function uploadImage(sessionId, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?session=' + encodeURIComponent(sessionId));
    xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status !== 200) { reject(Object.assign(new Error('HTTP ' + xhr.status), { status: xhr.status })); return; }
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      if (body && typeof body.path === 'string' && body.path) resolve(body);
      else reject(new Error('bad response'));
    };
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }));
    xhr.send(blob);
  });
}

function uploadErrorText(e) {
  if (e && e.kind === 'heic') return 'HEIC 사진을 이 브라우저가 열 수 없습니다 — 카메라 설정의 \'높은 호환성\'(JPEG)으로 찍거나 스크린샷을 보내세요';
  if (e && e.kind === 'decode') return '이 이미지 형식은 열 수 없습니다';
  if (e && e.status === 413) return '이미지가 너무 큽니다 (최대 15MB)';
  if (e && e.status === 415) return '지원하지 않는 이미지 형식입니다';
  if (e && e.status === 401) return '인증이 만료되었습니다 — 다시 페어링하세요';
  return '이미지 업로드 실패';
}

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
  return deviceNameFromUA(navigator.userAgent, navigator.maxTouchPoints);
}

document.addEventListener('DOMContentLoaded', () => { void Remote.boot(); });
