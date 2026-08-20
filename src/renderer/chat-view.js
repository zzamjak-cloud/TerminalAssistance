// 채팅 뷰: 활성 세션의 Claude Code 대화(jsonl 증분 tail)를 말풍선으로 표시.
// 메인 영역을 [터미널]/[채팅] 탭으로 전환하며, 입력은 PTY 직접 전달(drafts 의 deliverDraft 재사용).
// 대상 파일: 훅이 기록한 Claude 세션 id 우선, 없으면 프로젝트 폴더의 최근 활동 jsonl 폴백.
Object.assign(App, {
  CHAT_POLL_MS: 1000,
  CHAT_LOG_CAP: 500, // 세션당 보관 말풍선 상한 (DOM·메모리 방어)
  viewModes: new Map(), // sessionId → 'term' | 'chat'
  chatStates: new Map(), // sessionId → { file, offset, msgs }
  _chatBusy: false,

  initChatView() {
    document.querySelectorAll('#view-tabs button').forEach((b) => {
      b.onclick = () => App.setViewMode(App.state.activeId, b.dataset.mode);
    });
    const input = document.getElementById('chat-input');
    input.addEventListener('keydown', (ev) => {
      // IME 조합 중 Enter 는 조합 확정이지 전송이 아니다
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        App.sendChat();
      }
    });
    document.getElementById('chat-send').onclick = () => App.sendChat();
    setInterval(() => App.pollChat(), App.CHAT_POLL_MS);
  },

  setViewMode(id, mode) {
    if (!id) return;
    App.viewModes.set(id, mode);
    App.applyViewMode(true);
    if (mode === 'chat') App.pollChat();
  },

  // 탭 표시/영역 전환. rebuild 가 참이면 채팅 로그 DOM 을 캐시에서 재구축 (세션 전환·탭 전환 시)
  applyViewMode(rebuild) {
    const id = App.state.activeId;
    const mode = (id && App.viewModes.get(id)) || 'term';
    const tabs = document.getElementById('view-tabs');
    tabs.style.display = id ? '' : 'none';
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('term-area').style.display = mode === 'term' ? '' : 'none';
    document.getElementById('chat-view').style.display = mode === 'chat' ? 'flex' : 'none';
    if (!rebuild) return; // 실제 전환일 때만 무거운 작업 (renderTopbar 의 상시 호출은 표시 동기화만)
    if (mode === 'term') {
      TerminalView.fitActive(); // 숨김 동안의 크기 변화 반영
    } else {
      App.renderChatLog();
    }
  },

  renderChatLog() {
    const log = document.getElementById('chat-log');
    log.textContent = '';
    const st = App.chatStates.get(App.state.activeId);
    if (!st || !st.msgs.length) {
      const e = document.createElement('div');
      e.className = 'chat-empty';
      e.textContent = '표시할 대화가 없습니다. 이 세션에서 claude 또는 codex 를 실행하면 대화가 여기에 나타납니다.';
      log.appendChild(e);
      return;
    }
    for (const m of st.msgs) log.appendChild(App.chatBubble(m));
    log.scrollTop = log.scrollHeight;
  },

  chatBubble(m) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (m.kind === 'tool' ? 'tool' : m.role);
    el.textContent = m.kind === 'tool' ? '· ' + m.text : m.text;
    return el;
  },

  async pollChat() {
    const id = App.state.activeId;
    if (!id || App.viewModes.get(id) !== 'chat' || App._chatBusy) return;
    const s = App.state.sessions.find((x) => x.id === id);
    if (!s) return;
    App._chatBusy = true;
    try {
      const sid = await ta.claudeSessionOf(id).catch(() => null);
      let st = App.chatStates.get(id) || { file: null, offset: 0, msgs: [] };
      const chunk = await ta.chatTail(s.cwd, sid, st.file, st.offset, s.createdAtMs);
      const log = document.getElementById('chat-log');
      if (!chunk) {
        if (!st.msgs.length) App.renderChatLog(); // 대화 없음 안내 유지
        return;
      }
      // 다른 세션 파일로 전환됨 (새 claude 실행 등) → 로그 리셋
      if (chunk.file !== st.file) {
        st = { file: chunk.file, offset: chunk.offset, msgs: [] };
        log.textContent = '';
      } else {
        st.offset = chunk.offset;
      }
      App.chatStates.set(id, st);
      if (chunk.messages.length) {
        // 활성 세션이 그대로일 때만 DOM 에 증분 반영 (아니면 캐시만 갱신)
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        const emptyNote = log.querySelector('.chat-empty');
        if (emptyNote) emptyNote.remove();
        st.msgs.push(...chunk.messages);
        if (st.msgs.length > App.CHAT_LOG_CAP) st.msgs.splice(0, st.msgs.length - App.CHAT_LOG_CAP);
        if (App.state.activeId === id) {
          for (const m of chunk.messages) log.appendChild(App.chatBubble(m));
          while (log.children.length > App.CHAT_LOG_CAP) log.removeChild(log.firstChild);
          if (nearBottom) log.scrollTop = log.scrollHeight;
        }
      }
    } finally {
      App._chatBusy = false;
    }
  },

  sendChat() {
    const id = App.state.activeId;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!id || !text) return;
    App.deliverDraft(id, text); // PTY 직접 전달 + Enter — 터미널 뷰와 동일 경로
    input.value = '';
  }
});

App.initChatView();
