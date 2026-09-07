// 워크트리 런처의 순수 함수 검증 — 경로 제안·사이드바 정렬·그룹 이동.
// worktree.js 를 vm 샌드박스에 그대로 로드해 실제 구현을 돌린다 (App/ta 는 빈 스텁).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'worktree.js');
const context = { App: {}, ta: {}, console };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__wt = { worktreeFolderName, suggestWorktreePath, orderProjectsWithWorktrees,'
  + ' insertWorktreeProject, moveProjectGroup };',
  context
);
const { worktreeFolderName, suggestWorktreePath, orderProjectsWithWorktrees,
  insertWorktreeProject, moveProjectGroup } = context.__wt;

const ids = (list) => list.map((p) => p.id).join(',');

exports.name = '워크트리 런처 (경로 제안 · 정렬 · 그룹 이동)';
exports.run = function (t) {
  // ── 브랜치명 → 폴더명 ──
  t.check('슬래시를 하이픈으로 접는다', worktreeFolderName('feat/login') === 'feat-login');
  t.check('origin/ 접두사를 뗀다', worktreeFolderName('origin/feat/login') === 'feat-login');
  t.check('공백과 금지문자를 하이픈으로', worktreeFolderName('fix: bad?name') === 'fix-bad-name');
  t.check('앞뒤 점·하이픈 제거', worktreeFolderName('/-hotfix-/') === 'hotfix');
  t.check('빈 입력은 기본 이름', worktreeFolderName('  ') === 'worktree');
  t.check('한글 브랜치명은 보존', worktreeFolderName('기능/로그인') === '기능-로그인');

  // ── 형제 폴더 경로 제안 ──
  t.check('posix 형제 폴더 경로',
    suggestWorktreePath('/dev', 'TerminalAssistance', 'feat/x', [])
    === '/dev/TerminalAssistance-feat-x');
  t.check('windows 구분자 유지',
    suggestWorktreePath('D:\\1_Client', 'TA', 'feat/x', [])
    === 'D:\\1_Client\\TA-feat-x');
  // git 은 Windows 에서도 슬래시 경로를 돌려준다 — 여기에 역슬래시를 섞지 않는다
  t.check('드라이브 문자 + 슬래시 경로는 슬래시를 유지',
    suggestWorktreePath('C:/dev/work', 'TA', 'feat/x', [])
    === 'C:/dev/work/TA-feat-x',
    suggestWorktreePath('C:/dev/work', 'TA', 'feat/x', []));
  t.check('경로가 겹치면 -2 를 붙인다',
    suggestWorktreePath('/dev', 'TA', 'x', ['/dev/TA-x'])
    === '/dev/TA-x-2');
  t.check('연속 충돌은 -3 까지 이어진다',
    suggestWorktreePath('/dev', 'TA', 'x', ['/dev/TA-x', '/dev/TA-x-2'])
    === '/dev/TA-x-3');
  t.check('구분자·대소문자가 달라도 같은 경로로 본다',
    suggestWorktreePath('/dev', 'TA', 'x', ['\\dev\\ta-x\\'])
    === '/dev/TA-x-2');
  t.check('끝 슬래시가 있어도 중복되지 않는다',
    suggestWorktreePath('/dev/', 'TA', 'x', []) === '/dev/TA-x');

  // ── 사이드바 표시 순서 ──
  const projects = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'wb1', name: 'feat', parentId: 'b', branch: 'feat' },
    { id: 'wa1', name: 'fix', parentId: 'a', branch: 'fix' },
  ];
  const ordered = orderProjectsWithWorktrees(projects);
  t.check('워크트리가 부모 바로 아래로 모인다',
    ordered.map((x) => x.project.id).join(',') === 'a,wa1,b,wb1',
    ordered.map((x) => x.project.id).join(','));
  t.check('워크트리만 depth 1', ordered.map((x) => x.depth).join(',') === '0,1,0,1');

  const orphan = orderProjectsWithWorktrees([
    { id: 'a', name: 'A' },
    { id: 'w', name: 'w', parentId: 'gone', branch: 'x' },
  ]);
  t.check('부모가 없는 워크트리는 최상위로 올라온다',
    orphan.length === 2 && orphan[1].depth === 0);
  t.check('branch 없는 parentId 는 워크트리로 보지 않는다',
    orderProjectsWithWorktrees([{ id: 'a' }, { id: 'b', parentId: 'a' }])[1].depth === 0);
  t.check('자기 자신을 부모로 가리켜도 무한루프가 없다',
    orderProjectsWithWorktrees([{ id: 'a', parentId: 'a', branch: 'x' }]).length === 1);

  // ── 새 워크트리 삽입 위치 (백엔드 add_project 와 같은 규칙) ──
  const list = [{ id: 'a' }, { id: 'wa1', parentId: 'a' }, { id: 'b' }];
  insertWorktreeProject(list, { id: 'wa2', parentId: 'a' });
  t.check('기존 형제 워크트리 뒤에 들어간다', ids(list) === 'a,wa1,wa2,b', ids(list));
  const noParent = [{ id: 'a' }];
  insertWorktreeProject(noParent, { id: 'w', parentId: 'zzz' });
  t.check('부모를 못 찾으면 맨 뒤로', ids(noParent) === 'a,w');

  // ── 드래그 정렬: 그룹 통째로 이동 ──
  const g = () => [
    { id: 'a' }, { id: 'wa1', parentId: 'a' }, { id: 'wa2', parentId: 'a' },
    { id: 'b' }, { id: 'wb1', parentId: 'b' }, { id: 'c' },
  ];
  let arr = g();
  moveProjectGroup(arr, 'a', 'c', true);
  t.check('앞으로 놓기 — 워크트리가 따라온다', ids(arr) === 'b,wb1,a,wa1,wa2,c', ids(arr));

  arr = g();
  moveProjectGroup(arr, 'a', 'b', false);
  t.check('뒤로 놓기 — 대상의 워크트리 다음 자리로', ids(arr) === 'b,wb1,a,wa1,wa2,c', ids(arr));

  arr = g();
  moveProjectGroup(arr, 'c', 'a', true);
  t.check('워크트리 없는 프로젝트 이동', ids(arr) === 'c,a,wa1,wa2,b,wb1', ids(arr));

  arr = g();
  moveProjectGroup(arr, 'wa1', 'c', true);
  t.check('워크트리는 스스로 움직이지 않는다', ids(arr) === ids(g()), ids(arr));

  arr = g();
  moveProjectGroup(arr, 'a', 'wb1', true);
  t.check('워크트리 위로는 놓을 수 없다', ids(arr) === ids(g()), ids(arr));

  arr = g();
  moveProjectGroup(arr, 'a', 'a', true);
  t.check('자기 자신에게 놓으면 그대로', ids(arr) === ids(g()));

  arr = g();
  moveProjectGroup(arr, 'a', 'nope', true);
  t.check('없는 대상이면 그대로', ids(arr) === ids(g()));
};
