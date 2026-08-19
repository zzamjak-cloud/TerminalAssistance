// 사이드바: 프로젝트 목록(폴딩·드래그 정렬) + 프로젝트별 세션 목록 + 상태 시각화
function statusDot(status) {
  const d = document.createElement('span');
  d.className = 'status-dot ' + status;
  d.title = { idle: '대기', running: '실행 중', done: '작업 완료', exited: '종료됨' }[status] || status;
  return d;
}

// 폴딩 상태는 렌더러 로컬 설정 (localStorage)
const Collapsed = {
  set: new Set(JSON.parse(localStorage.getItem('ta-collapsed') || '[]')),
  has(id) { return this.set.has(id); },
  toggle(id) {
    this.set.has(id) ? this.set.delete(id) : this.set.add(id);
    localStorage.setItem('ta-collapsed', JSON.stringify([...this.set]));
  }
};

let dragProjectId = null; // 드래그 중인 프로젝트 id

function clearDropMarks(list) {
  for (const el of list.querySelectorAll('.drop-above, .drop-below')) {
    el.classList.remove('drop-above', 'drop-below');
  }
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
    const mySessions = sessions.filter((s) => s.projectId === p.id);
    const folded = Collapsed.has(p.id);

    const box = document.createElement('div');
    box.className = 'project';
    box.draggable = true;

    // ── 드래그 정렬 ──
    box.addEventListener('dragstart', (e) => {
      dragProjectId = p.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
      requestAnimationFrame(() => box.classList.add('dragging'));
    });
    box.addEventListener('dragend', () => {
      dragProjectId = null;
      box.classList.remove('dragging');
      clearDropMarks(list);
    });
    box.addEventListener('dragover', (e) => {
      if (!dragProjectId || dragProjectId === p.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const before = e.offsetY < box.offsetHeight / 2;
      box.classList.toggle('drop-above', before);
      box.classList.toggle('drop-below', !before);
    });
    box.addEventListener('dragleave', () => box.classList.remove('drop-above', 'drop-below'));
    box.addEventListener('drop', (e) => {
      if (!dragProjectId || dragProjectId === p.id) return;
      e.preventDefault();
      const before = box.classList.contains('drop-above');
      clearDropMarks(list);
      App.moveProject(dragProjectId, p.id, before);
    });

    const row = document.createElement('div');
    row.className = 'project-row';

    // 폴딩 토글 (세션이 없으면 자리만 유지)
    const chev = document.createElement('span');
    chev.className = 'chevron' + (folded ? '' : ' open') + (mySessions.length ? '' : ' empty');
    chev.textContent = '▸';
    chev.title = folded ? '펼치기' : '접기';
    chev.onclick = (e) => { e.stopPropagation(); Collapsed.toggle(p.id); renderSidebar(); };
    row.appendChild(chev);

    const dot = document.createElement('span');
    dot.className = 'project-dot';
    dot.style.background = p.color;
    row.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    row.appendChild(name);

    // 접힌 상태에서도 세션 상태가 보이도록 미니 점 요약
    if (folded && mySessions.length) {
      const mini = document.createElement('span');
      mini.className = 'mini-dots';
      for (const s of mySessions.slice(0, 5)) {
        const md = document.createElement('span');
        md.className = 'mini-dot ' + s.status;
        mini.appendChild(md);
      }
      row.appendChild(mini);
    }

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
    // 클릭 = 이 프로젝트의 세션으로 전환(없으면 생성). 경로는 호버 툴팁으로만 표시
    row.onclick = () => App.openProject(p.id);
    row.title = p.path;
    box.appendChild(row);

    if (!folded) {
      for (const s of mySessions) box.appendChild(sessionRow(s));
    }
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
