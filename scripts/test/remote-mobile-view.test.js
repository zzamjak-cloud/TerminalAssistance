// 모바일 세션 뷰 메시지 처리 — mobile.js 를 가짜 DOM·터미널과 함께 vm 에 올려 검증한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src', 'mobile');

function load() {
  const timers = [];
  const context = {
    console, Date, Map, Set, Math, JSON, Promise,
    document: { addEventListener() {}, visibilityState: 'visible' },
    window: {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval() {}, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'remote-core.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8') + '\n;globalThis.__R = Remote;', context);
  const R = context.__R;
  const log = { writes: [], sent: [], opened: [], toasts: [] };
  const callbacks = [];
  R.term = {
    write: (data, cb) => { log.writes.push(data); if (cb) callbacks.push(cb); },
    resize() {}, scrollToBottom: () => log.writes.push('<bottom>'), options: {}
  };
  R.termCols = 100; R.termRows = 30;
  R.fitFont = () => {};
  R.refresh = () => {};
  R.renderTermHeader = () => {};
  R.toast = (m) => log.toasts.push(m);
  R.send = (m) => { log.sent.push(m); return true; };
  R.openView = (id) => { log.opened.push(id); R.viewId = id; };
  return { R, log, callbacks, timers };
}

exports.name = '모바일 세션 뷰 (스냅샷 세대 · 새 세션 reqId)';

exports.run = function (t) {
  // ── 스냅샷: reset 을 write 큐로, bracketed paste 상태 복원 ──
  {
    const { R, log, callbacks } = load();
    R.viewId = 'a';
    R.handle({ t: 'snap', id: 'a', data: 'HELLO', off: 5, cols: 100, rows: 30, bracketedPaste: true });
    t.check('스냅샷은 RIS + 데이터 + 모드를 한 write 로 큐에 넣는다',
      log.writes[0] === '\x1bcHELLO\x1b[?2004h', JSON.stringify(log.writes));
    // 다른 스냅샷이 먼저 큐에 들어간 뒤 이전 콜백이 돌면 무시돼야 한다
    R.handle({ t: 'snap', id: 'a', data: 'NEW', off: 9, cols: 100, rows: 30 });
    callbacks[0]();
    t.check('이전 세대 write 콜백은 무시한다', !log.writes.includes('<bottom>'));
    callbacks[1]();
    t.check('현재 세대 콜백은 실행한다', log.writes.includes('<bottom>'));
    t.check('필드 없는 스냅샷은 모드를 건드리지 않는다', log.writes[1] === '\x1bcNEW');
    R.handle({ t: 'data', id: 'a', off: 8, data: 'old' });
    R.handle({ t: 'data', id: 'a', off: 9, data: 'live' });
    R.handle({ t: 'data', id: 'b', off: 99, data: 'other' });
    t.check('off 규칙 + 다른 세션 데이터 무시',
      !log.writes.includes('old') && log.writes.includes('live') && !log.writes.includes('other'));
  }

  // ── 새 세션: reqId 로만 짝 맞추기 ──
  {
    const { R, log, timers } = load();
    R.state.sessions = [];
    R.pendingCreate = { reqId: 'r1', timer: 0 };
    R.handle({ t: 'created', session: { id: 'x', projectId: 'p' } });
    t.check('created(브로드캐스트)만으로는 열지 않는다', log.opened.length === 0 && R.pendingCreate);
    R.handle({ t: 'createResult', reqId: 'other', session: { id: 'y' } });
    t.check('다른 reqId 응답은 무시', log.opened.length === 0 && R.pendingCreate);
    R.handle({ t: 'createResult', reqId: 'r1', session: { id: 'z', projectId: 'p' } });
    t.check('내 reqId 응답이면 연다', log.opened.join(',') === 'z' && R.pendingCreate === null);
    t.check('목록에도 들어간다', R.state.sessions.some((s) => s.id === 'z'));

    R.pendingCreate = { reqId: 'r2', timer: 0 };
    R.handle({ t: 'error', msg: '실패', reqId: 'r2' });
    t.check('error.reqId 가 맞으면 대기 해제', R.pendingCreate === null && log.toasts.includes('실패'));

    R.pendingCreate = { reqId: 'r3', timer: 0 };
    R.viewId = 'z';
    R.closeView(true);
    t.check('closeView 시 대기 해제', R.pendingCreate === null);
    void timers;
  }

  // ── 응답 없는 생성 요청은 10초 뒤 해제 ──
  {
    const src = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
    const core = fs.readFileSync(path.join(ROOT, 'remote-core.js'), 'utf8');
    t.check('타임아웃 10초', /const CREATE_TIMEOUT_MS = 10000;/.test(core));
    t.check('create 요청에 reqId 를 싣고 타임아웃 타이머를 건다',
      /t: 'create', projectId: p\.id, reqId/.test(src) && /\}, CREATE_TIMEOUT_MS\)/.test(src));
  }
};
