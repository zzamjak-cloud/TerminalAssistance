// 계획 문서: Claude 세션 기록에서 추출돼 프로젝트(경로) 귀속으로 영속화된 계획 목록 + 열람 팝업.
// 추출·저장은 백엔드(plans.rs) — 세션 기록이 정리돼도 계획은 앱 데이터에 남는다.
const PLAN_LIST_TTL_MS = 15000; // 목록 호출은 증분 스캔이라 가볍지만, 세션 전환 연타 방어용 캐시

Object.assign(App, {
  _planCache: {}, // cwd → { at, items }

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
      let items = [];
      try { items = await ta.listPlanDocs(cwd); } catch (_) { /* 목록 실패 = 빈 목록 */ }
      cached = App._planCache[cwd] = { at: Date.now(), items };
      if (App.claudeCwd() !== cwd) return; // await 사이에 세션이 바뀌었으면 그 쪽 렌더에 맡긴다
    }
    el.textContent = '';
    if (!cached.items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '아직 추출된 계획 문서가 없습니다. (플랜 모드 승인·plan .md 작성 시 자동 수집)';
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
      row.title = it.title + '\n' + new Date(it.createdMs).toLocaleString() + '\n클릭하면 계획 내용을 보여줍니다.';
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
          new Date(doc.createdMs).toLocaleString() + ' · 세션 ' + doc.sessionId.slice(0, 8);
        m.querySelector('.doc-view').textContent = doc.text;
        m.querySelector('#m-close').onclick = close;
      }, { wide: true });
  }
});
