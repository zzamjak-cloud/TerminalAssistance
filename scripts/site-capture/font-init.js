// 한글 고정폭 글꼴 주입 — 부팅(get_state) 전에 글리프를 준비해 xterm 이 폴백 글리프를 캐시하지 않게 한다
(function () {
  const D = window.__DEMO__;
  let p = null;
  window.__ensureFonts = () => {
    if (p || !D || !D.fontCss) return p || Promise.resolve();
    const st = document.createElement('style');
    st.textContent = D.fontCss;
    (document.head || document.documentElement).appendChild(st);
    const load = Promise.all([
      document.fonts.load('13px D2Coding', D.hangul), document.fonts.load('bold 13px D2Coding', D.hangul),
      document.fonts.load('13px Menlo', D.hangul), document.fonts.load('bold 13px Menlo', D.hangul)
    ]).catch(() => {});
    p = Promise.race([load, new Promise((r) => setTimeout(r, 6000))]);
    return p;
  };
})();
