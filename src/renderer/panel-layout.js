// 패널 레이아웃: 좌측 사이드바·우측 프롬프트/작업 패널의 폴딩과 드래그 리사이즈.
// 저장 키: ta-left-w / ta-right-w / ta-hist-h / ta-left-fold / ta-prompt-panel
Object.assign(App, {
  togglePromptPanel() {
    const p = document.getElementById('prompt-panel');
    const hidden = p.classList.toggle('hidden');
    document.getElementById('resize-right').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-prompt-panel', hidden ? '0' : '1');
    if (!hidden) { App.renderClaudeList(); App.renderDraftList(); } // 닫혀 있는 동안의 변경 반영
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS); // 슬라이딩 종료 후 리핏
  },

  toggleLeftSidebar() {
    const sb = document.getElementById('sidebar');
    const collapsed = sb.classList.toggle('collapsed');
    document.getElementById('resize-left').style.display = collapsed ? 'none' : '';
    localStorage.setItem('ta-left-fold', collapsed ? '1' : '0');
    setTimeout(() => TerminalView.fitActive(), PANEL_ANIM_MS);
  },

  // 패널 UI 초기화: 저장된 너비/폴딩 복원 + 리사이즈 핸들 배선
  initPanelUI() {
    const sb = document.getElementById('sidebar');
    const pp = document.getElementById('prompt-panel');
    const lw = Number(localStorage.getItem('ta-left-w'));
    const rw = Number(localStorage.getItem('ta-right-w'));
    if (lw >= 180) sb.style.width = lw + 'px';
    if (rw >= 200) pp.style.width = rw + 'px';
    if (localStorage.getItem('ta-left-fold') === '1') {
      sb.classList.add('collapsed');
      document.getElementById('resize-left').style.display = 'none';
    }
    document.getElementById('resize-right').style.display = pp.classList.contains('hidden') ? 'none' : '';

    document.getElementById('btn-fold-left').onclick = (e) => { e.stopPropagation(); App.toggleLeftSidebar(); };
    document.getElementById('btn-fold-right').onclick = () => App.togglePromptPanel();
    sb.onclick = () => { if (sb.classList.contains('collapsed')) App.toggleLeftSidebar(); }; // 슬림 레일 클릭 = 펼치기

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
    wireResize('resize-right', pp, 'ta-right-w', 200, 460, false);

    // 히스토리/초안 사이 가로 분할선: 드래그로 상단(히스토리) 높이 조절
    const histPanel = document.getElementById('history-panel');
    const hh = Number(localStorage.getItem('ta-hist-h'));
    if (hh >= 90) histPanel.style.height = hh + 'px';
    document.getElementById('panel-divider').onmousedown = (e) => {
      e.preventDefault();
      const handle = e.target;
      const startY = e.clientY, startH = histPanel.offsetHeight;
      handle.classList.add('active');
      const move = (ev) => {
        const max = pp.offsetHeight - 130; // 하단(초안) 최소 공간 확보
        const h = Math.max(90, Math.min(max, startH + (ev.clientY - startY)));
        histPanel.style.height = h + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        handle.classList.remove('active');
        localStorage.setItem('ta-hist-h', histPanel.offsetHeight);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
  }
});
