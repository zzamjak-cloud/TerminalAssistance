// 파일 미리보기 팝업 (탐색기 더블클릭/스페이스): 이미지·비디오·오디오·JSON·마크다운·코드.
// 코드 컬러는 highlight.js(vendor), 마크다운 렌더링은 marked(vendor) — quick-folder 방식.
const PREVIEW_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
const PREVIEW_VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const PREVIEW_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);

// 확장자 → highlight.js 언어 id (vendor 번들에 없는 언어는 렌더 시 plaintext 로 폴백)
const PREVIEW_EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', rb: 'ruby', php: 'php', lua: 'lua',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'shell', ps1: 'shell',
  sql: 'sql', r: 'r', pl: 'perl', diff: 'diff', patch: 'diff',
  makefile: 'makefile', dockerfile: 'plaintext',
  md: 'markdown', markdown: 'markdown',
  txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
  gitignore: 'plaintext', env: 'plaintext'
};
// 확장자 없는 관례 파일명 (텍스트로 취급)
const PREVIEW_KNOWN_FILES = new Set([
  'license', 'readme', 'makefile', 'dockerfile', 'gemfile', 'changelog',
  '.gitignore', '.gitattributes', '.env', '.editorconfig', '.prettierrc', '.npmrc'
]);

function previewExt(path) {
  const name = normPath(path).split('/').pop().toLowerCase();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1) : name; // ".gitignore" 처럼 점으로 시작하면 전체가 이름
}

Object.assign(App, {
  // 터미널 파일 링크 클릭 진입점: :줄번호 꼬리 제거 → 세션 cwd 기준 절대경로 해석 → 미리보기.
  // 상대 경로는 백엔드에서 실제 파일로 해석한다 — 단독 파일명(terminal-view.js 등)은
  // cwd 직속에 없으면 프로젝트를 검색해 찾는다.
  async openFileLinkPreview(sessionId, linkText) {
    const raw = String(linkText || '').trim().replace(/(?::\d+)+$/, '');
    if (!raw) return;
    const session = App.state.sessions.find((x) => x.id === sessionId);
    const base = (session && session.cwd) || App.claudeCwd();
    const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/');
    if (isAbs) return App.showFilePreview(raw);
    if (!base) return;
    const rel = raw.replace(/^\.[\\/]/, '');
    let resolved = null;
    try { resolved = await ta.resolveProjectFile(base, rel); } catch (_) {}
    return App.showFilePreview(resolved || `${String(base).replace(/[\\/]+$/, '')}/${rel}`);
  },

  // 파일 형식에 따라 알맞은 미리보기 팝업을 연다 (탐색기 진입점)
  async showFilePreview(path) {
    const name = normPath(path).split('/').pop();
    const ext = previewExt(path);
    if (PREVIEW_IMAGE_EXTS.has(ext)) return App._previewMedia(path, name, 'img');
    if (PREVIEW_VIDEO_EXTS.has(ext)) return App._previewMedia(path, name, 'video');
    if (PREVIEW_AUDIO_EXTS.has(ext)) return App._previewMedia(path, name, 'audio');

    const isText = ext in PREVIEW_EXT_LANG || PREVIEW_KNOWN_FILES.has(name.toLowerCase());
    let file = null;
    try {
      file = await ta.readTextFile(path);
    } catch (e) {
      // 알려진 텍스트 형식인데 못 읽었다면 형식 문제가 아니라 파일 문제(없음/권한)다
      return App._previewUnsupported(path, name, String(e), isText);
    }
    if (!isText && file.content.length === 0) return App._previewUnsupported(path, name, '내용이 비어 있습니다');

    if (ext === 'md' || ext === 'markdown') return App._previewMarkdown(path, name, file);
    if (ext === 'json') return App._previewJson(path, name, file);
    return App._previewCode(path, name, ext, file);
  },

  // 미리보기 공통 골격: 제목(파일명) + 경로 부제 + 본문 + [외부로 열기 | 편집 | 닫기]
  // opts.edit = 편집 버튼 표시 (텍스트 형식이고 잘리지 않은 파일만 — 잘린 내용을 저장하면 나머지가 날아간다)
  _previewShell(path, name, bodyClass, fill, opts) {
    App.modal(`
      <h3></h3>
      <div class="modal-sub"></div>
      <div class="${bodyClass}"></div>
      <div class="modal-actions">
        <button id="m-open-ext">외부 프로그램으로 열기</button>
        <span style="flex:1"></span>
        ${opts && opts.edit ? '<button id="m-edit" class="primary">편집</button>' : ''}
        <button id="m-close">닫기</button>
      </div>`,
      (m, close) => {
        App._modalIsPreview = true; // 스페이스 토글(다시 누르면 닫기)의 판별 플래그
        m.querySelector('h3').textContent = name;
        m.querySelector('.modal-sub').textContent = path;
        m.querySelector('#m-open-ext').onclick = () => ta.openPath(path);
        m.querySelector('#m-close').onclick = close;
        const edit = m.querySelector('#m-edit');
        if (edit) edit.onclick = () => App.showFileEditor(path); // 같은 자리에 편집기 모달로 교체
        fill(m.querySelector('.' + bodyClass.split(' ')[0]));
      }, { xl: true });
  },

  // 이미지·비디오·오디오 — asset protocol(convertFileSrc)로 직접 표시
  _previewMedia(path, name, kind) {
    App._previewShell(path, name, 'preview-media', (body) => {
      const el = document.createElement(kind);
      el.src = ta.fileSrc(path);
      if (kind !== 'img') el.controls = true;
      if (kind === 'img') {
        el.alt = name;
        el.onerror = () => { body.textContent = '이미지를 표시할 수 없습니다.'; };
      }
      body.appendChild(el);
    });
  },

  _truncNotice(body, file) {
    if (!file.truncated) return;
    const n = document.createElement('div');
    n.className = 'preview-trunc';
    n.textContent = `파일이 커서 앞부분 2MB 만 표시합니다 (전체 ${(file.size / 1048576).toFixed(1)}MB)`;
    body.prepend(n);
  },

  _previewMarkdown(path, name, file) {
    App._previewShell(path, name, 'preview-text md-view', (body) => {
      try {
        body.innerHTML = marked.parse(file.content, { async: false });
      } catch (_) {
        body.textContent = file.content; // 렌더 실패 시 원문 표시
      }
      // 마크다운 안의 코드 블록에도 하이라이팅 적용.
      // highlightElement(DOM 자동감지 의존) 대신 문자열 API 를 직접 쓴다 —
      // 언어 미지정 펜스도 highlightAuto 로 확실히 컬러가 입혀진다
      body.querySelectorAll('pre code').forEach((c) => {
        const cls = [...c.classList].find((x) => x.startsWith('language-'));
        const lang = cls ? cls.slice('language-'.length) : '';
        try {
          const r = lang && hljs.getLanguage(lang)
            ? hljs.highlight(c.textContent, { language: lang, ignoreIllegals: true })
            : hljs.highlightAuto(c.textContent);
          c.innerHTML = r.value;
        } catch (_) { /* 실패 시 이스케이프된 원문 유지 */ }
        c.classList.add('hljs');
      });
      App._truncNotice(body, file);
    }, { edit: !file.truncated });
  },

  _previewJson(path, name, file) {
    // JSON 은 정렬(pretty print) 후 하이라이팅 — 파싱 실패하면 원문 그대로
    let text = file.content;
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
    App._previewCodeBody(path, name, 'json', { ...file, content: text });
  },

  _previewCode(path, name, ext, file) {
    App._previewCodeBody(path, name, PREVIEW_EXT_LANG[ext] || 'plaintext', file);
  },

  _previewCodeBody(path, name, lang, file) {
    App._previewShell(path, name, 'preview-text', (body) => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'hljs';
      let html = null;
      if (lang !== 'plaintext' && window.hljs && hljs.getLanguage(lang)) {
        try { html = hljs.highlight(file.content, { language: lang, ignoreIllegals: true }).value; }
        catch (_) { html = null; }
      }
      if (html !== null) code.innerHTML = html;
      else code.textContent = file.content;
      pre.appendChild(code);
      body.appendChild(pre);
      App._truncNotice(body, file);
    }, { edit: !file.truncated && isEditableFile(path) });
  },

  _previewUnsupported(path, name, reason, readFailed) {
    App._previewShell(path, name, 'preview-media', (body) => {
      const d = document.createElement('div');
      d.className = 'tree-empty';
      d.style.padding = '30px 10px';
      d.textContent = (readFailed ? '파일을 열 수 없습니다. (' : '미리보기를 지원하지 않는 형식입니다. (') + reason + ')';
      body.appendChild(d);
    });
  }
});
