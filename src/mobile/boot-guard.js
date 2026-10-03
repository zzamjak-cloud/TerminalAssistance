// 부팅 안전망 — 다른 스크립트보다 먼저 로드된다. 홈 화면 앱은 주소창·새로고침 버튼이 없어
// 스크립트 오류나 로드 실패로 화면이 비면 사용자가 빠져나올 방법이 없기 때문.
// CSP(script-src 'self') 때문에 인라인이 아닌 별도 파일로 둔다.
(function () {
  'use strict';
  const BOOT_TIMEOUT_MS = 15000;
  let booted = false;
  let shown = false;
  let timedOut = false;

  function render(message) {
    if (booted || shown) return;
    shown = true;
    const draw = () => {
      const box = document.createElement('div');
      box.id = 'boot-error';
      box.setAttribute('role', 'alert');
      // mobile.css 로드 실패도 대비해 인라인 스타일로 그린다 (CSP 가 style 인라인은 허용)
      box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;'
        + 'justify-content:center;align-items:center;gap:14px;padding:24px;text-align:center;'
        + 'background:#14161c;color:#d5d9e4;font:15px -apple-system,system-ui,sans-serif;';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:18px;font-weight:600;';
      title.textContent = '앱을 시작하지 못했습니다';
      const detail = document.createElement('div');
      detail.style.cssText = 'color:#8b91a3;font-size:13px;max-width:320px;word-break:break-word;';
      detail.textContent = message;
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#8b91a3;font-size:13px;max-width:320px;';
      hint.textContent = '데스크톱 앱이 켜져 있고 이 폰의 Tailscale 이 연결돼 있는지 확인하세요.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '새로고침';
      btn.style.cssText = 'font-size:16px;padding:12px 28px;border-radius:10px;border:1px solid #2e6cd6;'
        + 'background:#1c3a63;color:#eaf1fb;font-weight:600;';
      btn.onclick = () => location.reload();
      box.append(title, detail, hint, btn);
      document.body.appendChild(box);
    };
    if (document.body) draw();
    else document.addEventListener('DOMContentLoaded', draw);
  }

  // 캡처 단계로 등록해야 <script> 로드 실패(리소스 오류)도 잡힌다
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName === 'SCRIPT') {
      render('스크립트를 불러오지 못했습니다: ' + (t.getAttribute('src') || ''));
      return;
    }
    if (t && t !== window) return; // 이미지 등 다른 리소스 실패는 무시
    render(String(e.message || '알 수 없는 오류'));
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    render(String((r && r.message) || r || '알 수 없는 오류'));
  });

  // Android 크롬 설치 프롬프트 — 앱 스크립트보다 먼저 올 수 있어 여기서 잡아 두고,
  // 기본 미니 인포바 대신 페어링 직후 안내 시트의 '앱 설치' 버튼에서 띄운다
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__taInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => { window.__taInstallPrompt = null; });

  // 부팅이 끝나지 않고 멈춘 경우(서버 응답 없음 등)도 빠져나갈 길을 준다
  const timer = setTimeout(() => { timedOut = !shown; render('서버 응답이 없습니다.'); }, BOOT_TIMEOUT_MS);

  // mobile.js 가 첫 화면을 띄운 뒤 부른다 — 이후 오류는 앱이 직접 처리한다
  window.__taBootDone = function () {
    booted = true;
    clearTimeout(timer);
    // 응답이 늦었을 뿐 부팅에 성공했으면 안내를 거둔다 (오류로 띄운 안내는 유지)
    const box = document.getElementById('boot-error');
    if (timedOut && box) { box.remove(); shown = false; }
  };
})();
