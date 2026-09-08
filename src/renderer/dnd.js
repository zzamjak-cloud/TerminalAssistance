// 포인터 기반 정렬 드래그 유틸.
// Tauri(WKWebView)는 파일 드롭용 네이티브 핸들러가 HTML5 DnD 이벤트를 가로채므로,
// dnd-kit 과 같은 방식으로 mousedown/mousemove/mouseup 을 직접 추적한다.
// 드롭 위치는 파란 점선(.drop-indicator)으로 표시.

// 드래그 중 목록 경계에 다가가면 자동 스크롤 — 컨테이너 자신 또는 스크롤되는 조상을 찾는다
function findScrollHost(el, axis) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const st = getComputedStyle(n);
    const ov = axis === 'x' ? st.overflowX : st.overflowY;
    if (!/(auto|scroll|overlay)/.test(ov)) continue;
    if (axis === 'x' ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

function makeSortable(opts) {
  // opts: { container, itemSelector, axis: 'y'|'x', ignore?, canDrop?(srcEl,dstEl), onDrop(srcId,dstId,before) }
  const c = opts.container;
  const EDGE = 40;      // 경계로부터 이 거리 안에서 자동 스크롤 시작 (px)
  const MAX_STEP = 16;  // 프레임당 최대 스크롤량 (px)
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const src = e.target.closest(opts.itemSelector);
    if (!src || !c.contains(src)) return;
    if (opts.ignore && e.target.closest(opts.ignore)) return; // 버튼 등 컨트롤 위에선 드래그 금지
    e.preventDefault(); // 드래그 중 텍스트 선택(회색 박스) 방지 — click 이벤트에는 영향 없음

    const startX = e.clientX, startY = e.clientY;
    let dragging = false, indicator = null, target = null, before = false;
    let host = null, timer = 0, lastX = e.clientX, lastY = e.clientY;

    // 포인터 위치로 드롭 대상과 인디케이터를 갱신한다 (자동 스크롤 뒤에도 재사용)
    const update = () => {
      target = null;
      for (const el of c.querySelectorAll(opts.itemSelector)) {
        if (el === src) continue;
        const r = el.getBoundingClientRect();
        const inside = opts.axis === 'x'
          ? lastX >= r.left && lastX <= r.right && lastY >= r.top - 10 && lastY <= r.bottom + 10
          : lastY >= r.top && lastY <= r.bottom;
        if (!inside) continue;
        if (opts.canDrop && !opts.canDrop(src, el)) continue;
        target = el;
        before = opts.axis === 'x'
          ? lastX < r.left + r.width / 2
          : lastY < r.top + r.height / 2;
        break;
      }
      if (target) {
        const r = target.getBoundingClientRect();
        indicator.style.display = 'block';
        if (opts.axis === 'x') {
          indicator.style.left = (before ? r.left - 3 : r.right + 1) + 'px';
          indicator.style.top = r.top + 'px';
          indicator.style.height = r.height + 'px';
        } else {
          indicator.style.left = r.left + 'px';
          indicator.style.width = r.width + 'px';
          indicator.style.top = (before ? r.top - 2 : r.bottom) + 'px';
        }
      } else if (indicator) {
        indicator.style.display = 'none';
      }
    };

    // 포인터가 멈춰 있어도 계속 굴러가야 하므로 타이머로 반복한다
    const autoScroll = () => {
      if (!host) return;
      const r = host.getBoundingClientRect();
      const pos = opts.axis === 'x' ? lastX : lastY;
      const min = opts.axis === 'x' ? r.left : r.top;
      const max = opts.axis === 'x' ? r.right : r.bottom;
      let dir = 0;
      if (pos < min + EDGE) dir = -(1 - (pos - min) / EDGE);
      else if (pos > max - EDGE) dir = 1 - (max - pos) / EDGE;
      if (!dir) return;
      dir = Math.max(-1, Math.min(1, dir));
      const key = opts.axis === 'x' ? 'scrollLeft' : 'scrollTop';
      const prev = host[key];
      host[key] = prev + dir * MAX_STEP;
      if (host[key] !== prev) update(); // 스크롤로 항목이 움직였으니 인디케이터를 다시 계산
    };

    const move = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return; // 클릭과 구분
        dragging = true;
        src.classList.add('dragging');
        indicator = document.createElement('div');
        indicator.className = 'drop-indicator' + (opts.axis === 'x' ? ' vert' : '');
        document.body.appendChild(indicator);
        document.body.classList.add('sorting');
        host = findScrollHost(c, opts.axis);
        if (host) timer = setInterval(autoScroll, 16);
      }
      update();
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (timer) { clearInterval(timer); timer = 0; }
      if (dragging) {
        src.classList.remove('dragging');
        if (indicator) indicator.remove();
        document.body.classList.remove('sorting');
        if (target) opts.onDrop(src.dataset.id, target.dataset.id, before);
        // 드래그를 끝낸 mouseup 과 같은 틱에 발생하는 click 만 차단.
        // (이전엔 once 리스너가 무기한 남아, 드롭 없이 끝난 드래그 뒤 첫 정상 클릭을 삼켰음)
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
