// 브라우저 안에서 실행되는 Tauri 목. window.__DEMO__ (JSON) 이 먼저 주입된다.
(function () {
  const D = window.__DEMO__;
  const listeners = {};
  const offs = {};
  const state = {
    projects: D.projects, presets: D.presets, recipes: [],
    settings: Object.assign({
      fontSize: 13, fontFamily: '', shell: '', notifyOnDone: true, notifyOnWaiting: true,
      showPromptInput: false, lineHeight: 1, letterSpacing: 0, minContrast: 1,
      claudeClassicRenderer: false, killBackgroundOnClose: false, contextWarnClaudeK: 200, contextWarnCodexPct: 60
    }, D.settings || {}),
    sessions: D.sessions, drafts: D.drafts || {}, platform: 'macos'
  };
  const handlers = {
    get_state: async () => { await window.__ensureFonts(); return JSON.parse(JSON.stringify(state)); },
    restore_sessions: () => ({ alreadyRunning: true, restored: [], skipped: [] }),
    get_scrollback: ({ id }) => { const d = D.scroll[id] || ''; offs[id] = d.length; return { data: d, off: d.length }; },
    ai_tools_installed: () => ({ claude: true, codex: true, antigravity: true }),
    claude_usage: () => D.usage.claude, codex_usage: () => D.usage.codex, antigravity_usage: () => D.usage.antigravity,
    get_memory: () => ({ pct: 52, cpu: 23, usedGb: 16.6, totalGb: 32 }),
    git_branch: ({ cwd }) => D.branches[cwd] || null,
    git_remote_state: ({ cwd }) => D.remote[cwd] || null,
    list_orphans: () => D.orphans || [],
    hooks_status: () => ({ claude: true, codex: true }),
    remote_get_config: () => ({ enabled: false, bind: '', port: 0, running: false, urls: [], devices: [], push: { kind: 'off' } }),
    list_shells: () => [{ label: 'zsh', value: '/bin/zsh' }],
    take_pending_resume: () => [], busy_agent_sessions: () => [],
    context_usage: () => null, hook_prompt: () => ({ hooked: false, id: null, prompt: null }),
    list_dir: ({ path }) => (D.tree && D.tree[path]) || [],
    git_status: () => null,
    repo_info: ({ cwd }) => D.repo[cwd] || null,
    worktree_check: () => ({ ok: true, dirty: false })
  };
  async function invoke(cmd, args) {
    const h = handlers[cmd];
    if (h) return h(args || {});
    if (/^list_|_list$/.test(cmd)) return [];
    window.__unmocked = (window.__unmocked || []).concat(cmd);
    return null;
  }
  let evId = 1;
  window.__TAURI__ = {
    core: { invoke, convertFileSrc: (p) => p },
    event: {
      listen: async (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return () => {}; }
    }
  };
  // 캡처 스크립트가 호출: 세션 출력 / 상태
  window.__emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ event: name, id: evId++, payload }));
  window.__feed = (sessionId, data) => {
    offs[sessionId] = (offs[sessionId] || 0) + data.length;
    window.__emit('ta:data', { sessionId, data, bytes: data.length, off: offs[sessionId] });
  };
  window.__status = (sessionId, status, busyMs) => window.__emit('ta:status', { sessionId, status, busyMs: busyMs || 0 });
  // 알림·클립보드 등 사용자 환경에 닿는 것 차단
  window.Notification = undefined;
})();
