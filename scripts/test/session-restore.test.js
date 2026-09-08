// 재시작 세션 복원 — 건너뛴 항목 요약과 배너 수명(입력·실행 시 걷힘) 검증.
// session-restore.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'session-restore.js');

// 배너가 붙는 holder 를 흉내내는 최소 엘리먼트
function fakeHolder() {
  return {
    children: [],
    listeners: [],
    appendChild(el) { el.parent = this; this.children.push(el); return el; },
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    removeEventListener(type, fn) {
      const i = this.listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) this.listeners.splice(i, 1);
    },
    fire(type) { for (const [t, fn] of this.listeners.slice()) if (t === type) fn(); }
  };
}

function fakeElement() {
  const classes = new Set();
  const el = {
    textContent: '', title: '', onclick: null,
    // className 대입도 classList 에 반영한다
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
    get className() { return [...classes].join(' '); },
    children: [],
    // classList 와 className 은 실제 DOM 처럼 같은 값을 본다
    classList: {
      add(c) { classes.add(c); el.className = [...classes].join(' '); },
      remove(c) { classes.delete(c); el.className = [...classes].join(' '); },
      contains: (c) => classes.has(c)
    },
    append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } },
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    remove() {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    }
  };
  return el;
}

function load(opts) {
  const o = opts || {};
  const toasts = [];
  const rendered = { count: 0 };
  const holder = fakeHolder();
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    document: { createElement: () => fakeElement() },
    Date,
    Promise,
    Set,
    Map,
    formatRelativeTime: (ms) => new Date(ms).toISOString(),
    renderSidebar: () => { rendered.count++; },
    TerminalView: { views: new Map([['s1', { holder }]]) },
    ta: {
      restoreSessions: async () => o.restoreResult,
      listClaudeSessions: async () => o.claude || [],
      listCodexSessions: async () => o.codex || [],
      // 배너의 '마지막 요청' 조회 — 열람 팝업과 같은 커맨드를 쓴다
      claudeSessionMessages: async () => o.messages || [],
      codexSessionMessages: async () => o.messages || []
    },
    App: {
      state: { sessions: o.sessions || [] },
      showToast: (m) => toasts.push(m),
      buildSessionHistoryItems: (cwd, claude, codex) => [
        ...claude.map((it) => ({ ...it, cwd, source: 'claude' })),
        ...codex.map((it) => ({ ...it, cwd, source: 'codex' }))
      ].sort((a, b) => b.mtimeMs - a.mtimeMs),
      resumeSessionHistory: (it, opt) => { resumed.push([it.id, opt && opt.sessionId]); }
    }
  };
  const resumed = [];
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(SRC, 'utf8') + ';globalThis.__describe = describeSkippedSessions;',
    sandbox
  );
  return { App: sandbox.App, toasts, rendered, holder, resumed, describe: sandbox.__describe };
}

exports.name = '재시작 세션 복원 (건너뜀 요약 · 이어서 하기 배너)';

// 배너 안에서 클래스로 자식을 찾는다 (본문은 rb-body 아래 2줄 구조)
function findByClass(el, className) {
  for (const c of el.children || []) {
    if (String(c.className || '').split(/\s+/).includes(className)) return c;
    const deep = findByClass(c, className);
    if (deep) return deep;
  }
  return null;
}

// mountResumeBanner 가 띄운 비동기 조회(마지막 요청)가 끝나기를 기다린다
const settle = () => new Promise((r) => setImmediate(r));

exports.run = async function (t) {
  // ── 건너뛴 항목 요약 ──
  {
    const { describe } = load({});
    t.check('건너뛴 게 없으면 빈 문자열', describe([]) === '');
    t.check('삭제된 프로젝트를 센다',
      describe([{ reason: 'project', title: 'S1' }]) === '프로젝트가 삭제됨 1개');
    const cwdText = describe([
      { reason: 'cwd', cwd: '/x/a' }, { reason: 'cwd', cwd: '/x/b' }, { reason: 'cwd', cwd: '/x/c' }
    ]);
    t.check('사라진 폴더는 폴더 이름을 2개까지 보여주고 나머지는 생략',
      cwdText === '작업 폴더가 없어짐 3개 (a, b 외)', cwdText);
    // 세션 제목(S1)이 아니라 사라진 폴더를 보여줘야 어느 워크트리인지 알 수 있다
    const wtText = describe([
      { reason: 'cwd', cwd: 'C:\\dev\\TA-feat-login', title: 'S1' }
    ]);
    t.check('폴더가 사라진 세션은 제목 대신 폴더 이름을 보여준다',
      wtText === '작업 폴더가 없어짐 1개 (TA-feat-login)', wtText);
    t.check('프로젝트가 삭제된 경우는 세션 제목을 쓴다',
      describe([{ reason: 'project', cwd: '/x/y', title: 'S2' }]) === '프로젝트가 삭제됨 1개');
    t.check('알 수 없는 사유는 시작 실패로 묶는다',
      describe([{ reason: 'PTY 실패' }]) === '시작 실패 1개');
    const mixed = describe([{ reason: 'project', title: 'S1' }, { reason: 'cwd', cwd: '/x' }]);
    t.check('사유가 섞이면 함께 나열', mixed.includes('·'), mixed);
  }

  // ── 복원 결과 수집 ──
  {
    const { App } = load({ restoreResult: { restored: [{ id: 's1' }, { id: 's2' }], skipped: [] } });
    await App.restoreSessions();
    t.check('복원된 세션 id 를 기억한다',
      App._restoredSessions.has('s1') && App._restoredSessions.has('s2'));
  }
  {
    const { App } = load({ restoreResult: { restored: [{ id: 's1' }], alreadyRunning: true } });
    await App.restoreSessions();
    t.check('웹뷰 리로드(alreadyRunning)면 복원 표시를 하지 않는다', App._restoredSessions.size === 0);
  }

  // ── 배너 노출 조건 ──
  const recent = { id: 'c1', mtimeMs: Date.now() - 60000, preview: '작업 이어감' };
  const old = { id: 'c0', mtimeMs: Date.now() - 30 * 24 * 3600 * 1000, preview: '오래된 것' };
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    t.check('최근 기록이 있으면 배너가 붙는다', ctx.holder.children.length === 1);
    t.check('토스트는 뜨지 않는다 (건너뛴 게 없음)', ctx.toasts.length === 0);

    // 이어서 하기 → 같은 세션에서 재개
    const bar = ctx.holder.children[0];
    const go = bar.children.find((c) => c.className === 'rb-go');
    go.onclick();
    t.check('이어서 하기는 새 세션을 만들지 않고 이 세션을 재사용',
      ctx.resumed.length === 1 && ctx.resumed[0][0] === 'c1' && ctx.resumed[0][1] === 's1',
      JSON.stringify(ctx.resumed));
    t.check('클릭하면 배너가 걷힌다', ctx.holder.children.length === 0);
    t.check('복원 태그도 함께 사라진다', !ctx.App._restoredSessions.has('s1'));
  }
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [old]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    t.check('오래된 기록(7일 초과)에는 배너를 띄우지 않는다', ctx.holder.children.length === 0);
  }
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: []
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    t.check('기록이 없으면 배너를 띄우지 않는다', ctx.holder.children.length === 0);
  }

  // ── 배너 걷힘: 직접 입력 / 실행 시작 ──
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    ctx.holder.fire('keydown');
    t.check('터미널에 직접 입력하면 배너가 걷힌다', ctx.holder.children.length === 0);
    t.check('걷힌 뒤 keydown 리스너도 해제된다', ctx.holder.listeners.length === 0);
  }
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    // 프롬프트 전송·터미널 입력이 부르는 경로 (셸 시작 출력만으로는 걷히지 않는다)
    ctx.App.noteSessionActivity('s1');
    t.check('사용자 활동(입력·전송)이 있으면 배너가 걷힌다', ctx.holder.children.length === 0);
    ctx.App.noteSessionActivity('없는세션');
    t.check('복원과 무관한 세션에 불려도 안전하다', ctx.holder.children.length === 0);
  }

  // ── 건너뛴 항목 알림 ──
  {
    const ctx = load({
      restoreResult: { restored: [], skipped: [{ reason: 'cwd', cwd: '/gone' }] },
      sessions: []
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [], skipped: [{ reason: 'cwd', cwd: '/x/gone', title: 'S1' }] });
    t.check('복원하지 못한 세션은 사라진 폴더와 함께 토스트로 알린다',
      ctx.toasts.length === 1 && ctx.toasts[0].includes('gone'), JSON.stringify(ctx.toasts));
  }

  // ── 같은 경로에 세션이 여러 개면 하나에만 제안 ──
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }, { id: 's2' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }, { id: 's2', cwd: '/p' }],
      claude: [recent]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }, { id: 's2' }], skipped: [] });
    t.check('같은 대화를 두 세션에서 재개하지 않는다 (배너 1개)',
      ctx.holder.children.length === 1);
  }

  // ── 마지막 실행 요청 표시 ──
  {
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent],
      messages: [
        { role: 'user', kind: 'text', text: '첫 요청' },
        { role: 'assistant', kind: 'text', text: '답변' },
        { role: 'user', kind: 'text', text: '마지막으로  보낸\n요청' },
        { role: 'assistant', kind: 'tool', text: 'Bash: ls' }
      ]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    await settle();
    const last = findByClass(ctx.holder.children[0], 'rb-last');
    t.check('마지막 사용자 요청을 한 줄로 보여준다',
      last && last.textContent === '마지막 요청 · 마지막으로 보낸 요청',
      last && last.textContent);
    t.check('툴팁에는 원문을 남긴다', last && last.title === '마지막으로  보낸\n요청');
    const meta = findByClass(ctx.holder.children[0], 'rb-meta');
    t.check('첫 줄에는 도구·시각·첫 요청이 남는다', meta && meta.textContent.includes('작업 이어감'));
  }
  {
    // 사용자 요청을 못 찾으면 빈 줄을 남기지 않는다
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent],
      messages: [{ role: 'assistant', kind: 'text', text: '답변만 있음' }]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    await settle();
    t.check('마지막 요청이 없으면 그 줄을 지운다',
      !findByClass(ctx.holder.children[0], 'rb-last'));
  }
  {
    // 조회가 끝나기 전에 배너를 걷어도 안전해야 한다
    const ctx = load({
      restoreResult: { restored: [{ id: 's1' }], skipped: [] },
      sessions: [{ id: 's1', cwd: '/p' }],
      claude: [recent],
      messages: [{ role: 'user', kind: 'text', text: '요청' }]
    });
    await ctx.App.restoreSessions();
    await ctx.App.afterSessionRestore({ restored: [{ id: 's1' }], skipped: [] });
    ctx.App.dismissResumeBanner('s1');
    await settle();
    t.check('조회 중 배너가 걷혀도 오류 없이 끝난다', ctx.holder.children.length === 0);
  }
};
