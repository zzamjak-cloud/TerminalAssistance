// 파일 편집기 (미리보기의 '편집' 버튼 / 탐색기 컨텍스트 메뉴 '편집하기').
// 확장자에 따라 세 가지 형태로 연다 — quick-folder 의 편집기 구성을 같은 방식으로 옮겼다:
//   · 마크다운: 편집 textarea + 실시간 렌더 미리보기 2단
//   · JSON: 코드 편집기 + 유효성 검사 + 정렬(pretty print)
//   · 그 외 텍스트: 줄번호 거터 + 구문 강조 오버레이 위의 투명 textarea
// 저장은 원자적 교체(ta.writeTextFile), 저장/취소 버튼 + Cmd/Ctrl+S 단축키.

// 편집기를 열 수 있는 형식인가 (미리보기의 '편집' 버튼 노출 조건과 같다)
function isEditableFile(path) {
  const name = normPath(path).split('/').pop().toLowerCase();
  const ext = previewExt(path);
  if (PREVIEW_IMAGE_EXTS.has(ext) || PREVIEW_VIDEO_EXTS.has(ext) || PREVIEW_AUDIO_EXTS.has(ext)) return false;
  return ext in PREVIEW_EXT_LANG || PREVIEW_KNOWN_FILES.has(name);
}

Object.assign(App, {
  // 탐색기/미리보기 공통 진입점. 파일을 읽어 형식에 맞는 편집기를 연다.
  async showFileEditor(path) {
    const name = normPath(path).split('/').pop();
    let file = null;
    try {
      file = await ta.readTextFile(path);
    } catch (e) {
      App.showToast('편집할 수 없는 파일입니다 — ' + String(e));
      return;
    }
    // 잘린 내용으로 저장하면 나머지가 날아간다 — 큰 파일은 편집을 막는다
    if (file.truncated) {
      App.showToast('2MB 가 넘는 파일은 편집할 수 없습니다 — 외부 편집기를 사용하세요');
      return;
    }
    const ext = previewExt(path);
    const kind = (ext === 'md' || ext === 'markdown') ? 'md' : ext === 'json' ? 'json' : 'code';
    App._openEditorModal(path, name, kind, PREVIEW_EXT_LANG[ext] || 'plaintext', file.content);
  },

  _openEditorModal(path, name, kind, lang, initial) {
    App.modal(`
      <h3></h3>
      <div class="modal-sub"></div>
      <div class="editor-body"></div>
      <div class="modal-actions">
        <span class="editor-status"></span>
        <span style="flex:1"></span>
        <button id="m-cancel">취소</button>
        <button id="m-save" class="primary">저장</button>
      </div>`,
      (m, close) => {
        m.querySelector('h3').textContent = name;
        m.querySelector('.modal-sub').textContent = path;
        const body = m.querySelector('.editor-body');
        const status = m.querySelector('.editor-status');
        const saveBtn = m.querySelector('#m-save');
        const cancelBtn = m.querySelector('#m-cancel');

        let dirty = false;
        let saving = false;
        const setStatus = (text, tone) => {
          status.textContent = text;
          status.className = 'editor-status' + (tone ? ' ' + tone : '');
        };
        const markDirty = () => {
          dirty = true;
          setStatus('저장되지 않음', 'unsaved');
          resetCancel();
        };

        // kind 별 편집 표면 — { textarea, onInput, extraActions } 를 돌려준다
        const surface = kind === 'md' ? App._editorMarkdown(body, initial)
          : kind === 'json' ? App._editorJson(body, initial, setStatus)
            : App._editorCode(body, initial, lang);
        const ta_ = surface.textarea;
        ta_.addEventListener('input', () => { surface.onInput(); markDirty(); });

        const save = async () => {
          if (saving) return;
          if (surface.beforeSave && !surface.beforeSave()) return; // JSON 문법 오류 등
          saving = true;
          saveBtn.disabled = true;
          setStatus('저장 중…');
          try {
            await ta.writeTextFile(path, ta_.value);
            dirty = false;
            setStatus('저장됨', 'saved');
            App.refreshExplorer(true); // git 상태 표시 갱신
          } catch (e) {
            setStatus('저장 실패 — ' + String(e), 'unsaved');
          } finally {
            saving = false;
            saveBtn.disabled = false;
          }
        };

        // 변경이 있으면 취소는 2단계 확인 (앱 전반의 무장 방식과 같은 감각)
        let armed = false, armTimer = null;
        const resetCancel = () => {
          clearTimeout(armTimer);
          armed = false;
          cancelBtn.textContent = '취소';
          cancelBtn.classList.remove('confirm');
        };
        cancelBtn.onclick = () => {
          if (!dirty) { close(); return; }
          if (armed) { resetCancel(); close(); return; }
          armed = true;
          cancelBtn.textContent = '변경 폐기 확인';
          cancelBtn.classList.add('confirm');
          armTimer = setTimeout(resetCancel, CONFIRM_ARM_MS);
        };
        saveBtn.onclick = save;

        // Cmd/Ctrl+S 저장, Esc 는 취소 버튼과 같은 절차(변경이 있으면 2단계 확인).
        // Esc 를 여기서 멈추지 않으면 모달 공통 핸들러가 그대로 닫아 작성 내용이 날아간다.
        m.addEventListener('keydown', (e) => {
          const mod = App.state.platform === 'macos' ? e.metaKey : e.ctrlKey;
          if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
          if (e.key === 'Escape' && dirty) { e.stopPropagation(); cancelBtn.click(); }
        });

        setStatus('');
        ta_.focus();
      }, { full: true });
  },

  // ── 코드 편집기: 줄번호 거터 + 강조 오버레이 + 투명 textarea (스크롤 동기화) ──
  _editorCode(body, initial, lang) {
    body.className = 'editor-body editor-code';
    const gutter = document.createElement('div');
    gutter.className = 'editor-gutter';
    const wrap = document.createElement('div');
    wrap.className = 'editor-surface';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'hljs';
    pre.appendChild(code);
    const area = document.createElement('textarea');
    area.className = 'editor-textarea';
    area.spellcheck = false;
    area.value = initial;
    wrap.appendChild(pre);
    wrap.appendChild(area);
    body.appendChild(gutter);
    body.appendChild(wrap);

    const paint = () => {
      const text = area.value;
      let html = null;
      if (lang !== 'plaintext' && window.hljs && hljs.getLanguage(lang)) {
        try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
        catch (_) { html = null; }
      }
      // 마지막 줄이 개행으로 끝나면 오버레이 높이가 한 줄 모자라 캐럿이 어긋난다
      if (html !== null) code.innerHTML = html + '\n';
      else code.textContent = text + '\n';
      const lines = text.split('\n').length;
      gutter.textContent = '';
      for (let i = 1; i <= lines; i++) {
        const d = document.createElement('div');
        d.textContent = String(i);
        gutter.appendChild(d);
      }
    };
    area.addEventListener('scroll', () => {
      pre.scrollTop = area.scrollTop;
      pre.scrollLeft = area.scrollLeft;
      gutter.scrollTop = area.scrollTop;
    });
    // Tab 은 포커스 이동 대신 두 칸 들여쓰기 (코드 편집기의 기본 감각)
    area.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = area.selectionStart, t = area.selectionEnd;
      area.value = area.value.slice(0, s) + '  ' + area.value.slice(t);
      area.selectionStart = area.selectionEnd = s + 2;
      area.dispatchEvent(new Event('input'));
    });
    paint();
    return { textarea: area, onInput: paint };
  },

  // ── JSON 편집기: 코드 편집기 + 실시간 문법 검사 + 정렬 버튼 ──
  _editorJson(body, initial, setStatus) {
    let text = initial;
    try { text = JSON.stringify(JSON.parse(initial), null, 2); } catch (_) { /* 깨진 JSON 은 원문 그대로 */ }
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    const fmt = document.createElement('button');
    fmt.textContent = '정렬';
    fmt.title = 'JSON 을 2칸 들여쓰기로 다시 정렬';
    bar.appendChild(fmt);
    body.appendChild(bar);

    const host = document.createElement('div');
    body.appendChild(host);
    const inner = App._editorCode(host, text, 'json');
    host.className = 'editor-body editor-code editor-code-inner';
    body.className = 'editor-body editor-json';

    const area = inner.textarea;
    const check = () => {
      try { JSON.parse(area.value); return null; }
      catch (e) { return String(e.message || e); }
    };
    const onInput = () => {
      inner.onInput();
      const err = check();
      if (err) setStatus('JSON 오류: ' + err, 'unsaved');
    };
    fmt.onclick = () => {
      const err = check();
      if (err) { setStatus('JSON 오류: ' + err, 'unsaved'); return; }
      area.value = JSON.stringify(JSON.parse(area.value), null, 2);
      area.dispatchEvent(new Event('input'));
    };
    return {
      textarea: area,
      onInput,
      // 문법이 깨진 JSON 은 저장을 막는다 (설정 파일이 망가지는 사고 방지)
      beforeSave() {
        const err = check();
        if (err) { setStatus('JSON 오류로 저장할 수 없습니다: ' + err, 'unsaved'); return false; }
        return true;
      }
    };
  },

  // ── 마크다운 편집기: 좌측 실시간 렌더 + 우측 원문 textarea (오른쪽에서 쓰는 편이 읽기 편하다) ──
  _editorMarkdown(body, initial) {
    body.className = 'editor-body editor-md';
    const area = document.createElement('textarea');
    area.className = 'editor-textarea editor-md-input';
    area.spellcheck = false;
    area.value = initial;
    const view = document.createElement('div');
    view.className = 'preview-text md-view editor-md-view';
    body.appendChild(view);
    body.appendChild(area);

    const paint = () => {
      try { view.innerHTML = marked.parse(area.value, { async: false }); }
      catch (_) { view.textContent = area.value; }
    };
    paint();
    return { textarea: area, onInput: paint };
  }
});
