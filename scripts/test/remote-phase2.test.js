// 원격 2단계 — 이미지 첨부 경로·축소 규칙, 제어권 크기 계산·보유 판정, 데스크톱 이벤트 처리.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadCore() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(read('mobile/remote-core.js') + ';globalThis.__r = { quoteRemotePath, scaledImageSize,'
    + ' imageNeedsReencode, insertAtCaret, controlSize, holdsControl, controlLostText, CONTROL_MIN_COLS,'
    + ' CONTROL_MIN_ROWS, IMAGE_MAX_SIDE, reencodeType, undecodableAction };', ctx);
  return ctx.__r;
}

function loadUtilQuote() {
  const ctx = { console, document: {}, window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('renderer/util.js') + ';globalThis.__q = quotePath;', ctx);
  return ctx.__q;
}

// 가짜 DOM 요소 — 모바일 버튼 상태 확인용
function fakeEl() {
  return {
    textContent: '', style: {}, classList: {
      set: new Set(),
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }
    }
  };
}

function loadMobile() {
  const els = new Map();
  const timers = [];
  const frames = [];
  const ctx = {
    console, Date, Map, Set, Math, JSON, Promise,
    document: {
      addEventListener() {}, visibilityState: 'visible',
      getElementById: (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); }
    },
    window: {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval() {}, clearInterval() {},
    requestAnimationFrame: (fn) => { frames.push(fn); }
  };
  vm.createContext(ctx);
  vm.runInContext(read('mobile/remote-core.js') + '\n' + read('mobile/mobile.js') + '\n;globalThis.__R = Remote;', ctx);
  const R = ctx.__R;
  const log = { sent: [], toasts: [], fits: 0 };
  R.send = (m) => { log.sent.push(m); return true; };
  R.toast = (m) => log.toasts.push(m);
  R.fitFont = () => { log.fits++; };
  R.refresh = () => {};
  return { R, log, els, timers, frames, ctx };
}

// 실제 측정 대신 고정 크기를 돌려주는 가짜 화면 (requestControl 의 rAF 안에서 쓰인다)
function fakeMeasure(ctx) {
  const node = { offsetWidth: 720, offsetHeight: 420, clientWidth: 390, clientHeight: 600 };
  ctx.document.querySelector = () => node;
  const getEl = ctx.document.getElementById;
  ctx.document.getElementById = (id) => (id === 'term-wrap' ? node : getEl(id));
  ctx.getComputedStyle = () => ({ paddingLeft: '4', paddingRight: '4', paddingTop: '4', paddingBottom: '4' });
}

function loadTerminalView() {
  const calls = { resize: [], release: [] };
  const created = [];
  const sandbox = {
    document: {
      getElementById: () => null,
      createElement: () => {
        const el = fakeEl();
        el.children = [];
        el.append = (...xs) => el.children.push(...xs);
        el.remove = () => { el.removed = true; };
        created.push(el);
        return el;
      }
    },
    window: { addEventListener() {} },
    ta: {
      resize: (id, c, r) => calls.resize.push([id, c, r]),
      remoteReleaseControl: (id) => { calls.release.push(id); return Promise.resolve(); }
    },
    App: { state: { platform: 'mac' }, isSplit: () => false, showToast() {} },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} }
  };
  const TV = vm.runInNewContext(read('renderer/terminal-view.js') + ';TerminalView', sandbox);
  return { TV, calls, created };
}

function fakeView() {
  const holder = fakeEl();
  holder.classList.add('active');
  holder.children = [];
  holder.appendChild = (el) => holder.children.push(el);
  const term = { cols: 120, rows: 40, resize(c, r) { term.cols = c; term.rows = r; } };
  return {
    holder, term, lastCols: 120, lastRows: 40, fitted: 0,
    fit: {
      fit() { this.owner.fitted++; term.resize(this.dims.cols, this.dims.rows); },
      proposeDimensions() { return this.dims; },
      dims: { cols: 120, rows: 40 }
    }
  };
}

exports.name = '원격 2단계 (이미지 경로 · 제어권 · 입력 동기화)';

exports.run = function (t) {
  const r = loadCore();
  const quotePath = loadUtilQuote();

  // ── 경로 인용: 데스크톱 quotePath 와 같은 결과 ──
  for (const p of ['/tmp/a.png', '/Users/me/My Pics/a b.png', 'C:\\Users\\x y\\img.png', '/t/tab\there.png']) {
    t.check('인용 일치: ' + JSON.stringify(p), r.quoteRemotePath(p) === quotePath(p), r.quoteRemotePath(p));
  }
  t.check('공백 경로는 큰따옴표', r.quoteRemotePath('/a b.png') === '"/a b.png"');

  // ── 이미지 축소 ──
  t.check('긴 변을 2048 로', JSON.stringify(r.scaledImageSize(4032, 3024, 2048)) === '{"width":2048,"height":1536}');
  t.check('세로 사진도 긴 변 기준', JSON.stringify(r.scaledImageSize(3024, 4032, 2048)) === '{"width":1536,"height":2048}');
  t.check('작은 이미지는 그대로', JSON.stringify(r.scaledImageSize(800, 600, 2048)) === '{"width":800,"height":600}');
  t.check('HEIC 는 항상 JPEG 로 재인코딩', r.imageNeedsReencode({ type: 'image/heic', size: 1000, width: 100, height: 100 }));
  t.check('모르는 형식은 재인코딩', r.imageNeedsReencode({ type: 'image/gif', size: 1000, width: 10, height: 10 }));
  t.check('큰 해상도는 재인코딩', r.imageNeedsReencode({ type: 'image/png', size: 1000, width: 4000, height: 10 }));
  t.check('큰 파일은 재인코딩', r.imageNeedsReencode({ type: 'image/jpeg', size: 9 * 1024 * 1024, width: 100, height: 100 }));
  t.check('작은 PNG 는 원본 그대로', !r.imageNeedsReencode({ type: 'image/png', size: 200000, width: 1200, height: 800 }));

  // ── 입력창 삽입 (바로 전송하지 않음) ──
  const ins = r.insertAtCaret('설명 이미지', 3, 3, '"/a b.png" ');
  t.check('커서 위치에 삽입', ins.value === '설명 "/a b.png" 이미지' && ins.caret === 14, JSON.stringify(ins));
  t.check('선택 영역은 대체', r.insertAtCaret('abcdef', 1, 4, 'X').value === 'aXef');
  t.check('커서 정보 없으면 끝에', r.insertAtCaret('ab', null, null, 'Z').value === 'abZ');

  // ── 제어권 크기 ──
  const s = r.controlSize(390, 600, 7.2, 14);
  t.check('화면에 들어가는 cols/rows', s.cols === 54 && s.rows === 42, JSON.stringify(s));
  const tiny = r.controlSize(200, 80, 7.2, 14);
  t.check('최소 cols/rows 보장', tiny.cols === r.CONTROL_MIN_COLS && tiny.rows === r.CONTROL_MIN_ROWS);
  t.check('측정 실패(0)도 최소값', r.controlSize(390, 600, 0, 0).cols === r.CONTROL_MIN_COLS);

  t.check('보유 판정', r.holdsControl({ holder: 'me' }, 'me') && !r.holdsControl({ holder: 'x' }, 'me')
    && !r.holdsControl({ holder: null }, 'me') && !r.holdsControl({ holder: 'me' }, null));
  t.check('다른 기기가 빼앗으면 알림', /폰B/.test(r.controlLostText({ holder: 'me' }, { holder: 'b', deviceName: '폰B' }, 'me')));
  t.check('반환되면 알림', /해제/.test(r.controlLostText({ holder: 'me' }, { holder: null }, 'me')));
  t.check('원래 내 것이 아니었으면 알림 없음', r.controlLostText({ holder: 'b' }, { holder: null }, 'me') === null);

  // ── 모바일: control 메시지 반영 ──
  {
    const { R, log, els } = loadMobile();
    R.deviceId = 'me';
    R.viewId = 's1';
    R.handle({ t: 'control', id: 's1', holder: 'me', deviceName: '내 폰', cols: 54, rows: 42 });
    t.check('내가 보유 → 반환 버튼', R.isHolding() && els.get('btn-control').textContent === '최적 해제'
      && els.get('btn-control').classList.contains('holding'));
    R.handle({ t: 'control', id: 's1', holder: 'other', deviceName: '아이패드', cols: 80, rows: 30 });
    t.check('다른 기기가 가져가면 상태 반영 + 알림', !R.isHolding() && els.get('btn-control').textContent === '최적보기'
      && log.toasts.some((m) => /아이패드/.test(m)) && log.fits >= 2);
    R.handle({ t: 'control', id: 's1', holder: 'me', cols: 54, rows: 42 });
    R.toggleControl();
    t.check('반환 버튼은 release 전송', log.sent.some((m) => m.t === 'release' && m.id === 's1'));
    R.handle({ t: 'control', id: 's1', holder: null });
    t.check('내가 반환한 것은 알리지 않는다', !log.toasts.some((m) => /반환/.test(m)));

    R.handle({ t: 'control', id: 's1', holder: 'me', cols: 54, rows: 42 });
    log.sent.length = 0;
    R.closeView(true);
    t.check('보유 중 목록으로 나가면 반환', log.sent.some((m) => m.t === 'release' && m.id === 's1'));

    const m2 = loadMobile();
    m2.R.deviceId = 'me';
    m2.R.setSessions([{ id: 'x', status: 'idle', controlHolder: 'me' }]);
    t.check('sessions 의 controlHolder 반영', m2.R.isHolding('x'));
    m2.R.setSessions([{ id: 'y', status: 'idle', controlHolder: 'b', controlDeviceName: '아이패드', cols: 70, rows: 30 }]);
    const cy = m2.R.controls.get('y');
    t.check('sessions 의 이름·크기까지 반영', cy.holder === 'b' && cy.deviceName === '아이패드' && cy.cols === 70 && cy.rows === 30);
    m2.R.handle({ t: 'snap', id: 'y', data: '', off: 0, cols: 70, rows: 30, controlHolder: 'b' });
    t.check('snap 의 보유자만 오면 기존 이름 유지', m2.R.controls.get('y').deviceName === '아이패드');
  }

  // ── 데스크톱: 제어권 배너 · 크기 고정 ──
  {
    const { TV, calls } = loadTerminalView();
    const v = fakeView();
    v.fit.owner = v;
    TV.views.set('s1', v);
    TV.setRemoteControl({ id: 's1', holder: 'dev', deviceName: '내 폰', cols: 54, rows: 42 });
    t.check('보유 중: xterm 을 PTY(폰) 크기에 고정', v.term.cols === 54 && v.term.rows === 42 && v.fitted === 0);
    t.check('배너 표시 + 레터박스/스크롤 클래스', v.remoteBanner && /내 폰/.test(v.remoteBanner.text.textContent)
      && v.holder.classList.contains('remote-held'));
    v.fit.dims = { cols: 150, rows: 50 };
    TV._fitView('s1', v);
    t.check('패널 크기 변화는 희망 크기로만 전송, xterm 은 그대로',
      JSON.stringify(calls.resize) === '[["s1",150,50]]' && v.term.cols === 54);
    v.remoteBanner.root.children[1].onclick({ stopPropagation() {} });
    t.check('되찾기 → remote_release_control', calls.release.join(',') === 's1');
    TV.setRemoteControl({ id: 's1', holder: null, cols: 150, rows: 50 });
    t.check('반환: 배너 제거 + 다시 패널에 맞춤', !v.remoteBanner && v.fitted === 1 && v.term.cols === 150
      && !v.holder.classList.contains('remote-held'));
    t.check('모르는 세션 이벤트는 무시', (TV.setRemoteControl({ id: 'zz', holder: 'a', cols: 1, rows: 1 }), true));
  }

  // ── 리로드: SessionInfo 로 제어 상태 복원 ──
  {
    const { TV } = loadTerminalView();
    const v = fakeView();
    v.fit.owner = v;
    TV.views.set('s1', v);
    TV.applySessionControl({ id: 's1', controlHolder: 'dev', controlDeviceName: '내 폰', cols: 60, rows: 44 });
    t.check('부팅 복원: 고정 크기 + 배너', v.term.cols === 60 && v.term.rows === 44
      && /내 폰/.test(v.remoteBanner.text.textContent));
    const w = fakeView();
    w.fit.owner = w;
    TV.views.set('s2', w);
    TV.applySessionControl({ id: 's2', controlHolder: null, cols: 60, rows: 44 });
    t.check('보유자 없으면 아무것도 하지 않는다', !w.remoteBanner && w.term.cols === 120 && w.fitted === 0);
    const appSrc = read('renderer/app.js');
    t.check('부팅 시 복원 세션마다 제어 상태 적용',
      /TerminalView\.create\(s, App\.state\.settings\.fontSize, \{ frozen: true \}\);\s*TerminalView\.applySessionControl\(s\);/.test(appSrc));
  }

  // ── 데스크톱: 원격 입력 → 입력 줄 추적 무효화, 이미지 수신 알림 ──
  {
    const appSrc = read('renderer/app.js');
    t.check('부팅 시 원격 이벤트 3종 구독',
      /ta\.onRemoteInput\(\(p\) => App\.onRemoteInput\(p\)\)/.test(appSrc)
      && /await ta\.onRemoteControl\(\(p\) => \{/.test(appSrc)
      && /ta\.onRemoteImage\(\(p\) => App\.onRemoteImage\(p\)\)/.test(appSrc));
    const apiSrc = read('renderer/api.js');
    t.check('api: 이벤트 이름·커맨드 인자', /listen\('ta:remote-control'/.test(apiSrc) && /listen\('ta:remote-input'/.test(apiSrc)
      && /listen\('ta:remote-image'/.test(apiSrc) && /invoke\('remote_release_control', \{ id \}\)/.test(apiSrc));

    const invalidated = [];
    const toasts = [];
    const ctx = {
      console, localStorage: { getItem: () => null, setItem() {} },
      document: { addEventListener() {} }, window: { addEventListener() {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      TerminalView: { invalidateTypedLine: (id) => invalidated.push(id) }
    };
    vm.createContext(ctx);
    vm.runInContext(appSrc + '\n;globalThis.__app = App;', ctx);
    const App = ctx.__app;
    App.showToast = (m) => toasts.push(m);
    App.state.sessions = [{ id: 's1', projectId: null, title: 'S1' }];
    App.onRemoteInput({ id: 's1' });
    App.onRemoteInput({});
    t.check('원격 입력 → 해당 세션 추적 무효화', invalidated.join(',') === 's1');
    App.onRemoteImage({ sessionId: 's1', path: '/tmp/x.png' });
    t.check('원격 이미지 → 데스크톱 알림 (경로 중복 삽입 없음)', toasts.length === 1 && /\/tmp\/x\.png/.test(toasts[0]));
  }

  // ── 이미지 재인코딩 형식 · HEIC 안내 ──
  t.check('PNG 는 PNG 로 재인코딩 (투명 보존)', r.reencodeType('image/png') === 'image/png');
  t.check('그 외는 JPEG', r.reencodeType('image/jpeg') === 'image/jpeg' && r.reencodeType('image/heic') === 'image/jpeg');
  t.check('디코드 못 한 HEIC/HEIF 는 업로드하지 않는다',
    r.undecodableAction({ type: 'image/heic', size: 10 }) === 'heic'
    && r.undecodableAction({ type: 'image/heif', size: 10 }) === 'heic'
    && r.undecodableAction({ type: '', name: 'IMG_1.HEIC', size: 10 }) === 'heic');
  t.check('서버가 받는 형식은 원본 그대로', r.undecodableAction({ type: 'image/webp', size: 10 }) === 'raw');
  t.check('그 외는 실패', r.undecodableAction({ type: 'image/gif', size: 10 }) === 'fail'
    && r.undecodableAction({ type: 'image/png', size: 16 * 1024 * 1024 }) === 'fail');
  const mobileSrc = read('mobile/mobile.js');
  t.check('JPEG 변환 시 흰 바탕을 먼저 칠한다',
    /fillStyle = '#ffffff';\s*ctx\.fillRect\(0, 0, size\.width, size\.height\);\s*ctx\.drawImage/.test(mobileSrc));

  // ── 제어권: 재연결 재보유 · 반환 대기 해제 · 탭 로컬 · 오류 복구 ──
  {
    const { R, log, timers, frames, ctx } = loadMobile();
    fakeMeasure(ctx);
    R.deviceId = 'me';
    R.viewId = 's1';
    R.term = { cols: 100, rows: 30, options: { fontSize: 8 } };
    R.toggleControl();
    t.check('제어 요청: 즉시 대기 표시', R.controlPending && R.controlPending.id === 's1' && R.controlWanted === 's1');
    frames.splice(0).forEach((f) => f());
    const req = log.sent.find((m) => m.t === 'control');
    t.check('실측 셀 크기로 cols/rows 전송 (382/7.2, 592/14)', req && req.cols === 53 && req.rows === 42, JSON.stringify(req));
    R.handle({ t: 'control', id: 's1', holder: 'me', deviceName: '내 폰', cols: 54, rows: 42 });
    t.check('보유 응답 → 대기 해제', R.controlPending === null && R.isHolding());

    // 재연결: 서버는 자동 반환 → 이 탭이 쥐던 것이면 다시 요청, 그 사이 '반환' 알림은 내지 않는다
    log.sent.length = 0;
    t.check('재연결 시 재보유 대상', R.wantsControl());
    R.requestControl();
    R.handle({ t: 'sessions', list: [{ id: 's1', status: 'idle', controlHolder: null }] });
    t.check('재보유 대기 중 자동 반환 알림 없음', !log.toasts.some((m) => /반환/.test(m)));
    frames.splice(0).forEach((f) => f());
    t.check('재보유 요청 전송', log.sent.some((m) => m.t === 'control' && m.id === 's1'));

    // 오류 → 글꼴 복구
    const fitsBefore = log.fits;
    R.handle({ t: 'error', msg: '거절' });
    t.check('control 대기 중 error → fitFont 복구 + 대기 해제', R.controlPending === null && log.fits > fitsBefore);

    // 같은 기기의 다른 탭: 보유자는 나지만 이 탭이 요청한 게 아니면 재전송하지 않는다
    const other = loadMobile();
    other.R.deviceId = 'me';
    other.R.viewId = 's1';
    other.R.handle({ t: 'control', id: 's1', holder: 'me', cols: 54, rows: 42 });
    t.check('다른 탭은 보유 표시만, 재전송 의사 없음', other.R.isHolding() && !other.R.wantsControl());
    other.R.scheduleControlResend();
    t.check('다른 탭 화면 변화로 control 을 보내지 않는다', other.timers.length === 0);

    // 반환: 응답이 없어도 대기 표시는 시간 제한으로 풀린다
    R.handle({ t: 'control', id: 's1', holder: 'me', cols: 54, rows: 42 });
    R.toggleControl();
    t.check('반환 요청 → 반환 대기 + 의사 해제', R.controlReleasing && R.controlWanted === null);
    const releaseTimer = timers.filter((x) => !x.cleared).pop();
    releaseTimer.fn();
    t.check('반환 대기는 시간 제한으로 해제', R.controlReleasing === null);
    R.toggleControl();
    R.handle({ t: 'control', id: 's1', holder: null });
    t.check('반환 응답으로도 해제 + 알림 없음', R.controlReleasing === null && !log.toasts.some((m) => /반환/.test(m)));

    // 다른 기기가 가져가면 이 탭의 의사도 접는다
    R.handle({ t: 'control', id: 's1', holder: 'me', cols: 54, rows: 42 });
    R.controlWanted = 's1';
    R.handle({ t: 'control', id: 's1', holder: 'pad', deviceName: '아이패드', cols: 80, rows: 30 });
    t.check('다른 기기가 가져가면 재보유하지 않는다', R.controlWanted === null && !R.wantsControl());
  }
};
