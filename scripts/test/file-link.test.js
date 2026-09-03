const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

exports.name = '터미널 파일 경로 링크 감지';

// terminal-view.js 는 브라우저 전역에 의존하므로 통째로 require 하지 않고,
// 링크 패턴 정의만 떼어내 같은 규칙으로 평가한다.
function loadMatcher() {
  const src = fs.readFileSync(SRC, 'utf8');
  const exts = src.match(/const FILE_LINK_EXTS =[\s\S]*?;\r?\n/)[0];
  const re = src.match(/FILE_LINK_RE: \(\(\) => \{[\s\S]*?\}\)\(\),/)[0]
    .replace('FILE_LINK_RE: ', 'const FILE_LINK_RE = ').replace(/,$/, ';');
  const tail = src.match(/FILE_LINK_TAIL_RE: new RegExp\([\s\S]*?\),\r?\n/)[0]
    .replace('FILE_LINK_TAIL_RE: new RegExp(', 'const FILE_LINK_TAIL_RE = new RegExp(')
    .replace(/\),\s*$/, ');');
  // _computeFileLinks 의 매치 후처리와 같은 순서로 꼬리를 다듬는다
  return new Function(exts + re + tail + `
    return (text) => {
      const out = [];
      FILE_LINK_RE.lastIndex = 0;
      let m;
      while ((m = FILE_LINK_RE.exec(text))) {
        out.push(m[0].replace(/[.,;'\"”’]+$/, '').replace(FILE_LINK_TAIL_RE, '$1'));
      }
      return out;
    };
  `)();
}

exports.run = function run(t) {
  const links = loadMatcher();
  const first = (text) => links(text)[0];

  t.check(
    '경로 뒤에 붙은 한국어 조사는 링크에서 뺀다',
    first('승인하시면 docs/specs/2026-09-03-design.md로 스펙을 쓰고')
      === 'docs/specs/2026-09-03-design.md',
    first('승인하시면 docs/specs/2026-09-03-design.md로 스펙을 쓰고')
  );
  t.check(
    '단독 파일명 뒤의 조사도 뺀다',
    first('terminal-view.js에서 고쳤다') === 'terminal-view.js',
    first('terminal-view.js에서 고쳤다')
  );
  t.check(
    '한글 파일명 자체는 그대로 남는다',
    first('docs/설계/한글문서.md 확인') === 'docs/설계/한글문서.md',
    first('docs/설계/한글문서.md 확인')
  );
  t.check(
    '줄번호 꼬리는 유지한다',
    first('src/renderer/app.js:12 참고') === 'src/renderer/app.js:12',
    first('src/renderer/app.js:12 참고')
  );
  t.check(
    '윈도우 절대경로 + 조사',
    first('C:\\proj\\note.md에 저장') === 'C:\\proj\\note.md',
    first('C:\\proj\\note.md에 저장')
  );
};
