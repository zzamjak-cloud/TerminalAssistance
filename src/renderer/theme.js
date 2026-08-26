// 테마 엔진 — 배경색 + 강조색 두 값에서 전체 CSS 변수를 파생한다.
// 배경 명도로 라이트/다크를 판별하고, 라이트일 때는 글자·상태·프로젝트 색을
// 어두운 쪽으로 눌러 가독성을 확보한다 (밝은 배경 위 밝은 글자 방지).
const Theme = {
  STORE_KEY: 'ta-theme',

  PRESETS: [
    { id: 'dark', name: '기본(다크)', bg: '#14161c', accent: '#2e6cd6' },
    { id: 'graphite', name: '그라파이트', bg: '#0b0f19', accent: '#22c55e' },
    { id: 'slate', name: '슬레이트', bg: '#111827', accent: '#a855f7' },
    { id: 'purple', name: '다크 퍼플', bg: '#120a2a', accent: '#ec4899' },
    { id: 'forest', name: '다크 그린', bg: '#081c15', accent: '#10b981' },
    { id: 'brown', name: '다크 브라운', bg: '#1b120a', accent: '#f59e0b' },
    { id: 'macos-dark', name: 'macOS 다크', bg: '#1e1e1e', accent: '#0a84ff' },
    { id: 'windows-dark', name: 'Windows 다크', bg: '#202020', accent: '#60cdff' },
    { id: 'macos-light', name: 'macOS 라이트', bg: '#f5f5f5', accent: '#007aff' },
    { id: 'windows-light', name: 'Windows 라이트', bg: '#f3f3f3', accent: '#005fb8' },
    { id: 'paper', name: '페이퍼 라이트', bg: '#faf7f1', accent: '#b45309' },
    { id: 'sky-light', name: '스카이 라이트', bg: '#f1f5f9', accent: '#2563eb' }
  ],

  // 상태색 원본 (다크 기준). 라이트에서는 명도를 눌러 쓴다.
  BASE: {
    running: '#3fb950',
    waiting: '#d29922',
    done: '#58a6ff',
    exited: '#f85149',
    warn: '#e3b341',
    caution: '#f0883e',
    gitMod: '#e2c08d',
    gitAdd: '#73c991'
  },

  state: { id: 'dark', bg: '#14161c', accent: '#2e6cd6', isDark: true },

  // ── 색 계산 유틸 ──
  normalizeHex(value) {
    const v = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      const h = v.slice(1);
      return ('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
    }
    return null;
  },

  _rgb(hex) {
    const n = this.normalizeHex(hex);
    if (!n) return null;
    return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16) };
  },

  _hex(r, g, b) {
    const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
  },

  // t=0 이면 a, t=1 이면 b
  _mix(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  },

  _mixHex(aHex, bHex, t) {
    const a = this._rgb(aHex), b = this._rgb(bHex);
    if (!a || !b) return aHex;
    const m = this._mix(a, b, t);
    return this._hex(m.r, m.g, m.b);
  },

  _luminance(rgb) {
    const lin = [rgb.r, rgb.g, rgb.b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  },

  _rgba(hex, alpha) {
    const c = this._rgb(hex);
    if (!c) return hex;
    return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
  },

  _toHsl(hex) {
    const c = this._rgb(hex);
    if (!c) return null;
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h, s, l };
  },

  _fromHsl(h, s, l) {
    if (s === 0) { const v = l * 255; return this._hex(v, v, v); }
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return this._hex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
  },

  isDarkHex(hex) {
    const c = this._rgb(hex);
    return c ? this._luminance(c) < 0.35 : true;
  },

  _contrast(aHex, bHex) {
    const a = this._rgb(aHex), b = this._rgb(bHex);
    if (!a || !b) return 21;
    const la = this._luminance(a), lb = this._luminance(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  },

  /**
   * 배경 대비가 min 에 못 미치면 배경 반대 방향으로 섞어 대비를 확보한다.
   * HSL 명도만 자르면 노랑·초록처럼 체감 밝기가 높은 색이 라이트 배경에서 그대로 뜨는데,
   * 실제 상대휘도로 판정해 그 구멍을 막는다.
   */
  ensureContrast(hex, bgHex, min) {
    const base = this.normalizeHex(hex);
    if (!base) return hex;
    const target = this.isDarkHex(bgHex) ? '#ffffff' : '#000000';
    let out = base;
    for (let t = 0; t <= 1.001 && this._contrast(out, bgHex) < min; t += 0.04) {
      out = this._mixHex(base, target, t);
    }
    return out;
  },

  /**
   * 글자로 쓰이는 색을 현재 테마에서 읽히게 보정한다.
   * 라이트 테마: 너무 밝은 색을 어둡게 + 채도 보강, 다크: 너무 어두운 색을 밝게.
   * 그 뒤 배경 대비 4.5:1(작은 글자 AA)을 강제한다.
   * 프로젝트 이름·상태 배지처럼 사용자가 고른 색을 글자로 쓸 때 통과시킨다.
   */
  adjustText(hex, isDark, bgHex) {
    const dark = isDark === undefined ? this.state.isDark : isDark;
    const bg = this.normalizeHex(bgHex) || (bgHex === undefined ? this.state.bg : bgHex);
    const hsl = this._toHsl(hex);
    if (!hsl) return hex;
    let { h, s, l } = hsl;
    if (dark) {
      if (l < 0.5) l = 0.5;
    } else {
      if (l > 0.42) l = 0.42;
      if (s > 0 && s < 0.45) s = Math.min(0.7, s + 0.15); // 눌린 색이 회색으로 죽지 않게
    }
    return this.ensureContrast(this._fromHsl(h, s, l), bg || '#14161c', 4.5);
  },

  // ── 변수 파생 ──
  computeVars(bgHex, accentHex) {
    const bg = this.normalizeHex(bgHex) || '#14161c';
    const accentRaw = this.normalizeHex(accentHex) || '#2e6cd6';
    const isDark = this.isDarkHex(bg);
    const toward = isDark ? '#ffffff' : '#000000';
    const away = isDark ? '#000000' : '#ffffff';

    const bgPanel = this._mixHex(bg, toward, isDark ? 0.05 : 0.045);
    const bgHover = this._mixHex(bg, toward, isDark ? 0.11 : 0.095);
    const bgHoverHi = this._mixHex(bg, toward, isDark ? 0.17 : 0.15);
    const border = this._mixHex(bg, toward, isDark ? 0.16 : 0.2);

    // 글자색: 라이트에서 배경 색조를 살짝 머금은 진한 먹색 (순수 검정보다 눈이 편하다)
    const fg = isDark ? this._mixHex(bg, '#ffffff', 0.86) : this._mixHex(bg, '#000000', 0.9);
    const fgDim = isDark ? this._mixHex(bg, '#ffffff', 0.52) : this._mixHex(bg, '#000000', 0.58);

    // 강조색: 라이트에서는 배경 대비가 확보되도록 명도를 누른다
    // 강조색은 배지·테두리·활성 바에 쓰이므로 UI 요소 기준(3:1)까지만 밀어 색감을 살린다
    const accentStrong = this.ensureContrast(accentRaw, bg, 3.2);
    const accent = this._mixHex(accentStrong, bg, isDark ? 0.25 : 0.12);
    const accentFill = this._mixHex(accentStrong, bg, isDark ? 0.62 : 0.82);
    const accentFillHi = this._mixHex(accentStrong, bg, isDark ? 0.48 : 0.7);
    // 파랑 채움 위 글자 — 다크는 흰끼, 라이트는 강조색을 눌러 진하게
    const accentOnFill = isDark
      ? this._mixHex(accentStrong, '#ffffff', 0.85)
      : this._mixHex(accentStrong, '#000000', 0.45);

    const st = (key) => this.adjustText(this.BASE[key], isDark, bg);
    const running = st('running'), waiting = st('waiting'), done = st('done');
    const exited = st('exited'), warn = st('warn'), caution = st('caution');
    const gitMod = st('gitMod'), gitAdd = st('gitAdd');
    const tintA = isDark ? 0.16 : 0.13;
    const tintB = isDark ? 0.26 : 0.2;

    const codeBg = isDark ? '#0d1117' : '#f6f8fa';

    return {
      '--bg': bg,
      '--bg-panel': bgPanel,
      '--bg-hover': bgHover,
      '--bg-hover-hi': bgHoverHi,
      '--border': border,
      '--fg': fg,
      '--fg-dim': fgDim,
      '--fg-tint': this._rgba(fgDim, isDark ? 0.12 : 0.1),
      '--accent': accent,
      '--accent-strong': accentStrong,
      '--accent-fill': accentFill,
      '--accent-fill-hi': accentFillHi,
      '--accent-on-fill': accentOnFill,
      '--accent-tint': this._rgba(accentStrong, isDark ? 0.18 : 0.14),
      '--accent-tint-hi': this._rgba(accentStrong, isDark ? 0.28 : 0.22),
      '--running': running,
      '--running-tint': this._rgba(running, tintA),
      '--waiting': waiting,
      '--waiting-tint': this._rgba(waiting, tintA),
      '--waiting-tint-hi': this._rgba(waiting, tintB),
      '--done': done,
      '--done-tint': this._rgba(done, tintA),
      '--exited': exited,
      '--exited-tint': this._rgba(exited, tintA),
      '--exited-tint-hi': this._rgba(exited, tintB),
      '--warn': warn,
      '--warn-tint': this._rgba(warn, tintA),
      '--caution': caution,
      '--caution-tint': this._rgba(caution, tintA),
      '--git-mod': gitMod,
      '--git-add': gitAdd,
      '--danger-bg': this._mixHex(exited, bg, isDark ? 0.72 : 0.88),
      '--danger-fg': isDark ? this._mixHex(exited, '#ffffff', 0.2) : this._mixHex(exited, '#000000', 0.15),
      '--code-bg': codeBg,
      '--code-inline-bg': this._rgba(fgDim, isDark ? 0.15 : 0.13),
      '--overlay': isDark ? 'rgba(0, 0, 0, .55)' : 'rgba(15, 23, 42, .32)',
      '--shadow': isDark ? '0 10px 30px rgba(0, 0, 0, .35)' : '0 10px 30px rgba(15, 23, 42, .16)',
      '--chip-ring': isDark ? '#ffffff' : '#1f2937',
      // 터미널(xterm)용 — CSS 에는 쓰지 않지만 같은 계산에서 나온다
      '_termBg': bg,
      '_termFg': fg,
      '_isDark': isDark,
      '_awayRef': away
    };
  },

  // 라이트 배경에서도 읽히는 ANSI 팔레트 (GitHub Light 계열).
  // 다크는 xterm 기본 팔레트가 이미 최적화되어 있어 배경/전경만 넘긴다.
  LIGHT_ANSI: {
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7a4d05',
    blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
    brightBlack: '#6e7781', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
    brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#24292f'
  },

  termTheme() {
    const vars = this._vars || this.computeVars(this.state.bg, this.state.accent);
    const isDark = vars['_isDark'];
    const base = {
      background: vars['_termBg'],
      foreground: vars['_termFg'],
      cursor: vars['--accent-strong'],
      cursorAccent: vars['_termBg'],
      selectionBackground: vars['--accent-tint-hi'],
      // 포커스가 없어도 같은 색 — Shift+클릭 등 포커스 이동 없는 선택이 다른 색으로 보이지 않게
      selectionInactiveBackground: vars['--accent-tint-hi']
    };
    return isDark ? base : Object.assign(base, this.LIGHT_ANSI);
  },

  // ── 적용 ──
  apply() {
    const vars = this.computeVars(this.state.bg, this.state.accent);
    this._vars = vars;
    this.state.isDark = vars['_isDark'];
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith('_')) continue;
      root.style.setProperty(k, v);
    }
    // 네이티브 위젯(체크박스·색 선택기·스크롤바)이 테마를 따라가게 한다
    root.style.colorScheme = this.state.isDark ? 'dark' : 'light';
    document.body.dataset.theme = this.state.isDark ? 'dark' : 'light';
    // 코드 하이라이트 테마 교체 (github dark ↔ light)
    const link = document.getElementById('hljs-theme');
    if (link) link.href = this.state.isDark ? 'vendor/hljs-theme.css' : 'vendor/hljs-theme-light.css';
    if (window.TerminalView && TerminalView.applyTheme) TerminalView.applyTheme();
    if (typeof App !== 'undefined' && App.refreshThemedColors) App.refreshThemedColors();
  },

  set(id, bg, accent) {
    const preset = this.PRESETS.find((p) => p.id === id);
    if (preset) {
      this.state = { id: preset.id, bg: preset.bg, accent: preset.accent, isDark: this.isDarkHex(preset.bg) };
    } else {
      const nb = this.normalizeHex(bg), na = this.normalizeHex(accent);
      if (!nb || !na) return false;
      this.state = { id: 'custom', bg: nb, accent: na, isDark: this.isDarkHex(nb) };
    }
    try { localStorage.setItem(this.STORE_KEY, JSON.stringify(this.state)); } catch (_) {}
    this.apply();
    return true;
  },

  init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.STORE_KEY) || 'null'); } catch (_) {}
    const def = this.PRESETS[0];
    if (saved && typeof saved.id === 'string') {
      const preset = this.PRESETS.find((p) => p.id === saved.id);
      const bg = this.normalizeHex(preset ? preset.bg : saved.bg) || def.bg;
      const accent = this.normalizeHex(preset ? preset.accent : saved.accent) || def.accent;
      this.state = { id: saved.id, bg, accent, isDark: this.isDarkHex(bg) };
    } else {
      this.state = { id: def.id, bg: def.bg, accent: def.accent, isDark: true };
    }
    this.apply();
  }
};

// 스타일이 적용되기 전 한 프레임이라도 기본 다크가 비치지 않도록 즉시 실행
Theme.init();
