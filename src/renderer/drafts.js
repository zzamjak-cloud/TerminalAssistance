// 패널별 프롬프트 작성기: 즉시 전송, 세션별 예약 FIFO, 기존 프로젝트 초안을 함께 관리한다.
// 분할 중에는 패널마다 입력창이 따로 있으므로 모든 API 는 대상 세션 id 를 인자로 받는다
// (생략하면 활성 세션). 예약은 기존 drafts 맵의 queued:<sessionId> 키를 사용해
// 백엔드 형식 변경 없이 영속화한다.
Object.assign(App, {
  _draftSaveChains: new Map(), // 같은 키의 저장 순서를 보장해 늦은 응답이 최신 큐를 덮지 않게 한다
  _queueDispatching: new Set(),
  _composerTexts: new Map(), // 세션 전환 중 작성하던 텍스트의 오전송 방지

  // ── 작성 중 텍스트 영속화 (크래시 리로드·앱 재시작 대비) ──
  // 입력 버벅임 방지 설계: 키 입력 프레임에서는 O(1) 예약만 하고(타이머 재설정도 없음 —
  // 키마다 clearTimeout/setTimeout 을 반복하는 트레일링 디바운스 대신 스로틀),
  // 실제 localStorage 동기 쓰기는 주기 만료 후 유휴 시간(requestIdleCallback)에 수행한다.
  // 최신 텍스트는 쓰기 시점에 _composerTexts 에서 읽으므로 저장 지연은 최대 주기+유휴 대기.
  _composerSaveTimers: new Map(), // sessionId → timeout id
  COMPOSER_SAVE_MS: 700,

  composerStoreKey(id) {
    return 'ta-composer:' + id;
  },

  scheduleComposerPersist(sessionId) {
    if (!sessionId || App._composerSaveTimers.has(sessionId)) return; // 이미 예약됨
    App._composerSaveTimers.set(sessionId, setTimeout(() => {
      App._composerSaveTimers.delete(sessionId);
      const write = () => App.persistComposerText(sessionId);
      if (window.requestIdleCallback) requestIdleCallback(write, { timeout: 1000 });
      else write();
    }, App.COMPOSER_SAVE_MS));
  },

  persistComposerText(sessionId) {
    const text = App._composerTexts.get(sessionId) || '';
    try {
      if (text) localStorage.setItem(App.composerStoreKey(sessionId), text);
      else localStorage.removeItem(App.composerStoreKey(sessionId));
    } catch (_) { /* 저장 실패(용량 등)는 무시 — 입력 자체를 방해하지 않는다 */ }
  },

  // 예약된 저장 전부 즉시 실행 — pagehide(리로드·종료 직전)에서 최신 텍스트를 남긴다
  flushComposerPersists() {
    for (const [id, t] of App._composerSaveTimers) {
      clearTimeout(t);
      App.persistComposerText(id);
    }
    App._composerSaveTimers.clear();
  },

  // 부팅 시 저장분 복원 + 죽은 세션 키 정리 (세션 목록 로드 직후 호출)
  restoreComposerTexts() {
    const alive = new Set(App.state.sessions.map((s) => s.id));
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('ta-composer:')) continue;
        const id = k.slice('ta-composer:'.length);
        if (alive.has(id)) App._composerTexts.set(id, localStorage.getItem(k) || '');
        else localStorage.removeItem(k);
      }
    } catch (_) {}
  },

  // 세션 종료 시 저장분·예약 정리
  dropComposerPersist(id) {
    const t = App._composerSaveTimers.get(id);
    if (t) {
      clearTimeout(t);
      App._composerSaveTimers.delete(id);
    }
    try { localStorage.removeItem(App.composerStoreKey(id)); } catch (_) {}
  },

  draftKeyForSession(sessionId) {
    const s = App.state.sessions.find((x) => x.id === sessionId);
    return s && s.projectId ? s.projectId : '';
  },

  queueKey(sessionId) {
    return `queued:${sessionId}`;
  },

  rememberComposerText(sessionId, text) {
    if (!sessionId) return;
    App._composerTexts.set(sessionId, text);
    App.scheduleComposerPersist(sessionId);
  },

  setComposerText(sessionId, text) {
    const id = sessionId || App.state.activeId;
    if (!id) return;
    App._composerTexts.set(id, text);
    // 비우기(전송·예약 직후)는 즉시 반영 — 크래시 시 이미 보낸 텍스트가 복원되지 않게
    if (text) App.scheduleComposerPersist(id);
    else App.persistComposerText(id);
    const c = TerminalView.composerForSession(id);
    if (c) {
      c.input.value = text;
      TerminalView.resizeComposer(c);
    }
  },

  // 화면에 보이는 패널의 입력값이 우선 — 안 보이는 세션은 기억해 둔 텍스트를 쓴다
  composerText(sessionId) {
    const id = sessionId || App.state.activeId;
    if (!id) return '';
    const c = TerminalView.composerForSession(id);
    return c ? c.input.value : (App._composerTexts.get(id) || '');
  },

  // 전송 직전 정규화 — 마지막 단어 뒤의 공백·줄바꿈은 모두 잘라낸다.
  // \s 로 처리해 IME 가 넣는 전각 공백(U+3000)·NBSP 까지 포함시킨다.
  normalizeComposerSubmitText(text) {
    return String(text || '').replace(/\s+$/g, '');
  },

  clearComposerText(sessionId) {
    App.setComposerText(sessionId, '');
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

  // 화면에 보이는 패널 전부의 예약·초안 목록을 각자의 입력창 위에 그린다.
  // 목록 유무·항목 수가 composer 영역 높이를 바꾸므로, 높이가 바뀐 패널이 있으면
  // 터미널을 재fit 한다 — 안 하면 터미널 내용이 예약 목록을 덮는다.
  renderComposerQueue() {
    let layoutChanged = false;
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const c = TerminalView.composers[i];
      if (c && App.renderPaneComposerQueue(c, App.paneSessionId(i))) layoutChanged = true;
    }
    if (layoutChanged) TerminalView.fitActive(); // rAF 코얼레싱 — 치수 변경 시에만 IPC
  },

  // 목록을 다시 그리고, 높이가 바뀌었으면 true 를 반환한다 (호출부가 터미널 재fit)
  renderPaneComposerQueue(c, id) {
    const el = c.list;
    const before = el.offsetHeight;
    el.textContent = '';
    if (!id) {
      el.classList.add('hidden');
      return el.offsetHeight !== before;
    }

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
      cancel.title = '예약을 취소하고 내용을 입력창으로 되돌립니다';
      cancel.onclick = () => {
        void App.removeStoredDraft(queueKey, d.id);
        // 취소는 대부분 내용을 더 추가·수정하려는 의도 — 입력창으로 되돌린다.
        // 입력창에 작성 중이던 텍스트가 있으면 지우지 않고 줄바꿈으로 이어붙인다.
        const current = App.composerText(id);
        App.setComposerText(id, current.trim() ? `${current.replace(/\n+$/, '')}\n${d.text}` : d.text);
        c.input.focus();
        c.input.setSelectionRange(c.input.value.length, c.input.value.length);
      };
      appendItem(d, `예약 ${index + 1}`, 'queued', [cancel]);
    });

    legacy.forEach((d) => {
      const load = document.createElement('button');
      load.textContent = '불러오기';
      load.onclick = () => {
        App.setComposerText(id, d.text);
        c.input.focus();
      };
      const remove = document.createElement('button');
      remove.className = 'composer-remove';
      remove.textContent = '삭제';
      remove.onclick = () => App.removeStoredDraft(legacyKey, d.id);
      appendItem(d, '기존 초안', 'legacy', [load, remove]);
    });

    el.classList.toggle('hidden', !queued.length && !legacy.length);
    return el.offsetHeight !== before;
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

  // Cmd/Ctrl+Enter 또는 전송 버튼은 상태와 관계없이 그 패널의 세션에 즉시 실행한다.
  sendComposerPrompt(sessionId) {
    const id = sessionId || App.state.activeId;
    const text = App.normalizeComposerSubmitText(App.composerText(id));
    if (!id || !text.trim() || !TerminalView.views.has(id)) return;
    App.deliverDraft(id, text);
    App.clearComposerText(id);
    App.renderComposerQueue();
  },

  // 진행중·허가 대기 상태만 예약한다. 이미 쉬는 세션은 기다릴 작업이 없으므로 즉시 전송한다.
  async scheduleComposerPrompt(sessionId) {
    const id = sessionId || App.state.activeId;
    const text = App.normalizeComposerSubmitText(App.composerText(id));
    const session = App.state.sessions.find((s) => s.id === id);
    if (!session || !text.trim() || !TerminalView.views.has(id)) return;
    if (session.status === 'idle' || session.status === 'done') {
      App.sendComposerPrompt(id);
      return;
    }
    if (session.status !== 'running' && session.status !== 'waiting') return;

    const key = App.queueKey(id);
    const before = App.state.drafts[key] || [];
    const next = [...before, { id: newLocalId(), text }];
    App.state.drafts[key] = next;
    App.clearComposerText(id);
    App.renderComposerQueue();
    try {
      await App.persistDraftList(key, next);
    } catch (e) {
      // 같은 큐에 후속 예약이 추가된 경우 최신 배열을 보존한다.
      if (App.state.drafts[key] === next) {
        App.state.drafts[key] = before;
        if (!App.composerText(id)) App.setComposerText(id, text);
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
    const nextText = nextDraft ? App.normalizeComposerSubmitText(nextDraft.text) : '';
    if (!nextText.trim()) return;
    App._queueDispatching.add(sessionId);
    const rest = before.slice(1);
    App.state.drafts[key] = rest;
    App.renderComposerQueue();
    try {
      await App.persistDraftList(key, rest);
      App.deliverDraft(sessionId, nextText);
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

  // 붙여넣기 처리가 끝난 뒤 Enter 가 도착하도록 두는 간격(ms)
  SUBMIT_ENTER_DELAY_MS: 120,

  // 세션 하나에 프롬프트 전달 + 즉시 실행. paste 경로로 bracketed paste를 유지한다.
  deliverDraft(sessionId, text) {
    const submitText = App.normalizeComposerSubmitText(text);
    if (!submitText.trim() || !TerminalView.views.has(sessionId)) return;
    TerminalView.paste(sessionId, submitText);
    // Enter 는 붙여넣기와 분리된 별도 write 로 보낸다.
    // - ESC+CR 을 한 번에 쓰면 TUI(crossterm)가 Alt+Enter 로 읽어 줄바꿈만 삽입하고 대기한다.
    // - Codex/Claude TUI 는 붙여넣기 직후 도착한 Enter 를 붙여넣기의 일부로 삼키므로 한 틱 늦춘다.
    setTimeout(() => {
      if (TerminalView.views.has(sessionId)) ta.write(sessionId, '\r');
    }, App.SUBMIT_ENTER_DELAY_MS);
  },

  showComposerFanout(sessionId) {
    const id = sessionId || App.state.activeId;
    const text = App.composerText(id);
    if (!text.trim()) return;
    App.showFanoutModal(text, () => {
      App.clearComposerText(id);
      App.renderComposerQueue();
    });
  },

  // 기존 일괄 모달을 그 패널 입력 텍스트 대상으로 사용한다.
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
