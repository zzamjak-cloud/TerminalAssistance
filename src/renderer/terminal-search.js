// 활성 xterm 버퍼 검색. 외부 addon 없이 현재 보관 중인 스크롤백을 직접 훑는다.
Object.assign(App, {
  _searchMatches: [],
  _searchIndex: 0,

  openTerminalSearch() {
    const root = document.getElementById('term-search');
    const input = document.getElementById('term-search-input');
    if (!App.state.activeId || !TerminalView.views.get(App.state.activeId)) return;
    root.classList.remove('hidden');
    input.value = '';
    App._searchMatches = [];
    App._searchIndex = 0;
    App.renderTerminalSearchCount();
    requestAnimationFrame(() => input.focus());
  },

  closeTerminalSearch() {
    document.getElementById('term-search').classList.add('hidden');
    const v = TerminalView.views.get(App.state.activeId);
    if (v) {
      try { v.term.clearSelection(); } catch (_) {}
      v.term.focus();
    }
  },

  updateTerminalSearch() {
    const q = document.getElementById('term-search-input').value;
    App._searchMatches = App.collectTerminalMatches(q);
    App._searchIndex = 0;
    App.renderTerminalSearchCount();
    if (App._searchMatches.length) App.revealTerminalSearchMatch(0);
  },

  collectTerminalMatches(query) {
    const id = App.state.activeId;
    const v = TerminalView.views.get(id);
    if (!v || !query) return [];
    const q = query.toLowerCase();
    const out = [];
    const buf = v.term.buffer.active;
    for (let row = 0; row < buf.length; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      const lower = text.toLowerCase();
      let col = lower.indexOf(q);
      while (col >= 0) {
        out.push({ row, col, len: query.length });
        if (out.length >= 999) return out;
        col = lower.indexOf(q, col + Math.max(1, q.length));
      }
    }
    return out;
  },

  jumpTerminalSearch(dir) {
    if (!App._searchMatches.length) return;
    App._searchIndex = (App._searchIndex + dir + App._searchMatches.length) % App._searchMatches.length;
    App.renderTerminalSearchCount();
    App.revealTerminalSearchMatch(App._searchIndex);
  },

  revealTerminalSearchMatch(index) {
    const v = TerminalView.views.get(App.state.activeId);
    const m = App._searchMatches[index];
    if (!v || !m) return;
    try {
      v.term.scrollToLine(m.row);
      requestAnimationFrame(() => {
        try { v.term.select(m.col, m.row, m.len); } catch (_) {}
        v.term.focus();
      });
    } catch (_) {}
  },

  renderTerminalSearchCount() {
    const el = document.getElementById('term-search-count');
    const q = document.getElementById('term-search-input').value;
    if (!q) {
      el.textContent = '';
    } else if (!App._searchMatches.length) {
      el.textContent = '0/0';
    } else {
      el.textContent = `${App._searchIndex + 1}/${App._searchMatches.length}`;
    }
  },

  initTerminalSearchUI() {
    const input = document.getElementById('term-search-input');
    document.getElementById('term-search-close').onclick = () => App.closeTerminalSearch();
    document.getElementById('term-search-prev').onclick = () => App.jumpTerminalSearch(-1);
    document.getElementById('term-search-next').onclick = () => App.jumpTerminalSearch(1);
    input.oninput = () => App.updateTerminalSearch();
    input.onkeydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); App.closeTerminalSearch(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); App.jumpTerminalSearch(ev.shiftKey ? -1 : 1); }
    };
  }
});
