// 포인터 기반 정렬 드래그 유틸.
// Tauri(WKWebView)는 파일 드롭용 네이티브 핸들러가 HTML5 DnD 이벤트를 가로채므로,
// dnd-kit 과 같은 방식으로 mousedown/mousemove/mouseup 을 직접 추적한다.
// 드롭 위치는 파란 점선(.drop-indicator)으로 표시.
function makeSortable(opts) {
  // opts: { container, itemSelector, axis: 'y'|'x', ignore?, canDrop?(srcEl,dstEl), onDrop(srcId,dstId,before) }
  const c = opts.container;
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const src = e.target.closest(opts.itemSelector);
    if (!src || !c.contains(src)) return;
    if (opts.ignore && e.target.closest(opts.ignore)) return; // 버튼 등 컨트롤 위에선 드래그 금지

    const startX = e.clientX, startY = e.clientY;
    let dragging = false, indicator = null, target = null, before = false;

    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return; // 클릭과 구분
        dragging = true;
        src.classList.add('dragging');
        indicator = document.createElement('div');
        indicator.className = 'drop-indicator' + (opts.axis === 'x' ? ' vert' : '');
        document.body.appendChild(indicator);
        document.body.classList.add('sorting');
      }
      target = null;
      for (const el of c.querySelectorAll(opts.itemSelector)) {
        if (el === src) continue;
        const r = el.getBoundingClientRect();
        const inside = opts.axis === 'x'
          ? ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 10 && ev.clientY <= r.bottom + 10
          : ev.clientY >= r.top && ev.clientY <= r.bottom;
        if (!inside) continue;
        if (opts.canDrop && !opts.canDrop(src, el)) continue;
        target = el;
        before = opts.axis === 'x'
          ? ev.clientX < r.left + r.width / 2
          : ev.clientY < r.top + r.height / 2;
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

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) {
        src.classList.remove('dragging');
        if (indicator) indicator.remove();
        document.body.classList.remove('sorting');
        if (target) opts.onDrop(src.dataset.id, target.dataset.id, before);
        // 드래그를 끝낸 mouseup 직후의 click 은 실행으로 이어지지 않게 차단
        window.addEventListener('click', (ce) => { ce.stopPropagation(); ce.preventDefault(); }, { capture: true, once: true });
      }
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
