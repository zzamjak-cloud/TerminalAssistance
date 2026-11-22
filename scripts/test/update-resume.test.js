// 사용 중 업데이트·자동 이어하기 판단 로직 검증.
// update-core.js(순수 로직), update-resume.js(이어하기 실행), terminal-view.js(실행 명령 줄 기록)를
// vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

function loadCore() {
  return vm.runInNewContext(read('update-core.js') + ';UpdateCore', {});
}

exports.name = '사용 중 업데이트 · 자동 이어하기';

exports.run = async function run(t) {
  const C = loadCore();

  // ── 작업 중 판정 ──
  const sessions = [
    { id: 'a', status: 'running', title: 'A' },
    { id: 'b', status: 'waiting', title: 'B' },
    { id: 'c', status: 'done', title: 'C' },
    { id: 'd', status: 'idle', title: 'D' },
    { id: 'e', status: 'exited', title: 'E' }
  ];
  const drafts = { 'queued:c': [{ id: 'q', text: 'x' }], 'queued:d': [], proj: [{ id: 'z' }] };
  t.check('실행·허가 대기·예약 남은 세션만 작업 중', JSON.stringify(C.busySessionIds(sessions, drafts)) === '["a","b","c"]',
    JSON.stringify(C.busySessionIds(sessions, drafts)));
  t.check('빈 입력은 작업 없음', C.busySessionIds(null, null).length === 0);

  // ── 작업 끝나면 설치: 연속 3회 무작업이어야 카운트다운 ──
  let streak = 0;
  const seq = [0, 0, 1, 0, 0];
  const states = seq.map((busy) => (streak = C.nextIdleStreak(streak, busy)));
  t.check('작업이 끼면 연속 횟수 초기화', JSON.stringify(states) === '[1,2,0,1,2]', JSON.stringify(states));
  t.check('2회로는 설치하지 않음', !C.readyToInstall(2));
  t.check('3회 연속이면 설치', C.readyToInstall(C.nextIdleStreak(2, 0)));

  // ── 안내 모달 표시 조건 ──
  const info = { version: '1.2.3' };
  t.check('기본은 안내', C.shouldPromptUpdate(info, { dismissed: new Set() }));
  t.check('나중에 누른 버전은 재안내 안 함', !C.shouldPromptUpdate(info, { dismissed: new Set(['1.2.3']) }));
  t.check('더 새 버전은 다시 안내', C.shouldPromptUpdate({ version: '1.2.4' }, { dismissed: new Set(['1.2.3']) }));
  t.check('다른 모달 위에는 띄우지 않음', !C.shouldPromptUpdate(info, { modalOpen: true }));
  t.check('설치 대기 중에는 띄우지 않음', !C.shouldPromptUpdate(info, { idleInstalling: true }));
  t.check('업데이트 없음', !C.shouldPromptUpdate(null, {}));
  t.check('작업 중 버튼 문구', C.updateButtonLabel(2) === '지금 업데이트 (2개 중단 후 이어하기)');
  t.check('작업 없을 때 버튼 문구', C.updateButtonLabel(0) === '지금 업데이트');

  // ── 이어하기 계획 ──
  const plan = C.resumePlan([
    { sessionId: 'a', command: 'claude --resume x' },
    { sessionId: 'a', command: 'codex resume y' },
    { sessionId: 'gone', command: 'claude --resume z' },
    { sessionId: 'b', command: '  ' },
    null
  ], sessions);
  t.check('복원된 세션만 세션당 하나', JSON.stringify(plan) === '[{"sessionId":"a","command":"claude --resume x"}]', JSON.stringify(plan));
  t.check('cd 접두 제거', C.agentPartOf("cd '/p/it'\\''s' && codex --yolo resume 1") === 'codex --yolo resume 1',
    C.agentPartOf("cd '/p/it'\\''s' && codex --yolo resume 1"));
  t.check('접두 없으면 그대로', C.agentPartOf('claude --resume 1') === 'claude --resume 1');

  // ── 종료 확인 대상 ──
  const q = C.quitTargets([{ id: 'a', title: 'A' }], sessions, drafts);
  t.check('백엔드가 본 에이전트 탭 + 예약만 남은 세션 (출력 기반 waiting 은 백엔드 판정에 맡김)',
    JSON.stringify(q.map((x) => [x.id, x.queued])) === '[["a",false],["c",true]]', JSON.stringify(q));
  t.check('멈춘 예약은 종료 확인 대상 아님',
    C.quitTargets([], sessions, drafts, new Set(['c'])).length === 0);

  // ── 에이전트 탭만 작업 중 (셸의 npm run dev 출력은 제외) ──
  const narrowed = C.busySessionIds(sessions, drafts, { agentIds: new Set(['b']), pausedIds: new Set(['c']) });
  t.check('에이전트 탭과 멈추지 않은 예약만', JSON.stringify(narrowed) === '["b"]', JSON.stringify(narrowed));
  t.check('30분 대기 상한', !C.idleInstallExpired(0, C.IDLE_INSTALL_MAX_MS - 1) && C.idleInstallExpired(0, C.IDLE_INSTALL_MAX_MS));

  // ── 실행 명령 줄 기록 (TerminalView) ──
  const noted = [];
  const writes = [];
  const tvSandbox = {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    ta: { write: (id, d) => writes.push([id, d]), noteAgentCommand: (id, line) => { noted.push([id, line]); return Promise.resolve(); } },
    App: { state: { platform: 'macos' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} },
    Promise
  };
  const TV = vm.runInNewContext(read('terminal-view.js') + ';TerminalView', tvSandbox);
  TV.views.set('s1', { typedText: '', typedValid: true });
  for (const ch of 'claude --model opus') TV.noteTypedData('s1', ch);
  TV.noteTypedData('s1', '\r');
  for (const ch of 'claudette') TV.noteTypedData('s1', ch);
  TV.noteTypedData('s1', '\r');
  TV.noteTypedData('s1', '\x1b[A'); // 방향키 → 추적 포기
  for (const ch of 'codex') TV.noteTypedData('s1', ch);
  TV.noteTypedData('s1', '\r');
  for (const ch of '  codex --yolo') TV.noteTypedData('s1', ch);
  TV.noteTypedData('s1', '\r');
  TV.noteTypedData('s1', '\r'); // 빈 Enter 는 알리지 않는다
  t.check('에이전트 줄은 기억, 다른 줄·↑ 재실행(추적 불가)은 지움',
    JSON.stringify(noted) === '[["s1","claude --model opus"],["s1",""],["s1",""],["s1","codex --yolo"]]', JSON.stringify(noted));

  // ── 이어하기 실행: 첫 출력을 기다린 뒤 명령 입력, 예약 큐는 그동안 붙잡힘 ──
  const timers = [];
  const appWrites = [];
  const toasts = [];
  const App = {
    state: { sessions: [{ id: 's1' }, { id: 's2' }], drafts: {} },
    noteSessionActivity() {},
    showToastWhenFree: (m) => toasts.push(m),
    handled: [],
    handleQueuedDone(id) { this.handled.push(id); }
  };
  const sandbox = {
    App,
    UpdateCore: C,
    TerminalView: {
      views: new Map([['s1', {}], ['s2', { typedText: 'ls', typedValid: true }]]),
      noteSubmittedLine: (id, line) => noted.push([id, line]),
      resetTypedLine() {}
    },
    ta: {
      takePendingResume: async () => ({
        kind: 'crash',
        crashed: true,
        entries: [
          { sessionId: 's1', command: "cd '/w' && claude --resume u1" },
          { sessionId: 's2', command: 'codex resume u2' }
        ]
      }),
      write: (id, d) => appWrites.push([id, d])
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    Promise, Set, Map,
    document: { getElementById: () => null }
  };
  vm.runInNewContext(read('update-resume.js'), sandbox);
  const planned = await App.takeAutoResume({ alreadyRunning: false });
  t.check('이어하기 대상은 예약 큐에서 붙잡힘', App._autoResumeHold.has('s1') && App._autoResumeHold.has('s2'));
  t.check('리로드(이미 실행 중)는 이어하기 없음', (await App.takeAutoResume({ alreadyRunning: true })).length === 0);
  t.check('리로드는 이전 판정을 건드리지 않음', App._autoResumeKind === 'crash');
  noted.length = 0;
  App.noteOutput('s1'); // s1 은 이미 프롬프트가 떴다
  const running = App.runAutoResume(planned);
  await new Promise((r) => setImmediate(r));
  t.check('첫 출력을 본 세션은 바로 입력', JSON.stringify(appWrites) === JSON.stringify([['s1', "cd '/w' && claude --resume u1\r"]]),
    JSON.stringify(appWrites));
  App.noteOutput('s2'); // 늦게 뜬 프롬프트
  await running;
  t.check('입력줄에 친 것이 있으면 Ctrl+U 로 비우고 입력', appWrites.length === 2 && appWrites[1][1] === '\x15codex resume u2\r',
    JSON.stringify(appWrites));
  t.check('다음 업데이트용 실행 줄은 cd 접두 없이 기록', noted[0] && noted[0][1] === 'claude --resume u1', JSON.stringify(noted));
  t.check('비정상 종료 복구 토스트', toasts[0] === '비정상 종료 후 복구 — 세션 2개 이어하기', toasts[0]);
  t.check('비정상 종료 감지 기록', App._crashed === true);
  const holdTimers = timers.filter((x) => x.ms === C.RESUME_QUEUE_HOLD_MS);
  t.check('입력 뒤 일정 시간 후 예약 큐 해제 예약', holdTimers.length === 2);
  App._autoResumeMissedDone.add('s2'); // 붙잡는 동안 s2 의 턴이 끝났다
  holdTimers.forEach((x) => x.fn());
  t.check('해제 후 예약 큐 재개', App._autoResumeHold.size === 0);
  t.check('붙잡는 동안 놓친 완료는 해제 때 한 번 처리', JSON.stringify(App.handled) === '["s2"]', JSON.stringify(App.handled));

  // 출력이 전혀 없어도 상한 시간 뒤에는 진행한다
  const waitTimers = timers.filter((x) => x.ms === C.FIRST_OUTPUT_WAIT_MS);
  t.check('첫 출력 대기는 상한 타이머를 건다', waitTimers.length === 1);
  let resolved = false;
  const p = App.waitFirstOutput('never', 3000).then(() => { resolved = true; });
  timers[timers.length - 1].fn();
  await p;
  t.check('상한 시간이 지나면 대기 해제', resolved);
};
