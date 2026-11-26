/* Terminal Assistance 사이트 스크립트 — 순수 JS, 외부 의존성 없음 */
(function () {
  'use strict';

  var REPO = 'zzamjak-cloud/TerminalAssistance';
  var RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest';
  var API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var LANG_KEY = 'ta-lang';
  var CACHE_KEY = 'ta-release-cache';

  var root = document.documentElement;

  function store(op, key, val) {
    try {
      if (op === 'get') return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* 사생활 보호 모드 등 */ }
    return null;
  }

  /* ---------------------------------------------------------------
   * i18n — ko 는 HTML 에 적힌 한국어 원문을 최초 1회 읽어 사전으로 삼고(무JS·검색엔진 폴백 겸용),
   * en 만 여기에 둔다. 값은 <kbd>·<code>·<a>·<strong> 마크업을 포함할 수 있어 innerHTML 로 적용한다(정적 신뢰 문자열).
   * --------------------------------------------------------------- */
  var EN = {
    'skip': 'Skip to content',
    'nav.label': 'Main menu',
    'nav.features': 'Features',
    'nav.start': 'Get started',
    'nav.manual': 'Manual',
    'nav.faq': 'FAQ',
    'lang.label': 'Language',
    'meta.title': 'Terminal Assistance — A multi-project terminal workspace for AI coding agents',
    'meta.desc': 'A terminal workspace for people who run AI coding agents like Claude Code and Codex across many projects at once. See at a glance what is running and what is waiting for you. macOS and Windows, open source (GPL-3.0).',
    'meta.ogtitle': 'Terminal Assistance — A multi-project terminal workspace for AI coding agents',
    'meta.ogdesc': 'See at a glance what is running and what is waiting for you. An open-source terminal workspace for running Claude Code and Codex across many projects.',
    'meta.twdesc': 'See at a glance what is running and what is waiting for you. A multi-project terminal workspace for AI coding agents.',

    'hero.eyebrow': 'Open source · macOS · Windows',
    'hero.title': 'A <em>terminal workspace</em> for people who run AI agents across many projects at once',
    'hero.lead': 'Keep Claude Code, Codex and other AI coding agents running in every project. See at a glance what is running and what is waiting for you.',
    'dl.mac': 'Download for macOS',
    'dl.win': 'Download for Windows',
    'hero.github': 'View on GitHub',
    'hero.note': 'Free · GPL-3.0 · Lightweight, built on Tauri 2',
    'legend.label': 'Session states',
    'legend.running': 'Running',
    'legend.waiting': 'Waiting',
    'legend.done': 'Done · desktop notification',
    'legend.exited': 'Exited',
    'hero.video': 'Terminal Assistance demo video',

    'feat.title': 'What is running, and what is waiting for you',
    'feat.lead': 'Register your projects, switch terminals with one click, and never lose track of any session.',
    'f1.tag': 'Multi-session status',
    'f1.title': 'Live status for every session',
    'f1.p': 'Running (pulsing), waiting, done (badge + desktop notification), exited. Even while you are looking at another session, you will not miss a background task finishing.',
    'f1.li1': 'For sessions with the Claude Code hook installed, only the <code>Stop</code> hook signal counts as done, so a pause in output during tool execution is never mistaken for completion.',
    'f1.li2': 'Without the hook, a task that ran for 3+ seconds and then stays quiet for 5+ seconds is treated as done.',
    'f1.video': 'Session status changing in real time',

    'f2.tag': 'All-session dashboard',
    'f2.title': 'The sessions that need you come first',
    'f2.p': 'Press <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> to see every session on one screen. Cards are grouped by project, and sessions waiting for permission or finished always come first, so you see what needs your attention.',
    'f2.li1': 'Click a card to switch to that session; right-click to assign it to a split panel.',
    'f2.li2': 'Sort by status, project, or recent activity.',
    'f2.alt': 'All-session dashboard with session cards grouped by project and per-status counts',

    'f3.tag': 'Command presets',
    'f3.title': 'Your go-to instructions, one click away',
    'f3.p': 'Register frequently used instructions globally or per project. Each preset can have its own dropdown background color, and the preset manager lets you reorder and recolor them.',
    'f3.li1': 'Click = run, Shift+click = type only, right-click = edit.',
    'f3.li2': 'Drag to reorder in the manager and change an item’s color with the color button.',
    'f3.alt1': 'Preset dropdown list',
    'f3.alt2': 'Preset manager showing global and project-only presets side by side',

    'f4.tag': 'Split view',
    'f4.title': 'Several sessions side by side',
    'f4.p': 'Lay sessions out in split panels and watch several agents at once. When you relaunch the app, your open sessions come back with the same paths, names, and split layout.',
    'f4.li1': 'Screen contents are not restored, but if there is a recent Claude/Codex history for that path, a “Resume” banner runs --resume in one click.',
    'f4.alt': 'Split view with three sessions side by side',

    'f5.tag': 'Usage gauges',
    'f5.title': 'Remaining quota, always in the top bar',
    'f5.p': 'The top bar shows the remaining 5-hour and weekly usage for Claude Code and Codex. Installed tools are always shown, and if a lookup fails the last value is kept in a dimmed state. Tooltips show the reset time for each window.',
    'f5.alt': 'Top bar gauges showing remaining 5-hour and weekly usage for Claude and Codex',

    'f6.tag': 'Themes',
    'f6.title': 'Dark, light, or your own colors',
    'f6.p': 'Pick from 12 dark/light presets or set your own background and accent colors. Text, status, project colors and code highlighting adjust automatically to the background brightness.',
    'f6.alt': 'Screen with the light theme applied',

    'more.title': 'And more',
    'more.lead': 'We plugged the small gaps that kept getting in the way of the workflow.',
    'c1.title': 'Project registry',
    'c1.p': 'Register projects (name, path, color) and open or switch to a terminal at that path with one click. No more repeated <code>cd</code>.',
    'c2.title': 'Git worktree launcher',
    'c2.alt': 'Sidebar with sibling-folder worktrees expanded via the branch icon',
    'c2.p': 'Use the branch icon on a project row to expand the same repo into sibling folders on other branches and open a session right there. Files are separated per branch, so several agents can work in one repo without conflicts. Before removing one, it checks for open sessions, uncommitted changes, and unpushed commits.',
    'c3.title': 'Image attachment',
    'c3.alt': 'Screen with attached image thumbnails in the bottom strip',
    'c3.p': 'Paste a clipboard image with <kbd>Cmd/Ctrl</kbd>+<kbd>V</kbd> or drop a file; it is saved as PNG and its path is typed in automatically (Claude Code recognizes it as an image). The bottom strip shows thumbnails of what you sent, and clicking one opens the original.',
    'c4.title': 'Mobile remote control',
    'c4.alt': 'Mobile remote control checking session status in a phone browser',
    'c4.p': 'From a phone browser (PWA): check session status, view output, type prompts and special keys, run presets, open new sessions, attach photos. Completion and permission waits arrive as ntfy push notifications. It uses per-device tokens via QR pairing and is off by default.',
    'c5.title': 'Session restore',
    'c5.p': 'When you relaunch the app, the sessions from last time reopen with the same paths and names. If there is a recent Claude/Codex history, a “Resume” banner runs --resume for you.',
    'c6.title': 'Auto update',
    'c6.p': 'The app tells you when a new version is released and updates in one click. After restart it resumes Claude Code and Codex in each tab with the same conversation, and if work is in progress it can install after the work finishes. It recovers the same way after a crash.',
    'c7.title': 'Background process cleanup',
    'c7.badge': 'macOS·Linux',
    'c7.p': 'Closing a tab or the app also ends the servers and background jobs that session started. Leftover processes show up in the “Background N” badge with CPU and memory, and you can end them there.',
    'c8.title': 'Context warning',
    'c8.p': 'When a Claude Code or Codex conversation exceeds the threshold (default: Claude 200K, 60% of the Codex window), an orange notice at the bottom of the session suggests /clear (/new for Codex) after a response ends. The app never types the command for you.',

    'start.title': 'Up and running in five minutes',
    'start.lead': 'Install, register a project, open a session. That is it.',
    's1.title': 'Get the installer',
    's1.p': 'Use the download buttons above or <a href="https://github.com/zzamjak-cloud/TerminalAssistance/releases/latest" rel="noopener">Releases</a> to get the macOS (.dmg, universal for Intel/Apple Silicon) or Windows (.exe) installer and install it.',
    's2.title': 'Get past the first-run warning',
    's2.p': 'The app is unsigned, so you may see a warning. On macOS, right-click → Open. On Windows, in SmartScreen choose More info → Run anyway.',
    's3.title': 'Register a project',
    's3.p': 'Click “+ Register project” at the bottom left and pick a folder.',
    's4.title': 'Open a terminal',
    's4.p': 'Click a project in the sidebar. If it already has a session, it switches; otherwise a new one opens. Run Claude Code or Codex inside.',
    's5.title': 'Add presets',
    's5.p': 'Register your frequent instructions with “+ Preset” at the top, then click a chip to run it.',
    's6.title': 'Check status',
    's6.p': 'The color of the session dot in the sidebar shows progress and completion. You get a notification when an inactive session finishes.',
    'dl.file': 'File',
    'dl.tr.mac': 'macOS (universal, Intel/Apple Silicon)',

    'man.title': 'User manual',
    'man.lead': 'On macOS use <kbd>Cmd</kbd>; on Windows use <kbd>Ctrl</kbd>. Below it is written as <kbd>Cmd/Ctrl</kbd>.',
    'm1.sum': 'Basics',
    'm1.li1': '<strong>Register a project</strong> — bottom left <code>+ Register project</code> → choose a folder.',
    'm1.li2': '<strong>Open or switch terminals</strong> — click a project in the sidebar. If it already has a session it switches; otherwise a new one opens.',
    'm1.li3': '<strong>Move between sessions</strong> — <kbd>Cmd/Ctrl</kbd>+<kbd>1~9</kbd> switches sessions and <kbd>Cmd/Ctrl</kbd>+<kbd>T</kbd> opens a new session in the current project.',
    'm1.li4': '<strong>Prompt box</strong> — <kbd>Cmd/Ctrl</kbd>+<kbd>J</kbd> moves the cursor between the terminal and the prompt box. If you were typing a prompt into the terminal by mistake, what you typed is cut and moved into the prompt box.',
    'm1.li5': '<strong>Check status</strong> — the session dot color in the sidebar shows progress and completion. You get a notification when an inactive session finishes.',
    'm2.sum': 'Keyboard shortcuts',
    'k1': 'Switch session',
    'k2': 'New session in the current project',
    'k3': 'Toggle cursor between terminal and prompt box',
    'k4': 'Cycle through panels in split mode',
    'k5': 'All-session dashboard (close with <kbd>Esc</kbd>)',
    'k6': 'Force-redraw the terminal (when text looks garbled)',
    'k7': 'Fold/unfold the right panel',
    'k8': 'Fold/unfold the project sidebar',
    'k9': 'Fold/unfold the explorer',
    'k10': 'Attach a clipboard image',
    'm3.sum': 'Command presets',
    'm3.li1': 'Register with “+ Preset” at the top. You can keep global presets and per-project presets separate.',
    'm3.li2': '<strong>Click</strong> = run, <strong>Shift+click</strong> = type only, <strong>right-click</strong> = edit.',
    'm3.li3': 'Each preset can have its own dropdown background color.',
    'm3.li4': 'Open the manager from “Manage · Add presets” at the bottom of the panel preset dropdown. Reorder by dragging or with ▲▼, and change an item’s color with the color button.',
    'm4.sum': 'Image attachment',
    'm4.li1': 'Take a screenshot, then press <kbd>Cmd/Ctrl</kbd>+<kbd>V</kbd> in the terminal, or drop an image file onto the window.',
    'm4.li2': 'The image is saved as PNG and its path is typed in automatically. Claude Code recognizes it as an image.',
    'm4.li3': 'The thumbnails in the bottom strip show which images you sent; click one to open the original.',
    'm4.li4': 'In split view, the image is inserted into the panel (prompt box or terminal) where you dropped it.',
    'm5.sum': 'Split view and dashboard',
    'm5.li1': 'Open the dashboard with <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. Cards are grouped by project, with per-status counts summarized at each project header.',
    'm5.li2': 'Sessions waiting for permission and finished sessions always come first, so you see which ones need you. Sort by status, project, or recent activity.',
    'm5.li3': '<strong>Click</strong> a card to switch to that session; <strong>right-click</strong> it to assign it to a split panel. The dashboard stays open so you can place several in a row.',
    'm5.li4': 'Split view supports up to 6 panels. The split layout is restored when you relaunch the app.',
    'm5.li5': '“End session” in a session card’s right-click menu needs two presses to avoid accidents.',
    'm6.sum': 'Git worktrees',
    'm6.li1': 'Click the branch icon on a project row to expand the same repo into sibling folders on other branches and open a session right there.',
    'm6.li2': 'Files are separated per branch, so running several agents in one repo at once does not cause conflicts.',
    'm6.li3': 'In the sidebar they appear indented under the parent. Before removal, it checks for open sessions, uncommitted changes, and unpushed commits.',
    'm7.sum': 'Mobile remote control (Tailscale)',
    'm7.intro': 'From a phone browser you can check session status, view output, type prompts and special keys (Esc, Ctrl+C, arrows, Enter), run presets, open new sessions, and attach photos. It is off by default.',
    'm7.li1': 'Install <a href="https://tailscale.com" rel="noopener">Tailscale</a> on both your PC and phone and sign in with the same account. On the phone, enable VPN On Demand (iOS) or Always-on VPN (Android) in the Tailscale app to stay connected. It is a plain-HTTP server, so never expose it directly to public Wi-Fi or the internet.',
    'm7.li2': 'On Galaxy phones, if Samsung Wallet (Samsung Pay) asks you to turn off the VPN, go to the Tailscale app → profile icon → <strong>App-based split tunneling</strong> and exclude Samsung Wallet and Samsung Pass. The list is sorted by name, so apps with Korean names are at the bottom; type <code>spay</code> in the search box to find it right away.',
    'm7.li3': 'Press the 📱 button at the top. The app finds your Tailscale IP, starts the server, and shows a QR code and a code. Scan the QR with your phone camera (valid for 5 minutes, single use) to connect.',
    'm7.li4': 'If the terminal text is small, spread two fingers over the terminal area to enlarge only the font (the bottom input and special keys stay the same). Double-tap to return to fit-to-width; the scale is remembered per device.',
    'm7.li5': '<strong>Optimal view</strong> — resizes the terminal (columns and rows) to your phone screen so the TUI is redrawn at phone width. Meanwhile the PC terminal stays fixed at the phone size, and the “Reclaim” button on the PC banner brings it back. Typing itself always works, even without optimal view.',
    'm7.li6': 'With the default setting (Settings → “Run Claude Code with the classic renderer”), the conversation stays in terminal scrollback and scrolls smoothly on the phone. If you turn it off, Claude Code runs in full-screen mode with no scrollback, and swipes are sent to the TUI like a PC mouse wheel (adjust the speed with /scroll-speed inside Claude Code).',
    'm7.li7': 'Follow the prompt to add it to your home screen, and from then on just tap the icon. An iPhone home-screen app has storage separate from Safari, so enter the 8-character code from the 📱 window once the first time.',
    'm7.li8': 'Once connected, the server starts automatically when you relaunch the app and the phone reconnects as is. You can revoke devices in the 📱 window, and they expire automatically after 30 days of no use.',
    'm7.li9': 'Push notifications: turn on ntfy under Settings → “Mobile remote control” and subscribe to the displayed topic in the ntfy app on your phone. Completion and permission waits arrive as push.',
    'm8.sum': 'Usage gauges',
    'm8.li1': 'The top bar shows the remaining 5-hour and weekly usage for Claude Code and Codex. Installed tools are always shown.',
    'm8.li2': 'If a lookup fails, the last value stays in a dimmed state, and the tooltip tells you why it failed and when it will retry. Once the reset time has passed, it is shown as recovered.',
    'm8.li3': 'Tooltips show the reset time per window. The 5-hour and weekly values are each colored by their own remaining amount.',
    'm8.li4': 'If the Antigravity CLI (agy) is installed, its remaining 5-hour and weekly percentages are shown too. It is queried while the Antigravity app is running.',
    'm8.li5': 'It refreshes immediately when you return to the window, and backs off the interval if rate-limited.',
    'm9.sum': 'Auto update',
    'm9.li1': 'The app tells you when a new version is released and updates in one click. It re-checks every 6 hours.',
    'm9.li2': 'The update dialog shows how many sessions are working. “Update now” restarts and resumes Claude Code and Codex in each tab with the same conversation (--resume), keeping the flags you launched them with.',
    'm9.li3': 'If sessions are working, the update is downloaded in advance and installed after a 10-second countdown (cancelable) once all sessions finish.',
    'm9.li4': 'If the app was killed or crashed, the next launch restores your tabs and resumes the Claude Code and Codex that were running.',

    'faq.title': 'Frequently asked questions',
    'q1.q': 'macOS shows an “unidentified developer” warning.',
    'q1.a': 'The app is not notarized, so Gatekeeper shows a warning on first launch. Right-click the app and choose Open to run it.',
    'q2.q': 'Windows SmartScreen shows a warning.',
    'q2.a': 'In the warning dialog, click “More info”, then choose “Run anyway”.',
    'q3.q': 'On macOS, folder-access permission prompts keep appearing.',
    'q3.a': 'Builds without a stable signature invalidate the permission record on every build, so the prompts repeat. Official releases are signed with the same self-signed certificate, so permissions persist across auto updates. If you are on an older unsigned version, see the re-signing instructions in the repository README.',
    'q4.q': 'Are all features available on Windows too?',
    'q4.a': 'Background process cleanup and display are supported on macOS and Linux only, and the Codex context warning also works only on macOS and Linux. Everything else is the same on both OSes.',
    'q5.q': 'Is mobile remote control safe?',
    'q5.a': 'It is off by default and issues per-device tokens via QR pairing. It is a plain-HTTP server, though, so use it only inside a private network such as Tailscale and never expose it directly to public Wi-Fi or the internet. You can revoke a device at any time, and unused devices expire after 30 days.',
    'q6.q': 'Is it an Electron app? What about memory?',
    'q6.a': 'It is built on Tauri 2 and uses the system WebView, so memory usage is lower than Electron.',
    'q7.q': 'What about price and license?',
    'q7.a': 'It is open source, released under the GNU General Public License v3.0 only (<code>GPL-3.0-only</code>). Copying, modifying and distributing must follow the GPLv3 terms, and derivative works must keep the same license and source-disclosure obligations.',
    'q8.q': 'How do I build it from source?',
    'q8.a': 'You need Rust and Node.js 20+ (WebView2 on Windows). Clone the repository, run <code>npm install</code>, then <code>npm run dev</code> or <code>npm run build</code>. See the <a href="https://github.com/zzamjak-cloud/TerminalAssistance#readme" rel="noopener">README</a> for details.',

    'foot.p': 'A multi-project terminal workspace for AI coding agents. Open source, released under GPL-3.0-only.',
    'foot.license': 'GPL-3.0 license',
    'lb.label': 'Enlarged image',
    'lb.close': 'Close'
  };

  var dict = { ko: {}, en: EN };
  var attrKinds = [
    ['data-i18n-alt', 'alt'],
    ['data-i18n-aria', 'aria-label']
  ];

  // ko 사전: HTML 원문 수집
  function captureKo() {
    var ko = dict.ko;
    document.querySelectorAll('[data-i18n], [data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n') || el.getAttribute('data-i18n-html');
      if (!(key in ko)) ko[key] = el.innerHTML;
    });
    attrKinds.forEach(function (k) {
      document.querySelectorAll('[' + k[0] + ']').forEach(function (el) {
        var key = el.getAttribute(k[0]);
        if (!(key in ko)) ko[key] = el.getAttribute(k[1]) || '';
      });
    });
    ko['meta.title'] = document.title;
    ko['meta.desc'] = metaContent('meta[name="description"]');
    ko['meta.ogtitle'] = metaContent('meta[property="og:title"]');
    ko['meta.ogdesc'] = metaContent('meta[property="og:description"]');
    ko['meta.twdesc'] = metaContent('meta[name="twitter:description"]');
    ko['lb.label'] = ko['lb.label'] || '이미지 확대';
  }

  function metaContent(sel) {
    var m = document.querySelector(sel);
    return m ? m.getAttribute('content') || '' : '';
  }
  function setMeta(sel, val) {
    var m = document.querySelector(sel);
    if (m && val) m.setAttribute('content', val);
  }

  var currentLang = 'ko';
  var releaseVersion = '';

  function applyLang(lang) {
    var d = dict[lang] || dict.ko;
    currentLang = lang;
    root.setAttribute('lang', lang);
    document.querySelectorAll('[data-i18n], [data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n') || el.getAttribute('data-i18n-html');
      if (key in d) el.innerHTML = d[key];
    });
    attrKinds.forEach(function (k) {
      document.querySelectorAll('[' + k[0] + ']').forEach(function (el) {
        var key = el.getAttribute(k[0]);
        if (key in d) el.setAttribute(k[1], d[key]);
      });
    });
    document.title = d['meta.title'];
    setMeta('meta[name="description"]', d['meta.desc']);
    setMeta('meta[property="og:title"]', d['meta.ogtitle']);
    setMeta('meta[property="og:description"]', d['meta.ogdesc']);
    setMeta('meta[name="twitter:description"]', d['meta.twdesc']);
    document.querySelectorAll('.lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lang ? 'true' : 'false');
    });
    renderVersion();
  }

  function detectLang() {
    var saved = store('get', LANG_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'ko';
    return /^ko/i.test(nav) ? 'ko' : 'en';
  }

  /* ---------------- 다운로드 버튼 ---------------- */
  var assetUrls = { mac: '', win: '' };

  function renderVersion() {
    var note = document.getElementById('dl-note');
    if (note && releaseVersion) {
      var base = (dict[currentLang] || dict.ko)['hero.note'];
      note.innerHTML = base + ' · v' + releaseVersion;
    }
  }

  function applyRelease(data) {
    if (!data || !Array.isArray(data.assets)) return;
    data.assets.forEach(function (a) {
      var name = a.name || '';
      if (/_universal\.dmg$/.test(name)) assetUrls.mac = a.browser_download_url;
      else if (/_x64-setup\.exe$/.test(name)) assetUrls.win = a.browser_download_url;
    });
    releaseVersion = String(data.tag_name || '').replace(/^v/, '');
    ['mac', 'win'].forEach(function (os) {
      var btn = document.querySelector('[data-dl="' + os + '"]');
      if (!btn) return;
      if (assetUrls[os]) btn.setAttribute('href', assetUrls[os]);
      var small = btn.querySelector('[data-dl-label]');
      if (small && releaseVersion) {
        small.textContent = 'v' + releaseVersion + ' · ' + (os === 'mac' ? 'universal .dmg' : 'x64 .exe');
      }
    });
    renderVersion();
  }

  function loadRelease() {
    var cached = null;
    try { cached = JSON.parse(store('get', CACHE_KEY) || 'null'); } catch (e) { cached = null; }
    if (cached && Date.now() - cached.t < 3600 * 1000) {
      applyRelease(cached.d);
      return;
    }
    if (!window.fetch) return;
    fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (data) {
        var slim = { tag_name: data.tag_name, assets: (data.assets || []).map(function (a) {
          return { name: a.name, browser_download_url: a.browser_download_url };
        }) };
        store('set', CACHE_KEY, JSON.stringify({ t: Date.now(), d: slim }));
        applyRelease(slim);
      })
      .catch(function () { /* 폴백: 버튼은 이미 releases/latest 를 가리킨다 */ });
  }

  function highlightOs() {
    var ua = navigator.userAgent || '';
    var os = '';
    if (/Windows/i.test(ua)) os = 'win';
    else if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua) && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) && 'ontouchend' in document)) os = 'mac';
    var mac = document.querySelector('[data-dl="mac"]');
    var win = document.querySelector('[data-dl="win"]');
    [mac, win].forEach(function (b) { if (b) b.classList.remove('primary'); });
    var target = os === 'win' ? win : mac; // 감지 실패(모바일·리눅스)는 macOS 를 기본 강조
    if (target) target.classList.add('primary');
    // 주 버튼을 앞으로
    if (os === 'win' && win && mac && win.parentNode === mac.parentNode) mac.parentNode.insertBefore(win, mac);
  }

  /* ---------------- 영상 ---------------- */
  function setupVideos() {
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      vids.forEach(function (v) {
        v.removeAttribute('autoplay');
        v.pause();
        v.setAttribute('controls', '');
      });
      return;
    }
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    }, { threshold: 0.25 });
    vids.forEach(function (v) { io.observe(v); });
  }

  /* ---------------- 스크롤 등장 ---------------- */
  function setupReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (e) { e.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ---------------- 라이트박스 ---------------- */
  function setupLightbox() {
    var dlg = document.getElementById('lightbox');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    var img = document.getElementById('lb-img');
    var cap = document.getElementById('lb-cap');
    function open(src, alt) {
      img.src = src;
      img.alt = alt || '';
      cap.textContent = alt || '';
      dlg.showModal();
    }
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t.matches && t.matches('img[data-zoom]')) open(t.currentSrc || t.src, t.alt);
      else if (t === dlg || t.id === 'lb-close') dlg.close();
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if ((e.key === 'Enter' || e.key === ' ') && t.matches && t.matches('img[data-zoom]')) {
        e.preventDefault();
        open(t.currentSrc || t.src, t.alt);
      }
    });
    document.querySelectorAll('img[data-zoom]').forEach(function (i) {
      i.setAttribute('tabindex', '0');
      i.setAttribute('role', 'button');
    });
    dlg.addEventListener('close', function () { img.removeAttribute('src'); });
  }

  /* ---------------- 시작 ---------------- */
  function init() {
    captureKo();
    var lang = detectLang();
    if (lang !== 'ko') applyLang(lang);
    document.querySelectorAll('.lang button').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = b.getAttribute('data-lang');
        store('set', LANG_KEY, l);
        applyLang(l);
      });
    });
    highlightOs();
    loadRelease();
    setupVideos();
    setupReveal();
    setupLightbox();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
