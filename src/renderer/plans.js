// 통합 문서: 세션에서 추출한 계획과 프로젝트 내부 Markdown 메모 목록 + 열람 팝업.
const PLAN_LIST_TTL_MS = 15000; // 목록 호출은 증분 스캔이라 가볍지만, 세션 전환 연타 방어용 캐시

Object.assign(App, {
  _planCache: {}, // cwd → { at, items }
  _planFileDrops: new Set(),
  _documentRemovals: new Set(),
  _planDropFeedbackTimer: null,

  showPlanDropFeedback(message, type, duration) {
    const feedback = document.getElementById('plan-drop-feedback');
    if (!feedback) return;
    clearTimeout(App._planDropFeedbackTimer);
    feedback.textContent = message;
    feedback.className = `plan-drop-feedback ${type || 'info'}`;
    feedback.hidden = false;
    if (duration !== 0) {
      App._planDropFeedbackTimer = setTimeout(() => {
        feedback.hidden = true;
        feedback.textContent = '';
      }, duration || 2200);
    }
  },

  async registerPlanFile(path) {
    const cwd = App.claudeCwd();
    const root = App.explorerRoot();
    const normalize = (value) => normPath(value || '').replace(/\/+$/, '');
    const left = normalize(cwd);
    const right = normalize(root);
    const sameRoot = App.state.platform === 'windows'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
    if (!cwd || !root || !sameRoot) {
      App.showPlanDropFeedback('활성 세션과 탐색기 프로젝트가 일치하지 않습니다.', 'error');
      return;
    }
    const key = normalize(path);
    if (App._planFileDrops.has(key)) {
      App.showPlanDropFeedback('이미 이 파일을 등록하고 있습니다.', 'info');
      return;
    }
    App._planFileDrops.add(key);
    const panel = document.getElementById('plan-panel');
    if (panel) panel.classList.add('drop-busy');
    App.showPlanDropFeedback('계획 파일 등록 중…', 'info', 0);
    try {
      const saved = await ta.registerPlanFile(cwd, path);
      const existing = App._planCache[cwd] ? App._planCache[cwd].items : [];
      const items = [saved, ...existing.filter((item) => item.id !== saved.id)];
      items.sort((a, b) => (b.updatedMs || b.createdMs) - (a.updatedMs || a.createdMs));
      App._planCache[cwd] = { at: Date.now(), items };
      App.showPlanDropFeedback(`계획 파일 등록됨: ${saved.title}`, 'success');
      await App.renderPlanList(true);
    } catch (error) {
      console.warn('계획 파일 등록 실패:', error);
      App.showPlanDropFeedback('계획 파일 등록 실패: ' + error, 'error', 4200);
    } finally {
      App._planFileDrops.delete(key);
      if (panel) panel.classList.remove('drop-busy');
    }
  },

  // 메모는 실제 파일을 삭제하고, 계획은 원본을 보존한 채 통합 문서 목록에서만 숨긴다.
  async removeDocument(cwd, doc, options) {
    const opts = options || {};
    const isMemo = doc.kind === 'memo';
    const action = isMemo ? '삭제' : '목록에서 제거';
    const key = `${cwd}\n${doc.id}`;
    if (App._documentRemovals.has(key)) {
      App.showPlanDropFeedback('이미 이 문서를 제거하고 있습니다.', 'info');
      return false;
    }
    const planSourceNotice = doc.path
      ? `목록에서만 제거하며 원본 파일 "${doc.path}"은 삭제하지 않습니다.`
      : (doc.id && doc.id.startsWith('m')
          ? '목록에서만 제거하며 터미널과 세션 기록은 삭제하지 않습니다.'
          : '목록에서만 제거하며 원본 세션 기록은 삭제하지 않습니다.');
    const question = isMemo
      ? `메모 "${doc.title}"을 삭제할까요?\n프로젝트의 .md 파일도 영구 삭제됩니다.`
      : `계획 "${doc.title}"을 목록에서 제거할까요?\n${planSourceNotice}`;
    if (!confirm(question)) return false;

    const button = opts.button || null;
    const previousText = button ? button.textContent : '';
    App._documentRemovals.add(key);
    if (button) {
      button.disabled = true;
      button.textContent = '제거 중…';
    }
    try {
      if (isMemo) await ta.deleteMemoDoc(cwd, doc.id);
      else await ta.dismissPlanDoc(cwd, doc.id);

      const cached = App._planCache[cwd];
      if (cached) cached.items = cached.items.filter((item) => item.id !== doc.id);
      if (typeof opts.close === 'function') opts.close();
      App.showPlanDropFeedback(
        isMemo ? `메모 삭제됨: ${doc.title}` : `계획 목록에서 제거됨: ${doc.title}`,
        'success'
      );
      if (App.claudeCwd() === cwd) await App.renderPlanList(true);
      return true;
    } catch (error) {
      console.warn(`문서 ${action} 실패:`, error);
      App.showPlanDropFeedback(`문서 ${action} 실패: ${error}`, 'error', 4200);
      if (button) {
        button.disabled = false;
        button.textContent = previousText;
      }
      return false;
    } finally {
      App._documentRemovals.delete(key);
    }
  },

  normalizePlanSelection(text) {
    return (text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .trim();
  },

  revealPlanPanel() {
    const panel = document.getElementById('prompt-panel');
    if (panel.classList.contains('hidden')) App.togglePromptPanel();
    const sec = document.getElementById('plan-panel');
    if (!sec.classList.contains('folded')) return;
    let folded = {};
    try { folded = JSON.parse(localStorage.getItem('ta-sec-fold') || '{}'); } catch (_) {}
    folded.plans = false;
    localStorage.setItem('ta-sec-fold', JSON.stringify(folded));
    sec.classList.remove('folded');
    const arrow = sec.querySelector('.chevron');
    if (arrow) {
      arrow.classList.remove('folded');
      arrow.classList.add('open');
    }
  },

  planCaptureButtons() {
    return ['btn-plan-capture', 'btn-plan-capture-top']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  },

  setPlanCaptureButtons(buttons, text, disabled) {
    for (const btn of buttons) {
      btn.disabled = disabled;
      btn.textContent = text;
    }
  },

  restorePlanCaptureButtons(buttons, prev) {
    for (const btn of buttons) {
      btn.disabled = false;
      btn.textContent = prev.get(btn);
    }
  },

  withPlanTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  },

  async readPlanSelectionText(sessionId) {
    TerminalView.rememberSelectionSoon(sessionId);
    const selected = App.normalizePlanSelection(TerminalView.getSelection(sessionId, { allowCached: true }));
    if (selected) return selected;
    if (!TerminalView.hasRecentSelectionActivity(sessionId, 60000)) return '';
    const clip = await App.withPlanTimeout(
      ta.clipboardText(), 1000, '클립보드 읽기 시간 초과'
    ).catch(() => '');
    return App.normalizePlanSelection(clip);
  },

  async captureSelectionAsPlan() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (!s || !s.cwd) {
      alert('계획으로 저장할 활성 세션이 없습니다.');
      return;
    }
    const buttons = App.planCaptureButtons();
    const prev = new Map(buttons.map((btn) => [btn, btn.textContent]));
    App.setPlanCaptureButtons(buttons, '확인 중', true);
    try {
      const text = await App.readPlanSelectionText(s.id);
      if (!text) {
        App.setPlanCaptureButtons(buttons, '선택 없음', false);
        setTimeout(() => App.restorePlanCaptureButtons(buttons, prev), 1200);
        TerminalView.activate(s.id);
        return;
      }
      App.setPlanCaptureButtons(buttons, '저장 중', true);
      const saved = await App.withPlanTimeout(
        ta.addPlanDoc(s.cwd, s.id, text), 5000, '계획 저장 응답 시간이 초과됐습니다.'
      );
      const existing = App._planCache[s.cwd] ? App._planCache[s.cwd].items : [];
      App._planCache[s.cwd] = {
        at: Date.now(),
        items: [saved, ...existing.filter((it) => it.id !== saved.id)]
      };
      App.revealPlanPanel();
      void App.renderPlanList(false);
      void App.renderPlanList(true).catch(() => {});
      TerminalView.clearSelection(s.id);
      for (const btn of buttons) {
        btn.textContent = '저장됨';
        setTimeout(() => {
          if (btn.textContent === '저장됨') btn.textContent = prev.get(btn);
        }, 1200);
      }
    } catch (e) {
      alert('계획 저장 실패: ' + e);
      App.restorePlanCaptureButtons(buttons, prev);
    } finally {
      for (const btn of buttons) btn.disabled = false;
    }
  },

  async renderPlanList(force) {
    // 패널이 닫혀 있으면 렌더 생략 — 열 때 togglePromptPanel 이 다시 채운다
    if (document.getElementById('prompt-panel').classList.contains('hidden')) return;
    const el = document.getElementById('plan-list');
    const cwd = App.claudeCwd();
    if (!cwd) {
      el.textContent = '';
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '세션을 열면 해당 프로젝트의 계획과 메모가 표시됩니다.';
      el.appendChild(e);
      return;
    }
    let cached = App._planCache[cwd];
    if (force || !cached || Date.now() - cached.at > PLAN_LIST_TTL_MS) {
      let items = cached ? cached.items : [];
      try {
        items = await ta.listPlanDocs(cwd);
      } catch (e) {
        console.warn('계획 문서 목록 새로고침 실패:', e);
      }
      cached = App._planCache[cwd] = { at: Date.now(), items };
      if (App.claudeCwd() !== cwd) return; // await 사이에 세션이 바뀌었으면 그 쪽 렌더에 맡긴다
    }
    el.textContent = '';
    cached.items.sort((a, b) => (b.updatedMs || b.createdMs) - (a.updatedMs || a.createdMs));
    if (!cached.items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '아직 문서가 없습니다. + 메모로 작성하거나 계획 파일을 생성하면 여기에 표시됩니다.';
      el.appendChild(e);
      return;
    }
    for (const it of cached.items) {
      const row = document.createElement('div');
      const isMemo = it.kind === 'memo';
      row.className = 'cs-item doc-item';
      const meta = document.createElement('div');
      meta.className = 'doc-meta';
      const badge = document.createElement('span');
      badge.className = `doc-kind ${isMemo ? 'memo' : 'plan'}`;
      badge.textContent = isMemo ? '메모' : '계획';
      const time = document.createElement('div');
      time.className = 'cs-time';
      time.textContent = formatRelativeTime(it.updatedMs || it.createdMs);
      meta.append(badge, time);
      const text = document.createElement('div');
      text.className = 'cs-text';
      text.textContent = it.title;
      const source = document.createElement('div');
      source.className = 'doc-source';
      const src = isMemo
        ? (it.path || '.terminal-assistance/memos')
        : (it.path ? '파일: ' + it.path : (it.id && it.id.startsWith('m') ? '선택 저장' : '세션 추출'));
      source.textContent = src;
      row.title = it.title + '\n' + src + '\n' + new Date(it.updatedMs || it.createdMs).toLocaleString()
        + (isMemo ? '\n클릭하면 메모를 수정할 수 있습니다.' : '\n클릭하면 문서 내용을 보여줍니다.');
      row.onclick = () => App.showPlanDoc(cwd, it);
      const remove = document.createElement('button');
      remove.className = 'doc-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = isMemo ? '메모 삭제' : '계획을 목록에서 제거';
      remove.setAttribute('aria-label', `${it.title} ${isMemo ? '삭제' : '목록에서 제거'}`);
      remove.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await App.removeDocument(cwd, it, { button: remove });
      };
      row.append(meta, text, source, remove);
      el.appendChild(row);
    }
  },

  // 계획/메모 문서 열람 팝업. 메모 본문은 raw HTML 실행을 막기 위해 평문으로 표시한다.
  // 사용자가 직접 등록한 메모는 열람 대신 곧바로 수정 팝업을 연다.
  async showPlanDoc(cwd, it) {
    let doc = null;
    try { doc = await ta.getPlanDoc(cwd, it.id); } catch (_) {}
    if (!doc) { alert('계획 문서를 불러오지 못했습니다.'); return; }
    if (doc.kind === 'memo') {
      App.showMemoEditModal(cwd, doc);
      return;
    }
    App.modal(`
      <h3></h3>
      <div class="modal-sub"></div>
      <div class="doc-view"></div>
      <div class="modal-actions">
        <button id="m-delete" class="danger"></button>
        <button id="m-close">닫기</button>
      </div>`,
      (m, close) => {
        const isMemo = doc.kind === 'memo';
        m.querySelector('h3').textContent = doc.title;
        m.querySelector('.modal-sub').textContent =
          (isMemo ? '메모 · ' : '계획 · ') + new Date(doc.updatedMs || doc.createdMs).toLocaleString() +
          (doc.path ? ' · ' + doc.path : (doc.id && doc.id.startsWith('m') ? ' · 선택 저장' : ' · 세션 ' + doc.sessionId.slice(0, 8)));
        m.querySelector('.doc-view').textContent = doc.text;
        const remove = m.querySelector('#m-delete');
        remove.textContent = isMemo ? '삭제' : '목록에서 제거';
        remove.onclick = () => App.removeDocument(cwd, doc, { button: remove, close });
        m.querySelector('#m-close').onclick = close;
      }, { wide: true });
  }
});
