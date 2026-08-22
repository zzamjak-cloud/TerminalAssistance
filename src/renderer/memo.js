// 프로젝트 내부 Markdown 메모의 입력·정제·변환과 구버전 drafts 메모 이전을 담당한다.
Object.assign(App, {
  _memoMigrations: new Map(),

  sanitizeMemoStyle(styleText) {
    const allowed = new Set([
      'color', 'background-color', 'font-weight', 'font-style',
      'text-decoration', 'white-space', 'opacity'
    ]);
    const safe = [];
    for (const declaration of String(styleText || '').split(';')) {
      const split = declaration.indexOf(':');
      if (split < 1) continue;
      const name = declaration.slice(0, split).trim().toLowerCase();
      const value = declaration.slice(split + 1).trim();
      if (!allowed.has(name) || !value || /url\s*\(|expression\s*\(|javascript:|var\s*\(|[{}<>]/i.test(value)) continue;
      let valid = false;
      if (name === 'color' || name === 'background-color') {
        valid = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^;]*\)|[a-z]+)$/i.test(value);
      } else if (name === 'font-weight') {
        valid = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(value);
      } else if (name === 'font-style') {
        valid = /^(?:normal|italic|oblique)$/i.test(value);
      } else if (name === 'text-decoration') {
        valid = value.split(/\s+/).every((v) =>
          ['none', 'underline', 'line-through', 'overline', 'solid', 'double', 'dotted', 'dashed', 'wavy'].includes(v.toLowerCase()));
      } else if (name === 'white-space') {
        valid = /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/i.test(value);
      } else if (name === 'opacity') {
        valid = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value);
      }
      if (valid) safe.push(`${name}: ${value}`);
    }
    return safe.join('; ');
  },

  sanitizeMemoNode(node) {
    const allowedTags = new Set([
      'DIV', 'P', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
      'PRE', 'CODE', 'BLOCKQUOTE', 'UL', 'OL', 'LI'
    ]);
    const blockedTags = new Set([
      'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'LINK', 'META',
      'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'TEMPLATE'
    ]);

    if (node.nodeType === 3) return; // 텍스트
    if (node.nodeType !== 1) {
      node.remove();
      return;
    }
    const tag = node.tagName.toUpperCase();
    if (blockedTags.has(tag)) {
      node.remove();
      return;
    }
    [...node.childNodes].forEach((child) => App.sanitizeMemoNode(child));
    if (!allowedTags.has(tag)) {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      node.remove();
      return;
    }
    const safeStyle = App.sanitizeMemoStyle(node.getAttribute('style'));
    [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));
    if (safeStyle) node.setAttribute('style', safeStyle);
  },

  sanitizeMemoHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    [...template.content.childNodes].forEach((node) => App.sanitizeMemoNode(node));
    return template.innerHTML;
  },

  escapeMemoMarkdownText(text) {
    // Markdown 안에서 임의 HTML로 해석되지 않도록 먼저 HTML 문자를 이스케이프한다.
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, '\\$1');
  },

  memoInlineCode(node) {
    const value = String(node.textContent || '').replace(/\r\n?/g, '\n');
    const runs = value.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
    const pad = /^(?:`|\s)|(?:`|\s)$/.test(value) ? ' ' : '';
    // 코드 스팬 안에서는 HTML/Markdown 구문이 해석되지 않으므로 원문을 보존한다.
    return `${fence}${pad}${value}${pad}${fence}`;
  },

  memoStyleNeedsHtml(node) {
    const style = String(node.getAttribute && node.getAttribute('style') || '').toLowerCase();
    if (!style) return node.tagName === 'U';
    return /(?:^|;)\s*(?:color|background-color|opacity|white-space)\s*:/.test(style)
      || /(?:^|;)\s*text-decoration\s*:[^;]*(?:underline|overline|double|dotted|dashed|wavy)/.test(style);
  },

  memoListToMarkdown(list, depth) {
    const ordered = list.tagName === 'OL';
    const indent = '  '.repeat(depth || 0);
    const items = [...list.childNodes].filter((node) => node.nodeType === 1 && node.tagName === 'LI');
    return items.map((item, index) => {
      const nested = [];
      let body = '';
      for (const child of [...item.childNodes]) {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) nested.push(child);
        else body += App.memoNodeToMarkdown(child);
      }
      body = body.replace(/^\n+|\n+$/g, '');
      const marker = ordered ? `${index + 1}. ` : '- ';
      const continuation = `${indent}${' '.repeat(marker.length)}`;
      const lines = (body || '').split('\n');
      let result = `${indent}${marker}${lines[0] || ''}`;
      for (const line of lines.slice(1)) result += `\n${continuation}${line}`;
      for (const childList of nested) result += `\n${App.memoListToMarkdown(childList, (depth || 0) + 1)}`;
      return result;
    }).join('\n');
  },

  memoNodeToMarkdown(node) {
    if (node.nodeType === 3) return App.escapeMemoMarkdownText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const children = () => [...node.childNodes].map((child) => App.memoNodeToMarkdown(child)).join('');
    const tag = node.tagName;
    if (tag === 'BR') return '  \n';
    if (tag === 'PRE') return `${node.outerHTML}\n\n`;
    if (tag === 'CODE') return App.memoInlineCode(node);
    if (tag === 'B' || tag === 'STRONG') return `**${children()}**`;
    if (tag === 'I' || tag === 'EM') return `*${children()}*`;
    if (tag === 'S' || tag === 'STRIKE') return `~~${children()}~~`;
    if (tag === 'U' || (tag === 'SPAN' && App.memoStyleNeedsHtml(node))) return node.outerHTML;
    if (tag === 'SPAN') {
      const style = String(node.getAttribute('style') || '').toLowerCase();
      let value = children();
      if (/font-weight\s*:\s*(?:bold|[6-9]00)/.test(style)) value = `**${value}**`;
      if (/font-style\s*:\s*(?:italic|oblique)/.test(style)) value = `*${value}*`;
      if (/text-decoration\s*:[^;]*line-through/.test(style)) value = `~~${value}~~`;
      return value;
    }
    if (tag === 'UL' || tag === 'OL') return `${App.memoListToMarkdown(node, 0)}\n\n`;
    if (tag === 'LI') return children();
    if (tag === 'BLOCKQUOTE') {
      const value = children().replace(/^\n+|\n+$/g, '');
      return `${value.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')}\n\n`;
    }
    if (tag === 'P' || tag === 'DIV') return `${children()}\n\n`;
    return children();
  },

  memoHtmlToMarkdown(html) {
    const safeHtml = App.sanitizeMemoHtml(html);
    const template = document.createElement('template');
    template.innerHTML = safeHtml;
    const markdown = [...template.content.childNodes]
      .map((node) => App.memoNodeToMarkdown(node))
      .join('')
      .replace(/^\n+|[ \t]+$/g, '')
      .replace(/\n*$/, '\n');
    return markdown === '\n' ? '' : markdown;
  },

  memoPlainText(html) {
    const template = document.createElement('template');
    template.innerHTML = App.sanitizeMemoHtml(html);
    const read = (node) => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return '\n';
      const value = [...node.childNodes].map(read).join('');
      return ['DIV', 'P', 'PRE', 'BLOCKQUOTE', 'LI'].includes(node.tagName) ? `${value}\n` : value;
    };
    return [...template.content.childNodes].map(read).join('').replace(/\r\n?/g, '\n');
  },

  memoHasContent(editorOrHtml) {
    const html = typeof editorOrHtml === 'string' ? editorOrHtml : editorOrHtml.innerHTML;
    return App.memoPlainText(html).trim().length > 0;
  },

  insertMemoFragment(editor, fragment) {
    if (!fragment || !fragment.childNodes.length) return;
    const selection = window.getSelection && window.getSelection();
    let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last && selection) {
      range.setStartAfter(last);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  },

  insertMemoPlainText(editor, text) {
    const fragment = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, index) => {
      if (index) fragment.appendChild(document.createElement('br'));
      fragment.appendChild(document.createTextNode(line));
    });
    App.insertMemoFragment(editor, fragment);
  },

  insertMemoHtml(editor, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    App.insertMemoFragment(editor, template.content);
  },

  handleMemoPaste(ev, editor) {
    const data = ev.clipboardData;
    if (!data) return;
    const html = data.getData('text/html');
    const plain = data.getData('text/plain');
    if (!html && !plain) return;
    ev.preventDefault();
    const safeHtml = html ? App.sanitizeMemoHtml(html) : '';
    if (safeHtml) App.insertMemoHtml(editor, safeHtml);
    else App.insertMemoPlainText(editor, plain);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  },

  showMemoModal() {
    const session = App.state.sessions.find((item) => item.id === App.state.activeId);
    const cwd = session && session.projectId ? session.cwd : null;
    if (!cwd) {
      alert('메모를 저장할 프로젝트 세션을 먼저 열어 주세요.');
      return;
    }
    App.modal(`
      <h3>메모 추가</h3>
      <label for="memo-title">제목</label>
      <input id="memo-title" type="text" maxlength="80" autocomplete="off" placeholder="메모 제목">
      <label id="memo-body-label">본문</label>
      <div id="memo-body" class="memo-modal-editor" contenteditable="true" role="textbox"
        aria-labelledby="memo-body-label" aria-multiline="true" data-placeholder="메모 내용을 입력하세요"></div>
      <div id="memo-error" class="form-error" role="alert" aria-live="polite"></div>
      <div class="modal-actions">
        <button id="m-cancel">취소</button><button id="m-save" disabled>저장</button>
      </div>`,
    (m, close) => {
      const title = m.querySelector('#memo-title');
      const editor = m.querySelector('#memo-body');
      const error = m.querySelector('#memo-error');
      const cancel = m.querySelector('#m-cancel');
      const save = m.querySelector('#m-save');
      let busy = false;
      const validate = () => {
        const valid = title.value.trim() && App.memoHasContent(editor);
        if (!busy) save.disabled = !valid;
        return !!valid;
      };
      title.oninput = validate;
      title.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          editor.focus();
        }
      };
      editor.oninput = validate;
      editor.onpaste = (event) => App.handleMemoPaste(event, editor);
      editor.onkeydown = (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && validate()) {
          event.preventDefault();
          save.click();
        }
      };
      cancel.onclick = close;
      save.onclick = async () => {
        if (busy || !validate()) {
          error.textContent = '제목과 본문을 모두 입력해 주세요.';
          return;
        }
        const safeHtml = App.sanitizeMemoHtml(editor.innerHTML);
        const markdown = App.memoHtmlToMarkdown(safeHtml);
        if (!markdown.trim()) {
          error.textContent = '본문을 입력해 주세요.';
          return;
        }
        busy = true;
        save.disabled = true;
        cancel.disabled = true;
        save.textContent = '저장 중…';
        error.textContent = '';
        try {
          const saved = await ta.createMemoDoc(cwd, title.value.trim(), markdown, null);
          const existing = App._planCache[cwd] ? App._planCache[cwd].items : [];
          App._planCache[cwd] = {
            at: Date.now(),
            items: [saved, ...existing.filter((item) => item.id !== saved.id)]
          };
          close();
          App.revealPlanPanel();
          void App.renderPlanList(true);
        } catch (e) {
          busy = false;
          cancel.disabled = false;
          save.textContent = '저장';
          validate();
          error.textContent = '메모 저장 실패: ' + e;
        }
      };
      title.focus();
    }, { wide: true });
  },

  legacyMemoId(projectId, memo, index) {
    const source = `${projectId}\u0000${memo.id || index}\u0000${memo.text || ''}`;
    let first = 2166136261;
    let second = 2246822519;
    for (let i = 0; i < source.length; i += 1) {
      first = Math.imul(first ^ source.charCodeAt(i), 16777619) >>> 0;
      second = Math.imul(second ^ source.charCodeAt(source.length - 1 - i), 3266489917) >>> 0;
    }
    return `legacy-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
  },

  migrateLegacyMemos() {
    const session = App.state.sessions.find((item) => item.id === App.state.activeId);
    if (!session || !session.projectId || !session.cwd) return Promise.resolve();
    const key = `memo:${session.projectId}`;
    const list = App.state.drafts[key];
    // 프로젝트 없는 홈 키(memo:)는 사용자의 원본을 그대로 보존한다.
    if (!Array.isArray(list) || !list.length) return Promise.resolve();
    if (App._memoMigrations.has(key)) return App._memoMigrations.get(key);
    const snapshot = list.map((memo) => ({ id: memo.id, text: memo.text }));
    const task = (async () => {
      const saved = [];
      for (let index = 0; index < snapshot.length; index += 1) {
        const memo = snapshot[index];
        const safeHtml = App.sanitizeMemoHtml(memo.text);
        const markdown = App.memoHtmlToMarkdown(safeHtml);
        if (!markdown.trim()) throw new Error('비어 있는 기존 메모는 자동 이전할 수 없습니다.');
        const title = App.memoPlainText(safeHtml)
          .split('\n').map((line) => line.trim()).find(Boolean) || '메모';
        saved.push(await ta.createMemoDoc(
          session.cwd,
          [...title].slice(0, 80).join(''),
          markdown,
          App.legacyMemoId(session.projectId, memo, index)
        ));
      }
      // 모든 파일 생성과 drafts 비우기 저장이 성공한 뒤에만 메모 원본을 메모리에서 제거한다.
      await App.persistDraftList(key, []);
      App.state.drafts[key] = [];
      const existing = App._planCache[session.cwd] ? App._planCache[session.cwd].items : [];
      const ids = new Set(saved.map((item) => item.id));
      App._planCache[session.cwd] = {
        at: Date.now(),
        items: [...saved, ...existing.filter((item) => !ids.has(item.id))]
      };
      void App.renderPlanList(true);
    })().catch((error) => {
      console.warn('기존 메모 Markdown 이전 실패 (원본 보존):', error);
    }).finally(() => App._memoMigrations.delete(key));
    App._memoMigrations.set(key, task);
    return task;
  }
});
