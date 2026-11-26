// 렌더러 단위 테스트 러너 — scripts/test/*.test.js 를 순서대로 실행한다.
// 번들러·테스트 프레임워크 없이 순수 node 로 돌린다 (프로젝트의 무의존 원칙 유지).
// 각 테스트 파일은 { name, run(t) } 를 export 하고, run 안에서 t.check(설명, 조건) 을 부른다.
const fs = require('fs');
const path = require('path');

// 렌더러 코드는 UI 문자열을 tr()(src/renderer/i18n.js)로 감싼다. 테스트 샌드박스마다
// i18n.js 를 싣지 않아도 되도록, vm 컨텍스트를 만들 때 한국어 원문을 돌려주는 tr 을 넣어 둔다.
const vm = require('vm');
const trKo = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
const withTr = (o) => {
  const box = o || {};
  if (typeof box.tr !== 'function') box.tr = trKo;
  return box;
};
const origCreate = vm.createContext;
vm.createContext = (o, ...rest) => origCreate.call(vm, withTr(o), ...rest);
const origNew = vm.runInNewContext;
vm.runInNewContext = (code, o, ...rest) => origNew.call(vm, code, withTr(o), ...rest);

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

async function main() {
  for (const file of files) {
    const mod = require(path.join(dir, file));
    console.log(mod.name || file);
    await mod.run(t);
  }

  if (!files.length) {
    console.log('실행할 테스트가 없습니다 (scripts/test/*.test.js)');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
