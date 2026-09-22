// 일반 버퍼 휠 스크롤을 앱이 직접 처리하는 판정(wheelLinesFor) 검증.
// xterm 의 DOM scrollTop 경로는 출력 중 사용자 휠 입력을 유실하므로(Viewport._innerRefresh 의
// _ignoreNextScrollEvent 플래그와 프레임 내 scroll 이벤트 병합), 앱이 scrollLines 로 직접 옮긴다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

function loadTerminalView() {
  return vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';TerminalView', {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    ta: { write() {}, resize() {} },
    App: { state: { platform: 'windows' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} },
  });
}

// 가짜 터미널: 버퍼 종류·스크롤 위치·마우스 트래킹·xterm 줄 수 변환을 조절한다
function fakeTerm(o) {
  const opts = o || {};
  return {
    buffer: { active: { type: opts.type || 'normal', viewportY: opts.viewportY || 0, baseY: opts.baseY || 0 } },
    _core: {
      coreMouseService: { areMouseEventsActive: !!opts.tracking },
      viewport: opts.noViewport ? undefined : {
        getLinesScrolled: (ev) => (opts.linesFor ? opts.linesFor(ev) : Math.round(ev.deltaY / 20)),
      },
    },
  };
}

const wheel = (deltaY, extra) => Object.assign({ deltaY, shiftKey: false, deltaMode: 0 }, extra || {});

exports.name = '터미널 휠 스크롤 — 일반 버퍼는 앱이 직접 처리';

exports.run = function run(t) {
  const TV = loadTerminalView();

  // 일반 버퍼: 방향과 무관하게 앱이 처리한다 (마우스 트래킹이 없어도)
  t.check('일반 버퍼에서 위로 굴리면 앱이 처리한다', TV.wheelLinesFor(fakeTerm(), wheel(-100)) === -5);
  t.check('일반 버퍼에서 아래로 굴려도 앱이 처리한다(바닥이어도)', TV.wheelLinesFor(fakeTerm(), wheel(100)) === 5);

  // 부분 누적(작은 델타)이 0줄을 돌려주면 0 — null 이 아니므로 preventDefault 는 하되 이동은 없다
  t.check('0줄이면 0 을 돌려준다(xterm 경로로 새지 않게 막기만 한다)',
    TV.wheelLinesFor(fakeTerm({ linesFor: () => 0 }), wheel(-3)) === 0);

  // xterm 의 줄 수 변환(감도·deltaMode·부분 누적)을 그대로 쓴다
  t.check('xterm getLinesScrolled 결과를 사용한다',
    TV.wheelLinesFor(fakeTerm({ linesFor: () => -7 }), wheel(-1)) === -7);

  // 변환을 못 쓰면 40px ≈ 1줄 휴리스틱으로 폴백
  t.check('viewport 를 못 읽으면 휴리스틱으로 폴백한다',
    TV.wheelLinesFor(fakeTerm({ noViewport: true }), wheel(-120)) === -3);
  t.check('폴백은 최소 1줄은 움직인다', TV.wheelLinesFor(fakeTerm({ noViewport: true }), wheel(-5)) === -1);

  // xterm 에 맡기는 경우
  t.check('대체 버퍼(전체 화면 TUI)는 xterm 에 맡긴다', TV.wheelLinesFor(fakeTerm({ type: 'alternate' }), wheel(-100)) === null);
  t.check('Shift+휠(가로)은 xterm 에 맡긴다', TV.wheelLinesFor(fakeTerm(), wheel(-100, { shiftKey: true })) === null);
  t.check('deltaY 0 은 xterm 에 맡긴다', TV.wheelLinesFor(fakeTerm(), wheel(0)) === null);
  t.check('버퍼를 못 읽으면 xterm 에 맡긴다', TV.wheelLinesFor({}, wheel(-100)) === null);

  // 일반 버퍼 + TUI 마우스 트래킹: 기존 동작 보존
  t.check('트래킹 중 바닥에서 아래로 굴리면 TUI 로 보낸다',
    TV.wheelLinesFor(fakeTerm({ tracking: true, viewportY: 10, baseY: 10 }), wheel(100)) === null);
  t.check('트래킹 중에도 위로 굴리면 앱이 스크롤백을 보여준다',
    TV.wheelLinesFor(fakeTerm({ tracking: true, viewportY: 10, baseY: 10 }), wheel(-100)) === -5);
  t.check('트래킹 중 스크롤백을 보는 중이면 아래로도 앱이 처리한다',
    TV.wheelLinesFor(fakeTerm({ tracking: true, viewportY: 3, baseY: 10 }), wheel(100)) === 5);
};
