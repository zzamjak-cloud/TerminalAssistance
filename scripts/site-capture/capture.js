// 홍보용 미디어 일괄 생성: node scripts/site-capture/capture.js [장면...]
// 실제 렌더러(src/renderer)를 정적 서버로 띄우고 window.__TAURI__ 를 목으로 대체한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { webkit } = require('playwright');
const D = require('./demo-data');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'site/assets/media');
const TMP = path.join(__dirname, '.tmp');
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  // 모바일 웹앱은 루트 절대경로로 자원을 요청한다 — 모바일 → 렌더러 → vendor 순으로 찾는다
  const dirs = [path.join(ROOT, 'src/mobile'), path.join(ROOT, 'src/renderer'), path.join(ROOT, 'src/renderer/vendor')];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u.startsWith('/api/') || u === '/sw.js' || u === '/icon.png' || u.endsWith('.png') && !u.startsWith('/icon')) { res.writeHead(404); return res.end(); }
    const rel = u === '/' || u === '/m/' ? 'index.html' : u.replace(/^\/m\//, '');
    const rdir = req.headers.referer && req.headers.referer.includes('/m/') ? 'mobile' : null;
    const f = (u.startsWith('/m/') || rdir ? dirs : [dirs[1], dirs[2], dirs[0]]).map((d) => path.join(d, rel)).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// 장면 설정: 분할·활성 세션·패널 접힘 등 localStorage 로 렌더러 상태를 미리 맞춘다
function lsFor(o) {
  const ls = {
    'ta-split-mode': o.mode || '2x2', 'ta-split-panes': JSON.stringify(o.panes || ['s1', 's4', 's2', 's3']),
    'ta-split-focused': String(o.focused || 0), 'ta-active-session': o.active || (o.panes || ['s1'])[0],
    'ta-explorer-fold': '1', 'ta-prompt-panel': '0', 'ta-left-w': '230'
  };
  if (o.theme) ls['ta-theme'] = JSON.stringify({ id: o.theme });
  return Object.assign(ls, o.ls || {});
}

async function openPage(browser, base, o = {}) {
  const ctxOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: o.video ? 1 : 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul' };
  if (o.video) ctxOpts.recordVideo = { dir: TMP, size: { width: 1440, height: 900 } };
  const t0 = Date.now();
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const demo = Object.assign({}, D, { settings: o.settings, scroll: o.scroll || D.scroll, drafts: o.drafts, tree: o.tree });
  await page.addInitScript({ content: `window.__DEMO__=${JSON.stringify(demo)};` + fs.readFileSync(path.join(__dirname, 'mock-init.js'), 'utf8') });
  await page.addInitScript((ls) => { try { for (const k in ls) localStorage.setItem(k, ls[k]); } catch (_) {} }, lsFor(o));
  await page.goto(base + '/');
  await page.addStyleTag({ content: '#app-toast{display:none !important}' });
  await page.waitForSelector('#project-list .project, #project-list > *', { state: 'attached', timeout: 10000 });
  await sleep(o.settle || 3500);
  ctx.trimSec = Math.max(0, (Date.now() - t0) / 1000 - 0.4); // 로딩 구간은 영상에서 잘라낸다
  return { ctx, page, errors };
}

const shot = async (page, name, opts) => { await page.screenshot(Object.assign({ path: path.join(OUT, name) }, opts)); console.log('  ->', name); };

async function finishVideo(ctx, page, name) {
  const v = page.video();
  const trim = String(ctx.trimSec || 0);
  await ctx.close();
  const src = await v.path();
  const mp4 = path.join(OUT, name + '.mp4'), webm = path.join(OUT, name + '.webm');
  const common = ['-y', '-loglevel', 'error', '-ss', trim, '-i', src, '-an', '-vf', 'fps=30,scale=1440:900,format=yuv420p'];
  execFileSync(FFMPEG, [...common, '-c:v', 'libx264', '-crf', '27', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', trim, '-i', src, '-an', '-vf', 'fps=30,scale=1440:900', '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', webm]);
  console.log('  ->', name + '.mp4/.webm');
}

// ── 장면 ──
const scenes = {};

async function streamS1(page, gap) {
  for (const chunk of D.s1Live) {
    const parts = chunk.split('\r\n'); parts.pop();
    for (const line of parts) {
      if (line === '') { await page.evaluate(() => window.__feed('s1', '\r\n')); continue; }
      await page.evaluate((l) => window.__feed('s1', l + '\r\n'), line);
      await sleep(gap);
    }
  }
}

scenes.hero = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { video: true, mode: '2x2', panes: ['s1', 's4', 's2', 's3'], settings: { fontSize: 12 } });
  await sleep(1200);
  await streamS1(page, 280);
  await page.evaluate(() => window.__status('s1', 'done', 14000));
  await sleep(2200);
  await shot(page, 'hero.png');
  await finishVideo(ctx, page, 'hero');
  return errors;
};

scenes.status = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { video: true, mode: '2x1', panes: ['s1', 's6'], settings: { fontSize: 13 } });
  await sleep(1500);
  const lines = D.s1Live[0].split('\r\n').concat(D.s1Live[1].split('\r\n'));
  for (const l of lines) { await page.evaluate((x) => window.__feed('s1', x + '\r\n'), l); await sleep(200); }
  const perm = '\r\n' + D.box(D.c.yellow, [' Bash 실행 허가: npm test -- SearchBar', '  ' + D.c.green + '❯ 1. Yes' + D.c.r + '   2. Yes, always   3. No'], 44).join('\r\n') + '\r\n';
  await page.evaluate((perm) => {
    window.__feed('s1', perm);
    window.__status('s1', 'waiting', 0);
  }, perm);
  await sleep(1200);
  await shot(page, 'status.png');
  await sleep(1000);
  await page.evaluate(() => window.__status('s1', 'running', 0));
  for (const l of D.s1Live[2].split('\r\n').concat(D.s1Live[3].split('\r\n'))) { await page.evaluate((x) => window.__feed('s1', x + '\r\n'), l); await sleep(220); }
  await page.evaluate(() => window.__status('s1', 'done', 11000));
  await sleep(1800);
  await finishVideo(ctx, page, 'status');
  return errors;
};

const base2x2 = { mode: '2x2', panes: ['s1', 's4', 's2', 's3'], settings: { fontSize: 12 } };

scenes.dashboard = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { ...base2x2 });
  await page.click('#btn-dashboard');
  await sleep(1800);
  await shot(page, 'dashboard.png');
  await ctx.close();
  return errors;
};

scenes.presets = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { ...base2x2 });
  await page.locator('.pane-preset-toggle').first().click();
  await sleep(600);
  await shot(page, 'presets.png');
  await ctx.close();
  return errors;
};

scenes['preset-manager'] = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { ...base2x2 });
  await page.locator('.pane-preset-toggle').first().click();
  await page.locator('.pane-preset-add').first().click();
  await sleep(900);
  await shot(page, 'preset-manager.png', { clip: { x: 250, y: 28, width: 900, height: 300 } });
  await ctx.close();
  return errors;
};

scenes.usage = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { ...base2x2 });
  const box = await page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const a = r('panel-codex'), z = r('panel-mem');
    return { x: a.left, y: 0, w: z.right - a.left, h: 42 };
  });
  await shot(page, 'usage.png', { clip: { x: box.x - 5, y: 5, width: box.w + 10, height: 32 } });
  await ctx.close();
  return errors;
};

scenes.split = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { mode: '2x1', panes: ['s1', 's2'], settings: { fontSize: 13 }, ls: { 'ta-left-fold': '1' } });
  await shot(page, 'split.png', { clip: { x: 0, y: 0, width: 1440, height: 520 } });
  await ctx.close();
  return errors;
};

scenes['theme-light'] = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { ...base2x2, theme: 'macos-light' });
  await shot(page, 'theme-light.png');
  await ctx.close();
  return errors;
};

scenes.og = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { mode: '2x1', panes: ['s1', 's2'], settings: { fontSize: 13 } });
  await page.setViewportSize({ width: 1200, height: 630 });
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, 'og.png'), scale: 'css' });
  console.log('  -> og.png');
  await ctx.close();
  return errors;
};

scenes.worktree = async (b, base) => {
  const { ctx, page, errors } = await openPage(b, base, { mode: '2x1', panes: ['s1', 's8'], settings: { fontSize: 13 } });
  await page.locator('#project-list .project').filter({ hasText: 'web-app' }).first().hover();
  await page.evaluate(() => App.showWorktreeModal(App.state.projects[0]));
  await sleep(700);
  await page.fill('#w-branch', 'feature/coupon-ui');
  await sleep(700);
  const r = await page.locator('#modal').boundingBox();
  await shot(page, 'worktree.png', { clip: { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: Math.min(r.height + 32, 700) } });
  await ctx.close();
  return errors;
};

scenes.mobile = async (b, base) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const sess = D.sessions.map((s) => ({ ...s }));
  await page.route('**/api/me', (r) => r.fulfill({ json: { deviceId: 'd1', deviceName: '데모 폰' } }));
  await page.route('**/api/state', (r) => r.fulfill({ json: { projects: D.projects, presets: D.presets, sessions: sess } }));
  await page.addInitScript({ content: `window.__M=${JSON.stringify({ scroll: D.scroll.s1 + D.s1Live.join('') })};` + `
    class FakeWS { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 50); }
      send(t) { const m = JSON.parse(t); if (m.t === 'sub') setTimeout(() => this.onmessage({ data: JSON.stringify({ t: 'snap', id: m.id, cols: 46, rows: 30, off: 1, data: window.__M.scroll }) }), 80); if (m.t === 'ping') this.onmessage({ data: '{"t":"pong"}' }); }
      close() {} }
    FakeWS.OPEN = 1; window.WebSocket = FakeWS;` });
  await page.goto(base + '/m/');
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, 'mobile-dash.png') });
  await page.evaluate(() => Remote.openView('s1'));
  await sleep(2000);
  await page.screenshot({ path: path.join(OUT, 'mobile.png') });
  console.log('  -> mobile.png');
  await ctx.close();
  return errors;
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const want = process.argv.slice(2);
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await webkit.launch();
  for (const name of Object.keys(scenes)) {
    if (want.length && !want.includes(name)) continue;
    console.log('[' + name + ']');
    try {
      const errs = await scenes[name](browser, base);
      if (errs && errs.length) console.log('  errors:', [...new Set(errs)].slice(0, 8));
    } catch (e) { console.log('  FAIL', e.message); }
  }
  await browser.close(); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
main();
