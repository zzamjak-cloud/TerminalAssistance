// Pull 실패 진단 팝업 — 실패 유형별 안내, 막은 파일 목록, 파일별 되돌리기(2단 확인) 검증.
// 되돌리기는 복구할 수 없는 작업이므로 "한 번 클릭으로는 실행되지 않는다"를 특히 못박아 둔다.
// git-pull.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'git-pull.js');

function fakeElement(tag) {
  const classes = new Set();
  const el = {
    tag: tag || 'div',
    textContent: '', title: '', innerHTML: '', disabled: false, onclick: null,
    children: [],
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
    get className() { return [...classes].join(' '); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
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

// 팝업 HTML 은 실제로 파싱하지 않는다 — querySelector 로 찾는 자리만 대신 채운다
function fakeModalRoot(html) {
  const nodes = new Map();
  return {
    html,
    querySelector(sel) {
      if (!nodes.has(sel)) nodes.set(sel, fakeElement());
      return nodes.get(sel);
    },
    node: (sel) => nodes.get(sel)
  };
}

function load(opts) {
  const o = opts || {};
  const calls = { discard: [], toasts: [], modal: [], explorerRefresh: 0, pull: [] };
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    Date, Promise, Set, Map,
    setTimeout, clearTimeout,
    document: { createElement: (tag) => fakeElement(tag) },
    escapeHtml: (s) => String(s),
    ta: {
      gitPull: async (cwd) => { calls.pull.push(cwd); return o.pullResult; },
      gitDiscardPaths: async (cwd, paths) => {
        calls.discard.push([cwd, paths]);
        if (o.discardThrows) throw new Error('권한 없음');
        return o.discardResult || { ok: true, done: paths, failed: [] };
      }
    },
    App: {
      state: { gitRemote: o.gitRemote || {} },
      showToast: (m) => calls.toasts.push(m),
      renderPanePresets() {},
      refreshBranch() {},
      refreshGitRemote: async () => {},
      refreshExplorer: async () => { calls.explorerRefresh++; },
      modal(html, onOpen) {
        const m = fakeModalRoot(html);
        calls.modal.push(m);
        onOpen(m, () => { calls.closed = true; });
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return { App: sandbox.App, calls };
}

// 목록에서 파일 한 줄(.pull-file)을 꺼낸다
function rowsOf(modal) {
  const host = modal.node('.pull-files');
  return (host ? host.children : []).filter((c) => c.className.split(' ').includes('pull-file'));
}
const partOf = (row, cls) => row.children.find((c) => c.className.split(' ').includes(cls));

exports.name = 'Pull 실패 진단 팝업 (원인 · 파일 목록 · 되돌리기)';

exports.run = async function (t) {
  // ── 성공은 토스트만, 실패는 팝업 ──
  {
    const ctx = load({ pullResult: { ok: true, message: 'Fast-forward' } });
    await ctx.App.runGitPull('/repo');
    t.check('Pull 성공은 토스트로 알린다',
      ctx.calls.toasts.length === 1 && ctx.calls.toasts[0].includes('Fast-forward'),
      JSON.stringify(ctx.calls.toasts));
    t.check('성공 시 팝업은 띄우지 않는다', ctx.calls.modal.length === 0);
  }
  {
    const ctx = load({
      pullResult: {
        ok: false, kind: 'local_changes', message: 'error: ...',
        files: [{ path: 'src/a.js', status: 'M', untracked: false }],
        raw: 'error: Your local changes...'
      },
      gitRemote: { '/repo': { branch: 'main', behind: 3 } }
    });
    await ctx.App.runGitPull('/repo');
    t.check('Pull 실패는 팝업으로 원인을 보여준다', ctx.calls.modal.length === 1);
    const m = ctx.calls.modal[0];
    t.check('제목에 실패 원인 유형이 들어간다', m.html.includes('로컬 수정이 원격 변경과 겹칩니다'), m.html);
    t.check('부제에 브랜치·받을 커밋 수·경로를 담는다',
      m.node('.modal-sub').textContent === '⎇ main · 원격에 새 커밋 3개 · /repo',
      m.node('.modal-sub').textContent);
    t.check('git 원본 출력을 그대로 남긴다',
      m.node('.pull-raw pre').textContent === 'error: Your local changes...');
    t.check('실패 토스트는 띄우지 않는다 (팝업이 대신한다)', ctx.calls.toasts.length === 0);
    const rows = rowsOf(m);
    t.check('막은 파일이 목록에 한 줄씩 들어간다', rows.length === 1);
    t.check('상태 문자를 배지로 보여준다', partOf(rows[0], 'pf-status').textContent === 'M');
    t.check('경로를 그대로 보여준다', partOf(rows[0], 'pf-path').textContent === 'src/a.js');
  }

  // ── 유형별 안내 ──
  {
    const ctx = load({ pullResult: { ok: false, kind: 'diverged', message: 'fatal: ...', files: [], raw: 'fatal: ...' } });
    await ctx.App.runGitPull('/repo');
    const m = ctx.calls.modal[0];
    t.check('갈라진 브랜치는 rebase/merge 안내를 준다', m.html.includes('--rebase'), m.html);
    t.check('파일이 원인이 아니면 그렇다고 알려 준다',
      m.node('.pull-files').children[0].textContent.includes('특정 파일이 원인은 아닙니다'));
  }
  {
    // 알 수 없는 kind(백엔드 확장·구버전)도 팝업이 떠야 한다
    const ctx = load({ pullResult: { ok: false, kind: 'brand_new', message: '?', files: [], raw: 'x' } });
    await ctx.App.runGitPull('/repo');
    t.check('모르는 실패 유형도 기본 안내로 표시한다',
      ctx.calls.modal.length === 1 && ctx.calls.modal[0].html.includes('Pull 실패'));
  }
  {
    // 커맨드 자체가 실패해도 원인을 삼키지 않는다
    const ctx = load({ pullResult: null });
    await ctx.App.runGitPull('/repo');
    t.check('백엔드 응답이 없어도 팝업으로 알린다', ctx.calls.modal.length === 1);
  }

  // ── 되돌리기: 2단 확인 ──
  {
    const ctx = load({
      pullResult: {
        ok: false, kind: 'local_changes', message: 'e',
        files: [{ path: 'src/a.js', status: 'M', untracked: false }], raw: 'e'
      }
    });
    await ctx.App.runGitPull('/repo');
    const row = rowsOf(ctx.calls.modal[0])[0];
    const btn = partOf(row, 'pf-discard');
    t.check('추적 파일은 되돌리기 버튼', btn.textContent === '되돌리기');
    await btn.onclick();
    t.check('첫 클릭으로는 실행되지 않는다 (확인 단계)', ctx.calls.discard.length === 0);
    t.check('확인 단계임을 버튼에 표시한다',
      btn.textContent === '정말 되돌리기?' && btn.classList.contains('armed'), btn.textContent);
    await btn.onclick();
    t.check('두 번째 클릭에서 되돌린다',
      ctx.calls.discard.length === 1
      && ctx.calls.discard[0][0] === '/repo'
      && ctx.calls.discard[0][1].length === 1
      && ctx.calls.discard[0][1][0] === 'src/a.js',
      JSON.stringify(ctx.calls.discard));
    t.check('되돌린 줄은 목록에 남겨 표시한다',
      row.classList.contains('done') && btn.textContent === '되돌렸습니다', btn.textContent);
    t.check('탐색기 변경 표시도 갱신한다', ctx.calls.explorerRefresh === 1);
  }

  // ── 미추적 파일은 '삭제'로 안내 ──
  {
    const ctx = load({
      pullResult: {
        ok: false, kind: 'untracked', message: 'e',
        files: [{ path: 'docs/new.md', status: 'U', untracked: true }], raw: 'e'
      }
    });
    await ctx.App.runGitPull('/repo');
    const btn = partOf(rowsOf(ctx.calls.modal[0])[0], 'pf-discard');
    t.check('미추적 파일은 삭제라고 명시한다', btn.textContent === '삭제');
    await btn.onclick();
    t.check('확인 문구도 삭제로 바뀐다', btn.textContent === '정말 삭제?', btn.textContent);
    await btn.onclick();
    t.check('삭제 후 표시도 삭제됨', btn.textContent === '삭제됨', btn.textContent);
  }

  // ── 되돌리기 실패 ──
  {
    const ctx = load({
      pullResult: {
        ok: false, kind: 'local_changes', message: 'e',
        files: [{ path: 'src/a.js', status: 'M', untracked: false }], raw: 'e'
      },
      discardResult: { ok: false, done: [], failed: [{ path: 'src/a.js', message: '파일이 잠겨 있습니다' }] }
    });
    await ctx.App.runGitPull('/repo');
    const row = rowsOf(ctx.calls.modal[0])[0];
    const btn = partOf(row, 'pf-discard');
    await btn.onclick();
    await btn.onclick();
    t.check('실패하면 사유를 토스트로 알린다',
      ctx.calls.toasts.some((m) => m.includes('파일이 잠겨 있습니다')), JSON.stringify(ctx.calls.toasts));
    t.check('실패한 줄은 다시 시도할 수 있게 남는다',
      !btn.disabled && btn.textContent === '실패 — 재시도' && row.classList.contains('failed'),
      btn.textContent);
    t.check('실패 사유를 툴팁에 남긴다', btn.title === '파일이 잠겨 있습니다');
  }
  {
    // 커맨드가 예외를 던져도 팝업이 멈추지 않는다
    const ctx = load({
      pullResult: {
        ok: false, kind: 'local_changes', message: 'e',
        files: [{ path: 'src/a.js', status: 'M', untracked: false }], raw: 'e'
      },
      discardThrows: true
    });
    await ctx.App.runGitPull('/repo');
    const btn = partOf(rowsOf(ctx.calls.modal[0])[0], 'pf-discard');
    await btn.onclick();
    await btn.onclick();
    t.check('예외도 실패로 처리해 재시도를 허용한다',
      !btn.disabled && ctx.calls.toasts.some((m) => m.includes('권한 없음')), btn.textContent);
  }

  // ── 중복 실행 방지 ──
  {
    const ctx = load({ pullResult: { ok: true, message: 'ok' } });
    ctx.App._gitPulling = '/repo';
    await ctx.App.runGitPull('/repo');
    t.check('같은 저장소의 Pull 이 진행 중이면 다시 실행하지 않는다', ctx.calls.pull.length === 0);
  }
};
