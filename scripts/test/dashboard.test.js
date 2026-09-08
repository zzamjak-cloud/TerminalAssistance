// 전 세션 대시보드 — 정렬 우선순위와 xterm 버퍼 tail 추출 검증.
// dashboard.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'dashboard.js');
const sandbox = { App: {}, TerminalView: { views: new Map() }, document: {}, Date, Map, Set, console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__d = { sortSessionsForDashboard, tailFromBuffer, dashboardStatusRank, formatRunElapsed };',
  sandbox
);
const { sortSessionsForDashboard, tailFromBuffer, dashboardStatusRank, formatRunElapsed } = sandbox.__d;

// xterm 버퍼 흉내 — getLine(row).translateToString(true) 만 쓴다
function fakeView(lines) {
  return {
    term: {
      buffer: {
        active: {
          length: lines.length,
          getLine: (row) => (row in lines ? { translateToString: () => lines[row] } : null)
        }
      }
    }
  };
}

const order = (list) => sortSessionsForDashboard(list).map((s) => s.id).join(',');

exports.name = '전 세션 대시보드 (정렬 · 버퍼 tail)';

exports.run = function (t) {
  // ── 상태 우선순위: 내가 개입해야 하는 것이 먼저 ──
  t.check('허가 대기 → 완료 → 진행중 → 대기 → 종료됨',
    dashboardStatusRank('waiting') < dashboardStatusRank('done')
    && dashboardStatusRank('done') < dashboardStatusRank('running')
    && dashboardStatusRank('running') < dashboardStatusRank('idle')
    && dashboardStatusRank('idle') < dashboardStatusRank('exited'));
  t.check('알 수 없는 상태는 대기와 같은 순위로 둔다',
    dashboardStatusRank('무엇') === dashboardStatusRank('idle'));

  const sessions = [
    { id: 'a', status: 'idle' },
    { id: 'b', status: 'running' },
    { id: 'c', status: 'waiting' },
    { id: 'd', status: 'exited' },
    { id: 'e', status: 'done' }
  ];
  t.check('상태 우선순위대로 정렬된다', order(sessions) === 'c,e,b,a,d', order(sessions));
  t.check('원본 배열을 변형하지 않는다',
    sessions.map((s) => s.id).join(',') === 'a,b,c,d,e');
  t.check('같은 상태끼리는 생성(원본) 순서를 유지한다',
    order([
      { id: 'x1', status: 'running' }, { id: 'x2', status: 'running' }, { id: 'x3', status: 'running' }
    ]) === 'x1,x2,x3');
  t.check('허가 대기가 여러 개면 그들끼리도 원본 순서',
    order([
      { id: 'r', status: 'running' }, { id: 'w1', status: 'waiting' }, { id: 'w2', status: 'waiting' }
    ]) === 'w1,w2,r');
  t.check('빈 목록·null 도 안전', order([]) === '' && order(null) === '');

  // ── 버퍼 tail ──
  t.check('마지막 3행을 순서대로 가져온다',
    tailFromBuffer(fakeView(['1', '2', '3', '4', '5']), 3).join('|') === '3|4|5');
  t.check('행 수가 요청보다 적으면 있는 만큼',
    tailFromBuffer(fakeView(['a', 'b']), 5).join('|') === 'a|b');
  // TUI 대체 버퍼는 하단이 입력 영역이라 그냥 마지막 n 행을 뜨면 빈 줄만 잡힌다
  t.check('화면 아래쪽 빈 줄은 건너뛴다',
    tailFromBuffer(fakeView(['내용1', '내용2', '', '   ', '']), 2).join('|') === '내용1|내용2');
  t.check('내용 사이의 빈 줄은 그대로 보존한다',
    tailFromBuffer(fakeView(['a', '', 'b', '']), 3).join('|') === 'a||b');
  // 좁은 타일에서 위쪽 빈 줄은 한 행을 낭비한다 (셸 시작 배너 앞의 공백 등)
  t.check('위쪽 빈 줄은 걷어낸다',
    tailFromBuffer(fakeView(['', '배너', '프롬프트']), 3).join('|') === '배너|프롬프트');
  t.check('걷어낸 뒤에도 내용 사이 빈 줄은 남는다',
    tailFromBuffer(fakeView(['', 'a', '', 'b']), 4).join('|') === 'a||b');
  t.check('행 끝 공백은 제거한다',
    tailFromBuffer(fakeView(['코드   ']), 1)[0] === '코드');
  t.check('전부 빈 줄이면 빈 배열',
    tailFromBuffer(fakeView(['', '  ', '']), 3).length === 0);
  t.check('버퍼가 없는 뷰는 빈 배열', tailFromBuffer(null, 3).length === 0
    && tailFromBuffer({}, 3).length === 0
    && tailFromBuffer({ term: {} }, 3).length === 0);
  t.check('getLine 이 null 을 주는 행은 건너뛴다', (() => {
    const lines = ['a', 'b'];
    const v = fakeView(lines);
    v.term.buffer.active.length = 4; // 실제보다 긴 length — 없는 행은 null
    return tailFromBuffer(v, 3).join('|') === 'a|b';
  })());

  // ── 진행 시간 표기 ──
  t.check('1분 미만은 초', formatRunElapsed(4200) === '4초');
  t.check('1분 이상은 분:초', formatRunElapsed(74000) === '1:14');
  t.check('초는 두 자리로 채운다', formatRunElapsed(65000) === '1:05');
  t.check('음수·0 도 안전', formatRunElapsed(-100) === '0초' && formatRunElapsed(0) === '0초');
};
