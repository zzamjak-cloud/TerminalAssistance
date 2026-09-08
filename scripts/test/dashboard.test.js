// 전 세션 대시보드 — 프로젝트 묶기와 정렬 우선순위 검증.
// dashboard.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'dashboard.js');
const sandbox = {
  App: {}, TerminalView: { views: new Map() }, document: {}, Date, Map, Set, console,
  localStorage: { getItem: () => null, setItem() {} }
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__d = { sortSessionsForDashboard, sortGroupsForDashboard, dashboardStatusRank,'
  + ' formatRunElapsed, formatSinceChange, dashboardSignature };',
  sandbox
);
const {
  sortSessionsForDashboard, sortGroupsForDashboard, dashboardStatusRank,
  formatRunElapsed, formatSinceChange, dashboardSignature
} = sandbox.__d;
const App = sandbox.App;

const order = (list, mode, ctx) =>
  sortSessionsForDashboard(list, mode, ctx).map((s) => s.id).join(',');

// 세션 목록을 그대로 App.state 에 꽂고 그룹 결과를 'key:세션,세션' 형태로 요약한다
function groupsOf(sessions, projects) {
  App.state = { sessions, projects: projects || [] };
  return App.groupSessionsForDashboard()
    .map((g) => g.key + ':' + g.sessions.map((s) => s.id).join('+'))
    .join(' | ');
}

exports.name = '전 세션 대시보드 (프로젝트 묶기 · 정렬)';

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
  t.check('알 수 없는 정렬 기준은 상태 정렬로 대체', order(sessions, '무엇') === 'c,e,b,a,d');
  t.check('ctx 를 생략해도 상태 정렬은 동작', order(sessions, 'status') === 'c,e,b,a,d');

  // ── 프로젝트 정렬: 프로젝트 등록 순서 → 세션 생성 순서 ──
  const projCtx = { projectIndex: new Map([['p2', 0], ['p1', 1]]) };
  const mixed = [
    { id: 'a', status: 'idle', projectId: 'p1' },
    { id: 'b', status: 'idle', projectId: 'p2' },
    { id: 'home', status: 'idle', projectId: null },
    { id: 'c', status: 'idle', projectId: 'p1' },
    { id: 'd', status: 'idle', projectId: 'p2' }
  ];
  t.check('프로젝트 등록 순서대로 묶인다',
    order(mixed, 'project', projCtx) === 'b,d,a,c,home', order(mixed, 'project', projCtx));
  t.check('프로젝트 없는 홈 터미널은 끝으로',
    order(mixed, 'project', projCtx).endsWith('home'));
  t.check('등록 목록에 없는 프로젝트도 끝으로 (삭제 직후 등)',
    order([{ id: 'x', projectId: '사라짐' }, { id: 'y', projectId: 'p2' }], 'project', projCtx) === 'y,x');
  t.check('프로젝트 정렬은 상태를 보지 않는다',
    order([
      { id: 'a', status: 'exited', projectId: 'p2' },
      { id: 'b', status: 'waiting', projectId: 'p1' }
    ], 'project', projCtx) === 'a,b');

  // ── 최근 활동 정렬: 최근에 상태가 바뀐 순 ──
  const actCtx = { lastChangeAt: new Map([['a', 100], ['b', 300], ['c', 200]]) };
  t.check('최근 변화가 앞으로',
    order([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'activity', actCtx) === 'b,c,a');
  t.check('기록이 없는 세션은 뒤로',
    order([{ id: 'z' }, { id: 'b' }], 'activity', actCtx) === 'b,z');
  t.check('기록이 없는 세션끼리는 생성 순서 유지',
    order([{ id: 'z1' }, { id: 'z2' }], 'activity', actCtx) === 'z1,z2');

  // ── 프로젝트 묶기 ──
  const projects = [{ id: 'p1', name: '알파' }, { id: 'p2', name: '베타' }];
  t.check('같은 프로젝트의 세션이 한 그룹으로 모인다',
    groupsOf([
      { id: 'a', projectId: 'p1' }, { id: 'b', projectId: 'p2' },
      { id: 'c', projectId: 'p1' }, { id: 'd', projectId: 'p2' }
    ], projects) === 'p:p1:a+c | p:p2:b+d', groupsOf([
      { id: 'a', projectId: 'p1' }, { id: 'b', projectId: 'p2' },
      { id: 'c', projectId: 'p1' }, { id: 'd', projectId: 'p2' }
    ], projects));
  t.check('그룹은 첫 등장 순서로 만들어진다',
    groupsOf([{ id: 'a', projectId: 'p2' }, { id: 'b', projectId: 'p1' }], projects)
      .startsWith('p:p2:'));
  t.check('프로젝트 없는 세션은 홈 터미널 한 그룹으로 모인다',
    groupsOf([
      { id: 'h1', projectId: null }, { id: 'a', projectId: 'p1' }, { id: 'h2' }
    ], projects) === 'home:h1+h2 | p:p1:a');
  t.check('그룹은 프로젝트 객체를 함께 들고 온다', (() => {
    App.state = { sessions: [{ id: 'a', projectId: 'p1' }], projects };
    const g = App.groupSessionsForDashboard()[0];
    return g.project && g.project.name === '알파';
  })());
  t.check('등록 목록에 없는 프로젝트여도 그룹은 만들어진다 (project 는 null)', (() => {
    App.state = { sessions: [{ id: 'a', projectId: '사라짐' }], projects };
    const g = App.groupSessionsForDashboard()[0];
    return g.project === null && g.sessions.length === 1;
  })());
  t.check('세션이 없으면 그룹도 없다', groupsOf([], projects) === '');

  // ── 그룹 정렬: 그룹 안에서 가장 앞서는 세션이 그룹을 끌어올린다 ──
  const grp = (key, index, sessions) => ({ key, projectId: key, index, sessions });
  const gOrder = (groups, mode, ctx) =>
    sortGroupsForDashboard(groups, mode, ctx).map((g) => g.key).join(',');
  const gs = [
    grp('p1', 0, [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }]),
    grp('p2', 1, [{ id: 'c', status: 'exited' }]),
    grp('p3', 2, [{ id: 'd', status: 'idle' }, { id: 'e', status: 'waiting' }])
  ];
  t.check('허가 대기를 품은 그룹이 맨 위로',
    gOrder(gs, 'status') === 'p3,p1,p2', gOrder(gs, 'status'));
  t.check('그룹 정렬이 원본 배열을 변형하지 않는다',
    gs.map((g) => g.key).join(',') === 'p1,p2,p3');
  t.check('대표 상태가 같으면 첫 등장 순서로',
    gOrder([
      grp('x', 0, [{ id: '1', status: 'running' }]),
      grp('y', 1, [{ id: '2', status: 'running' }])
    ], 'status') === 'x,y');
  t.check('프로젝트 기준이면 등록 순서를 따른다',
    gOrder(gs, 'project', { projectIndex: new Map([['p3', 0], ['p2', 1], ['p1', 2]]) }) === 'p3,p2,p1');
  t.check('등록 목록에 없는 그룹은 끝으로',
    gOrder(gs, 'project', { projectIndex: new Map([['p2', 0]]) }) === 'p2,p1,p3');
  t.check('활동 기준이면 그룹 안 최신 활동이 대표값',
    gOrder(gs, 'activity', { lastChangeAt: new Map([['a', 10], ['c', 50], ['e', 30]]) }) === 'p2,p3,p1');
  t.check('활동 기록이 전혀 없는 그룹끼리는 첫 등장 순서',
    gOrder(gs, 'activity', { lastChangeAt: new Map() }) === 'p1,p2,p3');
  t.check('알 수 없는 그룹 정렬 기준은 상태 정렬로 대체',
    gOrder(gs, '무엇') === 'p3,p1,p2');

  // ── 골격 재생성 서명 ──
  const sig = (ss, ps) => dashboardSignature(ss, ps);
  const base = [{ id: 'a', projectId: 'p1', title: 'S1' }];
  t.check('같은 상태면 서명이 같다', sig(base, projects) === sig(base, projects));
  t.check('세션이 늘면 서명이 달라진다',
    sig(base, projects) !== sig(base.concat([{ id: 'b', projectId: 'p1', title: 'S2' }]), projects));
  t.check('세션 이름이 바뀌면 서명이 달라진다',
    sig(base, projects) !== sig([{ id: 'a', projectId: 'p1', title: '이름변경' }], projects));
  t.check('프로젝트 이름이 바뀌면 서명이 달라진다',
    sig(base, projects) !== sig(base, [{ id: 'p1', name: '알파둘' }]));
  t.check('소속 프로젝트가 바뀌면 서명이 달라진다',
    sig(base, projects) !== sig([{ id: 'a', projectId: 'p2', title: 'S1' }], projects));
  t.check('상태 변화만으로는 서명이 바뀌지 않는다 (값 갱신으로 충분)',
    sig([{ id: 'a', projectId: 'p1', title: 'S1', status: 'idle' }], projects)
    === sig([{ id: 'a', projectId: 'p1', title: 'S1', status: 'waiting' }], projects));
  t.check('세션이 없으면 빈 서명', sig([], projects) === '');

  // ── 진행 시간 표기 ──
  t.check('1분 미만은 초', formatRunElapsed(4200) === '4초');
  t.check('1분 이상은 분:초', formatRunElapsed(74000) === '1:14');
  t.check('초는 두 자리로 채운다', formatRunElapsed(65000) === '1:05');
  t.check('음수·0 도 안전', formatRunElapsed(-100) === '0초' && formatRunElapsed(0) === '0초');

  // ── 마지막 활동 표기 ──
  const now = 1_000_000_000;
  const since = (secAgo) => formatSinceChange(now, now - secAgo * 1000);
  t.check('45초 미만은 방금', since(0) === '방금' && since(44) === '방금');
  t.check('1시간 미만은 분 단위', since(60) === '1분 전' && since(600) === '10분 전');
  t.check('45초 이상은 최소 1분으로 올린다', since(45) === '1분 전');
  t.check('1일 미만은 시간 단위', since(3600) === '1시간 전' && since(7200) === '2시간 전');
  t.check('그 이상은 일 단위', since(86400) === '1일 전' && since(86400 * 3) === '3일 전');
  t.check('미래 시각도 안전하게 방금으로', formatSinceChange(now, now + 5000) === '방금');
};
