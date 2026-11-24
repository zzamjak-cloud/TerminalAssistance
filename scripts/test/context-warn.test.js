// 컨텍스트 경고 판정(contextWarnDecision) 검증 — context-warn.js 를 vm 샌드박스에 로드한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'context-warn.js');

function load() {
  const sandbox = { App: {}, ta: {}, TerminalView: { views: new Map() }, Map, setInterval, clearInterval };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8') + ';globalThis.__d = contextWarnDecision;', sandbox);
  return sandbox.__d;
}

exports.name = '컨텍스트 경고 판정';

exports.run = async function (t) {
  const d = load();
  const st = { contextWarnClaudeK: 200, contextWarnCodexPct: 60 };
  const claude = (tokens, convId = 'a') => ({ agent: 'claude', tokens, window: null, convId });
  const codex = (tokens, window = 200000, convId = 'c') => ({ agent: 'codex', tokens, window, convId });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  t.check('usage null → 숨김, 닫기 기록 유지', eq(d(null, st, { convId: 'a', dismissedAt: 1 }), { show: false, reset: false }));
  t.check('claude 기준 이상 → 표시', eq(d(claude(200000), st, null), { show: true, reset: false }));
  t.check('claude 기준 미만 → 숨김 + 초기화', eq(d(claude(199999), st, null), { show: false, reset: true }));
  t.check('claude 설정 0 → 끔', d(claude(900000), { contextWarnClaudeK: 0 }, null).show === false);
  t.check('codex 창 대비 비율 이상 → 표시', d(codex(120000), st, null).show === true);
  t.check('codex 비율 미만 → 숨김', d(codex(119999), st, null).show === false);
  t.check('codex 창 없음 → 표시 안 함', d({ agent: 'codex', tokens: 999999, window: null, convId: 'c' }, st, null).show === false);
  t.check('codex 설정 0 → 끔', d(codex(190000), { contextWarnCodexPct: 0 }, null).show === false);
  t.check('닫은 직후 같은 대화는 숨김 유지', eq(d(claude(250000), st, { convId: 'a', dismissedAt: 250000 }), { show: false, reset: false }));
  t.check('claude 닫은 뒤 +100K 이상 → 재표시', eq(d(claude(350000), st, { convId: 'a', dismissedAt: 250000 }), { show: true, reset: true }));
  t.check('claude +100K 직전은 숨김', d(claude(349999), st, { convId: 'a', dismissedAt: 250000 }).show === false);
  t.check('codex 닫은 뒤 창의 10% 이상 → 재표시', d(codex(140000), st, { convId: 'c', dismissedAt: 120000 }).show === true);
  t.check('codex 10% 직전은 숨김', d(codex(139999), st, { convId: 'c', dismissedAt: 120000 }).show === false);
  t.check('대화가 바뀌면 닫기 기록 초기화 후 표시', eq(d(claude(250000, 'b'), st, { convId: 'a', dismissedAt: 250000 }), { show: true, reset: true }));
};
