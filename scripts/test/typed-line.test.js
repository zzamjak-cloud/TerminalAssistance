// 터미널 입력 라인 추적기 검증 (Cmd/Ctrl+J 로 치던 입력을 프롬프트 입력창으로 잘라 오는 기능).
// terminal-view.js 를 vm 샌드박스에 그대로 로드해 실제 구현을 돌린다 — DOM 은 객체 리터럴
// 평가에 필요한 만큼만 흉내 내고, xterm 버퍼는 화면 줄 배열로 대체한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

// ta.write 로 나간 데이터를 모아 백스페이스 개수를 센다
const writes = [];

function loadTerminalView() {
  const sandbox = {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    ta: { write: (id, data) => writes.push([id, data]) },
    App: { state: { platform: 'windows' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    // 구현이 불일치 진단을 console.warn 으로 남기므로 테스트 출력에서 가린다
    console: { log() {}, warn() {}, error() {} },
  };
  return vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';TerminalView', sandbox);
}

// 화면 줄 목록으로 가짜 xterm 버퍼를 만든다.
// cursorAt 을 주지 않으면 마지막 줄에 커서가 있다고 본다 (셸의 프롬프트 줄).
function fakeView(lines, opts) {
  const o = opts || {};
  const wrapped = o.wrapped || [];
  const cursorY = o.cursorAt === undefined ? lines.length - 1 : o.cursorAt;
  return {
    typedText: '',
    typedValid: true,
    cutFailReason: '',
    term: {
      rows: Math.max(lines.length, 12),
      buffer: {
        active: {
          baseY: 0,
          cursorY,
          length: lines.length,
          getLine: (y) => (lines[y] === undefined ? null : {
            isWrapped: !!wrapped[y],
            // trim=true 는 xterm 과 같이 우측 공백만 제거한다
            translateToString: (trim) => (trim ? lines[y].replace(/\s+$/, '') : lines[y]),
          }),
        },
      },
    },
  };
}

exports.name = '터미널 입력 라인 추적기 (Cmd/Ctrl+J 잘라내기)';

exports.run = function run(t) {
  const TerminalView = loadTerminalView();
  let seq = 0;

  // feed: PTY 로 나간 사용자 입력 조각들 / expectCut: 잘라내 온 문자열 / expectDels: 보낸 백스페이스 수
  const check = (name, lines, feed, expectCut, expectDels, opts) => {
    const id = 'session-' + (seq++);
    TerminalView.views.set(id, fakeView(lines, opts));
    writes.length = 0;
    for (const chunk of feed) TerminalView.noteTypedData(id, chunk);
    const cut = TerminalView.cutTypedLine(id);
    const dels = writes.length ? Array.from(writes[0][1]).length : 0;
    t.check(name, cut === expectCut && dels === expectDels,
      `cut=${JSON.stringify(cut)} dels=${dels} (기대 ${JSON.stringify(expectCut)}, ${expectDels})`);
    TerminalView.views.delete(id);
  };

  // ── 잘라내야 하는 경우 ──
  check('셸 프롬프트 뒤 텍스트', ['PS D:\\proj> hello world'],
    ['h', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'], 'hello world', 11);
  check('TUI 입력 상자(│ > … │)', ['╭──────────────╮', '│ > 리팩터링 해줘        │'],
    ['리팩터링', ' ', '해줘'], '리팩터링 해줘', 7);
  check('한글은 글자 수만큼 백스페이스', ['│ > 테스트 코드 작성   │'],
    ['테스트', ' ', '코드', ' ', '작성'], '테스트 코드 작성', 9);
  check('백스페이스 반영', ['> ab'], ['a', 'b', 'c', '\x7f'], 'ab', 2);
  check('붙여넣은 텍스트 포함', ['> hi there'],
    ['h', 'i', '\x1b[200~ there\x1b[201~'], 'hi there', 8);
  check('셸에서 래핑된 긴 입력', ['PS D:\\p> ' + 'a'.repeat(71), 'a'.repeat(9) + 'bcd'],
    ['a'.repeat(80), 'bcd'], 'a'.repeat(80) + 'bcd', 83, { wrapped: [false, true] });
  check('공백으로 끝나는 입력도 공백까지', ['PS D:\\p> git commit '],
    ['git commit '], 'git commit ', 11);
  // Ink 계열 TUI 는 실제 커서를 숨기고 자체 커서를 그려 커서 줄이 입력 상자가 아니다
  check('커서가 입력 상자 밖에 있는 TUI', [
    '● 이전 답변 …',
    '╭──────────────────────────╮',
    '│ > 안녕하세요 테스트            │',
    '╰──────────────────────────╯',
    '  ? for shortcuts',
  ], ['안녕하세요', ' ', '테스트'], '안녕하세요 테스트', 9);
  // 대체 버퍼는 위쪽부터 프레임을 그려 화면 아래쪽이 빈 줄로 남는다
  check('대체 버퍼 위쪽 프레임 + 아래 빈 줄', [
    '● 무엇을 도와드릴까요?',
    '╭──────────────────────────╮',
    '│ > 그렇다고 어쩌라고            │',
    '╰──────────────────────────╯',
    '  ? for shortcuts',
    '', '', '', '', '', '', '',
  ], ['그렇다고', ' ', '어쩌라고', ' '], '그렇다고 어쩌라고 ', 10);
  // TUI 가 입력을 여러 줄로 접어 뒷부분만 보이는 경우 — 12글자 이상 겹치면 인정
  check('여러 줄로 접힌 긴 TUI 입력', ['│ 코드를 리팩터링해서 테스트까지 붙여줘 │'],
    ['이 파일의 코드를 리팩터링해서 테스트까지 붙여줘'],
    '이 파일의 코드를 리팩터링해서 테스트까지 붙여줘', 26);

  // ── 잘라내면 안 되는 경우 (터미널 내용을 그대로 둔다) ──
  check('Enter 전송 뒤', ['PS D:\\proj> '], ['a', 'b', 'c', '\r'], '', 0);
  check('Ctrl+U 뒤', ['> '], ['a', 'b', '\x15'], '', 0);
  check('방향키 뒤 (커서 위치를 모른다)', ['PS D:\\proj> abc'],
    ['a', 'b', 'c', '\x1b[D'], '', 0);
  check('Tab 완성 뒤 (셸이 라인을 고쳐 쓴다)', ['PS D:\\proj> src/'],
    ['s', 'r', 'c', '\t'], '', 0);
  check('화면과 추적 내용 불일치', ['npm ERR! code ELIFECYCLE'], ['h', 'i', '!'], '', 0);
  check('짧은 텍스트의 우연한 끝 일치', ['빌드 완료 e'], ['e'], '', 0);
  check('아래쪽 훑기가 엉뚱한 줄을 잡지 않음', [
    '> 다른 세션에서 쓴 프롬프트',
    '실행 로그 한 줄',
    '╭───────╮',
    '│ >          │',
    '╰───────╯',
  ], ['옮길 내용 12글자 이상 있음'], '', 0);
  check('공백만 입력', ['PS D:\\p>    '], [' ', ' ', ' '], '', 0);
  check('추적 상한 초과', ['> ' + 'x'.repeat(10)], ['x'.repeat(4001)], '', 0);

  // 실패 사유가 UI 토스트 분기와 맞는지 — 'invalid'(추적 불가) / 'mismatch'(화면 불일치)
  const reasonOf = (lines, feed) => {
    const id = 'reason-' + (seq++);
    TerminalView.views.set(id, fakeView(lines));
    for (const chunk of feed) TerminalView.noteTypedData(id, chunk);
    TerminalView.cutTypedLine(id);
    const why = TerminalView.cutFailReason(id);
    TerminalView.views.delete(id);
    return why;
  };
  t.check("실패 사유: 방향키 → 'invalid'",
    reasonOf(['> abc'], ['a', 'b', 'c', '\x1b[D']) === 'invalid');
  t.check("실패 사유: 화면 불일치 → 'mismatch'",
    reasonOf(['npm ERR!'], ['h', 'i', '!']) === 'mismatch');
  t.check('실패 사유: 잘라낼 것이 없으면 비어 있음',
    reasonOf(['> '], ['a', '\r']) === '');
};
