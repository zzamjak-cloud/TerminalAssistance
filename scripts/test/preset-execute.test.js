const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js');

exports.name = '프리셋 즉시 실행 전송';

exports.run = function run(t) {
  const source = fs.readFileSync(SRC, 'utf8');
  t.check(
    '실행 프리셋은 명령어를 먼저 쓰고, 간격을 둔 뒤 Enter 를 별도 write 로 보낸다',
    /if\s*\(execute\)\s*\{[\s\S]*?ta\.write\(id,\s*command\);[\s\S]*?setTimeout\(r,\s*App\.PRESET_ENTER_DELAY_MS\)[\s\S]*?ta\.write\(id,\s*'\x5cr'\);/.test(source)
  );
  t.check(
    '명령어와 Enter 를 한 덩어리로 쓰지 않는다 (붙여넣기로 판정돼 줄바꿈만 들어감)',
    !/ta\.write\(id,\s*command\s*\+\s*'\x5cr'\)/.test(source)
  );
  const m = source.match(/PRESET_ENTER_DELAY_MS:\s*(\d+)/);
  t.check(
    'Enter 간격은 Codex 붙여넣기 판정 창(약 120ms)보다 길다',
    !!m && Number(m[1]) >= 150
  );
  t.check(
    '비실행 프리셋은 기존처럼 paste 로 입력만 채운다',
    /else\s*\{\s*TerminalView\.paste\(id,\s*command\);/.test(source)
  );
};
