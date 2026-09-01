// 렌더러 단위 테스트 러너 — scripts/test/*.test.js 를 순서대로 실행한다.
// 번들러·테스트 프레임워크 없이 순수 node 로 돌린다 (프로젝트의 무의존 원칙 유지).
// 각 테스트 파일은 { name, run(t) } 를 export 하고, run 안에서 t.check(설명, 조건) 을 부른다.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'test');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()
  : [];

let pass = 0;
let fail = 0;

// 테스트 파일에 넘기는 도구 — 통과/실패만 세고 실패 사유를 그대로 출력한다
const t = {
  check(name, ok, detail) {
    if (ok) {
      pass++;
      console.log('  ok   ' + name);
    } else {
      fail++;
      console.log('  FAIL ' + name + (detail === undefined ? '' : ' → ' + detail));
    }
  },
};

for (const file of files) {
  const mod = require(path.join(dir, file));
  console.log(mod.name || file);
  mod.run(t);
}

if (!files.length) {
  console.log('실행할 테스트가 없습니다 (scripts/test/*.test.js)');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
