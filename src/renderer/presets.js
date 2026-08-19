// 명령 프리셋 바: 전역 + 현재 프로젝트 프리셋을 칩으로 표시.
// 클릭 = 즉시 실행, Shift+클릭 = 입력만(엔터 없이), 우클릭 = 수정/삭제
function renderPresets() {
  const bar = document.getElementById('preset-bar');
  bar.textContent = '';
  const { presets, activeId, sessions } = App.state;
  const active = sessions.find((s) => s.id === activeId);
  const projectId = active ? active.projectId : null;

  const visible = presets.filter((p) => !p.projectId || p.projectId === projectId);
  for (const p of visible) {
    const chip = document.createElement('button');
    chip.className = 'preset-chip';
    chip.title = p.command + '\n(클릭=실행, Shift+클릭=입력만, 우클릭=수정)';
    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.textContent = p.projectId ? '▸' : '◆';
    chip.appendChild(scope);
    chip.appendChild(document.createTextNode(p.label));
    chip.onclick = (e) => App.runPreset(p, !e.shiftKey);
    chip.oncontextmenu = (e) => { e.preventDefault(); App.showPresetModal(p); };
    bar.appendChild(chip);
  }
}
