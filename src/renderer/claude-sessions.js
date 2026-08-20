// Claude Code 세션 열람: Claude Code 가 ~/.claude/projects 에 저장해 둔 세션 기록을
// 현재 세션의 작업 경로 기준으로 나열하고, 클릭 시 같은 프로젝트에 새 터미널을 열어
// `claude --resume <id>` 로 재개한다. 앱은 기록을 읽기만 하고 자체 저장은 하지 않는다.
const CLAUDE_LIST_TTL_MS = 10000; // 세션 전환마다 파일 파싱을 반복하지 않기 위한 캐시 수명

function claudeRelTime(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return '방금';
  if (d < 3600000) return Math.floor(d / 60000) + '분 전';
  if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
  return Math.floor(d / 86400000) + '일 전';
}

Object.assign(App, {
  _claudeCache: {}, // cwd → { at, items }

  // 목록 기준 경로: 활성 세션의 작업 폴더 (프로젝트 터미널 = 프로젝트 경로)
  claudeCwd() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    return s ? s.cwd : null;
  },

  async renderClaudeList(force) {
    // 패널이 닫혀 있으면 렌더 생략 — 열 때 togglePromptPanel 이 다시 채운다
    if (document.getElementById('prompt-panel').classList.contains('hidden')) return;
    const el = document.getElementById('claude-list');
    const cwd = App.claudeCwd();
    if (!cwd) {
      el.textContent = '';
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '세션을 열면 해당 경로에서 진행했던 Claude Code 세션 목록이 표시됩니다.';
      el.appendChild(e);
      return;
    }
    let cached = App._claudeCache[cwd];
    if (force || !cached || Date.now() - cached.at > CLAUDE_LIST_TTL_MS) {
      let items = [];
      try { items = await ta.listClaudeSessions(cwd); } catch (_) { /* 목록 실패 = 빈 목록 */ }
      cached = App._claudeCache[cwd] = { at: Date.now(), items };
      if (App.claudeCwd() !== cwd) return; // await 사이에 세션이 바뀌었으면 그 쪽 렌더에 맡긴다
    }
    el.textContent = '';
    if (!cached.items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '이 경로에 저장된 Claude Code 세션이 없습니다. (claude 실행 시 자동으로 기록됩니다)';
      el.appendChild(e);
      return;
    }
    for (const it of cached.items) {
      const row = document.createElement('div');
      row.className = 'cs-item';
      const time = document.createElement('div');
      time.className = 'cs-time';
      time.textContent = claudeRelTime(it.mtimeMs);
      const text = document.createElement('div');
      text.className = 'cs-text';
      text.textContent = it.preview;
      row.title = it.preview + '\n\n' + new Date(it.mtimeMs).toLocaleString()
        + '\n클릭하면 새 터미널에서 claude --resume 으로 재개합니다.';
      row.onclick = () => App.resumeClaudeSession(it);
      row.append(time, text);
      el.appendChild(row);
    }
  },

  // 같은 프로젝트에 새 터미널을 열고 resume 명령 실행.
  // 셸 초기화 출력과 입력이 얽히지 않도록 잠시 뒤에 보낸다 (그 전 입력도 PTY 가 버퍼링하긴 함)
  async resumeClaudeSession(it) {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    const info = await App.createSession(s ? s.projectId : null);
    if (info) setTimeout(() => ta.write(info.id, 'claude --resume ' + it.id + '\r'), 600);
  }
});
