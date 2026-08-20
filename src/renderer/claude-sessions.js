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
        + '\n클릭하면 저장된 대화 내용을 보여줍니다.';
      row.onclick = () => App.showClaudeSessionPopup(it);
      row.append(time, text);
      el.appendChild(row);
    }
  },

  // 세션 항목 클릭 → 저장된 대화 내용을 팝업으로 열람. 재개는 팝업의 버튼으로.
  async showClaudeSessionPopup(it) {
    const cwd = App.claudeCwd();
    let msgs = [];
    try { msgs = await ta.claudeSessionMessages(cwd, it.id); } catch (_) { /* 실패 = 빈 내용 */ }
    App.modal(`
      <h3>Claude 세션 기록</h3>
      <div class="modal-sub"></div>
      <div class="cv-log"></div>
      <div class="modal-actions">
        <button id="m-resume">새 터미널에서 이어서 진행</button>
        <button id="m-close">닫기</button>
      </div>`,
      (m, close) => {
        m.querySelector('.modal-sub').textContent =
          new Date(it.mtimeMs).toLocaleString() + ' · ' + it.id.slice(0, 8);
        const log = m.querySelector('.cv-log');
        if (!msgs.length) {
          const e = document.createElement('div');
          e.className = 'prompt-empty';
          e.textContent = '표시할 대화 내용이 없습니다.';
          log.appendChild(e);
        }
        for (const msg of msgs) {
          const b = document.createElement('div');
          b.className = 'cv-msg ' + (msg.kind === 'tool' ? 'tool' : msg.role);
          b.textContent = msg.kind === 'tool' ? '· ' + msg.text : msg.text;
          log.appendChild(b);
        }
        log.scrollTop = log.scrollHeight; // 최근 대화부터 보이게
        m.querySelector('#m-resume').onclick = () => { close(); App.resumeClaudeSession(it); };
        m.querySelector('#m-close').onclick = close;
      }, { wide: true });
  },

  // 재개 자동화: 새 세션을 자동 생성하고 그 안에서 resume 명령을 즉시 실행한다.
  // 세션 경로는 기록의 cwd 와 일치하는 프로젝트 우선 — Claude Code 는 세션을 경로 기준으로
  // 찾으므로 홈 터미널에서 열람했더라도 올바른 경로에서 재개된다.
  // 셸 초기화 출력과 입력이 얽히지 않도록 잠시 뒤에 보낸다 (그 전 입력도 PTY 가 버퍼링하긴 함)
  _resuming: false, // 연타로 세션이 여러 개 생기지 않게
  async resumeClaudeSession(it) {
    if (App._resuming) return;
    App._resuming = true;
    try {
      const cwd = App.claudeCwd();
      const active = App.state.sessions.find((x) => x.id === App.state.activeId);
      const proj = App.state.projects.find((p) => p.path === cwd);
      const info = await App.createSession(proj ? proj.id : (active ? active.projectId : null));
      if (info) setTimeout(() => ta.write(info.id, 'claude --resume ' + it.id + '\r'), 600);
    } finally {
      App._resuming = false;
    }
  }
});
