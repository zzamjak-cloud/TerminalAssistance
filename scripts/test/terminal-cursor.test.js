const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

exports.name = '터미널 커서 표시 설정';

exports.run = function run(t) {
  const source = fs.readFileSync(SRC, 'utf8');
  t.check(
    'xterm 입력 커서는 깜빡이지 않는 고정 커서로 만든다',
    /cursorBlink:\s*false\b/.test(source)
  );
};
