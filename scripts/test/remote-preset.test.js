// 모바일 프리셋 치환이 데스크톱 app.js expandPresetCommand 와 같은 결과를 내는지 검증.
// 두 구현을 각각 vm 에 올려 같은 입력으로 돌린다. {clipboard} 는 모바일에서 미지원(빈 문자열).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src');

function loadDesktop() {
  const context = {
    console,
    localStorage: { getItem: () => null, setItem() {} },
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    ta: { clipboardText: () => Promise.resolve('') },
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8') + '\n;globalThis.__app = App;', context);
  return context.__app;
}

function loadMobile() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'mobile', 'remote-core.js'), 'utf8')
    + '\n;globalThis.__m = { expandRemotePreset };', context);
  return context.__m;
}

exports.name = '모바일 프리셋 치환 (데스크톱과 결과 일치)';

exports.run = async function (t) {
  const App = loadDesktop();
  const { expandRemotePreset } = loadMobile();
  const project = { id: 'p1', name: '내 프로젝트', path: '/work/p1' };
  const session = { id: 's1', projectId: 'p1', title: 'S2', cwd: '/work/p1/sub' };
  App.state.projects = [project];
  App.state.sessions = [session];
  App.state.activeId = 's1';
  App.state.branches = { s1: 'feat/x' };

  // 같은 답을 내는 입력 질의 — 호출 순서까지 기록해 비교한다
  const answers = { 이름: '홍길동', 메시지: 'fix: 버그' };
  const makeAsk = (log) => (label) => { log.push(label); return Promise.resolve(answers[label]); };

  const cases = [
    'echo {branch} {projectPath} {projectName} {session}',
    'git commit -m "{input:메시지}" && echo {input:이름} {input:메시지}',
    'claude --resume {input: 이름 }',
    '{unknown} {branch}{branch}',
    'plain command'
  ];
  for (const cmd of cases) {
    const dLog = [];
    const mLog = [];
    App.promptPresetSlot = makeAsk(dLog);
    const desktop = await App.expandPresetCommand(cmd, undefined, 's1');
    const mobile = await expandRemotePreset(cmd, { session, project, branch: 'feat/x' }, makeAsk(mLog));
    t.check('일치: ' + cmd, desktop === mobile && dLog.join('|') === mLog.join('|'),
      JSON.stringify({ desktop, mobile, dLog, mLog }));
  }

  // 입력값 취소 → 둘 다 null
  App.promptPresetSlot = () => Promise.resolve(null);
  const dCancel = await App.expandPresetCommand('x {input:a}', undefined, 's1');
  const mCancel = await expandRemotePreset('x {input:a}', { session, project }, () => Promise.resolve(null));
  t.check('입력 취소 시 둘 다 null', dCancel === null && mCancel === null);

  // 슬롯 값 공유 (레시피처럼 여러 명령이 같은 값을 쓰는 경우)
  const slots = { a: '1' };
  let asked = 0;
  const shared = await expandRemotePreset('{input:a}-{input:b}', { session, project }, () => { asked++; return Promise.resolve('2'); }, slots);
  t.check('이미 받은 슬롯 값은 다시 묻지 않는다', shared === '1-2' && asked === 1 && slots.b === '2');

  // 세션이 없으면 세션 의존 치환은 빈 문자열 (데스크톱과 동일)
  App.state.activeId = null;
  App.state.sessions = [];
  const dNone = await App.expandPresetCommand('[{branch}][{projectPath}][{projectName}][{session}]');
  const mNone = await expandRemotePreset('[{branch}][{projectPath}][{projectName}][{session}]', {}, makeAsk([]));
  t.check('세션 없음도 일치', dNone === mNone && mNone === '[][][][]', JSON.stringify({ dNone, mNone }));

  t.check('{clipboard} 는 모바일에서 빈 문자열',
    (await expandRemotePreset('a{clipboard}b', { session, project }, makeAsk([]))) === 'ab');
};
