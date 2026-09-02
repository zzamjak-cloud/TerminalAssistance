const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js');

exports.name = '프리셋 즉시 실행 전송';

exports.run = function run(t) {
  const source = fs.readFileSync(SRC, 'utf8');
  t.check(
    '실행 프리셋은 명령어와 Enter 를 하나의 PTY write 로 보낸다',
    /if\s*\(execute\)\s*\{\s*ta\.write\(id,\s*command\s*\+\s*'\x5cr'\);/.test(source)
  );
  t.check(
    '비실행 프리셋은 기존처럼 paste 로 입력만 채운다',
    /else\s*\{\s*TerminalView\.paste\(id,\s*command\);/.test(source)
  );
};
