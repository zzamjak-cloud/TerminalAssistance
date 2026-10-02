// 원격(모바일)에서 만든 세션 수신 — 데스크톱이 같은 id 를 두 번 추가하지 않는지 검증.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src', 'renderer');

function loadApp() {
  const calls = { create: [], restore: [], activate: [], render: 0, git: 0, statusRow: [] };
  const context = {
    console,
    localStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    ta: { getScrollback: (id) => Promise.resolve({ data: 'snap-' + id, off: 10 }) },
    updateSessionStatus: (s) => calls.statusRow.push(s.id + ':' + s.status),
    TerminalView: {
      create: (info, size, opts) => calls.create.push({ id: info.id, frozen: !!(opts && opts.frozen) }),
      restore: (id, snap) => calls.restore.push({ id, snap })
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8') + '\n;globalThis.__app = App;', context);
  const App = context.__app;
  App.state.settings = { fontSize: 13 };
  App.refreshGitRemoteForSessions = () => { calls.git++; };
  App.renderAll = () => { calls.render++; };
  App.activateSession = (id) => { calls.activate.push(id); App.state.activeId = id; };
  App.noteStatusForDashboard = () => {};
  App.refreshPickerStatus = () => {};
  App.renderTopbar = () => {};
  return { App, calls, context };
}

exports.name = '원격 세션 생성 수신 (id 중복 방지)';

exports.run = async function (t) {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  t.check('api.js 가 ta:session-created 를 구독한다',
    /onSessionCreated:\s*\(cb\)\s*=>\s*listen\('ta:session-created'/.test(apiSrc));
  const boot = appSrc.slice(appSrc.indexOf('  async boot() {'), appSrc.indexOf('\n  },', appSrc.indexOf('  async boot() {')));
  t.check('부팅: getState 보다 먼저 ta:session-created 를 구독한다',
    boot.indexOf('await ta.onSessionCreated(') >= 0
    && boot.indexOf('await ta.onSessionCreated(') < boot.indexOf('await ta.getState()'));
  t.check('부팅 중 도착분은 모아 두었다가 부팅 끝에 처리한다',
    /if \(booted\) void App\.adoptRemoteSession\(info\);\s*else createdDuringBoot\.push\(info\);/.test(boot)
    && /booted = true;\s*for \(const info of createdDuringBoot\.splice\(0\)\) void App\.adoptRemoteSession\(info\);\s*$/.test(boot));

  const { App, calls } = loadApp();
  App.state.sessions = [{ id: 'old', projectId: null, title: 'S1' }];
  App.state.activeId = 'old';

  const info = { id: 'r1', projectId: 'p', title: 'S2', status: 'idle', cwd: '/w' };
  const first = await App.adoptRemoteSession(info);
  t.check('새 id 는 추가된다', first === true && App.state.sessions.map((s) => s.id).join(',') === 'old,r1');
  t.check('frozen 으로 만들고 스크롤백 스냅샷으로 복원한다',
    calls.create.length === 1 && calls.create[0].frozen
    && calls.restore.length === 1 && calls.restore[0].snap.data === 'snap-r1');
  t.check('보던 세션을 빼앗지 않는다', calls.activate.length === 0 && App.state.activeId === 'old' && calls.render === 1);

  const again = await App.adoptRemoteSession(Object.assign({}, info));
  t.check('같은 id 는 무시한다', again === false && App.state.sessions.length === 2 && calls.create.length === 1);

  // 이벤트가 연달아 두 번 와도 (스냅샷 조회 대기 중) 한 번만 들어간다
  const p1 = App.adoptRemoteSession({ id: 'r2', projectId: null, title: 'S3' });
  const p2 = App.adoptRemoteSession({ id: 'r2', projectId: null, title: 'S3' });
  const [a, b] = await Promise.all([p1, p2]);
  t.check('동시 수신도 한 번만 추가', a === true && b === false
    && App.state.sessions.filter((s) => s.id === 'r2').length === 1);

  t.check('잘못된 payload 는 무시', (await App.adoptRemoteSession(null)) === false
    && (await App.adoptRemoteSession({})) === false);

  // 활성 세션이 없으면 새 세션을 띄운다
  const fresh = loadApp();
  fresh.App.state.sessions = [];
  fresh.App.state.activeId = null;
  await fresh.App.adoptRemoteSession({ id: 'z', projectId: null, title: 'S1' });
  t.check('활성 세션이 없으면 활성화한다', fresh.calls.activate.join(',') === 'z');

  // 스냅샷 실패해도 라이브 출력은 살린다
  const failing = loadApp();
  failing.context.ta.getScrollback = () => Promise.reject(new Error('x'));
  failing.App.state.sessions = [];
  failing.App.state.activeId = 'q';
  await failing.App.adoptRemoteSession({ id: 'f', projectId: null, title: 'S1' });
  t.check('스냅샷 실패 시 restore(null)', failing.calls.restore.length === 1 && failing.calls.restore[0].snap === null);

  // 들이기 전 도착해 버려진 ta:status 를 백엔드 현재 상태로 맞춘다
  const late = loadApp();
  late.App.state.sessions = [];
  late.App.state.activeId = 'q';
  late.context.ta.getState = () => Promise.resolve({ sessions: [{ id: 'w', status: 'waiting' }] });
  await late.App.adoptRemoteSession({ id: 'w', projectId: null, title: 'S1', status: 'idle' });
  t.check('adopt 후 상태 재동기화', late.App.state.sessions[0].status === 'waiting'
    && late.calls.statusRow.join(',') === 'w:waiting');
};
