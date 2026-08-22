// 하단 프롬프트 작성기: 즉시 전송, 세션별 예약 FIFO, 기존 프로젝트 초안을 함께 관리한다.
// 예약은 기존 drafts 맵의 queued:<sessionId> 키를 사용해 백엔드 형식 변경 없이 영속화한다.
Object.assign(App, {
  _draftSaveChains: new Map(), // 같은 키의 저장 순서를 보장해 늦은 응답이 최신 큐를 덮지 않게 한다
  _queueDispatching: new Set(),
  _composerTexts: new Map(), // 세션 전환 중 작성하던 텍스트의 오전송 방지

  draftKeyForSession(sessionId) {
    const s = App.state.sessions.find((x) => x.id === sessionId);
    return s && s.projectId ? s.projectId : '';
  },

  queueKey(sessionId) {
    return `queued:${sessionId}`;
  },

  rememberComposerText(text) {
    const id = App.state.activeId;
    if (id) App._composerTexts.set(id, text);
  },

  setComposerText(text) {
    const id = App.state.activeId;
    if (id) App._composerTexts.set(id, text);
    if (TerminalView.promptInput) {
      TerminalView.promptInput.value = text;
      TerminalView.resizePromptInput();
    }
  },

  composerText() {
    return TerminalView.promptInput ? TerminalView.promptInput.value : '';
  },

  clearComposerText() {
    App.setComposerText('');
  },

  // 키별 IPC 저장을 직렬화한다. 호출 시점의 배열을 복사해 이후 로컬 변경과 분리한다.
  persistDraftList(key, drafts) {
    const snapshot = drafts.map((d) => ({ id: d.id, text: d.text }));
    const previous = App._draftSaveChains.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => ta.setDrafts(key, snapshot));
    App._draftSaveChains.set(key, task);
    const cleanup = () => {
      if (App._draftSaveChains.get(key) === task) App._draftSaveChains.delete(key);
    };
    task.then(cleanup, cleanup);
    return task;
  },

  renderComposerQueue() {
    const el = document.getElementById('terminal-prompt-list');
    if (!el) return;
    el.textContent = '';
    const id = App.state.activeId;
    if (!id) {
      el.classList.add('hidden');
      return;
    }

    const input = TerminalView.promptInput;
    const remembered = App._composerTexts.get(id) || '';
    if (input && input.value !== remembered) input.value = remembered;

    const queueKey = App.queueKey(id);
    const queued = App.state.drafts[queueKey] || [];
    const legacyKey = App.draftKeyForSession(id);
    const legacy = App.state.drafts[legacyKey] || [];

    const appendItem = (d, label, className, actions) => {
      const row = document.createElement('div');
      row.className = `composer-item ${className}`;
      const kind = document.createElement('span');
      kind.className = 'composer-kind';
      kind.textContent = label;
      const text = document.createElement('span');
      text.className = 'composer-text';
      text.textContent = d.text;
      text.title = d.text;
      row.append(kind, text, ...actions);
      el.appendChild(row);
    };

    queued.forEach((d, index) => {
      const cancel = document.createElement('button');
      cancel.className = 'composer-remove';
      cancel.textContent = '취소';
      cancel.onclick = () => App.removeStoredDraft(queueKey, d.id);
      appendItem(d, `예약 ${index + 1}`, 'queued', [cancel]);
    });

    legacy.forEach((d) => {
      const load = document.createElement('button');
      load.textContent = '불러오기';
      load.onclick = () => {
        App.setComposerText(d.text);
        if (TerminalView.promptInput) TerminalView.promptInput.focus();
      };
      const remove = document.createElement('button');
      remove.className = 'composer-remove';
      remove.textContent = '삭제';
      remove.onclick = () => App.removeStoredDraft(legacyKey, d.id);
      appendItem(d, '기존 초안', 'legacy', [load, remove]);
    });

    el.classList.toggle('hidden', !queued.length && !legacy.length);
  },

  async removeStoredDraft(key, draftId) {
    const before = App.state.drafts[key] || [];
    const next = before.filter((d) => d.id !== draftId);
    App.state.drafts[key] = next;
    App.renderComposerQueue();
    try {
      await App.persistDraftList(key, next);
    } catch (e) {
      // 저장 대기 중 더 최신 변경이 생겼다면 그 상태를 롤백으로 덮지 않는다.
      if (App.state.drafts[key] === next) App.state.drafts[key] = before;
      App.renderComposerQueue();
      console.warn('프롬프트 저장 실패:', e);
    }
  },

  // Cmd/Ctrl+Enter 또는 전송 버튼은 상태와 관계없이 활성 세션에 즉시 실행한다.
  sendComposerPrompt() {
    const id = App.state.activeId;
    const text = App.composerText();
    if (!id || !text.trim() || !TerminalView.views.has(id)) return;
    App.deliverDraft(id, text);
    App.clearComposerText();
    App.renderComposerQueue();
  },

  // 진행중·허가 대기 상태만 예약한다. 이미 쉬는 세션은 기다릴 작업이 없으므로 즉시 전송한다.
  async scheduleComposerPrompt() {
    const id = App.state.activeId;
    const text = App.composerText();
    const session = App.state.sessions.find((s) => s.id === id);
    if (!session || !text.trim() || !TerminalView.views.has(id)) return;
    if (session.status === 'idle' || session.status === 'done') {
      App.sendComposerPrompt();
      return;
    }
    if (session.status !== 'running' && session.status !== 'waiting') return;

    const key = App.queueKey(id);
    const before = App.state.drafts[key] || [];
    const next = [...before, { id: newLocalId(), text }];
    App.state.drafts[key] = next;
    App.clearComposerText();
    App.renderComposerQueue();
    try {
      await App.persistDraftList(key, next);
    } catch (e) {
      // 같은 큐에 후속 예약이 추가된 경우 최신 배열을 보존한다.
      if (App.state.drafts[key] === next) {
        App.state.drafts[key] = before;
        if (!App.composerText()) App.setComposerText(text);
      }
      App.renderComposerQueue();
      console.warn('예약 저장 실패:', e);
    }
  },

  // 영속 저장소에서 선두 항목 제거가 성공한 뒤에만 PTY로 보낸다(at-most-once).
  async dispatchNextQueued(sessionId) {
    if (App._queueDispatching.has(sessionId)) return;
    const key = App.queueKey(sessionId);
    const before = App.state.drafts[key] || [];
    const nextDraft = before[0];
    if (!nextDraft || !nextDraft.text.trim()) return;
    App._queueDispatching.add(sessionId);
    const rest = before.slice(1);
    App.state.drafts[key] = rest;
    App.renderComposerQueue();
    try {
      await App.persistDraftList(key, rest);
      App.deliverDraft(sessionId, nextDraft.text);
    } catch (e) {
      const current = App.state.drafts[key] || [];
      if (!current.some((d) => d.id === nextDraft.id)) {
        App.state.drafts[key] = [nextDraft, ...current];
      }
      App.renderComposerQueue();
      console.warn('예약 전송 준비 실패:', e);
    } finally {
      App._queueDispatching.delete(sessionId);
    }
  },

  handleQueuedDone(sessionId) {
    App.dispatchNextQueued(sessionId);
  },

  async clearQueuedPrompts(sessionId) {
    const key = App.queueKey(sessionId);
    if (!Object.prototype.hasOwnProperty.call(App.state.drafts, key)) return;
    delete App.state.drafts[key];
    try { await App.persistDraftList(key, []); }
    catch (e) { console.warn('예약 정리 실패:', e); }
  },

  async cleanupDeadQueuedPrompts() {
    const alive = new Set(App.state.sessions.map((s) => s.id));
    const stale = Object.keys(App.state.drafts)
      .filter((key) => key.startsWith('queued:') && !alive.has(key.slice(7)));
    await Promise.all(stale.map((key) => App.clearQueuedPrompts(key.slice(7))));
  },

  // 세션 하나에 프롬프트 전달 + 즉시 실행. paste 경로로 bracketed paste를 유지한다.
  deliverDraft(sessionId, text) {
    if (!text.trim() || !TerminalView.views.has(sessionId)) return;
    TerminalView.paste(sessionId, text);
    ta.write(sessionId, '\r');
  },

  showComposerFanout() {
    const text = App.composerText();
    if (!text.trim()) return;
    App.showFanoutModal(text, () => {
      App.clearComposerText();
      App.renderComposerQueue();
    });
  },

  // 기존 일괄 모달을 현재 하단 입력 텍스트 대상으로 사용한다.
  showFanoutModal(text, onSuccess) {
    const alive = App.state.sessions.filter((s) => s.status !== 'exited');
    if (!text.trim() || !alive.length) return;
    const statusName = { idle: '대기중', running: '진행중', waiting: '허가 대기', done: '완료' };
    const rows = alive.map((s) => {
      const label = App.sessionLabel(s) + (s.id === App.state.activeId ? ' (현재)' : '');
      return `<div class="check"><input type="checkbox" data-sid="${s.id}" id="fo-${s.id}">` +
        `<label for="fo-${s.id}" style="margin:0">${escapeHtml(label)}` +
        ` <span style="color:var(--fg-dim)">· ${statusName[s.status] || s.status}</span></label></div>`;
    }).join('');
    App.modal(`
      <h3>여러 세션에 실행</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:6px">
        체크한 모든 세션에 프롬프트를 즉시 실행합니다.
        셸 프롬프트 상태의 세션에서는 셸 명령으로 실행되니 대상을 확인하세요.</p>
      ${rows}
      <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-fanout">실행</button></div>`,
      (m, close) => {
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-fanout').onclick = () => {
          const ids = [...m.querySelectorAll('input[data-sid]:checked')].map((c) => c.dataset.sid);
          if (!ids.length) return;
          for (const sid of ids) App.deliverDraft(sid, text);
          if (onSuccess) onSuccess();
          close();
        };
      });
  }
});
