// 사이드바: 프로젝트 목록 + 프로젝트별 세션 목록 + 상태 시각화
function statusDot(status) {
  const d = document.createElement('span');
  d.className = 'status-dot ' + status;
  d.title = { idle: '대기', running: '실행 중', done: '작업 완료', exited: '종료됨' }[status] || status;
  return d;
}

function renderSidebar() {
  const list = document.getElementById('project-list');
  list.textContent = '';
  const { projects, sessions, activeId } = App.state;

  const sessionRow = (s) => {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.id === activeId ? ' active' : '');
    row.appendChild(statusDot(s.status));
    const t = document.createElement('span');
    t.className = 'session-title';
    t.textContent = s.title;
    row.appendChild(t);
    if (s.status === 'done') {
      const b = document.createElement('span');
      b.className = 'done-badge';
      b.textContent = '완료';
      row.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'session-close';
    x.textContent = '✕';
    x.title = '세션 닫기';
    x.onclick = (e) => { e.stopPropagation(); App.closeSession(s.id); };
    row.appendChild(x);
    row.onclick = () => App.activateSession(s.id);
    return row;
  };

  for (const p of projects) {
    const box = document.createElement('div');
    box.className = 'project';

    const row = document.createElement('div');
    row.className = 'project-row';
    const dot = document.createElement('span');
    dot.className = 'project-dot';
    dot.style.background = p.color;
    row.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    row.appendChild(name);

    const actions = document.createElement('span');
    actions.className = 'project-actions';
    const addBtn = document.createElement('button');
    addBtn.textContent = '＋';
    addBtn.title = '새 세션';
    addBtn.onclick = (e) => { e.stopPropagation(); App.createSession(p.id); };
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = '수정';
    editBtn.onclick = (e) => { e.stopPropagation(); App.showProjectModal(p); };
    actions.appendChild(addBtn);
    actions.appendChild(editBtn);
    row.appendChild(actions);
    // 클릭 = 이 프로젝트의 세션으로 전환(없으면 생성)
    row.onclick = () => App.openProject(p.id);
    box.appendChild(row);

    const path = document.createElement('div');
    path.className = 'project-path';
    path.textContent = p.path;
    path.title = p.path;
    box.appendChild(path);

    for (const s of sessions.filter((s) => s.projectId === p.id)) box.appendChild(sessionRow(s));
    list.appendChild(box);
  }

  // 프로젝트에 속하지 않은 세션 (+ 터미널 버튼으로 연 것)
  const orphans = sessions.filter((s) => !s.projectId || !projects.some((p) => p.id === s.projectId));
  if (orphans.length) {
    const box = document.createElement('div');
    box.className = 'project';
    const row = document.createElement('div');
    row.className = 'project-row';
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = '일반 터미널';
    name.style.color = 'var(--fg-dim)';
    row.appendChild(name);
    box.appendChild(row);
    for (const s of orphans) box.appendChild(sessionRow(s));
    list.appendChild(box);
  }
}
