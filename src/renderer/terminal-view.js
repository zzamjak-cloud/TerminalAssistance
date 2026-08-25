// xterm 인스턴스 관리. 세션별 holder 를 display 토글로 전환 —
// 비활성 세션도 xterm 버퍼가 유지되므로 전환 시 리플로우/재렌더 비용이 없다.
// WebGL 렌더러는 화면에 보이는 세션에만 부착한다 — 브라우저의 WebGL 컨텍스트 수 제한(~16)
// 때문에 세션이 많아도 컨텍스트는 보이는 패널 수(단일 1, 분할 최대 6)만 쓰고,
// 화면에 없는 세션은 어차피 렌더링되지 않으므로 손해가 없다.
const TerminalView = {
  views: new Map(), // sessionId → { term, fit, holder, webgl, frozen, queue }
  area: null,
  panes: [], // 분할 패널 컨테이너 (최대 3×2)
  paneBodies: [], // 패널별 터미널 영역 (holder 의 부모)
  composers: [], // 패널별 프롬프트 작성기 — 패널마다 독립된 입력/예약 목록

  init() {
    this.area = document.getElementById('term-area');
    this.panes = Array.from({ length: SPLIT_MAX_PANES }, (_, i) => document.getElementById('term-pane-' + i));
    this.buildPaneShells();
    window.addEventListener('resize', () => {
      this.resizeAllComposers();
      this.fitActive();
    });
    requestAnimationFrame(() => this.resizeAllComposers());
  },

  // 각 패널 = 터미널 영역 + 전용 프롬프트 작성기. 분할하면 패널마다 따로 입력·전송한다.
  buildPaneShells() {
    this.paneBodies = [];
    this.composers = [];
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const pane = this.panes[i];
      const body = document.createElement('div');
      body.className = 'pane-body';
      pane.appendChild(body);
      this.paneBodies.push(body);
      this.composers.push(this.buildComposer(i, pane));
    }
  },

  buildComposer(paneIdx, pane) {
    const root = document.createElement('div');
    root.className = 'pane-prompt hidden';
    const images = document.createElement('div');
    images.className = 'pane-prompt-images hidden'; // 이 세션에 첨부한 최근 이미지
    const list = document.createElement('div');
    list.className = 'pane-prompt-list hidden';
    const compose = document.createElement('div');
    compose.className = 'pane-prompt-compose';
    const input = document.createElement('textarea');
    input.className = 'pane-prompt-input';
    input.rows = 2;
    input.spellcheck = false;
    input.disabled = true;
    input.placeholder = '프롬프트 입력 (Enter 줄바꿈 · Cmd/Ctrl+Enter 전송)';
    input.setAttribute('aria-label', '터미널 프롬프트 입력');
    const actions = document.createElement('div');
    actions.className = 'pane-prompt-actions';
    const mkBtn = (cls, text, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = title;
      b.disabled = true;
      return b;
    };
    const send = mkBtn('pp-send', '전송', '이 패널의 세션에 즉시 전송 (Cmd/Ctrl+Enter)');
    const schedule = mkBtn('pp-schedule', '예약', '진행 중이면 완료 후 전송');
    const fanout = mkBtn('pp-fanout', '일괄', '선택한 여러 세션에 즉시 전송');
    actions.append(send, schedule, fanout);
    compose.append(input, actions);
    root.append(images, list, compose);
    pane.appendChild(root);

    const c = { paneIdx, root, images, list, input, send, schedule, fanout };
    const target = () => App.paneSessionId(paneIdx); // 전송 시점의 배정 세션을 그때그때 조회
    // xterm의 키/IME 보정과 완전히 분리해 일반 textarea의 편집 감각을 유지한다.
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        App.sendComposerPrompt(target());
      }
    });
    // 텍스트 붙여넣기는 기본 동작에 맡기고(실행 취소 이력 보존), 텍스트가 없을 때만
    // 네이티브 클립보드에서 이미지를 받아 저장된 PNG 경로를 삽입한다.
    input.addEventListener('paste', (ev) => {
      ev.stopPropagation();
      const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      if (text) return;
      ev.preventDefault();
      void App.pasteToComposer(target(), c, '');
    });
    input.addEventListener('keypress', (ev) => ev.stopPropagation());
    input.addEventListener('keyup', (ev) => ev.stopPropagation());
    input.addEventListener('input', () => {
      App.rememberComposerText(target(), input.value);
      this.resizeComposer(c);
    });
    // 입력창을 쓰면 그 패널이 활성 패널 — 전역 프리셋·이미지 첨부 대상이 어긋나지 않게 한다
    input.addEventListener('focus', () => App.focusPane(paneIdx));
    send.addEventListener('click', () => App.sendComposerPrompt(target()));
    schedule.addEventListener('click', () => App.scheduleComposerPrompt(target()));
    fanout.addEventListener('click', () => App.showComposerFanout(target()));
    return c;
  },

  // 세션이 보이는 패널의 작성기 (보이지 않으면 null)
  composerForSession(sid) {
    const idx = App.paneIndexForSession(sid);
    return idx >= 0 ? this.composers[idx] || null : null;
  },

  // 입력 내용에 따라 높이 자동 조절 — 상한은 그 패널 높이의 절반
  resizeComposer(c) {
    if (!c || !c.input) return;
    const input = c.input;
    const previousHeight = input.offsetHeight;
    input.style.height = 'auto';
    const style = getComputedStyle(input);
    const borderHeight = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const contentHeight = input.scrollHeight + borderHeight;
    const paneHeight = this.panes[c.paneIdx] ? this.panes[c.paneIdx].clientHeight : 0;
    const maxHeight = Math.max(56, Math.floor((paneHeight || window.innerHeight) * 0.5));
    input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    if (input.offsetHeight !== previousHeight) this.fitActive();
  },

  resizeAllComposers() {
    for (const c of this.composers) this.resizeComposer(c);
  },

  // 패널별 작성기 활성/잠금 + 그 패널 세션의 작성 중 텍스트 복원
  syncComposerStates(opts) {
    for (let i = 0; i < SPLIT_MAX_PANES; i++) {
      const c = this.composers[i];
      if (!c) continue;
      const sid = App.paneSessionId(i);
      const live = !!(sid && this.views.has(sid));
      c.root.classList.toggle('hidden', !live);
      for (const el of [c.input, c.send, c.schedule, c.fanout]) el.disabled = !live;
      const text = live ? (App._composerTexts.get(sid) || '') : '';
      if (c.input.value !== text) {
        c.input.value = text;
        this.resizeComposer(c);
      }
    }
    App.renderComposerQueue();
    if (opts && opts.noFocus) return;
    const focused = App.isSplit && App.isSplit() ? App.split.focused : 0;
    const fc = this.composers[focused];
    if (fc && !fc.input.disabled) fc.input.focus();
  },

  ansiColor(index) {
    const basic = [
      '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
      '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
    ];
    if (index >= 0 && index < 16) return basic[index];
    if (index >= 16 && index <= 231) {
      const n = index - 16;
      const level = [0, 95, 135, 175, 215, 255];
      const r = level[Math.floor(n / 36)];
      const g = level[Math.floor((n % 36) / 6)];
      const b = level[n % 6];
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (index >= 232 && index <= 255) {
      const gray = 8 + (index - 232) * 10;
      return `rgb(${gray}, ${gray}, ${gray})`;
    }
    return null;
  },

  _rgbColor(value) {
    const n = Number(value) >>> 0;
    return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
  },

  _cellColor(cell, kind, term, bold) {
    const cap = kind === 'fg' ? 'Fg' : 'Bg';
    const theme = (term.options && term.options.theme) || {};
    const themeFallback = Theme.termTheme();
    const fallback = kind === 'fg'
      ? (theme.foreground || themeFallback.foreground)
      : (theme.background || themeFallback.background);
    try {
      if (typeof cell[`is${cap}RGB`] === 'function' && cell[`is${cap}RGB`]()) {
        return this._rgbColor(cell[`get${cap}Color`]());
      }
      if (typeof cell[`is${cap}Palette`] === 'function' && cell[`is${cap}Palette`]()) {
        let index = cell[`get${cap}Color`]();
        if (kind === 'fg' && bold && index < 8 && term.options.drawBoldTextInBrightColors !== false) index += 8;
        return this.ansiColor(index) || fallback;
      }
    } catch (_) {}
    return fallback;
  },

  _cellStyle(cell, term) {
    const bold = !!(cell.isBold && cell.isBold());
    let fg = this._cellColor(cell, 'fg', term, bold);
    let bg = this._cellColor(cell, 'bg', term, false);
    if (cell.isInverse && cell.isInverse()) [fg, bg] = [bg, fg];
    const styles = [`color: ${fg}`, `background-color: ${bg}`];
    if (bold) styles.push('font-weight: 700');
    if (cell.isItalic && cell.isItalic()) styles.push('font-style: italic');
    if (cell.isDim && cell.isDim()) styles.push('opacity: 0.6');
    const decorations = [];
    if (cell.isUnderline && cell.isUnderline()) decorations.push('underline');
    if (cell.isStrikethrough && cell.isStrikethrough()) decorations.push('line-through');
    if (decorations.length) styles.push(`text-decoration: ${decorations.join(' ')}`);
    return styles.join('; ');
  },

  _escapeSelectionHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _selectionTokensToHtml(lines) {
    return lines.map((tokens) => {
      let html = '', style = null, text = '';
      const flush = () => {
        if (!text) return;
        const escaped = this._escapeSelectionHtml(text);
        html += style ? `<span style="${style}">${escaped}</span>` : escaped;
        text = '';
      };
      for (const token of tokens) {
        if (token.style !== style) {
          flush();
          style = token.style;
        }
        text += token.text;
      }
      flush();
      return html;
    }).join('\n');
  },

  _selectionCandidate(term, position, coordinateOffset) {
    const buffer = term.buffer && term.buffer.active;
    if (!buffer || !position) return null;
    const sx = Math.max(0, position.start.x + coordinateOffset);
    const sy = Math.max(0, position.start.y + coordinateOffset);
    const ex = Math.max(0, position.end.x + coordinateOffset);
    const ey = Math.max(0, position.end.y + coordinateOffset);
    if (ey < sy) return null;
    const logicalLines = [];
    for (let y = sy; y <= ey; y++) {
      const line = buffer.getLine(y);
      if (!line) return null;
      const from = y === sy ? sx : 0;
      const to = y === ey ? ex : term.cols;
      const tokens = [];
      for (let x = from; x < to; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        const width = typeof cell.getWidth === 'function' ? cell.getWidth() : 1;
        if (width === 0) continue; // 와이드문자 후속 셀은 첫 셀에서 이미 포함된다
        const chars = (cell.getChars && cell.getChars()) || ' ';
        tokens.push({ text: chars.replace(/\u00a0/g, ' '), style: this._cellStyle(cell, term) });
      }
      // xterm getSelection()과 같이 각 물리 줄 끝의 빈 셀은 제거한다.
      while (tokens.length && /^[ ]+$/.test(tokens[tokens.length - 1].text)) tokens.pop();
      if (y === sy || !line.isWrapped || !logicalLines.length) logicalLines.push(tokens);
      else logicalLines[logicalLines.length - 1].push(...tokens);
    }
    return {
      text: logicalLines.map((tokens) => tokens.map((token) => token.text).join('')).join('\n'),
      html: this._selectionTokensToHtml(logicalLines)
    };
  },

  serializeSelectionHtml(term, plainText) {
    const plain = String(plainText || '').replace(/\r\n/g, '\n');
    if (!plain || typeof term.getSelectionPosition !== 'function') return '';
    const position = term.getSelectionPosition();
    // 공개 좌표는 1-based이므로 먼저 -1 변환한다. 엔진 차이는 plain 정합성 검사로 폴백한다.
    const candidates = [this._selectionCandidate(term, position, -1), this._selectionCandidate(term, position, 0)];
    const matched = candidates.find((candidate) => candidate && candidate.text === plain);
    const content = matched ? matched.html : this._escapeSelectionHtml(plain);
    return `<pre style="margin: 0; white-space: pre-wrap">${content}</pre>`;
  },

  copySelectionAsHtml(term, ev) {
    if (!ev.clipboardData || typeof term.getSelection !== 'function') return false;
    const plain = term.getSelection();
    if (!plain) return false;
    try {
      const html = this.serializeSelectionHtml(term, plain);
      if (!html) return false;
      ev.clipboardData.setData('text/plain', plain);
      ev.clipboardData.setData('text/html', html);
      ev.preventDefault();
      return true;
    } catch (_) {
      // 기본 xterm plain copy가 계속 동작하도록 실패 시 이벤트를 취소하지 않는다.
      return false;
    }
  },

  // opts.frozen: 복구(스크롤백 주입) 완료 전까지 라이브 출력을 큐에 보관
  create(session, fontSize, opts) {
    const holder = document.createElement('div');
    holder.className = 'term-holder';
    this.paneBodies[0].appendChild(holder); // 실제 패널 배치는 syncLayout 이 분할 상태에 맞춰 조정

    const term = new Terminal(Object.assign({
      fontSize: fontSize || 13,
      fontFamily: 'Menlo, Consolas, "D2Coding", "Cascadia Mono", monospace',
      theme: Theme.termTheme(),
      scrollback: 5000,
      cursorBlink: true
    }, this.readabilityOptions()));
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_, url) => {
      ta.openUrl(url).catch((err) => console.warn('링크 열기 실패:', err));
    }));
    term.open(holder);
    const richCopyHandler = (ev) => this.copySelectionAsHtml(term, ev);
    holder.addEventListener('copy', richCopyHandler, true);
    let pointerDownInTerminal = false;
    let pointerMovedInTerminal = false;
    const markSelectionStart = () => {
      pointerDownInTerminal = true;
      pointerMovedInTerminal = false;
    };
    const markSelectionMove = () => {
      if (pointerDownInTerminal) pointerMovedInTerminal = true;
    };
    const rememberSelectionChange = () => this.rememberSelectionSoon(session.id, { markAttempt: true });
    const rememberFinishedSelection = () => {
      this.rememberSelectionSoon(session.id, { markAttempt: pointerMovedInTerminal });
      pointerDownInTerminal = false;
      pointerMovedInTerminal = false;
    };
    holder.addEventListener('pointerdown', markSelectionStart, true);
    holder.addEventListener('mousedown', markSelectionStart, true);
    holder.addEventListener('pointermove', markSelectionMove, true);
    holder.addEventListener('mousemove', markSelectionMove, true);
    holder.addEventListener('pointerup', rememberFinishedSelection, true);
    holder.addEventListener('mouseup', rememberFinishedSelection, true);
    window.addEventListener('pointerup', rememberFinishedSelection, true);
    window.addEventListener('mouseup', rememberFinishedSelection, true);

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
    let mirrorInvalidate = () => {};
    let mirrorMarkDeleteHandled = () => {};
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
        let pendingKeyDeleteMirror = null; // keydown 에서 이미 처리한 삭제 뒤 textarea 목표값
        let imeBackspaceFallbackTimer = null;
        // WKWebView 는 IME 삭제 input 과 keydown(229, Backspace) 순서를 뒤집어 보낼 수 있다.
        // 이미 diff 경로에서 삭제를 보낸 input 은 serial 로 기록해 폴백 DEL 중복을 막는다.
        let deleteInputSerial = 0;
        let handledDeleteInputSerial = 0;
        let lastDeleteInputAt = 0;
        let lastImeFallbackDeleteAt = 0;
        let fallbackDeleteMirror = null;
        const MIRROR_TAIL_LIMIT = 16; // IME 교체 기준으로만 쓰므로 긴 터미널 라인을 보관하지 않는다
        const trimMirrorTail = (value) => {
          const chars = Array.from(value);
          return chars.length > MIRROR_TAIL_LIMIT ? chars.slice(-MIRROR_TAIL_LIMIT).join('') : value;
        };
        const setMirrorValue = (value) => {
          taEl.value = trimMirrorTail(value);
          try { taEl.setSelectionRange(taEl.value.length, taEl.value.length); } catch (_) {}
        };
        const clearImeBackspaceFallback = () => {
          if (imeBackspaceFallbackTimer !== null) {
            clearTimeout(imeBackspaceFallbackTimer);
            imeBackspaceFallbackTimer = null;
          }
        };
        mirrorInvalidate = () => {
          clearImeBackspaceFallback();
          preVal = null;
          pendingKeyDeleteMirror = null;
          fallbackDeleteMirror = null;
          setMirrorValue('');
        };
        mirrorMarkDeleteHandled = () => { pendingKeyDeleteMirror = taEl.value; };
        taEl.addEventListener('beforeinput', (ev) => {
          const inputType = ev.inputType || '';
          if (inputType.startsWith('deleteContent')) {
            sawInput = true; // delete input 이 곧 처리될 예정이면 폴백 DEL 을 막는다
          }
          const ch = core._compositionHelper;
          if (ev.isComposing || (ch && ch._isComposing)) { preVal = null; return; }
          preVal = taEl.value;
        });
        taEl.addEventListener('input', (ev) => {
          sawInput = true;
          const inputType = ev.inputType || '';
          const hadPendingImeBackspaceFallback = imeBackspaceFallbackTimer !== null;
          let countedDeleteInput = false;
          const markDeleteInput = () => {
            if (countedDeleteInput) return;
            countedDeleteInput = true;
            deleteInputSerial += 1;
            lastDeleteInputAt = Date.now();
            if (hadPendingImeBackspaceFallback) handledDeleteInputSerial = deleteInputSerial;
          };
          if (inputType.startsWith('deleteContent')) markDeleteInput();
          clearImeBackspaceFallback();
          const ch = core._compositionHelper;
          if (ev.isComposing || (ch && ch._isComposing)) { preVal = null; return; }
          if (fallbackDeleteMirror !== null && inputType.startsWith('deleteContent') &&
              Date.now() - lastImeFallbackDeleteAt < 300) {
            preVal = null;
            setMirrorValue(fallbackDeleteMirror);
            fallbackDeleteMirror = null;
            return;
          }
          if (fallbackDeleteMirror !== null && Date.now() - lastImeFallbackDeleteAt >= 300) {
            fallbackDeleteMirror = null;
          }
          if (pendingKeyDeleteMirror !== null &&
              (inputType.startsWith('deleteContent') || inputType === 'insertReplacementText')) {
            preVal = null;
            setMirrorValue(pendingKeyDeleteMirror);
            pendingKeyDeleteMirror = null;
            return;
          }
          if (preVal === null) return;
          const pre = preVal, cur = taEl.value;
          preVal = null;
          if (pre === cur || core._keyPressHandled) { setMirrorValue(cur); return; }
          // 공통 접두/접미를 제외한 변경 구간 계산
          let p = 0;
          const max = Math.min(pre.length, cur.length);
          while (p < max && pre[p] === cur[p]) p++;
          let s = 0;
          while (s < max - p && pre[pre.length - 1 - s] === cur[cur.length - 1 - s]) s++;
          const deletedText = pre.slice(p, pre.length - s);
          const deleted = Array.from(deletedText).length;
          const inserted = cur.slice(p, cur.length - s);
          if (deleted > 0) markDeleteInput();
          if (pendingKeyDeleteMirror !== null && deleted > 0) {
            setMirrorValue(pendingKeyDeleteMirror);
            pendingKeyDeleteMirror = null;
            return;
          }
          if (pendingKeyDeleteMirror !== null) pendingKeyDeleteMirror = null;
          const isInsertInput = inputType.startsWith('insert') || !!inserted;
          const isDeleteInput = inputType.startsWith('deleteContent');
          let deleteCount = deleted;
          let nextMirror = cur;
          if (deleted > 1 && isInsertInput) {
            // hidden textarea 가 전체 선택/중간 선택 상태로 오염되면 다음 insert 가
            // 긴 replace 로 보인다. 터미널에는 새 글자만 보내고 미러는 끝 삽입 기준으로 복구한다.
            deleteCount = 0;
            nextMirror = pre + inserted;
          } else if (deleted > 1 && isDeleteInput) {
            // 일반/IME Backspace 는 한 번에 한 글자만 지워야 한다. 여러 글자 삭제는
            // textarea selection 오염으로 보고 과삭제를 차단한다.
            deleteCount = 1;
            const keptDeleted = Array.from(deletedText);
            keptDeleted.pop();
            nextMirror = pre.slice(0, p) + keptDeleted.join('') + pre.slice(pre.length - s);
          }
          const out = '\x7f'.repeat(deleteCount) + inserted;
          if (out) core.coreService.triggerDataEvent(out, true);
          // Codex TUI처럼 화면을 자주 다시 그리는 앱에서는 textarea selection 이
          // 전체 선택/중간 위치로 남는 경우가 있다. 다음 IME 교체가 기존 줄 전체
          // 삭제로 해석되지 않도록 미러 커서를 항상 끝에 둔다.
          setMirrorValue(nextMirror);
        });
        // 미러 보정 구현 (서로게이트 쌍 안전하게 문자 단위로)
        mirrorTrimChar = () => {
          const chars = Array.from(taEl.value);
          if (chars.length) { chars.pop(); setMirrorValue(chars.join('')); }
        };
        mirrorTrimWord = () => setMirrorValue(taEl.value.replace(/\S+\s*$/, ''));
        mirrorClear = () => setMirrorValue('');

        taEl.addEventListener('keydown', (ev) => {
          // 일반 백스페이스(keyCode 8): xterm 이 \x7f 전송 후 이벤트를 취소해
          // textarea 에는 글자가 남는다 → 미러에서도 한 글자 지워 desync 를 막는다
          if (ev.key === 'Backspace' && ev.keyCode !== 229 && !ev.metaKey && !ev.altKey && !ev.ctrlKey) {
            ev.preventDefault(); // 기본 textarea 삭제/input 이 뒤늦게 한 번 더 들어오는 경로 차단
            mirrorTrimChar();
            mirrorMarkDeleteHandled();
            return;
          }
          // IME 가 소비한 백스페이스(keyCode 229): 자모 분해는 위 diff 가 처리하지만,
          // IME 텍스트 경계를 넘어 지울 때는 textarea 변화 없이 keydown 만 온다 → DEL 폴백
          if (ev.keyCode !== 229 || ev.key !== 'Backspace') return;
          clearImeBackspaceFallback();
          if (deleteInputSerial !== handledDeleteInputSerial) {
            const deleteInputAge = Date.now() - lastDeleteInputAt;
            handledDeleteInputSerial = deleteInputSerial;
            if (deleteInputAge < 500) return;
          }
          sawInput = false;
          const fallbackBaseDeleteSerial = deleteInputSerial;
          imeBackspaceFallbackTimer = setTimeout(() => {
            imeBackspaceFallbackTimer = null;
            if (!sawInput && deleteInputSerial === fallbackBaseDeleteSerial) {
              core.coreService.triggerDataEvent('\x7f', true);
              mirrorTrimChar(); // 전송한 삭제를 미러에도 반영 — 남겨두면 diff 이중 삭제
              fallbackDeleteMirror = taEl.value;
              lastImeFallbackDeleteAt = Date.now();
            }
          }, 120);
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
      if (App.handleAppShortcut(ev, { fromTerminal: true })) return false;
      // ── 맥북(Home/End 키 없음) 텍스트 이동 — macOS 에디터 관행을 터미널 시퀀스로 재현 ──
      // Cmd+←/→ = 줄 시작/끝(Home/End 키와 동일 시퀀스), Option+←/→ = 단어 이동(ESC b/f),
      // Cmd+⌫ = 줄 시작까지 삭제(^U), Option+⌫ = 단어 삭제(^W)
      if (App.state.platform === 'macos' && !ev.shiftKey && !ev.ctrlKey) {
        const horiz = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
        if (ev.metaKey && !ev.altKey && horiz) {
          ev.preventDefault(); // 웹뷰의 히스토리 뒤로/앞으로 내비게이션 차단
          mirrorInvalidate();
          const appMode = term.modes && term.modes.applicationCursorKeysMode;
          ta.write(session.id, ev.key === 'ArrowLeft'
            ? (appMode ? '\x1bOH' : '\x1b[H')
            : (appMode ? '\x1bOF' : '\x1b[F'));
          return false;
        }
        if (ev.altKey && !ev.metaKey && horiz) {
          ev.preventDefault(); // textarea 의 단어 단위 캐럿 이동 차단 — IME 삽입 위치 desync 방지
          mirrorInvalidate();
          ta.write(session.id, ev.key === 'ArrowLeft' ? '\x1bb' : '\x1bf');
          return false;
        }
        if (ev.key === 'Backspace' && (ev.metaKey !== ev.altKey)) {
          // preventDefault 필수: 기본 동작이 textarea 의 단어/줄을 지우면 input diff 가
          // 같은 삭제를 한 번 더 전송해 이중 삭제가 된다
          ev.preventDefault();
          mirrorClear(); // 단어/줄 삭제 뒤에는 터미널 커서 상태를 정확히 알 수 없으므로 새 기준으로 시작
          mirrorMarkDeleteHandled();
          ta.write(session.id, ev.metaKey ? '\x15' : '\x17');
          return false;
        }
      }
      if (App.state.platform === 'macos') {
        const navKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
        if (ev.ctrlKey || navKeys.includes(ev.key) || ev.key === 'Enter' || ev.key === 'Tab' || ev.key === 'Delete') {
          mirrorInvalidate();
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

    const view = {
      term, fit, holder,
      webgl: null,
      frozen: !!(opts && opts.frozen),
      queue: [],     // frozen 동안 도착한 ta:data 페이로드
      queueBytes: 0, // 큐 누적 바이트 (상한 관리용)
      lastCols: 0,   // PTY 에 마지막으로 보낸 치수 — 변했을 때만 리사이즈 IPC
      lastRows: 0,
      resetInputMirror: mirrorInvalidate,
      scrollQueued: false,
      scrollForce: false,
      scrollDisposable: null,
      lastSelection: '',
      lastSelectionAt: 0,
      lastSelectionAttemptAt: 0,
      selectionDisposable: null,
      selectionStartHandler: markSelectionStart,
      selectionMoveHandler: markSelectionMove,
      selectionHandler: rememberFinishedSelection,
      selectionFinishHandler: rememberFinishedSelection,
      richCopyHandler
    };
    this.views.set(session.id, view);
    if (typeof term.onSelectionChange === 'function') {
      view.selectionDisposable = term.onSelectionChange(rememberSelectionChange);
    }
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
    v.term.write(p.data, () => {
      if (this.isActive(p.sessionId)) this.scrollToBottom(p.sessionId);
      ta.ackData(p.sessionId, p.bytes);
    });
  },

  // 복구: 백엔드 스크롤백 스냅샷 주입 후, 스냅샷 이후(off 기준) 도착분만 이어붙인다
  restore(id, snap) {
    const v = this.views.get(id);
    if (!v) return;
    if (snap && snap.data) {
      v.term.write(snap.data, () => {
        if (this.isActive(id)) this.scrollToBottom(id);
      });
    }
    for (const p of v.queue) {
      if (!snap || p.off >= snap.off) {
        v.term.write(p.data, () => {
          if (this.isActive(id)) this.scrollToBottom(id);
          ta.ackData(id, p.bytes);
        });
      }
      // off < snap.off 인 이벤트는 스냅샷에 이미 포함된 중복 → 버림 (ack 도 하지 않음)
    }
    v.queue = [];
    v.queueBytes = 0;
    v.frozen = false;
    if (this.isActive(id)) this.scrollToBottom(id, true);
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

  activate(id, opts) {
    this.syncLayout(opts);
  },

  // 분할 상태(App.split)에 맞춰 holder 의 패널 배치·표시·WebGL 부착을 재조정한다.
  // 단일 모드 = 활성 세션 1개만 표시, 분할 모드 = 각 패널에 배정된 세션 표시.
  // WebGL 은 화면에 보이는 세션 전부에 부착 (최대 6개 — 컨텍스트 한도 ~16 대비 여유).
  syncLayout(opts) {
    const assign = new Map(); // sessionId → paneIdx
    if (App.isSplit && App.isSplit()) {
      App.splitVisiblePanes().forEach((sid, i) => {
        if (sid && !assign.has(sid)) assign.set(sid, i);
      });
    } else if (App.state.activeId) {
      assign.set(App.state.activeId, 0);
    }
    const newlyVisible = new Set();
    for (const [sid, v] of this.views) {
      const target = this.paneBodies[assign.has(sid) ? assign.get(sid) : 0];
      if (target && v.holder.parentElement !== target) {
        // reparent 된 캔버스는 WebGL 컨텍스트가 빈 화면으로 남을 수 있어 떼었다 다시 붙인다
        this._detachWebgl(v);
        target.appendChild(v.holder);
      }
      const show = assign.has(sid);
      if (show && !v.holder.classList.contains('active')) newlyVisible.add(sid);
      v.holder.classList.toggle('active', show);
      if (!show) this._detachWebgl(v); // 화면에 없는 세션은 WebGL 컨텍스트 반납
    }
    // display 전환 직후엔 크기가 0 → 다음 프레임에 fit (WebGL 부착도 가시 상태에서)
    requestAnimationFrame(() => {
      for (const sid of assign.keys()) {
        const v = this.views.get(sid);
        if (!v) continue;
        try { v.fit.fit(); } catch (_) {}
        this._attachWebgl(v);
        this._syncPtySize(sid, v);
        // 새로 보이게 된 세션만 바닥으로 강제 스크롤 — 이미 보이던 패널의 스크롤백 열람 위치는
        // 포커스 이동(패널 클릭·드래그 선택 시작)만으로 잃지 않아야 한다.
        // opts.toBottom: 허가 대기 배지 클릭처럼 명시적 점프 의도만 예외.
        this.scrollToBottom(sid, newlyVisible.has(sid) ||
          !!(opts && opts.toBottom && sid === App.state.activeId));
      }
      this.syncComposerStates(opts);
    });
  },

  isActive(id) {
    const v = this.views.get(id);
    return !!(v && v.holder.classList.contains('active'));
  },

  // 뷰포트가 스크롤백 바닥에 붙어 있는지. xterm 은 휠·스크롤바로 인한 스크롤을
  // suppressScrollEvent 로 처리해 onScroll 을 발화시키지 않으므로(vendor/xterm.js _handleScroll),
  // 이벤트로 추종 여부를 추적하면 사용자가 위로 올려도 계속 바닥으로 끌려간다 → 버퍼 좌표를 직접 본다.
  _atBottom(v) {
    const b = v.term.buffer && v.term.buffer.active;
    if (!b) return true;
    return b.viewportY >= b.baseY;
  },

  scrollToBottom(id, force) {
    const v = this.views.get(id);
    if (!v || typeof v.term.scrollToBottom !== 'function') return;
    if (!force && !this._atBottom(v)) return;
    if (v.scrollQueued) {
      if (force) v.scrollForce = true;
      return;
    }
    v.scrollQueued = true;
    v.scrollForce = !!force;
    requestAnimationFrame(() => {
      v.scrollQueued = false;
      const forced = v.scrollForce;
      v.scrollForce = false;
      if (!forced && !this._atBottom(v)) return;
      try { v.term.scrollToBottom(); } catch (_) {}
      requestAnimationFrame(() => {
        if (!this._atBottom(v)) return;
        try { v.term.scrollToBottom(); } catch (_) {}
      });
    });
  },

  // 치수가 실제로 변했을 때만 PTY 리사이즈 IPC 전송
  // (같은 크기 요청도 ConPTY 는 실제 작업을 수행하므로 무조건 호출하면 드래그가 무거워진다)
  _syncPtySize(id, v) {
    // 스플리터 극단 축소 등으로 0에 가까운 치수가 나오면 PTY 에 보내지 않는다
    if (v.term.cols < 2 || v.term.rows < 1) return;
    if (v.term.cols !== v.lastCols || v.term.rows !== v.lastRows) {
      v.lastCols = v.term.cols;
      v.lastRows = v.term.rows;
      ta.resize(id, v.term.cols, v.term.rows);
    }
  },

  // 패널 드래그·창 리사이즈 등 고빈도 호출을 rAF 로 코얼레싱.
  // 분할 모드에서는 화면에 보이는 모든 세션을 리핏한다.
  _fitQueued: false,
  fitActive() {
    if (this._fitQueued) return;
    this._fitQueued = true;
    requestAnimationFrame(() => {
      this._fitQueued = false;
      for (const [sid, v] of this.views) {
        if (!v.holder.classList.contains('active')) continue;
        try { v.fit.fit(); } catch (_) {}
        this._syncPtySize(sid, v);
        this.scrollToBottom(sid);
      }
    });
  },

  write(id, data, onDone) {
    const v = this.views.get(id);
    if (!v) return;
    v.term.write(data, () => {
      if (this.isActive(id)) this.scrollToBottom(id);
      if (onDone) onDone();
    });
  },

  rememberSelection(id, opts) {
    const v = this.views.get(id);
    if (!v || typeof v.term.getSelection !== 'function') return '';
    if (opts && opts.markAttempt) v.lastSelectionAttemptAt = Date.now();
    const text = v.term.getSelection();
    if (text) {
      v.lastSelection = text;
      v.lastSelectionAt = Date.now();
    }
    return text;
  },

  rememberSelectionSoon(id, opts) {
    const remember = () => this.rememberSelection(id, opts);
    remember();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(remember);
    setTimeout(remember, 0);
  },

  hasRecentSelectionActivity(id, maxAgeMs) {
    const v = this.views.get(id);
    if (!v) return false;
    const since = Math.max(v.lastSelectionAt || 0, v.lastSelectionAttemptAt || 0);
    return since > 0 && Date.now() - since < maxAgeMs;
  },

  getSelection(id, opts) {
    const v = this.views.get(id);
    if (!v || typeof v.term.getSelection !== 'function') return '';
    const text = v.term.getSelection();
    if (text) {
      v.lastSelection = text;
      v.lastSelectionAt = Date.now();
      return text;
    }
    if (opts && opts.allowCached && v.lastSelection && Date.now() - v.lastSelectionAt < 30000) {
      return v.lastSelection;
    }
    return '';
  },

  clearSelection(id) {
    const v = this.views.get(id);
    if (!v) return;
    if (typeof v.term.clearSelection === 'function') v.term.clearSelection();
    v.lastSelection = '';
    v.lastSelectionAt = 0;
    v.lastSelectionAttemptAt = 0;
  },

  // 터미널 본문(xterm 헬퍼 textarea)에 키보드 포커스를 준다.
  // 프리셋 칩·메뉴는 버튼이라 클릭만으로 포커스를 가져가므로, 명령을 흘려보낸 뒤
  // 여기서 되돌려야 /model 같은 대화형 선택을 곧바로 방향키로 조작할 수 있다.
  focusTerminal(id) {
    const v = this.views.get(id);
    if (!v) return;
    // 패널 배치·display 토글은 syncLayout 이 다음 프레임에 끝내므로 그 뒤에 포커스를 준다
    requestAnimationFrame(() => {
      if (!v.holder.classList.contains('active')) return;
      try { v.term.focus(); } catch (_) {}
    });
  },

  // xterm 의 paste 경로 사용 (bracketed paste 처리 포함) → onData → pty
  paste(id, text) {
    const v = this.views.get(id);
    if (v) {
      v.term.paste(text);
      v.resetInputMirror();
    }
  },

  setFontSize(n) {
    for (const v of this.views.values()) v.term.options.fontSize = n;
    this.fitActive();
  },

  // 가독성 설정 → xterm 옵션. 저장값이 없으면 xterm 기본과 같은 무보정 값.
  // minimumContrastRatio 는 Claude/Codex 가 많이 쓰는 dim·회색 출력이 배경에 묻히는 것을
  // 배경 대비 기준으로 자동 보정한다 (1 = 끔).
  readabilityOptions() {
    const st = (window.App && App.state && App.state.settings) || {};
    const num = (v, def, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
    };
    return {
      lineHeight: num(st.lineHeight, 1, 1, 2),
      letterSpacing: num(st.letterSpacing, 0, 0, 4),
      minimumContrastRatio: num(st.minContrast, 1, 1, 21)
    };
  },

  // 셀 치수가 바뀌므로(줄 간격·자간) 적용 후 반드시 리핏 → PTY 리사이즈까지 이어진다
  applyReadability() {
    const opts = this.readabilityOptions();
    for (const v of this.views.values()) {
      for (const [k, val] of Object.entries(opts)) {
        try { v.term.options[k] = val; } catch (_) {}
      }
    }
    this.fitActive();
  },

  // 테마 변경 시 살아있는 모든 터미널의 배경/전경/ANSI 팔레트를 갈아끼운다.
  applyTheme() {
    const theme = Theme.termTheme();
    for (const v of this.views.values()) {
      try { v.term.options.theme = theme; } catch (_) {}
    }
  },

  dispose(id) {
    const v = this.views.get(id);
    if (v) {
      if (v.scrollDisposable) {
        try { v.scrollDisposable.dispose(); } catch (_) {}
      }
      if (v.selectionDisposable) {
        try { v.selectionDisposable.dispose(); } catch (_) {}
      }
      if (v.selectionHandler) {
        v.holder.removeEventListener('pointerdown', v.selectionStartHandler, true);
        v.holder.removeEventListener('mousedown', v.selectionStartHandler, true);
        v.holder.removeEventListener('pointermove', v.selectionMoveHandler, true);
        v.holder.removeEventListener('mousemove', v.selectionMoveHandler, true);
        v.holder.removeEventListener('pointerup', v.selectionHandler, true);
        v.holder.removeEventListener('mouseup', v.selectionHandler, true);
        window.removeEventListener('pointerup', v.selectionFinishHandler, true);
        window.removeEventListener('mouseup', v.selectionFinishHandler, true);
      }
      if (v.richCopyHandler) v.holder.removeEventListener('copy', v.richCopyHandler, true);
      this._detachWebgl(v);
      v.term.dispose();
      v.holder.remove();
      this.views.delete(id);
      this.syncComposerStates({ noFocus: true });
    }
  }
};
