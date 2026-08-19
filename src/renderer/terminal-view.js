// xterm 인스턴스 관리. 세션별 holder 를 display 토글로 전환 —
// 비활성 세션도 xterm 버퍼가 유지되므로 전환 시 리플로우/재렌더 비용이 없다.
const TerminalView = {
  views: new Map(), // sessionId → { term, fit, holder }
  area: null,

  init() {
    this.area = document.getElementById('term-area');
    window.addEventListener('resize', () => this.fitActive());
  },

  create(session, fontSize) {
    const holder = document.createElement('div');
    holder.className = 'term-holder';
    this.area.appendChild(holder);

    const term = new Terminal({
      fontSize: fontSize || 13,
      fontFamily: 'Menlo, Consolas, "D2Coding", "Cascadia Mono", monospace',
      theme: { background: '#14161c', foreground: '#d5d9e4' },
      scrollback: 5000,
      cursorBlink: true
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(holder);

    term.onData((d) => {
      ta.write(session.id, d);
      App.trackInput(session.id, d); // 프롬프트 히스토리용 입력 추적
      App.ackIfDone(session.id); // 입력 = 사용자가 결과를 확인함
    });

    term.attachCustomKeyEventHandler((ev) => {
      // IME 조합(한글 등) 중에는 어떤 키도 가로채지 않는다 — 조합 파괴 방지
      if (ev.isComposing || ev.keyCode === 229) return true;
      if (ev.type !== 'keydown') return true;
      const mod = ev.metaKey || ev.ctrlKey;
      // Cmd/Ctrl+V: 클립보드에 이미지가 있으면 경로 첨부로 대체, 아니면 텍스트 붙여넣기
      if (mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'v') {
        App.pasteToSession(session.id);
        return false;
      }
      // Cmd/Ctrl+1~9: 세션 전환 (터미널 포커스 중에도 동작)
      if (mod && ev.key >= '1' && ev.key <= '9') {
        App.activateByIndex(Number(ev.key) - 1);
        return false;
      }
      // Cmd/Ctrl+T: 현재 프로젝트에 새 세션
      if (mod && ev.key.toLowerCase() === 't') {
        App.newSessionInActiveProject();
        return false;
      }
      return true;
    });

    this.views.set(session.id, { term, fit, holder });
    return term;
  },

  // 프롬프트 제출 지점에 마커 등록 + 구분선 데코레이션 (히스토리 점프의 앵커)
  addPromptMarker(id) {
    const v = this.views.get(id);
    if (!v) return null;
    const marker = v.term.registerMarker(0);
    if (marker) {
      try {
        const deco = v.term.registerDecoration({ marker, width: v.term.cols });
        if (deco) deco.onRender((el) => el.classList.add('prompt-divider'));
      } catch (_) { /* 데코레이션 미지원이어도 마커 점프는 동작 */ }
    }
    return marker;
  },

  // 히스토리 클릭 → 해당 프롬프트 위치로 스크롤. 스크롤백에서 밀려났으면 false
  scrollToMarker(id, marker) {
    const v = this.views.get(id);
    if (!v || !marker || marker.isDisposed || marker.line < 0) return false;
    v.term.scrollToLine(marker.line);
    return true;
  },

  activate(id) {
    for (const [sid, v] of this.views) v.holder.classList.toggle('active', sid === id);
    const v = this.views.get(id);
    if (v) {
      // display 전환 직후엔 크기가 0 → 다음 프레임에 fit
      requestAnimationFrame(() => {
        try { v.fit.fit(); } catch (_) {}
        ta.resize(id, v.term.cols, v.term.rows);
        v.term.focus();
      });
    }
  },

  fitActive() {
    const id = App.state.activeId;
    const v = this.views.get(id);
    if (v && v.holder.classList.contains('active')) {
      try { v.fit.fit(); } catch (_) {}
      ta.resize(id, v.term.cols, v.term.rows);
    }
  },

  write(id, data) {
    const v = this.views.get(id);
    if (v) v.term.write(data);
  },

  // xterm 의 paste 경로 사용 (bracketed paste 처리 포함) → onData → pty
  paste(id, text) {
    const v = this.views.get(id);
    if (v) v.term.paste(text);
  },

  setFontSize(n) {
    for (const v of this.views.values()) v.term.options.fontSize = n;
    this.fitActive();
  },

  dispose(id) {
    const v = this.views.get(id);
    if (v) {
      v.term.dispose();
      v.holder.remove();
      this.views.delete(id);
    }
  }
};
