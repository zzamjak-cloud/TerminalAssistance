// WebGL 렌더링 깨짐 방어 검증 — 아틀라스 페이지 병합 뒤 재그리기와 컨텍스트 소실 재부착.
// terminal-view.js 를 vm 샌드박스에 그대로 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');

// rAF 는 즉시 실행으로 대체해 재부착 경로를 동기적으로 관찰한다
function loadTerminalView() {
  const sandbox = {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    ta: { write() {}, resize() {} },
    App: { state: { platform: 'macos' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} },
  };
  return vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';TerminalView', sandbox);
}

// 아틀라스 페이지 수를 흉내 내는 가짜 TextureAtlas (실제 xterm 은 설정이 같은 터미널끼리 공유)
function fakeAtlas(pages) {
  return { pages: new Array(pages).fill(null).map(() => ({})) };
}

// onAddTextureAtlasCanvas 를 흉내 내는 가짜 WebglAddon — 테스트가 직접 발화시킨다
function fakeAddon(atlas) {
  const listeners = [];
  return {
    _renderer: { _charAtlas: atlas },
    onAddTextureAtlasCanvas(cb) { listeners.push(cb); },
    fire() { for (const cb of listeners) cb({}); },
  };
}

function fakeView(opts) {
  const o = opts || {};
  const active = o.active !== false;
  return {
    webgl: o.webgl === undefined ? fakeAddon(o.atlas || fakeAtlas(o.pages || 1)) : o.webgl,
    webglFailures: 0,
    cleared: 0,
    refreshed: 0,
    holder: { classList: { contains: () => active } },
    term: {
      rows: 24,
      clearTextureAtlas() { this._v.cleared++; },
      refresh() { this._v.refreshed++; },
    },
  };
}

function mount(TV, id, v) {
  v.term._v = v;
  TV.views.set(id, v);
  return v;
}

// 실제 xterm 의 _createNewPage 병합 순서를 재현한다: 4장 삭제 → 병합 1장 push + 발화 → 새 1장 push + 발화
function simulateMerge(atlas, addon) {
  atlas.pages.splice(0, 4);
  atlas.pages.push({});
  addon.fire();
  atlas.pages.push({});
  addon.fire();
}

exports.name = 'WebGL 텍스처 아틀라스 · 컨텍스트 소실 방어';

exports.run = function run(t) {
  const TV = loadTerminalView();

  // ── 회귀(0.18.6~0.18.7): 아틀라스를 선제적으로 비우는 경로가 없어야 한다 ──
  // 아틀라스는 세션끼리 공유되고 clearTextureAtlas 는 호출한 뷰만 모델을 다시 만들므로,
  // 주기적으로 비우면 출력이 멈춘 패널이 빈 화면으로 남는다.
  t.check('주기 감시 타이머가 없다', typeof TV._guardAtlas !== 'function' && TV.ATLAS_CHECK_MS === undefined);
  t.check('시간 기반 강제 초기화가 없다', TV.ATLAS_MAX_AGE_MS === undefined && typeof TV._clearAtlas !== 'function');

  // ── 병합 감지 → 모든 뷰 재그리기 ──
  // 병합은 어떤 뷰의 프레임 도중 일어나 그 프레임은 병합 전 좌표로 그려진다. xterm 은 플래그를
  // 세워 다음 renderRows 에서 모델을 다시 만들지만, 출력이 멈춘 뷰에는 그 계기가 없다.
  const shared = fakeAtlas(16);
  const busyAddon = fakeAddon(shared);
  const busy = mount(TV, 'a', fakeView({ webgl: busyAddon }));
  const idle = mount(TV, 'b', fakeView({ atlas: shared }));
  const idleHidden = mount(TV, 'c', fakeView({ atlas: shared, active: false }));
  TV._watchAtlasMerge(busy, busyAddon);

  // 단순 페이지 증가는 좌표가 그대로 → 재그리기 불필요
  shared.pages.push({});
  busyAddon.fire();
  t.check('페이지가 단순히 늘어난 것은 병합이 아니다', idle.refreshed === 0 && (TV.atlasMerges || 0) === 0,
    `refreshed=${idle.refreshed} merges=${TV.atlasMerges}`);

  simulateMerge(shared, busyAddon);
  t.check('병합을 한 번으로 감지한다', TV.atlasMerges === 1, `merges=${TV.atlasMerges}`);
  t.check('출력이 멈춘 패널을 다시 그린다', idle.refreshed >= 1, `refreshed=${idle.refreshed}`);
  t.check('숨은 패널에도 재그리기를 요청한다(보일 때 갚는다)', idleHidden.refreshed >= 1, `refreshed=${idleHidden.refreshed}`);
  t.check('병합 감지는 아틀라스를 비우지 않는다',
    busy.cleared + idle.cleared + idleHidden.cleared === 0,
    `cleared=${busy.cleared + idle.cleared + idleHidden.cleared}`);

  // 두 번째 병합도 감지한다 (기준 페이지 수가 갱신되어야 한다)
  while (shared.pages.length < 16) shared.pages.push({});
  busyAddon.fire();
  const before = idle.refreshed;
  simulateMerge(shared, busyAddon);
  t.check('이어지는 병합도 감지한다', TV.atlasMerges === 2 && idle.refreshed > before,
    `merges=${TV.atlasMerges} refreshed=${idle.refreshed}`);
  TV.views.clear();
  TV.atlasMerges = 0;

  // 페이지 수를 못 읽는 환경에서는 보수적으로 매번 재그리기를 요청한다
  const opaqueAddon = { _renderer: {}, _cb: null, onAddTextureAtlasCanvas(cb) { this._cb = cb; } };
  const opaque = mount(TV, 'd', fakeView({ webgl: opaqueAddon }));
  TV._watchAtlasMerge(opaque, opaqueAddon);
  opaqueAddon._cb({});
  t.check('페이지 수를 못 읽으면 캔버스 추가마다 다시 그린다', opaque.refreshed === 1, `refreshed=${opaque.refreshed}`);
  TV.views.clear();

  // 이벤트를 노출하지 않는 애드온이어도 부착이 깨지지 않는다
  const legacyAddon = { _renderer: {} };
  const legacy = mount(TV, 'e', fakeView({ webgl: legacyAddon }));
  let threw = false;
  try { TV._watchAtlasMerge(legacy, legacyAddon); } catch (_) { threw = true; }
  t.check('병합 이벤트가 없는 애드온에도 안전하다', !threw);
  TV.views.clear();

  // ── 수동 재그리기 (Mod+Shift+R) ──
  // 공유 뷰 각각에 clearTextureAtlas 를 부른다 — 첫 호출이 아틀라스를 비우고 나머지는
  // xterm 이 조기 반환해 그 뷰의 모델 초기화 + 재그리기만 한다. 한 뷰만 부르면 나머지는 빈 화면.
  const shared2 = fakeAtlas(3);
  const m1 = mount(TV, 'f', fakeView({ atlas: shared2 }));
  const m2 = mount(TV, 'g', fakeView({ atlas: shared2 }));
  const off = mount(TV, 'h', fakeView({ atlas: shared2, active: false }));
  const dom = mount(TV, 'i', fakeView({ webgl: null }));
  TV.redrawVisible();
  t.check('보이는 WebGL 뷰는 각각 모델을 다시 만든다(공유 아틀라스 함정 회피)',
    m1.cleared === 1 && m2.cleared === 1, `m1=${m1.cleared} m2=${m2.cleared}`);
  t.check('숨은 뷰는 건드리지 않는다', off.cleared === 0 && off.refreshed === 0,
    `cleared=${off.cleared} refreshed=${off.refreshed}`);
  t.check('DOM 렌더러 뷰는 재그리기만 요청한다', dom.cleared === 0 && dom.refreshed === 1,
    `cleared=${dom.cleared} refreshed=${dom.refreshed}`);
  TV.views.clear();

  // ── 컨텍스트 소실 → 재부착, 연속 실패는 상한에서 멈춘다 ──
  let created = 0;
  const losses = [];
  function WebglAddonStub() {
    created++;
    this.onContextLoss = (cb) => losses.push(cb);
    this.dispose = () => {};
  }
  // WebglAddon 은 모듈 스코프 전역으로 참조되므로 vm 컨텍스트에 심어 다시 로드한다
  const TV2 = vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';TerminalView', {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    ta: { write() {}, resize() {} },
    App: { state: { platform: 'macos' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} },
    WebglAddon: { WebglAddon: WebglAddonStub },
  });

  const view = {
    webgl: null, webglFailures: 0,
    holder: { classList: { contains: () => true } },
    term: { rows: 24, loadAddon() {} },
  };
  TV2._attachWebgl(view);
  t.check('WebGL 부착 시 애드온을 만든다', created === 1 && !!view.webgl, `created=${created}`);

  // 소실 콜백을 차례로 때려 상한(WEBGL_MAX_FAILURES)까지만 재부착하는지 본다
  let guard = 0;
  while (losses.length && guard++ < 10) losses.shift()();
  t.check('컨텍스트 소실 뒤 다시 붙는다', created > 1, `created=${created}`);
  t.check('연속 실패는 상한에서 멈춘다 (DOM 렌더러로 고정)',
    created === TV2.WEBGL_MAX_FAILURES && view.webgl === null,
    `created=${created} limit=${TV2.WEBGL_MAX_FAILURES} webgl=${view.webgl}`);

  // 상한에 걸린 직후의 재시도는 막혀야 한다 (연속 실패 = 이 환경에서 WebGL 이 안 되는 것)
  const capped = created;
  losses.length = 0;
  TV2._attachWebgl(view);
  t.check('상한 직후에는 재부착하지 않는다', created === capped && view.webgl === null, `created=${created}`);

  // 영구 강등은 아니다 — 마지막 소실로부터 충분히 지난 뒤의 시도는 다시 받아 준다
  view.webglLossAt = Date.now() - TV2.WEBGL_FAILURE_RESET_MS - 1;
  TV2._attachWebgl(view);
  t.check('충분히 지난 뒤에는 다시 시도한다',
    created === capped + 1 && !!view.webgl && view.webglFailures === 0,
    `created=${created} failures=${view.webglFailures}`);

  // 이미 붙어 있으면 중복 생성하지 않는다 (syncLayout 의 rAF 와 소실 rAF 가 겹쳐도 멱등)
  const attached = created;
  TV2._attachWebgl(view);
  t.check('이미 붙어 있으면 중복 생성하지 않는다', created === attached, `created=${created}`);

  // 숨은 패널이면 재부착하지 않는다 — 안 보이는 세션이 컨텍스트를 도로 물면 안 된다
  const gone = [];
  let created2 = 0;
  let visible = true;
  function WebglAddonStub2() {
    created2++;
    this.onContextLoss = (cb) => gone.push(cb);
    this.dispose = () => {};
  }
  const TV3 = vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';TerminalView', {
    document: { getElementById: () => null, createElement: () => ({}) },
    window: { addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    ta: { write() {}, resize() {} },
    App: { state: { platform: 'macos' }, isSplit: () => false },
    SPLIT_MAX_PANES: 6,
    console: { log() {}, warn() {}, error() {} },
    WebglAddon: { WebglAddon: WebglAddonStub2 },
  });
  const hiddenView = {
    webgl: null, webglFailures: 0,
    holder: { classList: { contains: () => visible } },
    term: { rows: 24, loadAddon() {} },
  };
  TV3._attachWebgl(hiddenView);
  visible = false;
  gone.shift()();
  t.check('숨은 패널은 소실 뒤 재부착하지 않는다',
    created2 === 1 && hiddenView.webgl === null, `created=${created2}`);
};
