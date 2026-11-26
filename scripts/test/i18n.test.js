// 영어 사전 점검 — 사전끼리 같은 키를 다른 번역으로 덮어쓰지 않는지, tr() 키가 모두 사전에 있는지.
// 키는 한국어 원문이라 누락되면 영어 화면에 한국어가 섞인다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src');
const DICTS = [
  'renderer/i18n/en-static.js', 'renderer/i18n/en-shared.js', 'renderer/i18n/en-core.js',
  'renderer/i18n/en-modals.js', 'renderer/i18n/en-help.js', 'renderer/i18n/en-misc.js', 'mobile/en-mobile.js'
];

module.exports = {
  name: 'i18n 영어 사전',
  run(t) {
    const all = new Map();
    const conflicts = [];
    for (const f of DICTS) {
      const box = { window: {} };
      vm.createContext(box);
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), box);
      for (const [k, v] of Object.entries(box.window.I18N_DICT.en)) {
        const prev = all.get(k);
        if (prev && prev.v !== v) conflicts.push(`${k}: ${prev.f}="${prev.v}" / ${path.basename(f)}="${v}"`);
        all.set(k, { v, f: path.basename(f) });
      }
    }
    t.check('사전끼리 같은 키를 다른 번역으로 덮어쓰지 않는다', conflicts.length === 0, conflicts.join('\n'));
    const korean = [...all].filter(([, x]) => /[가-힣]/.test(x.v)).map(([k]) => k);
    t.check('영어 값에 한국어가 없다', korean.length === 0, korean.join(', '));

    const files = fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => 'renderer/' + f)
      .concat(['mobile/mobile.js', 'mobile/remote-core.js']);
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // 문자열 하나로 끝나는 tr('...') 만 본다 — '+' 로 이어붙인 키는 건너뛴다
      for (const m of src.matchAll(/\btr\(\s*'((?:\\.|[^'\\])*)'\s*(?=[,)])/g)) {
        const key = JSON.parse('"' + m[1].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
        if (/[가-힣]/.test(key) && !all.has(key)) missing.push(`${f}: ${key}`);
      }
    }
    t.check('tr() 키가 모두 사전에 있다', missing.length === 0, missing.join('\n'));
  }
};
