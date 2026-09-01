// 드롭다운 검색 매칭 검증 (패널 제목 드롭다운의 세션 검색창).
// util.js 를 vm 샌드박스에 그대로 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'util.js');
const fuzzyMatch = vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';fuzzyMatch', {});

exports.name = '드롭다운 검색 매칭 (fuzzyMatch)';
exports.run = function (t) {
  const fields = ['터미널 3', '/Users/woody/dev/AI/TerminalAssistance', 'TerminalAssistance'];

  t.check('빈 검색어는 모두 통과', fuzzyMatch(fields, '') && fuzzyMatch(fields, '   '));
  t.check('부분 문자열 일치', fuzzyMatch(fields, 'assist'));
  t.check('대소문자 무시', fuzzyMatch(fields, 'TERMINALASS'.slice(0, 8)));
  t.check('불완전 입력도 순서만 맞으면 일치', fuzzyMatch(fields, 'trmasi'));
  t.check('경로 조각으로 일치', fuzzyMatch(fields, 'dev/AI'));
  t.check('한글 제목 일치', fuzzyMatch(fields, '터미널'));
  t.check('토큰이 서로 다른 후보에 걸려도 일치', fuzzyMatch(fields, 'woody 터미널'));
  t.check('토큰 하나라도 빠지면 불일치', !fuzzyMatch(fields, 'woody zzz'));
  t.check('순서가 뒤집히면 불일치', !fuzzyMatch(['terminal'], 'lanimret'));
  t.check('후보가 없으면 불일치', !fuzzyMatch([], 'x'));
  t.check('null 후보는 건너뛴다', fuzzyMatch([null, 'terminal'], 'term'));
  t.check('문자열 하나만 넘겨도 동작', fuzzyMatch('terminal', 'tml'));
};
