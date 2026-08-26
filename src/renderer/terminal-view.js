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
    input.placeholder = '프롬프트 입력 (Enter 줄바꿈 · Cmd/Ctrl+Enter 전송 · Shift+Enter 예약)';
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
      if (this.handleComposerEditKeys(input, ev)) return;
      // Tab/Shift+Tab = 분할 패널 순회 — 다음 패널 입력창으로 커서를 옮긴다
      if (ev.key === 'Tab' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        if (App.cyclePaneFocus(ev.shiftKey ? -1 : 1)) ev.preventDefault();
        return;
      }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        App.sendComposerPrompt(target());
        return;
      }
      // Shift+Enter = 예약 발송 (진행 중이면 완료 후 전송) — 예약 버튼과 동일
      if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        App.scheduleComposerPrompt(target());
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

  // Windows/Linux 입력창의 커서 이동·삭제를 Mac 과 맞춘다 —
  // Ctrl+←/→ = 줄(문단) 시작/끝 (Mac 의 Cmd+←/→), Alt+←/→ = 단어 그룹 단위 (Mac 의 Opt+←/→),
  // Ctrl+Backspace = 줄 시작까지 삭제 (Mac 의 Cmd+Delete), Alt+Backspace = 단어 삭제 (Mac 의 Opt+Delete).
  // Shift+방향키 조합은 선택 확장. Mac 은 네이티브 동작이 이미 이 규칙이므로 손대지 않는다.
  // 처리했으면 true 를 반환한다 (호출부가 이후 키 처리를 건너뛰게).
  handleComposerEditKeys(input, ev) {
    if (App.state.platform === 'macos') return false;
    const arrow = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
    if (!arrow && ev.key !== 'Backspace') return false;
    // Ctrl 또는 Alt 중 정확히 하나만 — Ctrl+Alt 동시(AltGr)는 건드리지 않는다
    if (ev.metaKey || ev.ctrlKey === ev.altKey) return false;
    const v = input.value;
    // 줄 시작/끝 — 캐럿이 있는 줄의 개행 경계까지
    // (lastIndexOf 는 음수 fromIndex 를 0 으로 취급하므로 캐럿 0 은 따로 처리)
    const lineStart = (p) => (p === 0 ? 0 : v.lastIndexOf('\n', p - 1) + 1);
    const lineEnd = (p) => { const nl = v.indexOf('\n', p); return nl < 0 ? v.length : nl; };
    // 단어 그룹 — 공백을 건너뛴 뒤 같은 종류(단어/기호) 묶음의 경계까지
    const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);
    const wordLeft = (p) => {
      let i = p;
      while (i > 0 && /\s/.test(v[i - 1])) i--;
      if (i > 0) {
        const w = isWord(v[i - 1]);
        while (i > 0 && !/\s/.test(v[i - 1]) && isWord(v[i - 1]) === w) i--;
      }
      return i;
    };
    const wordRight = (p) => {
      let i = p;
      while (i < v.length && /\s/.test(v[i])) i++;
      if (i < v.length) {
        const w = isWord(v[i]);
        while (i < v.length && !/\s/.test(v[i]) && isWord(v[i]) === w) i++;
      }
      return i;
    };

    if (ev.key === 'Backspace') {
      if (ev.shiftKey) return false; // Shift 변형은 손대지 않는다
      // 선택이 있으면 선택 삭제(기본 동작)에 맡긴다
      if (input.selectionStart !== input.selectionEnd) return false;
      ev.preventDefault(); // 기본 단어 삭제(Ctrl+Backspace)를 막고 아래 규칙으로 대체
      const pos = input.selectionStart;
      const from = ev.ctrlKey ? lineStart(pos) : wordLeft(pos);
      if (from >= pos) return true; // 지울 범위 없음 (줄 시작 등)
      // execCommand 경유 삭제는 네이티브 실행 취소(undo) 이력과 input 이벤트를 보존한다
      input.setSelectionRange(from, pos);
      if (!(document.execCommand && document.execCommand('delete'))) {
        input.setRangeText('', from, pos, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }

    // ── 방향키 이동 ──
    ev.preventDefault();
    const left = ev.key === 'ArrowLeft';
    // 선택이 있으면 이동 중인 쪽(focus) 끝을 기준으로 계산한다
    const backward = input.selectionDirection === 'backward';
    const focusPos = backward ? input.selectionStart : input.selectionEnd;
    const pos = ev.ctrlKey
      ? (left ? lineStart(focusPos) : lineEnd(focusPos))
      : (left ? wordLeft(focusPos) : wordRight(focusPos));
    if (ev.shiftKey) {
      const anchor = backward ? input.selectionEnd : input.selectionStart;
      if (pos < anchor) input.setSelectionRange(pos, anchor, 'backward');
      else input.setSelectionRange(anchor, pos, 'forward');
    } else {
      input.setSelectionRange(pos, pos);
    }
    return true;
  },

  // 세션이 보이는 패널의 작성기 (보이지 않으면 null)
  composerForSession(sid) {
    const idx = App.paneIndexForSession(sid);
    return idx >= 0 ? this.composers[idx] || null : null;
  },

  // 사용자가 이 세션 터미널에 직접 입력한 시각 기록 (App.focusComposerOnDone 억제 근거)
  noteTyping(sid) {
    const v = this.views.get(sid);
    if (v) v.lastTypedAt = Date.now();
  },

  // 최근 ms 이내에 이 세션 터미널로 직접 타이핑했는가
  typedRecently(sid, ms) {
    const v = this.views.get(sid);
    return !!v && v.lastTypedAt > 0 && Date.now() - v.lastTypedAt < ms;
  },

  // 입력 내용에 따라 높이 자동 조절 — 상한은 그 패널 높이의 절반
  resizeComposer(c) {
    if (!c || !c.input) return;
    const input = c.input;
    // 숨겨진 상태(부팅 직후 등)에선 scrollHeight 가 0 이라 계산하면 쪼그라든 높이가
    // 인라인으로 박제된다 — 인라인 높이를 지워 rows 기본 크기로 되돌리고,
    // 표시된 뒤(syncComposerStates)에 다시 계산한다.
    if (!input.offsetParent) {
      input.style.height = '';
      input.style.overflowY = 'hidden';
      return;
    }
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
      const wasHidden = c.root.classList.contains('hidden');
      c.root.classList.toggle('hidden', !live);
      for (const el of [c.input, c.send, c.schedule, c.fanout]) el.disabled = !live;
      const text = live ? (App._composerTexts.get(sid) || '') : '';
      if (c.input.value !== text) {
        c.input.value = text;
        this.resizeComposer(c);
      } else if (live && wasHidden) {
        this.resizeComposer(c); // 숨김 중엔 높이 계산이 불가 — 처음 보일 때 기본/실측 높이로 재계산
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

  // ── 드래그 선택 자동 스크롤 틱 (50ms interval) ──
  // 포인터가 holder 위/아래로 벗어난 거리에 비례해 스크롤하고, xterm 내부 selection
  // service 의 선택 끝을 뷰포트 경계로 확장한다 (xterm _dragScroll 과 같은 규칙).
  _dragSelectionAutoScroll(id, state) {
    const v = this.views.get(id);
    if (!v || !state.active) return;
    const term = v.term;
    let svc = null;
    try { svc = term._core && term._core._selectionService; } catch (_) {}
    // 드래그 "선택" 중일 때만 — 단순 클릭·포커스 이동·스크롤바 드래그에는 개입하지 않는다.
    // _dragScrollIntervalTimer 는 선택 mousedown 에 설정되고 mouseup 에 undefined 로
    // 리셋되므로, 이전 선택이 남은 채 다른 드래그를 할 때의 오동작을 막는 정확한 신호다.
    if (!svc || !svc._model || !svc._model.selectionStart) return;
    if (svc._dragScrollIntervalTimer === undefined) return;
    if (svc._dragScrollAmount) return; // 내장 자동 스크롤이 이미 동작 중 — 이중 스크롤 방지
    const rect = v.holder.getBoundingClientRect();
    let over = 0;
    if (state.y > rect.bottom) over = state.y - rect.bottom;
    else if (state.y < rect.top) over = state.y - rect.top;
    if (!over) return;
    // 벗어난 거리 50px 상한, 틱당 최대 15줄 — xterm 내장과 같은 가감속
    const t = Math.min(Math.max(over, -50), 50) / 50;
    const amount = (t > 0 ? 1 : -1) + Math.round(14 * t);
    const b = term.buffer && term.buffer.active;
    if (!b) return;
    try {
      term.scrollLines(amount);
      svc._model.selectionEnd = amount > 0
        ? [term.cols, Math.min(b.viewportY + term.rows, b.baseY + term.rows - 1)]
        : [0, b.viewportY];
      svc.refresh();
    } catch (_) {}
  },

  // ── 파일 경로 링크 감지 ──
  // ① 구분자를 포함한 경로(상대·절대·Windows 드라이브), ② 알려진 확장자의 단독 파일명
  // (terminal-view.js 처럼 경로 없이 언급된 파일), ③ :줄번호가 붙은 임의 확장자 파일명.
  // 한글 등 유니코드 파일명 허용. URL(://) 은 WebLinksAddon 담당이므로 제외한다.
  FILE_LINK_RE: (() => {
    const seg = '[\\p{L}\\p{N}._$@%+~=-]';
    // 단독 파일명은 알려진 확장자만 — 일반 단어·도메인(example.com 등) 오탐 방지
    const exts = '(?:jsx?|mjs|cjs|tsx?|py|rs|go|java|kt|c|h|cpp|cc|cxx|hpp|cs|swift|rb|php|lua'
      + '|css|scss|less|html?|xml|svg|json|jsonl|yaml|yml|toml|ini|sh|bash|zsh|bat|ps1|sql|pl'
      + '|diff|patch|md|markdown|txt|log|csv|lock|env|gitignore'
      + '|png|jpe?g|gif|bmp|webp|ico|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac)';
    return new RegExp(
      `(?:[A-Za-z]:[\\\\/]|\\\\\\\\|\\.{1,2}[\\\\/])?${seg}+(?:[\\\\/]${seg}+)+(?::\\d+(?::\\d+)?)?` +
      `|${seg}+\\.${exts}(?!\\.?[\\p{L}\\p{N}])(?::\\d+(?::\\d+)?)?` +
      `|${seg}+\\.[A-Za-z][A-Za-z0-9]{0,9}:\\d+(?::\\d+)?`,
      'giu'
    );
  })(),

  fileLinkProvider(term, sessionId) {
    return {
      provideLinks: (lineNo, cb) => {
        let links = null;
        try { links = this._computeFileLinks(term, sessionId, lineNo); } catch (_) {}
        cb(links && links.length ? links : undefined);
      }
    };
  },

  // 물리 줄이 아니라 래핑을 잇댄 논리 줄 전체에서 경로를 찾는다 (긴 경로가 줄바꿈돼도 인식).
  // 와이드 문자(한글)는 셀 2칸을 차지해 문자열 인덱스 ≠ 열 이므로,
  // 코드유닛마다 (행, 열) 좌표를 기록해 정확한 버퍼 범위로 되돌린다.
  _computeFileLinks(term, sessionId, lineNo) {
    const buf = term.buffer && term.buffer.active;
    if (!buf) return null;
    const row0 = lineNo - 1;
    let start = row0;
    while (start > 0) {
      const line = buf.getLine(start);
      if (!line || !line.isWrapped) break;
      start--;
    }
    let end = row0;
    while (end + 1 < buf.length) {
      const line = buf.getLine(end + 1);
      if (!line || !line.isWrapped) break;
      end++;
    }
    if (end - start > 40) return null; // 비정상적으로 긴 논리 줄은 비용 때문에 건너뛴다
    let text = '';
    const map = []; // text 코드유닛 인덱스 → { y, x } (0-based 버퍼 좌표)
    const cell = typeof buf.getNullCell === 'function' ? buf.getNullCell() : null;
    for (let y = start; y <= end; y++) {
      const line = buf.getLine(y);
      if (!line) break;
      for (let x = 0; x < line.length; x++) {
        const c = cell ? line.getCell(x, cell) : line.getCell(x);
        if (!c) continue;
        if ((typeof c.getWidth === 'function' ? c.getWidth() : 1) === 0) continue;
        const chars = (c.getChars && c.getChars()) || ' ';
        for (let k = 0; k < chars.length; k++) map.push({ y, x });
        text += chars;
      }
    }
    const links = [];
    const re = this.FILE_LINK_RE;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const matched = m[0].replace(/[.,;'"”’]+$/, ''); // 문장 끝 문장부호 꼬리 제거
      if (matched.length < 3 || !/\p{L}/u.test(matched)) continue;
      // 직전에 공백 없이 URL 스킴(://)이 이어지면 URL 의 일부 — WebLinksAddon 에 맡긴다
      const before = text.slice(Math.max(0, m.index - 64), m.index);
      if (/[A-Za-z][\w+.-]*:\/\/\S*$/.test(before)) continue;
      const startIdx = m.index;
      const endIdx = m.index + matched.length - 1;
      if (!map[startIdx] || !map[endIdx]) continue;
      links.push({
        range: {
          start: { x: map[startIdx].x + 1, y: map[startIdx].y + 1 },
          end: { x: map[endIdx].x + 1, y: map[endIdx].y + 1 }
        },
        text: matched,
        decorations: { pointerCursor: true, underline: true },
        activate: (_ev, linkText) => App.openFileLinkPreview(sessionId, linkText)
      });
    }
    return links;
  },

  // opts.frozen: 복구(스크롤백 주입) 완료 전까지 라이브 출력을 큐에 보관
  create(session, fontSize, opts) {
    const holder = document.createElement('div');
    holder.className = 'term-holder';
    this.paneBodies[0].appendChild(holder); // 실제 패널 배치는 syncLayout 이 분할 상태에 맞춰 조정

    const term = new Terminal(Object.assign({
      fontSize: fontSize || 13,
      fontFamily: this.fontFamilyOption(),
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

    // ── 드래그 선택 자동 스크롤 ──
    // 선택 드래그 중 포인터가 터미널 위/아래 경계를 벗어나면 벗어난 거리에 비례해
    // 스크롤하며 선택 끝을 함께 확장한다. xterm 내장 자동 스크롤이 동작하는 환경에서는
    // (_dragScrollAmount 가 이미 설정됨) 이중 스크롤을 피하기 위해 개입하지 않는다.
    // window 리스너는 캡처 단계 필수 — xterm 의 document mousemove 핸들러가
    // stopImmediatePropagation 을 호출해 버블 단계 리스너에는 이벤트가 오지 않는다.
    const autoScroll = { active: false, y: 0, timer: null };
    const dragScrollMove = (ev) => { autoScroll.y = ev.clientY; };
    const dragScrollStop = () => {
      autoScroll.active = false;
      if (autoScroll.timer) { clearInterval(autoScroll.timer); autoScroll.timer = null; }
      window.removeEventListener('mousemove', dragScrollMove, true);
    };
    const dragScrollStart = (ev) => {
      if (ev.button !== 0) return;
      dragScrollStop();
      autoScroll.active = true;
      autoScroll.y = ev.clientY;
      window.addEventListener('mousemove', dragScrollMove, true);
      autoScroll.timer = setInterval(() => this._dragSelectionAutoScroll(session.id, autoScroll), 50);
    };
    holder.addEventListener('mousedown', dragScrollStart, true);
    window.addEventListener('mouseup', dragScrollStop, true);

    // ── 마우스 중간(휠) 클릭 팬 스크롤 (토글 방식) ──
    // 중간 클릭 = 시작, 다시 중간 클릭 = 종료. 버튼을 놓아도 유지된다 — 시작/종료가
    // 오직 중간 클릭 토글이어야 "멈추려는 클릭"이 새 팬 시작으로 오인되지 않는다.
    // 활성 중에는 누른 지점(기준점) 대비 포인터의 위/아래 거리에 비례해 스크롤한다.
    // 다른 버튼 클릭이나 (반동 유예 후) 휠 조작도 종료 신호다.
    const panScroll = { active: false, originY: 0, y: 0, timer: null, startedAt: 0 };
    const panMove = (ev) => { panScroll.y = ev.clientY; };
    const panStop = () => {
      if (!panScroll.active) return;
      panScroll.active = false;
      if (panScroll.timer) { clearInterval(panScroll.timer); panScroll.timer = null; }
      window.removeEventListener('mousemove', panMove, true);
      holder.classList.remove('pan-scrolling');
    };
    const panTick = () => {
      const delta = panScroll.y - panScroll.originY;
      if (Math.abs(delta) <= 8) return; // 기준점 근처 데드존 — 정지
      const lines = Math.max(-40, Math.min(40, Math.round(delta / 15)));
      if (lines) { try { term.scrollLines(lines); } catch (_) {} }
    };
    const panStart = (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      ev.stopPropagation(); // xterm 의 중간클릭 처리(TUI 마우스 전달 등) 차단 — 팬 스크롤 전용
      if (panScroll.active) { panStop(); return; } // 토글 종료
      panScroll.active = true;
      panScroll.startedAt = Date.now();
      panScroll.originY = ev.clientY;
      panScroll.y = ev.clientY;
      window.addEventListener('mousemove', panMove, true);
      panScroll.timer = setInterval(panTick, 50);
      holder.classList.add('pan-scrolling');
    };
    // 다른 버튼 클릭은 팬 종료 (중간 버튼 토글은 panStart 가 처리)
    const panWindowDown = (ev) => { if (ev.button !== 1 && panScroll.active) panStop(); };
    // 휠 클릭 직후의 미세한 휠 굴림(클릭 반동)에 즉시 종료되면 팬이 죽은 것처럼 보인다
    // — 시작 후 400ms 는 휠 이벤트를 무시하고, 그 뒤의 휠 조작만 종료 신호로 본다.
    const panWheel = () => {
      if (panScroll.active && Date.now() - panScroll.startedAt > 400) panStop();
    };
    holder.addEventListener('mousedown', panStart, true);
    window.addEventListener('mousedown', panWindowDown, true);
    window.addEventListener('wheel', panWheel, { capture: true, passive: true });

    // ── TUI 마우스 트래킹 중에도 스크롤백은 휠로 볼 수 있게 ──
    // 트래킹이 켜지면 xterm 은 휠을 마우스 리포트로 바꿔 TUI 로 보내고 화면은 움직이지
    // 않는다. 일반 버퍼에서 위로 굴리거나 이미 스크롤백을 보는 중이면 앱이 직접 뷰포트를
    // 스크롤한다 (대체 버퍼(alt) TUI 의 휠 동작은 그대로 보존).
    const wheelHandler = (ev) => {
      try {
        const b = term.buffer && term.buffer.active;
        if (!b || b.type !== 'normal') return;
        const mouseSvc = term._core && term._core.coreMouseService;
        if (!mouseSvc || !mouseSvc.areMouseEventsActive) return;
        if (b.viewportY < b.baseY || ev.deltaY < 0) {
          ev.preventDefault();
          ev.stopPropagation();
          const lines = Math.sign(ev.deltaY) * Math.max(1, Math.round(Math.abs(ev.deltaY) / 40));
          term.scrollLines(lines);
        }
      } catch (_) {}
    };
    holder.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

    // ── Shift+클릭 확장 선택 ──
    // 시작 지점 클릭(앵커 기억) → 스크롤 → Shift+클릭으로 그 지점까지 한 번에 선택.
    // xterm 내장 incremental click 에 맡길 수 없는 이유: TUI 가 마우스 트래킹을 켜면
    // (_enabled=false) 일반 클릭은 앵커를 남기지 않고, shift+클릭은 "강제 새 선택"으로
    // 처리되며 stopPropagation 까지 걸린다. → 캡처 단계에서 클릭 좌표를 직접 기억하고
    // shift+클릭 시 선택 모델을 앱이 구성한다 (xterm 의 mousedown 처리는 차단).
    const shiftClick = { anchor: null };
    const shiftClickHandler = (ev) => {
      if (ev.button !== 0) return;
      let svc = null;
      try { svc = term._core && term._core._selectionService; } catch (_) {}
      if (!svc || !svc._model) return;
      let coords = null;
      try { coords = svc._getMouseBufferCoords(ev) || null; } catch (_) {}
      if (!ev.shiftKey) {
        shiftClick.anchor = coords; // 일반 클릭 = 앵커 갱신 (화면 표시는 없지만 기억한다)
        // 일반 클릭은 기존 선택을 해제한다 (표준 동작). TUI 마우스 트래킹 중에는 xterm 의
        // 클릭 처리(_handleSingleClick)가 실행되지 않고, 마우스 리포트를 사용자 입력에서
        // 제외하면서 리포트 경유 해제도 사라졌으므로 앱이 직접 재현해야 한다.
        // term.clearSelection() 만 호출 — 최근 선택 캐시(계획 저장·메뉴용)는 보존한다.
        if (typeof term.hasSelection === 'function' && term.hasSelection()) {
          try { term.clearSelection(); } catch (_) {}
        }
        return;
      }
      // 드래그 선택이 남긴 시작점이 있으면 그것을, 없으면 직전 클릭 앵커를 사용
      const anchor = svc._model.selectionStart || shiftClick.anchor;
      if (!anchor || !coords) return;
      ev.preventDefault();
      ev.stopPropagation(); // xterm 의 mousedown(새 선택 시작·TUI 마우스 전달)이 덮지 않게
      try {
        svc._model.isSelectAllActive = false;
        svc._model.selectionStartLength = 0;
        svc._activeSelectionMode = 0;
        svc._model.selectionStart = anchor;
        svc._model.selectionEnd = coords;
        svc.refresh(true);
      } catch (_) {}
      // preventDefault 로 막힌 포커스 이동을 직접 수행 — 일반 클릭과 같은 활성 선택 색으로
      // 렌더되고, 곧바로 Ctrl+C 복사도 동작한다.
      try { term.focus(); } catch (_) {}
      this.rememberSelectionSoon(session.id, { markAttempt: true });
    };
    holder.addEventListener('mousedown', shiftClickHandler, true);

    // 선택이 있는 상태의 우클릭은 컨텍스트 메뉴 전용 — xterm(TUI 마우스 리포트)으로
    // 보내지 않는다. contextmenu 이벤트는 별개로 발생하므로 메뉴는 정상 표시된다.
    const rightDownHandler = (ev) => {
      if (ev.button !== 2) return;
      if (typeof term.hasSelection === 'function' && term.hasSelection()) ev.stopPropagation();
    };
    holder.addEventListener('mousedown', rightDownHandler, true);

    // ── 우클릭 컨텍스트 메뉴 (복사 · 메모에 등록하기) ──
    const contextMenuHandler = (ev) => {
      ev.preventDefault();
      this.rememberSelection(session.id, {});
      App.showTerminalContextMenu(ev, session.id);
    };
    holder.addEventListener('contextmenu', contextMenuHandler);

    // ── 파일 경로 링크: 클릭하면 미리보기 팝업 (URL 은 WebLinksAddon 이 처리) ──
    let linkDisposable = null;
    try {
      linkDisposable = term.registerLinkProvider(this.fileLinkProvider(term, session.id));
    } catch (_) {}

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

    // ── 마우스 리포트는 "사용자 입력"으로 치지 않는다 ──
    // xterm 은 사용자 입력마다 선택을 지운다(onUserInput → clearSelection). 그런데 TUI 가
    // 마우스 트래킹을 켜면 마우스 이동/버튼 리포트도 사용자 입력으로 집계돼, 드래그·
    // Shift+클릭으로 만든 선택이 마우스만 움직이거나 우클릭해도 즉시 사라진다.
    // 리포트(X10 \x1b[M…, SGR \x1b[<…)는 wasUserInput=false 로 통과시킨다 — TUI 전달은
    // 그대로 유지되고, 선택 해제와 "입력 시 바닥으로 스크롤"만 건너뛴다.
    if (core && core.coreService && typeof core.coreService.triggerDataEvent === 'function') {
      const coreSvc = core.coreService;
      const origTrigger = coreSvc.triggerDataEvent.bind(coreSvc);
      coreSvc.triggerDataEvent = (data, wasUserInput) => {
        const isMouseReport = typeof data === 'string' && /^\x1b\[(?:M|<)/.test(data);
        return origTrigger(data, wasUserInput && !isMouseReport);
      };
    }

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
    // 사용자의 실제 키 입력만 타이핑으로 기록한다 — onData 에서 기록하면 컴포저 전송·예약
    // 발송(deliverDraft → term.paste → onData)까지 타이핑으로 오인해 완료 시 포커스 이동이
    // 잘못 억제된다. keydown 은 IME 조합 중 키(keyCode 229)도 잡으므로 조합 파괴도 막는다.
    if (term.textarea) {
      term.textarea.addEventListener('keydown', () => this.noteTyping(session.id));
    }

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
      // Ctrl+C: 선택이 있으면 복사만 하고 선택을 유지한다 — ^C 인터럽트는 선택이 없을 때만.
      // (기존에는 항상 ^C 가 PTY 로 전송돼 TUI 재렌더로 선택이 즉시 사라졌다)
      // execCommand('copy') 는 holder 의 copy 핸들러를 태워 색상 보존(rich) 복사가 된다.
      // macOS 는 Cmd+C 가 복사이므로 Ctrl+C 를 인터럽트로 유지한다.
      if (App.state.platform !== 'macos' && ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey
          && ev.key.toLowerCase() === 'c'
          && typeof term.hasSelection === 'function' && term.hasSelection()) {
        ev.preventDefault();
        try { document.execCommand('copy'); } catch (_) {}
        return false;
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
      // ── 나머지 터미널 제어 조합(Ctrl+문자) 차단 ──
      // 이 앱의 주 사용자는 터미널 단축키를 모른다 — Ctrl+D(셸 종료), Ctrl+Z(중지),
      // Ctrl+S(출력 정지), Ctrl+R(역검색) 등이 실수로 눌려 혼란을 만들지 않게
      // PTY 로 보내지 않는다. 예외: Ctrl+C 는 실행 중인 작업 중단용으로 필수라 유지.
      // (preventDefault 로 웹뷰 기본 동작(Ctrl+R 리로드, Ctrl+S 저장 등)도 함께 막는다.
      //  Ctrl+Alt 동시는 AltGr 문자 입력일 수 있어 건드리지 않는다)
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (/^[a-z]$/.test(k) && k !== 'c') {
          ev.preventDefault();
          return false;
        }
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
      lastTypedAt: 0, // 사용자가 이 터미널에 직접 키 입력한 마지막 시각 (완료 시 포커스 이동 억제 근거)
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
      richCopyHandler,
      autoScrollState: autoScroll,
      dragScrollStartHandler: dragScrollStart,
      dragScrollStopHandler: dragScrollStop,
      panStartHandler: panStart,
      panWindowDownHandler: panWindowDown,
      panWheelHandler: panWheel,
      panStop,
      wheelHandler,
      shiftClickHandler,
      rightDownHandler,
      contextMenuHandler,
      linkDisposable
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

  // 기본 글꼴 체인 — 사용자 지정 글꼴이 글리프를 못 그릴 때의 폴백으로도 쓰인다
  DEFAULT_FONT: 'Menlo, Consolas, "D2Coding", "Cascadia Mono", monospace',

  // 설정의 fontFamily → xterm fontFamily 문자열. 빈 값이면 기본 체인 그대로.
  fontFamilyOption() {
    const st = (typeof App !== 'undefined' && App.state && App.state.settings) || {};
    const f = String(st.fontFamily || '').replace(/["']/g, '').trim();
    return f ? `"${f}", ${this.DEFAULT_FONT}` : this.DEFAULT_FONT;
  },

  // 셀 치수가 바뀌므로 적용 후 리핏 → PTY 리사이즈까지 이어진다
  setFontFamily() {
    const f = this.fontFamilyOption();
    for (const v of this.views.values()) {
      try { v.term.options.fontFamily = f; } catch (_) {}
    }
    this.fitActive();
  },

  // 가독성 설정 → xterm 옵션. 저장값이 없으면 xterm 기본과 같은 무보정 값.
  // minimumContrastRatio 는 Claude/Codex 가 많이 쓰는 dim·회색 출력이 배경에 묻히는 것을
  // 배경 대비 기준으로 자동 보정한다 (1 = 끔).
  readabilityOptions() {
    const st = (typeof App !== 'undefined' && App.state && App.state.settings) || {};
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
      if (v.dragScrollStopHandler) {
        v.dragScrollStopHandler(); // 진행 중이던 자동 스크롤 interval·mousemove 리스너 정리
        window.removeEventListener('mouseup', v.dragScrollStopHandler, true);
      }
      if (v.dragScrollStartHandler) v.holder.removeEventListener('mousedown', v.dragScrollStartHandler, true);
      if (v.panStop) {
        v.panStop(); // 진행 중이던 팬 스크롤 interval·mousemove 리스너 정리
        v.holder.removeEventListener('mousedown', v.panStartHandler, true);
        window.removeEventListener('mousedown', v.panWindowDownHandler, true);
        window.removeEventListener('wheel', v.panWheelHandler, { capture: true });
      }
      if (v.wheelHandler) v.holder.removeEventListener('wheel', v.wheelHandler, { capture: true });
      if (v.shiftClickHandler) v.holder.removeEventListener('mousedown', v.shiftClickHandler, true);
      if (v.rightDownHandler) v.holder.removeEventListener('mousedown', v.rightDownHandler, true);
      if (v.contextMenuHandler) v.holder.removeEventListener('contextmenu', v.contextMenuHandler);
      if (v.linkDisposable) {
        try { v.linkDisposable.dispose(); } catch (_) {}
      }
      this._detachWebgl(v);
      v.term.dispose();
      v.holder.remove();
      this.views.delete(id);
      this.syncComposerStates({ noFocus: true });
    }
  }
};
