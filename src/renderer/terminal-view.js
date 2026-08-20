// xterm 인스턴스 관리. 세션별 holder 를 display 토글로 전환 —
// 비활성 세션도 xterm 버퍼가 유지되므로 전환 시 리플로우/재렌더 비용이 없다.
// WebGL 렌더러는 활성 세션에만 부착한다 — 브라우저의 WebGL 컨텍스트 수 제한(~16) 때문에
// 세션이 많아도 컨텍스트를 1개만 쓰고, 비활성 세션은 어차피 화면에 없으므로 손해가 없다.
const TerminalView = {
  views: new Map(), // sessionId → { term, fit, holder, webgl, frozen, queue }
  area: null,

  init() {
    this.area = document.getElementById('term-area');
    window.addEventListener('resize', () => this.fitActive());
  },

  // opts.frozen: 복구(스크롤백 주입) 완료 전까지 라이브 출력을 큐에 보관
  create(session, fontSize, opts) {
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

    this.views.set(session.id, {
      term, fit, holder,
      webgl: null,
      frozen: !!(opts && opts.frozen),
      queue: [],     // frozen 동안 도착한 ta:data 페이로드
      queueBytes: 0, // 큐 누적 바이트 (상한 관리용)
      lastCols: 0,   // PTY 에 마지막으로 보낸 치수 — 변했을 때만 리사이즈 IPC
      lastRows: 0
    });
    return term;
  },

  // 복구(frozen) 중 세션당 라이브 큐 상한 — 복구가 길어져도 메모리 스파이크를 막는다
  FROZEN_QUEUE_CAP: 1024 * 1024,

  // ── 출력 수신 (flow control 포함) ──
  // 백엔드 ta:data 페이로드를 처리한다. frozen(복구 중)이면 큐에 보관.
  // xterm 이 청크를 소비 완료하면 ack 를 보내 백엔드 emit 을 재개시킨다.
  feed(p) {
    const v = this.views.get(p.sessionId);
    if (!v) return;
    if (v.frozen) {
      v.queue.push(p);
      v.queueBytes += p.bytes || 0;
      // 상한 초과 시 가장 오래된 조각부터 버린다. 버린 구간은 백엔드 스크롤백 스냅샷에
      // 이미 포함돼 있으므로 화면 손실이 없다 (스냅샷 조회 시 outstanding 도 리셋됨).
      while (v.queueBytes > this.FROZEN_QUEUE_CAP && v.queue.length > 1) {
        const drop = v.queue.shift();
        v.queueBytes -= drop.bytes || 0;
      }
      return;
    }
    v.term.write(p.data, () => ta.ackData(p.sessionId, p.bytes));
  },

  // 복구: 백엔드 스크롤백 스냅샷 주입 후, 스냅샷 이후(off 기준) 도착분만 이어붙인다
  restore(id, snap) {
    const v = this.views.get(id);
    if (!v) return;
    if (snap && snap.data) v.term.write(snap.data);
    for (const p of v.queue) {
      if (!snap || p.off >= snap.off) {
        v.term.write(p.data, () => ta.ackData(id, p.bytes));
      }
      // off < snap.off 인 이벤트는 스냅샷에 이미 포함된 중복 → 버림 (ack 도 하지 않음)
    }
    v.queue = [];
    v.queueBytes = 0;
    v.frozen = false;
  },

  // WebGL 렌더러 부착/해제 — 실패(WebGL 미지원·컨텍스트 소실) 시 DOM 렌더러로 자동 폴백
  _attachWebgl(v) {
    if (v.webgl || typeof WebglAddon === 'undefined') return;
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => {
        try { gl.dispose(); } catch (_) {}
        v.webgl = null;
      });
      v.term.loadAddon(gl);
      v.webgl = gl;
    } catch (_) {
      v.webgl = null;
    }
  },

  _detachWebgl(v) {
    if (v.webgl) {
      try { v.webgl.dispose(); } catch (_) {}
      v.webgl = null;
    }
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

  // 히스토리 클릭 → 해당 프롬프트 위치로 스크롤.
  // TUI(Claude Code 등)가 화면 클리어(CSI 2J)·alt buffer 전환을 하면 마커가 폐기되므로,
  // 마커가 죽었으면 버퍼에서 프롬프트 텍스트를 검색해 폴백 점프한다. 둘 다 실패하면 false.
  scrollToPrompt(id, item) {
    const v = this.views.get(id);
    if (!v) return false;
    const term = v.term;
    // alt buffer(전체화면 TUI) 표시 중엔 일반 버퍼 스크롤이 보이지 않음
    if (term.buffer.active.type === 'alternate') return false;

    const m = item.marker;
    if (m && !m.isDisposed && m.line >= 0) {
      term.scrollToLine(Math.max(0, m.line - 1)); // 한 줄 위 여백을 두고 표시
      return true;
    }

    // 폴백: 프롬프트 앞 30자를 버퍼 전체에서 검색.
    // 같은 텍스트가 여러 번 있으면 커밋 시점 라인(item.line)에 가장 가까운 매치 선택.
    const needle = (item.text || '').slice(0, 30).trim();
    if (needle.length < 2) return false;
    const buf = term.buffer.active;
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line || !line.translateToString(true).includes(needle)) continue;
      const dist = item.line >= 0 ? Math.abs(i - item.line) : buf.length - i;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    if (best < 0) return false;
    term.scrollToLine(Math.max(0, best - 1));
    return true;
  },

  activate(id) {
    for (const [sid, v] of this.views) {
      v.holder.classList.toggle('active', sid === id);
      if (sid !== id) this._detachWebgl(v); // WebGL 컨텍스트는 활성 세션 1개만 유지
    }
    const v = this.views.get(id);
    if (v) {
      // display 전환 직후엔 크기가 0 → 다음 프레임에 fit (WebGL 부착도 가시 상태에서)
      requestAnimationFrame(() => {
        try { v.fit.fit(); } catch (_) {}
        this._attachWebgl(v);
        this._syncPtySize(id, v);
        v.term.focus();
      });
    }
  },

  // 치수가 실제로 변했을 때만 PTY 리사이즈 IPC 전송
  // (같은 크기 요청도 ConPTY 는 실제 작업을 수행하므로 무조건 호출하면 드래그가 무거워진다)
  _syncPtySize(id, v) {
    if (v.term.cols !== v.lastCols || v.term.rows !== v.lastRows) {
      v.lastCols = v.term.cols;
      v.lastRows = v.term.rows;
      ta.resize(id, v.term.cols, v.term.rows);
    }
  },

  // 패널 드래그·창 리사이즈 등 고빈도 호출을 rAF 로 코얼레싱
  _fitQueued: false,
  fitActive() {
    if (this._fitQueued) return;
    this._fitQueued = true;
    requestAnimationFrame(() => {
      this._fitQueued = false;
      const id = App.state.activeId;
      const v = this.views.get(id);
      if (!v || !v.holder.classList.contains('active')) return;
      try { v.fit.fit(); } catch (_) {}
      this._syncPtySize(id, v);
    });
  },

  write(id, data, onDone) {
    const v = this.views.get(id);
    if (v) v.term.write(data, onDone);
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
      this._detachWebgl(v);
      v.term.dispose();
      v.holder.remove();
      this.views.delete(id);
    }
  }
};
