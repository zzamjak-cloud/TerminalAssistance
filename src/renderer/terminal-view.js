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

    // ── 한글 등 IME 조합 입력 보정 (xterm 5.5.0) ──
    // xterm 은 조합 커밋 텍스트를 "compositionend 후 setTimeout 에 textarea 를 substring"
    // 하는 방식으로 보내는데, 이 방식은 두 웹뷰 엔진의 이벤트 순서에서 모두 깨진다.
    //  - WebView2(Windows): 커밋 input(insertText)가 keyup 이후에 지연 도착 → _keyDownSeen
    //    가드를 통과해 조합 경로와 이중 전송 (v0.5.0 의 중복 증상)
    //  - WKWebView(macOS): input 이 keydown(229)보다 먼저 오는 역순(xterm#5887 코멘트 트레이스).
    //    조합 직후 문자(공백 등)의 insertText 가 조합 전송 타이머보다 먼저 전송돼 순서가
    //    뒤집히고, 빠른 타이핑 시 _keyDownSeen 가드가 IME 직접 커밋 문자를 삼킨다.
    // 전략: compositionend 의 ev.data(커밋 정본)를 즉시 전송하고 xterm 의 지연 전송을 취소.
    // 이후 도착하는 같은 텍스트의 지연 insertText(WebView2)는 중복으로 차단하고,
    // macOS 는 _keyDownSeen 가드를 우회해 insertText 를 직접 전송한다.
    const core = term._core;
    let imeCommit = null; // { text, at } — 직전 조합 커밋 (중복/합성 keypress 판별용)
    // ── textarea 미러 보정 (macOS 전용, 아래 IME 블록에서 실제 동작 부여) ──
    // differ 는 textarea 를 터미널 입력 라인의 미러로 쓴다. 그런데 xterm 이 처리하고
    // 취소하는 백스페이스류는 터미널에서만 지워지고 textarea 에는 글자가 남아 미러가
    // 어긋나고, 이후 IME 의 음절 교체 diff 가 "이미 지운 글자"를 또 지우는 연쇄 삭제가
    // 됐다 (백스페이스 후 재입력 시 이전 텍스트가 계속 사라지던 버그의 원인).
    let mirrorTrimChar = () => {};
    let mirrorTrimWord = () => {};
    let mirrorClear = () => {};
    if (core && typeof core._inputEvent === 'function' && term.textarea) {
      const origInputEvent = core._inputEvent.bind(core);
      const isMac = App.state.platform === 'macos';
      const taEl = term.textarea;

      // ── macOS WKWebView 한글: 조합 이벤트가 전혀 없다 (실측 트레이스) ──
      // 새 음절은 insertText, 조합 진행은 insertReplacementText(직전 글자 교체)로만 도착하고
      // isComposing 은 항상 false 다. xterm 은 insertReplacementText 를 무시하므로 첫 자음만
      // 전송되고 교체분(모음 결합)이 전부 유실된다 → "테스트" 가 "ㅌ스트" 가 되던 원인.
      // 해법: beforeinput(변경 전 값)과 input(변경 후 값)을 diff 해 삭제분은 DEL(\x7f),
      // 삽입분은 그대로 pty 로 보낸다 — IME 의 음절 교체를 터미널 라인 편집으로 재현한다.
      // (일본어·중국어처럼 조합 이벤트를 쓰는 IME 는 아래 조합 경로가 그대로 처리)
      let preVal = null;   // beforeinput 시점의 textarea 값
      let sawInput = false; // 이번 키스트로크에서 input 이 발생했는지 (IME 백스페이스 폴백용)
      if (isMac) {
        taEl.addEventListener('beforeinput', (ev) => {
          const ch = core._compositionHelper;
          if (ev.isComposing || (ch && ch._isComposing)) { preVal = null; return; }
          preVal = taEl.value;
        });
        taEl.addEventListener('input', (ev) => {
          sawInput = true;
          const ch = core._compositionHelper;
          if (ev.isComposing || (ch && ch._isComposing)) { preVal = null; return; }
          if (preVal === null) return;
          const pre = preVal, cur = taEl.value;
          preVal = null;
          if (pre === cur || core._keyPressHandled) return;
          // 공통 접두/접미를 제외한 변경 구간 계산
          let p = 0;
          const max = Math.min(pre.length, cur.length);
          while (p < max && pre[p] === cur[p]) p++;
          let s = 0;
          while (s < max - p && pre[pre.length - 1 - s] === cur[cur.length - 1 - s]) s++;
          const deleted = pre.length - p - s;
          const inserted = cur.slice(p, cur.length - s);
          const out = '\x7f'.repeat(deleted) + inserted;
          if (out) core.coreService.triggerDataEvent(out, true);
        });
        // 미러 보정 구현 (서로게이트 쌍 안전하게 문자 단위로)
        mirrorTrimChar = () => {
          const chars = Array.from(taEl.value);
          if (chars.length) { chars.pop(); taEl.value = chars.join(''); }
        };
        mirrorTrimWord = () => { taEl.value = taEl.value.replace(/\S+\s*$/, ''); };
        mirrorClear = () => { taEl.value = ''; };

        taEl.addEventListener('keydown', (ev) => {
          // 일반 백스페이스(keyCode 8): xterm 이 \x7f 전송 후 이벤트를 취소해
          // textarea 에는 글자가 남는다 → 미러에서도 한 글자 지워 desync 를 막는다
          if (ev.key === 'Backspace' && ev.keyCode !== 229 && !ev.metaKey && !ev.altKey && !ev.ctrlKey) {
            mirrorTrimChar();
            return;
          }
          // IME 가 소비한 백스페이스(keyCode 229): 자모 분해는 위 diff 가 처리하지만,
          // IME 텍스트 경계를 넘어 지울 때는 textarea 변화 없이 keydown 만 온다 → DEL 폴백
          if (ev.keyCode !== 229 || ev.key !== 'Backspace') return;
          sawInput = false;
          setTimeout(() => {
            if (!sawInput) {
              core.coreService.triggerDataEvent('\x7f', true);
              mirrorTrimChar(); // 전송한 삭제를 미러에도 반영 — 남겨두면 diff 이중 삭제
            }
          }, 0);
        });
        // xterm 의 keydown(229) 기반 textarea diff 전송기는 위 differ 와 이중 전송
        // (빠른 타이핑 시 replace() 오동작으로 전체 라인 재전송 위험도 있음) → 무력화
        const ch0 = core._compositionHelper;
        if (ch0) ch0._handleAnyTextareaChanges = () => {};
      }

      term.textarea.addEventListener('compositionstart', () => { imeCommit = null; });
      term.textarea.addEventListener('compositionend', (ev) => {
        const ch = core._compositionHelper;
        const data = ev.data || '';
        // xterm 의 compositionend 리스너(open 시 등록)가 먼저 실행돼 지연 전송을 예약해 둔
        // 상태다. 키다운 경로(finalize(false))가 이미 보냈다면 플래그가 false — 손대지 않는다.
        // 취소된 조합(data 없음)도 xterm 기본 동작에 맡긴다.
        if (!ch || !ch._isSendingComposition || !data) return;
        ch._isSendingComposition = false; // substring 지연 전송 취소
        imeCommit = { text: data, at: Date.now() };
        core.coreService.triggerDataEvent(data, true);
      });

      core._inputEvent = (ev) => {
        const ch = core._compositionHelper;
        // mac 은 위 differ 가 텍스트 입력을 전담 — xterm 의 insertText 경로는 이중 전송
        if (isMac) return false;
        // WebView2 가 keyup 뒤에 지연 발생시키는 커밋 insertText — 위에서 이미 보낸 중복
        if (ev.inputType === 'insertText' && ev.data && imeCommit &&
            ev.data === imeCommit.text && Date.now() - imeCommit.at < 500) {
          imeCommit = null;
          return false;
        }
        // 조합 진행 중의 미리보기 input 은 차단 (원본도 무시함 — 동작 동일)
        if (ev.isComposing || (ch && ch._isComposing)) return false;
        return origInputEvent(ev);
      };
    }

    term.onData((d) => {
      ta.write(session.id, d);
      App.ackIfDone(session.id); // 입력 = 사용자가 결과를 확인함
    });

    term.attachCustomKeyEventHandler((ev) => {
      // WKWebView 는 조합을 커밋시킨 물리 키에 대해 커밋 문자의 charCode 를 담은
      // 합성 keypress 를 발생시킨다(xterm#5894) → 그대로 두면 커밋 문자가 한 번 더 전송됨
      if (ev.type === 'keypress' && ev.charCode && imeCommit &&
          String.fromCharCode(ev.charCode) === imeCommit.text &&
          Date.now() - imeCommit.at < 500) {
        imeCommit = null; // 일회성 — 직후 실제로 같은 문자를 입력하는 경우를 막지 않게
        return false;
      }
      // IME 조합(한글 등) 중에는 어떤 키도 가로채지 않는다 — 조합 파괴 방지
      if (ev.isComposing || ev.keyCode === 229) return true;
      if (ev.type !== 'keydown') return true;
      const mod = ev.metaKey || ev.ctrlKey;
      // ── 맥북(Home/End 키 없음) 텍스트 이동 — macOS 에디터 관행을 터미널 시퀀스로 재현 ──
      // Cmd+←/→ = 줄 시작/끝(Home/End 키와 동일 시퀀스), Option+←/→ = 단어 이동(ESC b/f),
      // Cmd+⌫ = 줄 시작까지 삭제(^U), Option+⌫ = 단어 삭제(^W)
      if (App.state.platform === 'macos' && !ev.shiftKey && !ev.ctrlKey) {
        const horiz = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
        if (ev.metaKey && !ev.altKey && horiz) {
          ev.preventDefault(); // 웹뷰의 히스토리 뒤로/앞으로 내비게이션 차단
          const appMode = term.modes && term.modes.applicationCursorKeysMode;
          ta.write(session.id, ev.key === 'ArrowLeft'
            ? (appMode ? '\x1bOH' : '\x1b[H')
            : (appMode ? '\x1bOF' : '\x1b[F'));
          return false;
        }
        if (ev.altKey && !ev.metaKey && horiz) {
          ev.preventDefault(); // textarea 의 단어 단위 캐럿 이동 차단 — IME 삽입 위치 desync 방지
          ta.write(session.id, ev.key === 'ArrowLeft' ? '\x1bb' : '\x1bf');
          return false;
        }
        if (ev.key === 'Backspace' && (ev.metaKey !== ev.altKey)) {
          // preventDefault 필수: 기본 동작이 textarea 의 단어/줄을 지우면 input diff 가
          // 같은 삭제를 한 번 더 전송해 이중 삭제가 된다
          ev.preventDefault();
          if (ev.metaKey) mirrorClear(); else mirrorTrimWord(); // 전송분을 미러에도 반영
          ta.write(session.id, ev.metaKey ? '\x15' : '\x17');
          return false;
        }
      }
      // Cmd/Ctrl+V: 클립보드에 이미지가 있으면 경로 첨부로 대체, 아니면 텍스트 붙여넣기
      if (mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'v') {
        ev.preventDefault();
        App.pasteToSession(session.id);
        return false;
      }
      // Cmd/Ctrl+1~9: 세션 전환 (터미널 포커스 중에도 동작)
      if (mod && ev.key >= '1' && ev.key <= '9') {
        ev.preventDefault();
        App.activateByIndex(Number(ev.key) - 1);
        return false;
      }
      // Cmd/Ctrl+T: 현재 프로젝트에 새 세션
      if (mod && ev.key.toLowerCase() === 't') {
        ev.preventDefault();
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
