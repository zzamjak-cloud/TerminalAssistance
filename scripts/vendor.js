// xterm 배포 파일을 node_modules → src/renderer/vendor 로 복사 (번들러 없이 정적 서빙)
// 복사본은 저장소에 커밋한다 — CI/신규 클론에서 npm install 없이도 프론트가 완결되도록.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js']
];

for (const [src, dst] of files) {
  fs.copyFileSync(path.join(root, src), path.join(out, dst));
  console.log(`vendor: ${dst}`);
}
