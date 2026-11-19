const fs = require('fs');
const path = require('path');

const TermLinks = require(path.join(__dirname, '..', '..', 'src', 'renderer', 'term-links.js'));
const VIEW_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

exports.name = '터미널 링크 후보·명령어 한 줄 복사';

function loadRegexes() {
  const src = fs.readFileSync(VIEW_SRC, 'utf8');
  const exts = src.match(/const FILE_LINK_EXTS =[\s\S]*?;\r?\n/)[0];
  const re = src.match(/FILE_LINK_RE: \(\(\) => \{[\s\S]*?\}\)\(\),/)[0]
    .replace('FILE_LINK_RE: ', 'const FILE_LINK_RE = ').replace(/,$/, ';');
  const tail = src.match(/FILE_LINK_TAIL_RE: new RegExp\([\s\S]*?\),\r?\n/)[0]
    .replace('FILE_LINK_TAIL_RE: new RegExp(', 'const FILE_LINK_TAIL_RE = new RegExp(')
    .replace(/\),\s*$/, ');');
  return new Function(exts + re + tail + 'return { FILE_LINK_RE, FILE_LINK_TAIL_RE };')();
}

// 텍스트 행 → joinCommandRows 입력 (cols 폭 기준으로 끝 열 계산, ASCII 전용)
function rows(lines, cols) {
  return lines.map((l, i) => {
    const body = l.replace(/\s+$/, '');
    return { raw: l, body, wrapped: false, trailingSpace: body.length < l.length, lastCol: body.length - 1 };
  });
}

exports.run = function run(t) {
  const { FILE_LINK_RE, FILE_LINK_TAIL_RE } = loadRegexes();
  const paths = (text) => TermLinks.candidates(text, FILE_LINK_RE, FILE_LINK_TAIL_RE).map((c) => c.path);

  // Claude Code 70열 실캡처: 폭 끝 토큰 절단 + 단어 경계의 줄 끝 공백 + 2칸 들여쓰기
  const claude = rows([
    '⏺ ! sh /private/tmp/claude-501/-Users-woody/30e7b2e1-5a15-4d1e-bc5f-57',
    '  d694cac4ba/scratchpad/install-k780-keymap.sh --force --verbose ',
    '  --log-file /tmp/k780-install.log'
  ], 70);
  const want = '! sh /private/tmp/claude-501/-Users-woody/30e7b2e1-5a15-4d1e-bc5f-57d694cac4ba/scratchpad/install-k780-keymap.sh --force --verbose --log-file /tmp/k780-install.log';
  const got = TermLinks.joinCommandRows(claude, 70);
  t.check('Claude TUI 줄바꿈 명령을 한 줄로 잇는다', got === want, got);

  // Codex 실캡처: '-'·'/' 뒤에서 끊고 줄 끝 공백 없음
  const codex = rows([
    '  sh /private/tmp/claude-501/-Users-woody/30e7b2e1-5a15-',
    '  4d1e-bc5f-57d694cac4ba/scratchpad/install-k780-keymap.sh --force',
    '  --verbose --log-file /tmp/k780-install.log'
  ], 70);
  const got2 = TermLinks.joinCommandRows(codex, 70);
  t.check('Codex TUI 줄바꿈 명령을 한 줄로 잇는다',
    got2 === 'sh /private/tmp/claude-501/-Users-woody/30e7b2e1-5a15-4d1e-bc5f-57d694cac4ba/scratchpad/install-k780-keymap.sh --force --verbose --log-file /tmp/k780-install.log', got2);

  const got3 = TermLinks.joinCommandRows(rows(['  docker run \\', '    -p 80:80 nginx'], 70), 70);
  t.check('셸 줄 잇기(\\)는 공백 하나로', got3 === 'docker run -p 80:80 nginx', got3);

  const sp = paths('설정 파일 ~/Library/Application Support/cloud.zzamjak.terminalassistance/ta-config.json 확인');
  t.check('공백 포함 절대경로 후보를 만든다',
    sp.includes('~/Library/Application Support/cloud.zzamjak.terminalassistance/ta-config.json'), sp.join(' | '));

  const ln = TermLinks.candidates('src/renderer/app.js:12 참고', FILE_LINK_RE, FILE_LINK_TAIL_RE)[0];
  t.check('줄번호를 분리한다', ln.path === 'src/renderer/app.js' && ln.line === 12, JSON.stringify(ln));

  t.check('스킴 없는 도메인 주소는 https 로', TermLinks.webUrlFor('github.com/topics/blender-addon', false)
    === 'https://github.com/topics/blender-addon');
  t.check('GitHub 맥락의 owner/repo 는 GitHub 링크', TermLinks.webUrlFor('ksami/QRemeshify', true)
    === 'https://github.com/ksami/QRemeshify');
  t.check('GitHub 맥락이 없으면 owner/repo 를 링크로 만들지 않는다', TermLinks.webUrlFor('SSN/ITIN', false) === null);
  t.check('대문자 약어 쌍(SSN/ITIN)은 GitHub 맥락에서도 제외', TermLinks.webUrlFor('SSN/ITIN', true) === null);
  t.check('파일처럼 보이는 a/b.md 는 GitHub 링크가 아니다', TermLinks.webUrlFor('docs/readme.md', true) === null);

  const picked = TermLinks.pickNonOverlapping([{ start: 0, end: 5 }, { start: 0, end: 20 }, { start: 22, end: 30 }]);
  t.check('겹치는 후보는 긴 것을 고른다', picked.length === 2 && picked[0].end === 20, JSON.stringify(picked));

  const sep = TermLinks.urls('https://example.com/a/very/long/path', (i) => (i < 20 ? 0 : 1));
  t.check('여러 행에 걸친 URL 을 찾는다', sep.length === 1 && sep[0].url === 'https://example.com/a/very/long/path');
};
