// HTTPS 이동 안내(410 moved)·#session 보류 열기·오프라인 재시도 중복 방지 — mobile.js 를 가짜 DOM 과 vm 에 올린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src', 'mobile');

function load() {
  const context = {
    console, Date, Map, Set, Math, JSON, Promise,
    document: { addEventListener() {}, visibilityState: 'visible' },
    window: {},
    history: { replaceState() {} },
    location: { pathname: '/', search: '', hash: '' },
    setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'remote-core.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8') + '\n;globalThis.__R = Remote; globalThis.__m = movedTarget;', context);
  return { R: context.__R, movedTarget: context.__m };
}

exports.name = 'HTTPS 이동 안내 · #session 보류 · 재시도 중복 방지';

exports.run = async function (t) {
  const { R, movedTarget } = load();
  t.check('410 moved https 만', movedTarget(410, { moved: 'https://mac.t.ts.net:7443' }) === 'https://mac.t.ts.net:7443');
  t.check('http·임의 스킴 거부', movedTarget(410, { moved: 'http://x' }) === null && movedTarget(410, { moved: 'javascript:1' }) === null);
  t.check('경로 섞인 값 거부', movedTarget(410, { moved: 'https://evil/x?y' }) === null);
  t.check('410 아니면 무시', movedTarget(404, { moved: 'https://a' }) === null);

  const opened = [];
  R.openView = (id) => opened.push(id);
  R.findSession = (id) => (id === 's1' ? { id } : null);
  R.toast = () => {};
  R.pendingSession = 's1';
  R.stateLoaded = false;
  R.openPendingSession();
  t.check('목록 전에는 열지 않고 보류', opened.length === 0 && R.pendingSession === 's1');
  R.stateLoaded = true;
  R.openPendingSession();
  t.check('목록 후 열고 비움', opened[0] === 's1' && R.pendingSession === null);

  let calls = 0;
  let release;
  R.enterOnce = () => { calls++; return new Promise((r) => { release = r; }); };
  const a = R.enter();
  const b = R.enter();
  t.check('진행 중 재시도는 무시', calls === 1);
  release();
  await a; await b;
  const c = R.enter();
  t.check('끝나면 다시 가능', calls === 2);
  release();
  await c;
};
