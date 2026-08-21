// 패널 레이아웃: 좌측 사이드바·탐색기·우측 프롬프트/작업 패널의 폴딩과 드래그 리사이즈.
// 저장 키: ta-left-w / ta-explorer-w / ta-right-w / ta-left-fold / ta-explorer-fold /
//          ta-prompt-panel / ta-sec-fold
Object.assign(App, {
  togglePromptPanel() {
    const p = document.getElementById('prompt-panel');
    const hidden = p.classList.toggle('hidden');
    document.getElementById('resize-right').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-prompt-panel', hidden ? '0' : '1');
    // 닫혀 있는 동안의 변경 반영
    if (!hidden) { App.renderClaudeList(); App.renderPlanList(); App.renderDraftList(); }
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS); // 슬라이딩 종료 후 리핏
  },

  toggleLeftSidebar() {
    const sb = document.getElementById('sidebar');
    const collapsed = sb.classList.toggle('collapsed');
    document.getElementById('resize-left').style.display = collapsed ? 'none' : '';
    localStorage.setItem('ta-left-fold', collapsed ? '1' : '0');
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS);
  },

  // 탐색기 폴딩 — 사이드바와 같은 슬림 레일 방식
  toggleExplorer() {
    const ex = document.getElementById('explorer');
    const collapsed = ex.classList.toggle('collapsed');
    document.getElementById('resize-explorer').style.display = collapsed ? 'none' : '';
    localStorage.setItem('ta-explorer-fold', collapsed ? '1' : '0');
    if (!collapsed) App.renderExplorer(); // 접힌 동안의 프로젝트 전환 반영
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS);
  },

  // 패널 UI 초기화: 저장된 너비/폴딩 복원 + 리사이즈 핸들 배선
  initPanelUI() {
    const sb = document.getElementById('sidebar');
    const ex = document.getElementById('explorer');
    const pp = document.getElementById('prompt-panel');
    const lw = Number(localStorage.getItem('ta-left-w'));
    const ew = Number(localStorage.getItem('ta-explorer-w'));
    const rw = Number(localStorage.getItem('ta-right-w'));
    if (lw >= 180) sb.style.width = lw + 'px';
    if (ew >= 160) ex.style.width = ew + 'px';
    if (rw >= 200) pp.style.width = rw + 'px';
    if (localStorage.getItem('ta-left-fold') === '1') {
      sb.classList.add('collapsed');
      document.getElementById('resize-left').style.display = 'none';
    }
    if (localStorage.getItem('ta-explorer-fold') === '1') {
      ex.classList.add('collapsed');
      document.getElementById('resize-explorer').style.display = 'none';
    }
    document.getElementById('resize-right').style.display = pp.classList.contains('hidden') ? 'none' : '';

    document.getElementById('btn-fold-left').onclick = (e) => { e.stopPropagation(); App.toggleLeftSidebar(); };
    document.getElementById('btn-fold-explorer').onclick = (e) => { e.stopPropagation(); App.toggleExplorer(); };
    document.getElementById('btn-fold-right').onclick = () => App.togglePromptPanel();
    sb.onclick = () => { if (sb.classList.contains('collapsed')) App.toggleLeftSidebar(); }; // 슬림 레일 클릭 = 펼치기
    ex.onclick = () => { if (ex.classList.contains('collapsed')) App.toggleExplorer(); };

    // 드래그로 너비 조절 (드래그 중엔 트랜지션 끔)
    const wireResize = (handleId, panel, key, min, max, fromLeft) => {
      document.getElementById(handleId).onmousedown = (e) => {
        e.preventDefault();
        const handle = e.target;
        const startX = e.clientX, startW = panel.offsetWidth;
        panel.classList.add('no-anim');
        handle.classList.add('active');
        const move = (ev) => {
          const delta = ev.clientX - startX;
          let w = fromLeft ? startW + delta : startW - delta;
          w = Math.max(min, Math.min(max, w));
          panel.style.width = w + 'px';
          TerminalView.fitActive(); // rAF 코얼레싱 + 치수 변경 시에만 IPC (terminal-view.js)
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          panel.classList.remove('no-anim');
          handle.classList.remove('active');
          localStorage.setItem(key, panel.offsetWidth);
          TerminalView.fitActive();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };
    };
    wireResize('resize-left', sb, 'ta-left-w', 180, 420, true);
    wireResize('resize-explorer', ex, 'ta-explorer-w', 160, 420, true);
    wireResize('resize-right', pp, 'ta-right-w', 200, 460, false);

    App.initSectionFolds();
  },

  // 우측 패널 섹션(Claude 세션·계획 문서·다음 프롬프트) 접기/펼치기 — 상태는 localStorage
  initSectionFolds() {
    let folded = {};
    try { folded = JSON.parse(localStorage.getItem('ta-sec-fold') || '{}'); } catch (_) {}
    document.querySelectorAll('#prompt-panel .panel-sec').forEach((sec) => {
      const key = sec.dataset.sec;
      const arrow = sec.querySelector('.chevron');
      const apply = () => {
        const f = !!folded[key];
        sec.classList.toggle('folded', f);
        arrow.classList.toggle('folded', f);
        arrow.classList.toggle('open', !f);
      };
      apply();
      const head = sec.querySelector('.sec-head');
      head.onclick = () => {
        folded[key] = !folded[key];
        localStorage.setItem('ta-sec-fold', JSON.stringify(folded));
        apply();
      };
      // 헤더 안의 버튼(새로고침·+ 초안) 클릭이 폴딩 토글로 새지 않게
      head.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', (e) => e.stopPropagation()));
    });
  }
});
