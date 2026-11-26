// 홍보용 미디어 일괄 생성: node scripts/site-capture/capture.js [--lang ko|en] [장면...] (기본: ko+en)
// 실제 렌더러(src/renderer)를 정적 서버로 띄우고 window.__TAURI__ 를 목으로 대체한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { webkit } = require('playwright');
const mkData = require('./demo-data');
let D = mkData('ko'); // 언어별 데모 데이터 (main 이 언어마다 교체)

const ROOT = path.resolve(__dirname, '../..');
const MEDIA = path.join(ROOT, 'site/assets/media');
let OUT = MEDIA;
let LANG = 'ko';
const FONT_DIR = path.join(__dirname, 'node_modules/@fontsource/nanum-gothic-coding');
const TMP = path.join(__dirname, '.tmp');
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  // 모바일 웹앱은 루트 절대경로로 자원을 요청한다 — 모바일 → 렌더러 → vendor 순으로 찾는다
  const dirs = [path.join(ROOT, 'src/mobile'), path.join(ROOT, 'src/renderer'), path.join(ROOT, 'src/renderer/vendor'), path.join(ROOT, 'src/renderer/i18n')];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u.startsWith('/__font/')) {
      const ff = path.join(FONT_DIR, u.slice(8));
      if (!ff.startsWith(FONT_DIR) || !fs.existsSync(ff)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return fs.createReadStream(ff).pipe(res);
    }
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

// 터미널 한글 글꼴: Menlo 에는 한글 글리프가 없어 시스템 글꼴로 폴백되며, 그 글리프(약 1em)가
// xterm 2셀(약 1.2em)보다 좁아 글자가 벌어져 보인다. 한글이 정확히 2칸인 나눔고딕코딩을
// 앱 기본 글꼴 체인(Menlo, Consolas, "D2Coding", ...)의 "D2Coding" 자리에 별칭으로 끼운다.
function fontCss(family = 'D2Coding') {
  const files = ['korean-400', 'korean-700'].concat(LANG === 'ko' ? ['latin-400', 'latin-700'] : []);
  return files.map((f) => fs.readFileSync(path.join(FONT_DIR, f + '.css'), 'utf8'))
    .join('\n').replace(/Nanum Gothic Coding/g, family)
    .replace(/url\(\.\/files\/([^)]+\.woff2)\) format\('woff2'\)(,\s*url\([^)]+\) format\('woff'\))?/g, "url(/__font/files/$1) format('woff2')");
}
const hangul = (obj) => [...new Set(JSON.stringify(obj).match(/[ㄱ-ㅎ가-힣]/g) || [])].join('') + ' !"#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz{|}~';

// ko: 한글이 정확히 2칸이 되도록 나눔고딕코딩(별칭 D2Coding)을 주 글꼴로 쓴다 (셀이 좁아지므로 글자 크기 +1)
const koFont = (s) => (LANG === 'ko' ? Object.assign({}, s, { fontFamily: 'D2Coding', fontSize: ((s && s.fontSize) || 13) + 1 }) : s);

// 장면 설정: 분할·활성 세션·패널 접힘 등 localStorage 로 렌더러 상태를 미리 맞춘다
function lsFor(o) {
  const ls = {
    'ta-split-mode': o.mode || '2x2', 'ta-split-panes': JSON.stringify(o.panes || ['s1', 's4', 's2', 's3']),
    'ta-split-focused': String(o.focused || 0), 'ta-active-session': o.active || (o.panes || ['s1'])[0],
    'ta-explorer-fold': '1', 'ta-prompt-panel': '0', 'ta-left-w': LANG === 'en' ? '300' : '230'
  };
  ls['ta-lang'] = LANG;
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
  const demo = Object.assign({}, D, { fontCss: fontCss(), hangul: hangul(D), settings: koFont(o.settings), scroll: o.scroll || D.scroll, drafts: o.drafts, tree: o.tree });
  await page.addInitScript({ content: `window.__DEMO__=${JSON.stringify(demo)};` + fs.readFileSync(path.join(__dirname, 'font-init.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'mock-init.js'), 'utf8') });
  await page.addInitScript((ls) => { try { for (const k in ls) localStorage.setItem(k, ls[k]); } catch (_) {} }, lsFor(o));
  await page.goto(base + '/');
  await page.addStyleTag({ content: '#app-toast{display:none !important}' });
  try { await page.waitForSelector('#project-list .project, #project-list > *', { state: 'attached', timeout: 10000 }); }
  catch (e) { throw new Error('부팅 실패 — ' + [...new Set(errors)].slice(0, 5).join(' | ')); }
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
  const perm = '\r\n' + D.box(D.c.yellow, [D.lang === 'en' ? ' Permission to run: npm test -- SearchBar' : ' Bash 실행 허가: npm test -- SearchBar', '  ' + D.c.green + '❯ 1. Yes' + D.c.r + '   2. Yes, always   3. No'], 44).join('\r\n') + '\r\n';
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
  const pm = await page.locator('#modal').boundingBox();
  await shot(page, 'preset-manager.png', { clip: { x: pm.x, y: pm.y, width: pm.width, height: 300 } });
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
  await page.route('**/api/me', (r) => r.fulfill({ json: { deviceId: 'd1', deviceName: 'Demo phone' } }));
  await page.route('**/api/state', (r) => r.fulfill({ json: { projects: D.projects, presets: D.presets, sessions: sess } }));
  await page.addInitScript((lang) => { try { localStorage.setItem('ta-lang', lang); } catch (_) {} }, LANG);
  await page.addInitScript({ content: `window.__DEMO__=${JSON.stringify({ fontCss: fontCss('D2Coding') + (LANG === 'ko' ? fontCss('Menlo') : ''), hangul: hangul(D) })};` + fs.readFileSync(path.join(__dirname, 'font-init.js'), 'utf8') });
  await page.addInitScript({ content: `window.__M=${JSON.stringify({ scroll: D.scroll.s1 + D.s1Live.join('') })};` + `
    class FakeWS { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 50); }
      send(t) { const m = JSON.parse(t); if (m.t === 'sub') setTimeout(() => this.onmessage({ data: JSON.stringify({ t: 'snap', id: m.id, cols: 46, rows: 30, off: 1, data: window.__M.scroll }) }), 80); if (m.t === 'ping') this.onmessage({ data: '{"t":"pong"}' }); }
      close() {} }
    FakeWS.OPEN = 1; window.WebSocket = FakeWS;` });
  await page.goto(base + '/m/');
  await page.evaluate(() => window.__ensureFonts());
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
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const args = process.argv.slice(2);
  const li = args.indexOf('--lang');
  const langs = li >= 0 ? [args[li + 1]] : (process.env.LANG_ONLY ? [process.env.LANG_ONLY] : ['ko', 'en']);
  const want = args.filter((a, i) => li < 0 || (i !== li && i !== li + 1));
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await webkit.launch();
  for (const lang of langs) {
    LANG = lang; D = mkData(lang);
    OUT = lang === 'ko' ? MEDIA : path.join(MEDIA, lang); // 영어는 media/en/ 에 같은 파일명
    fs.mkdirSync(OUT, { recursive: true });
    for (const name of Object.keys(scenes)) {
      if (want.length && !want.includes(name)) continue;
      if (name === 'og' && lang !== 'ko') continue; // 소셜 카드는 ko 만
      console.log('[' + lang + ':' + name + ']');
      try {
        const errs = await scenes[name](browser, base);
        if (errs && errs.length) console.log('  errors:', [...new Set(errs)].slice(0, 8));
      } catch (e) { console.log('  FAIL', e.message); }
    }
  }
  await browser.close(); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
main();
