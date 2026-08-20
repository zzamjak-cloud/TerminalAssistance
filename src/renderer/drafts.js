// 다음 프롬프트 초안: 프롬프트 히스토리 패널 하단 섹션.
// 프로젝트별로 영속화(ta-config.json)되며 [입력] 으로 터미널 입력 라인에 전달한다.
Object.assign(App, {
  _draftSaveTimer: null,

  draftKey() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    return s && s.projectId ? s.projectId : '';
  },

  renderDraftList() {
    // 패널이 닫혀 있으면 렌더 생략 — 열 때 togglePromptPanel 이 다시 채운다
    if (document.getElementById('prompt-panel').classList.contains('hidden')) return;
    const el = document.getElementById('draft-list');
    el.textContent = '';
    const list = App.state.drafts[App.draftKey()] || [];
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'draft-empty';
      e.textContent = '다음에 보낼 프롬프트를 미리 작성해 두세요. [입력] 을 누르면 터미널 입력 라인으로 전달됩니다. (멀티라인 지원)';
      el.appendChild(e);
      return;
    }
    for (const d of list) {
      const card = document.createElement('div');
      card.className = 'draft-card';
      const tx = document.createElement('textarea');
      tx.value = d.text;
      tx.placeholder = '프롬프트 작성…';
      tx.oninput = () => { d.text = tx.value; App.saveDraftsDebounced(); };
      const actions = document.createElement('div');
      actions.className = 'draft-actions';
      const send = document.createElement('button');
      send.className = 'draft-send';
      send.textContent = '실행';
      send.title = '터미널로 전달하고 즉시 실행 (전송된 초안은 목록에서 제거)';
      send.onclick = () => App.sendDraft(d);
      const fan = document.createElement('button');
      fan.className = 'draft-fanout';
      fan.textContent = '일괄';
      fan.title = '선택한 여러 세션에 전달하고 즉시 실행 (팬아웃)';
      fan.onclick = () => App.showFanoutModal(d);
      const del = document.createElement('button');
      del.className = 'draft-del';
      del.textContent = '✕';
      del.onclick = () => {
        const k = App.draftKey();
        App.state.drafts[k] = (App.state.drafts[k] || []).filter((x) => x.id !== d.id);
        ta.setDrafts(k, App.state.drafts[k]).catch((e) => console.warn('초안 저장 실패:', e));
        App.renderDraftList();
      };
      actions.append(send, fan, del);
      card.append(tx, actions);
      el.appendChild(card);
    }
  },

  addDraft() {
    const k = App.draftKey();
    const list = App.state.drafts[k] || (App.state.drafts[k] = []);
    list.push({ id: newLocalId(), text: '' });
    App.renderDraftList();
    App.saveDraftsDebounced();
    const areas = document.querySelectorAll('#draft-list textarea');
    if (areas.length) areas[areas.length - 1].focus();
  },

  saveDraftsDebounced() {
    clearTimeout(App._draftSaveTimer);
    App._draftSaveTimer = setTimeout(() => {
      const k = App.draftKey();
      ta.setDrafts(k, App.state.drafts[k] || []).catch((e) => console.warn('초안 저장 실패:', e));
    }, 600);
  },

  // 초안을 터미널로 전달하고 즉시 실행 (bracketed paste 로 멀티라인 안전 전달 후 Enter).
  // 전송한 초안은 목록에서 제거한다 — 보낸 프롬프트가 쌓여 있을 이유가 없음.
  sendDraft(d) {
    const id = App.state.activeId;
    if (!id || !d.text.trim()) return;
    App.deliverDraft(id, d.text);
    TerminalView.activate(id);
    App.consumeDraft(d);
  },

  // 세션 하나에 프롬프트 전달 + 즉시 실행. 세션별 xterm 의 paste 경로를 쓰므로
  // 각 세션의 bracketed paste 모드가 올바르게 적용되고 포커스도 필요 없다
  deliverDraft(sessionId, text) {
    TerminalView.paste(sessionId, text);
    ta.write(sessionId, '\r');
  },

  consumeDraft(d) {
    const k = App.draftKey();
    App.state.drafts[k] = (App.state.drafts[k] || []).filter((x) => x.id !== d.id);
    ta.setDrafts(k, App.state.drafts[k]).catch((e) => console.warn('초안 저장 실패:', e));
    App.renderDraftList();
  },

  // ── 팬아웃: 선택한 여러 세션에 같은 초안을 일괄 실행 ──
  // PTY 에 직접 쓰므로 클립보드를 건드리지 않고, 세션이 화면에 없어도 안전하게 들어간다
  showFanoutModal(d) {
    if (!d.text.trim()) return;
    const alive = App.state.sessions.filter((s) => s.status !== 'exited');
    if (!alive.length) return;
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
        체크한 모든 세션에 프롬프트를 전달하고 즉시 실행합니다.
        셸 프롬프트 상태의 세션에서는 셸 명령으로 실행되니 대상을 확인하세요.</p>
      ${rows}
      <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-fanout">실행</button></div>`,
      (m, close) => {
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-fanout').onclick = () => {
          const ids = [...m.querySelectorAll('input[data-sid]:checked')].map((c) => c.dataset.sid);
          if (!ids.length) return;
          for (const sid of ids) App.deliverDraft(sid, d.text);
          App.consumeDraft(d);
          close();
        };
      });
  }
});
