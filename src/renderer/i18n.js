// UI 다국어 — 한국어 원문을 키로 쓰는 gettext 방식.
// tr('프리셋 관리') → 현재 언어 사전에 있으면 번역, 없으면 원문(한국어) 그대로.
// 변수는 {이름} 자리표시자: tr('세션 {n}개', { n: 3 }).
// 사전은 i18n/en-*.js 가 I18N_DICT.en 에 영역별로 병합한다 (파일을 나눠 충돌 없이 추가).
// 언어는 localStorage('ta-lang') 에 저장하고, 바꾸면 웹뷰를 다시 불러 적용한다
// (리로드해도 백엔드 세션은 살아 있어 터미널이 그대로 이어진다).
// 모바일 웹앱(src/mobile)도 이 파일을 함께 쓴다 — 저장값이 없으면 브라우저 언어를 따른다.
(function (root) {
  const SUPPORTED = ['ko', 'en'];
  const dict = root.I18N_DICT || (root.I18N_DICT = { en: {} });

  function detect() {
    let saved = null;
    try { saved = root.localStorage && root.localStorage.getItem('ta-lang'); } catch (_) { /* 저장소 없음 */ }
    if (SUPPORTED.includes(saved)) return saved;
    // 데스크톱 앱(Tauri)은 설정에서 고르기 전까지 한국어 — 업데이트만으로 화면 언어가 바뀌지 않게.
    // 모바일 웹앱(폰 브라우저)은 브라우저 언어를 따른다.
    if (root.__TAURI__) return 'ko';
    const nav = (root.navigator && root.navigator.language) || 'ko';
    return /^ko\b/i.test(nav) ? 'ko' : 'en';
  }

  const lang = detect();

  function fill(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  }

  // ctx: 같은 한국어가 자리마다 다른 영어여야 할 때의 구분자 — 사전 키 '원문#ctx' 를 먼저 찾는다
  function tr(ko, vars, ctx) {
    const table = lang === 'ko' ? null : dict[lang];
    const own = (k) => table && Object.prototype.hasOwnProperty.call(table, k);
    const hit = ctx && own(ko + '#' + ctx) ? table[ko + '#' + ctx] : own(ko) ? table[ko] : ko;
    return fill(hit, vars);
  }

  // 정적 마크업(index.html) 번역 — 텍스트 노드와 title·placeholder·aria-label 속성 중
  // 사전에 정확히(앞뒤 공백 제외) 있는 것만 바꾼다. 한국어면 아무것도 하지 않는다.
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function apply(el) {
    if (lang === 'ko' || !el) return;
    const table = dict[lang] || {};
    const has = (s) => Object.prototype.hasOwnProperty.call(table, s);
    const walker = root.document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue;
      const key = raw.trim();
      if (key && has(key)) n.nodeValue = raw.replace(key, () => table[key]);
    }
    for (const node of el.querySelectorAll('*')) {
      for (const a of ATTRS) {
        const v = node.getAttribute(a);
        if (v && has(v.trim())) node.setAttribute(a, table[v.trim()]);
      }
    }
  }

  function setLang(next) {
    if (!SUPPORTED.includes(next) || next === lang) return false;
    try { root.localStorage.setItem('ta-lang', next); } catch (_) { return false; }
    return true;
  }

  root.tr = tr;
  root.I18N = { lang, supported: SUPPORTED, apply, setLang, tr };
  if (root.document && root.document.documentElement) root.document.documentElement.lang = lang;
})(typeof window !== 'undefined' ? window : globalThis);
