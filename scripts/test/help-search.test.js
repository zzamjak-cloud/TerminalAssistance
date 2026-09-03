// 도움말 팝업의 탭 렌더·검색·플랫폼 키 치환 검증.
// help.js 를 vm 샌드박스에 그대로 로드해 실제 구현을 돌린다 (DOM 없이 순수 함수만 호출).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'help.js');

function load(platform) {
  const sandbox = {
    App: { state: { platform } },
    escapeHtml: (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return sandbox.App;
}

const hits = (html) => {
  const m = /검색 결과 (\d+)건/.exec(html);
  return m ? Number(m[1]) : 0;
};

exports.name = '도움말 팝업 (탭 렌더 · 검색)';
exports.run = function (t) {
  const App = load('macos');
  const mod = App._helpModKey();

  t.check('macOS 는 Cmd 표기', mod === 'Cmd');
  t.check('탭 정의 3개 (단축키·터미널·Git)', App.HELP_TAB_DEFS.length === 3);
  t.check('모든 탭에 데이터가 있다',
    App.HELP_TAB_DEFS.every((d) => Array.isArray(App[d.data]) && App[d.data].length > 0));
  t.check('모든 항목이 [키, 설명] 쌍',
    App.HELP_TAB_DEFS.every((d) => App[d.data].every((g) =>
      g.title && g.items.length && g.items.every((it) => it.length === 2 && it[0] && it[1]))));

  const shortcuts = App._helpTabHtml('shortcuts', mod);
  t.check('단축키 탭에 Mod 가 Cmd 로 치환된다', shortcuts.includes('Cmd+J') && !shortcuts.includes('Mod+'));
  t.check('알 수 없는 탭 id 는 첫 탭으로 대체', App._helpTabHtml('nope', mod) === shortcuts);
  t.check('터미널 탭 렌더', App._helpTabHtml('terminal', mod).includes('grep'));
  t.check('Git 탭 렌더', App._helpTabHtml('git', mod).includes('git rebase'));

  t.check('설명으로 검색 (한글)', hits(App._helpSearchHtml('브랜치', mod)) > 0);
  t.check('명령으로 검색', hits(App._helpSearchHtml('grep', mod)) > 0);
  t.check('대소문자 무시', hits(App._helpSearchHtml('GREP', mod)) === hits(App._helpSearchHtml('grep', mod)));
  t.check('치환된 키로 검색', hits(App._helpSearchHtml('Cmd+J', mod)) === 1);
  t.check('원본 Mod 표기로도 검색', hits(App._helpSearchHtml('Mod+J', mod)) === 1);
  t.check('검색은 3탭 전체를 훑는다 (탭 배지 노출)',
    App._helpSearchHtml('git', mod).includes('help-badge'));
  t.check('그룹 제목이 맞으면 그룹 전체가 결과에 들어온다',
    hits(App._helpSearchHtml('임시 저장', mod)) === App.HELP_GIT.find((g) => g.title.includes('임시 저장')).items.length);
  t.check('일치 부분은 <mark> 로 강조', App._helpSearchHtml('grep', mod).includes('<mark>grep</mark>'));
  t.check('결과 없으면 안내 문구', App._helpSearchHtml('zzzzq', mod).includes('해당하는 항목이 없습니다'));

  t.check('HTML 은 이스케이프된다', !App._helpMark('<b>x</b>', '').includes('<b>'));
  t.check('엔티티 내부는 강조하지 않아 마크업이 깨지지 않는다',
    App._helpMark('a & b', '&') === 'a &amp; b');

  const win = load('windows');
  const winHtml = win._helpTabHtml('shortcuts', win._helpModKey());
  t.check('Windows 는 Ctrl 표기', win._helpModKey() === 'Ctrl');
  t.check('Windows 에서 Mod 가 Ctrl 로 치환된다', winHtml.includes('Ctrl+J') && !winHtml.includes('Mod+'));
};
