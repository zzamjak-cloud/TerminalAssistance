// 명령 프리셋 바: 전역(파랑, 맨앞 고정) + 현재 프로젝트 프리셋을 칩으로 표시.
// 클릭 = 실행 확인(빨강 "{이름} 실행")→재클릭 시 실행, Shift+클릭 = 입력만, 우클릭 = 수정.
// 포인터 드래그로 같은 그룹 내 순서 변경 (Tauri 에선 HTML5 DnD 불가 → dnd.js 사용).
let armedPresetId = null; // 실행 확인 대기 중인 프리셋
let armedTimer = null;

function disarmPreset() {
  armedPresetId = null;
  clearTimeout(armedTimer);
  renderPresets();
}

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
    const armed = armedPresetId === p.id;
    el.className = 'preset-chip' + (isGlobal ? ' global' : '') + (armed ? ' armed' : '');
    el.dataset.id = p.id;
    el.title = p.command + '\n(클릭=실행 확인 → 한 번 더 클릭=실행, Shift+클릭=입력만, 우클릭=수정)';
    if (armed) {
      el.textContent = p.label + ' 실행';
    } else {
      const scope = document.createElement('span');
      scope.className = 'scope';
      scope.textContent = isGlobal ? '◆' : '▸';
      el.appendChild(scope);
      el.appendChild(document.createTextNode(p.label));
    }

    el.onclick = (e) => {
      if (e.shiftKey) { armedPresetId = null; clearTimeout(armedTimer); App.runPreset(p, false); renderPresets(); return; }
      if (armedPresetId === p.id) {
        // 2차 클릭 = 실제 실행
        armedPresetId = null;
        clearTimeout(armedTimer);
        App.runPreset(p, true);
        renderPresets();
      } else {
        // 1차 클릭 = 실행 확인 상태 (3초 내 재클릭, 지나면 자동 해제)
        armedPresetId = p.id;
        clearTimeout(armedTimer);
        armedTimer = setTimeout(disarmPreset, 3000);
        renderPresets();
      }
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      armedPresetId = null;
      clearTimeout(armedTimer);
      App.showPresetModal(p);
    };
    return el;
  };

  for (const p of globals) bar.appendChild(makeChip(p, true));  // 전역은 항상 맨앞
  for (const p of projs) bar.appendChild(makeChip(p, false));

  initPresetSort();
}
