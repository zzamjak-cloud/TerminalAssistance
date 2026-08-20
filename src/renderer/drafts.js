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
      send.textContent = '입력';
      send.title = '터미널 입력 라인으로 전달 (실행은 터미널에서 Enter)';
      send.onclick = () => App.sendDraft(d);
      const del = document.createElement('button');
      del.className = 'draft-del';
      del.textContent = '✕';
      del.onclick = () => {
        const k = App.draftKey();
        App.state.drafts[k] = (App.state.drafts[k] || []).filter((x) => x.id !== d.id);
        ta.setDrafts(k, App.state.drafts[k]).catch((e) => console.warn('초안 저장 실패:', e));
        App.renderDraftList();
      };
      actions.append(send, del);
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

  // 초안을 터미널 입력 라인으로 전달 (bracketed paste 로 멀티라인 안전 전달)
  sendDraft(d) {
    const id = App.state.activeId;
    if (!id || !d.text.trim()) return;
    TerminalView.paste(id, d.text);
    TerminalView.activate(id);
  }
});
