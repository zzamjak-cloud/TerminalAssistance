// 계획 문서: Claude 세션 기록에서 추출돼 프로젝트(경로) 귀속으로 영속화된 계획 목록 + 열람 팝업.
// 추출·저장은 백엔드(plans.rs) — 세션 기록이 정리돼도 계획은 앱 데이터에 남는다.
const PLAN_LIST_TTL_MS = 15000; // 목록 호출은 증분 스캔이라 가볍지만, 세션 전환 연타 방어용 캐시

Object.assign(App, {
  _planCache: {}, // cwd → { at, items }

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
      e.textContent = '세션을 열면 해당 프로젝트에서 작성된 계획 문서 목록이 표시됩니다.';
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
    if (!cached.items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '아직 추출된 계획 문서가 없습니다. (플랜 모드 승인, plan/spec .md 작성, .omc/plans·docs/superpowers/specs 등 계획 폴더의 파일을 자동 수집)';
      el.appendChild(e);
      return;
    }
    for (const it of cached.items) {
      const row = document.createElement('div');
      row.className = 'cs-item';
      const time = document.createElement('div');
      time.className = 'cs-time';
      time.textContent = claudeRelTime(it.createdMs);
      const text = document.createElement('div');
      text.className = 'cs-text';
      text.textContent = it.title;
      // 파일 기반 계획(.omc/plans, docs/superpowers/specs 등)은 출처 경로를 함께 표시
      const src = it.path ? '파일: ' + it.path : (it.id && it.id.startsWith('m') ? '선택 저장' : '세션 추출');
      row.title = it.title + '\n' + src + '\n' + new Date(it.createdMs).toLocaleString() + '\n클릭하면 계획 내용을 보여줍니다.';
      row.onclick = () => App.showPlanDoc(cwd, it);
      row.append(time, text);
      el.appendChild(row);
    }
  },

  // 계획 문서 열람 팝업
  async showPlanDoc(cwd, it) {
    let doc = null;
    try { doc = await ta.getPlanDoc(cwd, it.id); } catch (_) {}
    if (!doc) { alert('계획 문서를 불러오지 못했습니다.'); return; }
    App.modal(`
      <h3></h3>
      <div class="modal-sub"></div>
      <div class="doc-view"></div>
      <div class="modal-actions"><button id="m-close">닫기</button></div>`,
      (m, close) => {
        m.querySelector('h3').textContent = doc.title;
        m.querySelector('.modal-sub').textContent =
          new Date(doc.createdMs).toLocaleString() +
          (doc.path ? ' · ' + doc.path : (doc.id && doc.id.startsWith('m') ? ' · 선택 저장' : ' · 세션 ' + doc.sessionId.slice(0, 8)));
        m.querySelector('.doc-view').textContent = doc.text;
        m.querySelector('#m-close').onclick = close;
      }, { wide: true });
  }
});
