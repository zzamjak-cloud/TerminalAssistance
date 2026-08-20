// 명령 프리셋 바: 전역(파랑, 맨앞 고정) + 현재 프로젝트 프리셋을 칩으로 표시.
// 클릭 = 즉시 실행, Shift+클릭 = 입력만(실행 안 함), 우클릭 = 수정.
// 포인터 드래그로 같은 그룹 내 순서 변경 (Tauri 에선 HTML5 DnD 불가 → dnd.js 사용).
let presetSortReady = false;
function initPresetSort() {
  if (presetSortReady) return;
  presetSortReady = true;
  makeSortable({
    container: document.getElementById('preset-bar'),
    itemSelector: '.preset-chip[data-id]',
    axis: 'x',
    // 전역(global)↔프로젝트 그룹 간 이동 금지
    canDrop: (srcEl, dstEl) => srcEl.classList.contains('global') === dstEl.classList.contains('global'),
    onDrop: (srcId, dstId, before) => App.movePreset(srcId, dstId, before)
  });
}

function renderPresets() {
  const bar = document.getElementById('preset-bar');
  bar.textContent = '';
  const { presets, activeId, sessions } = App.state;
  const active = sessions.find((s) => s.id === activeId);
  const projectId = active ? active.projectId : null;

  const globals = presets.filter((p) => !p.projectId);
  const projs = presets.filter((p) => p.projectId && p.projectId === projectId);

  const makeChip = (p, isGlobal) => {
    const el = document.createElement('button');
    el.className = 'preset-chip' + (isGlobal ? ' global' : '');
    el.dataset.id = p.id;
    el.title = p.command + '\n(클릭=즉시 실행, Shift+클릭=입력만, 우클릭=수정)';
    el.textContent = p.label;

    el.onclick = (e) => App.runPreset(p, !e.shiftKey); // Shift = 입력만, 그 외 즉시 실행
    el.oncontextmenu = (e) => {
      e.preventDefault();
      App.showPresetModal(p);
    };
    return el;
  };

  for (const p of globals) bar.appendChild(makeChip(p, true));  // 전역은 항상 맨앞
  for (const p of projs) bar.appendChild(makeChip(p, false));

  initPresetSort();
}
