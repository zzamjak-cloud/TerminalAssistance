// 패널 레이아웃: 좌측 사이드바·탐색기·우측 프롬프트/작업 패널의 토글과 드래그 리사이즈.
// 세 패널 모두 슬림 레일 없이 완전히 숨기는 방식 — 상단바 토글 버튼·패널 내부 접기 버튼으로 여닫는다.
// 저장 키: ta-left-w / ta-explorer-w / ta-right-w / ta-left-fold / ta-explorer-fold /
//          ta-prompt-panel / ta-sec-fold
Object.assign(App, {
  togglePromptPanel() {
    const p = document.getElementById('prompt-panel');
    const hidden = p.classList.toggle('hidden');
    document.getElementById('resize-right').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-prompt-panel', hidden ? '0' : '1');
    // 닫혀 있는 동안의 변경 반영
    if (!hidden) { App.renderClaudeList(); App.renderPlanList(); }
    App._syncPanelToggles();
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS); // 슬라이딩 종료 후 리핏
  },

  toggleLeftSidebar() {
    const sb = document.getElementById('sidebar');
    const hidden = sb.classList.toggle('hidden');
    document.getElementById('resize-left').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-left-fold', hidden ? '1' : '0');
    App._syncPanelToggles();
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS);
  },

  toggleExplorer() {
    const ex = document.getElementById('explorer');
    const hidden = ex.classList.toggle('hidden');
    document.getElementById('resize-explorer').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-explorer-fold', hidden ? '1' : '0');
    if (!hidden) App.renderExplorer(); // 숨겨져 있는 동안의 프로젝트 전환 반영
    App._syncPanelToggles();
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS);
  },

  // 상단바 토글 버튼의 켜짐 표시를 각 패널의 표시 상태와 동기화
  _syncPanelToggles() {
    const sync = (btnId, panelId) => {
      const btn = document.getElementById(btnId);
      const open = !document.getElementById(panelId).classList.contains('hidden');
      if (btn) btn.classList.toggle('on', open);
    };
    sync('btn-toggle-sidebar', 'sidebar');
    sync('btn-toggle-explorer', 'explorer');
    sync('btn-toggle-prompts', 'prompt-panel');
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
      sb.classList.add('hidden');
      document.getElementById('resize-left').style.display = 'none';
    }
    if (localStorage.getItem('ta-explorer-fold') === '1') {
      ex.classList.add('hidden');
      document.getElementById('resize-explorer').style.display = 'none';
    }
    document.getElementById('resize-right').style.display = pp.classList.contains('hidden') ? 'none' : '';

    // 상단바 토글 버튼 + 패널 내부 접기 버튼 배선
    document.getElementById('btn-toggle-sidebar').onclick = () => App.toggleLeftSidebar();
    document.getElementById('btn-toggle-explorer').onclick = () => App.toggleExplorer();
    document.getElementById('btn-fold-left').onclick = () => App.toggleLeftSidebar();
    document.getElementById('btn-fold-explorer').onclick = () => App.toggleExplorer();
    document.getElementById('btn-fold-right').onclick = () => App.togglePromptPanel();
    App._syncPanelToggles();

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

  // 우측 패널 섹션(세션 기록·문서) 접기/펼치기 — 상태는 localStorage
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
      // 헤더 안의 버튼 클릭이 폴딩 토글로 새지 않게
      head.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', (e) => e.stopPropagation()));
    });
  }
});
