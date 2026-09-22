// WebGL 렌더링 깨짐 방어 검증 — 텍스처 아틀라스 과밀 초기화와 컨텍스트 소실 재부착.
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

// 아틀라스 페이지 수와 상한을 흉내 내는 가짜 TextureAtlas.
// 실제 xterm 의 clearTexture 는 페이지 '내용'만 비우고 개수는 그대로 두므로 여기서도 그렇게 둔다.
function fakeAtlas(pages, limit) {
  const Atlas = function () {};
  Atlas.maxAtlasPages = limit;
  const atlas = new Atlas();
  atlas.pages = new Array(pages).fill(null).map(() => ({}));
  return atlas;
}

// 실제 xterm 은 폰트·테마·DPR 이 같은 터미널끼리 아틀라스를 공유한다 → atlas 를 넘겨 공유 재현
function fakeAddon(pages, limit, atlas) {
  return { _renderer: { _charAtlas: atlas || fakeAtlas(pages, limit) } };
}

function fakeView(opts) {
  const o = opts || {};
  let active = o.active !== false;
  return {
    webgl: o.webgl === undefined ? fakeAddon(o.pages || 1, o.limit || 16, o.atlas) : o.webgl,
    webglFailures: 0,
    atlasResetAt: o.atlasResetAt === undefined ? Date.now() : o.atlasResetAt,
    atlasPagesAtReset: 0,
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

exports.name = 'WebGL 텍스처 아틀라스 · 컨텍스트 소실 방어';

exports.run = function run(t) {
  const TV = loadTerminalView();

  // ── 과밀 판정: 상한 - 2 이상이면 비운다 ──
  const crowded = mount(TV, 'a', fakeView({ pages: 14, limit: 16 }));
  const roomy = mount(TV, 'b', fakeView({ pages: 5, limit: 16 }));
  TV._guardAtlas();
  t.check('병합 직전(14/16)이면 아틀라스를 비운다', crowded.cleared === 1, `cleared=${crowded.cleared}`);
  t.check('여유가 있으면(5/16) 건드리지 않는다', roomy.cleared === 0, `cleared=${roomy.cleared}`);

  // 회귀: clearTexture 는 페이지 개수를 줄이지 않는다 → 개수만 보면 영원히 참이 되어
  // 20초마다 전체 재래스터화를 반복한다. 페이지가 더 늘었을 때만 다시 비워야 한다.
  TV._guardAtlas();
  TV._guardAtlas();
  t.check('같은 페이지 수로는 다시 비우지 않는다', crowded.cleared === 1, `cleared=${crowded.cleared}`);
  crowded.webgl._renderer._charAtlas.pages.push({});
  TV._guardAtlas();
  t.check('페이지가 더 늘면 다시 비운다', crowded.cleared === 2, `cleared=${crowded.cleared}`);
  TV.views.clear();

  // ── 시간 기반 예비 초기화: 페이지 수를 못 읽어도 오래되면 비운다 ──
  const opaque = mount(TV, 'c', fakeView({
    webgl: {}, atlasResetAt: Date.now() - TV.ATLAS_MAX_AGE_MS - 1,
  }));
  const fresh = mount(TV, 'd', fakeView({ webgl: {}, atlasResetAt: Date.now() }));
  TV._guardAtlas();
  t.check('내부를 못 읽어도 오래됐으면 비운다', opaque.cleared === 1, `cleared=${opaque.cleared}`);
  t.check('막 비운 뒤에는 다시 비우지 않는다', fresh.cleared === 0, `cleared=${fresh.cleared}`);
  t.check('비운 시각이 갱신된다', opaque.atlasResetAt > Date.now() - 1000);
  TV.views.clear();

  // ── 화면에 없거나 WebGL 이 없는 뷰는 대상이 아니다 ──
  const hidden = mount(TV, 'e', fakeView({ pages: 16, limit: 16, active: false }));
  const dom = mount(TV, 'f', fakeView({ webgl: null, atlasResetAt: 0 }));
  TV._guardAtlas();
  t.check('숨은 패널은 건너뛴다', hidden.cleared === 0, `cleared=${hidden.cleared}`);
  t.check('DOM 렌더러 뷰는 건너뛴다', dom.cleared === 0, `cleared=${dom.cleared}`);
  TV.views.clear();

  // ── 수동 재그리기 ──
  const shown = mount(TV, 'g', fakeView({ pages: 2 }));
  const off = mount(TV, 'h', fakeView({ pages: 2, active: false }));
  TV.redrawVisible();
  t.check('보이는 터미널은 아틀라스를 버리고 다시 그린다', shown.cleared === 1, `cleared=${shown.cleared}`);
  t.check('숨은 터미널의 아틀라스는 버리지 않는다', off.cleared === 0, `cleared=${off.cleared}`);
  t.check('숨은 터미널에도 재그리기는 요청한다(보일 때 갚는다)', off.refreshed >= 1, `refreshed=${off.refreshed}`);
  TV.views.clear();

  // ── 회귀: 아틀라스는 세션끼리 공유된다 (xterm acquireTextureAtlas) ──
  // 한 뷰에서 비우면 다른 뷰가 쓰던 글리프 픽셀까지 지워지는데 xterm 은 호출한 뷰만 다시
  // 그린다 → 출력이 멈춰 있던 패널이 빈 화면으로 남았다(스플리터를 끌면 복구되던 증상).
  const shared = fakeAtlas(14, 16);
  const busy = mount(TV, 'i', fakeView({ atlas: shared }));
  const idle = mount(TV, 'j', fakeView({ atlas: shared }));
  const idleHidden = mount(TV, 'k', fakeView({ atlas: shared, active: false }));
  TV._guardAtlas();
  t.check('공유 아틀라스는 한 틱에 한 번만 비운다',
    busy.cleared + idle.cleared === 1, `busy=${busy.cleared} idle=${idle.cleared}`);
  t.check('출력이 멈춘 패널에도 재그리기가 전파된다',
    busy.refreshed + idle.refreshed >= 1, `busy=${busy.refreshed} idle=${idle.refreshed}`);
  t.check('숨은 패널에도 재그리기가 전파된다', idleHidden.refreshed >= 1, `refreshed=${idleHidden.refreshed}`);
  t.check('공유 뷰의 감시 기준점도 같이 맞춰진다',
    idle.atlasPagesAtReset === 14 && idleHidden.atlasPagesAtReset === 14,
    `idle=${idle.atlasPagesAtReset} hidden=${idleHidden.atlasPagesAtReset}`);
  const sharedCleared = busy.cleared + idle.cleared;
  TV._guardAtlas();
  t.check('공유 뷰 때문에 매 틱 반복해 비우지 않는다',
    busy.cleared + idle.cleared === sharedCleared, `cleared=${busy.cleared + idle.cleared}`);
  shared.pages.push({});
  TV._guardAtlas();
  t.check('공유 아틀라스도 페이지가 늘면 다시 비운다',
    busy.cleared + idle.cleared === sharedCleared + 1, `cleared=${busy.cleared + idle.cleared}`);
  TV.views.clear();

  // 수동 복구도 공유 아틀라스를 중복으로 비우지 않고 모든 뷰를 다시 그린다
  const shared2 = fakeAtlas(3, 16);
  const m1 = mount(TV, 'l', fakeView({ atlas: shared2 }));
  const m2 = mount(TV, 'm', fakeView({ atlas: shared2 }));
  TV.redrawVisible();
  t.check('수동 복구는 공유 아틀라스를 한 번만 비운다',
    m1.cleared + m2.cleared === 1, `m1=${m1.cleared} m2=${m2.cleared}`);
  t.check('수동 복구는 두 패널 모두 다시 그린다',
    m1.refreshed + m2.refreshed >= 1 && (m1.cleared ? m2.refreshed >= 1 : m1.refreshed >= 1),
    `m1=${m1.refreshed} m2=${m2.refreshed}`);
  TV.views.clear();

  // WebGL 이 아예 없는 환경(DOM 렌더러)에서도 수동 복구는 재그리기를 시도한다
  const domOnly = mount(TV, 'n', fakeView({ webgl: null }));
  TV.redrawVisible();
  t.check('DOM 렌더러만 있어도 재그리기를 시도한다', domOnly.refreshed >= 1, `refreshed=${domOnly.refreshed}`);
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
    webgl: null, webglFailures: 0, atlasResetAt: 0,
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
    webgl: null, webglFailures: 0, atlasResetAt: 0,
    holder: { classList: { contains: () => visible } },
    term: { rows: 24, loadAddon() {} },
  };
  TV3._attachWebgl(hiddenView);
  visible = false;
  gone.shift()();
  t.check('숨은 패널은 소실 뒤 재부착하지 않는다',
    created2 === 1 && hiddenView.webgl === null, `created=${created2}`);
};
