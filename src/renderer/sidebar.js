// 사이드바: 프로젝트 목록(폴딩·포인터 드래그 정렬) + 프로젝트별 세션 목록 + 상태 시각화
// 세션 상태를 한글 태그로 표시 (원형 점보다 직관적)
function statusTag(status) {
  const t = document.createElement('span');
  t.className = 'status-tag ' + status;
  t.textContent = { idle: '대기중', running: '진행중', done: '완료', exited: '종료됨' }[status] || status;
  return t;
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

// 프로젝트 정렬 드래그는 컨테이너에 1회만 배선 (렌더마다 중복 등록 방지)
let sidebarSortReady = false;
function initSidebarSort() {
  if (sidebarSortReady) return;
  sidebarSortReady = true;
  makeSortable({
    container: document.getElementById('project-list'),
    itemSelector: '.project[data-id]',
    axis: 'y',
    ignore: 'button, .chevron, .session-row',
    onDrop: (srcId, dstId, before) => App.moveProject(srcId, dstId, before)
  });
}

// 상태 전이 시 전체 재구축 대신 해당 세션 행의 태그만 교체.
// 전체 재구축은 호버 표시가 깜빡이고 드래그 중이던 요소가 DOM 에서 떨어져 나가는 부작용이 있다.
// 행이 없으면(프로젝트 접힘 → mini-dots 표시 등) 전체 렌더로 폴백.
function updateSessionStatus(s) {
  const row = document.querySelector(`#project-list .session-row[data-sid="${s.id}"]`);
  if (!row) { renderSidebar(); return; }
  const tag = row.querySelector('.status-tag');
  if (tag) tag.replaceWith(statusTag(s.status));
}

function renderSidebar() {
  const list = document.getElementById('project-list');
  list.textContent = '';
  const { projects, sessions, activeId } = App.state;

  const sessionRow = (s) => {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.id === activeId ? ' active' : '');
    row.dataset.sid = s.id; // 상태 전이 시 증분 갱신용
    const t = document.createElement('span');
    t.className = 'session-title';
    t.textContent = s.title;
    row.appendChild(t);
    row.appendChild(statusTag(s.status));
    // 닫기 버튼: 첫 클릭 = "삭제 확인" 표시(재클릭 시 실제 닫기) — 실수 방지
    const x = document.createElement('button');
    const armed = ArmedConfirm.isArmed(['session-close', s.id]);
    x.className = 'session-close' + (armed ? ' confirm' : '');
    x.textContent = armed ? '삭제 확인' : '✕';
    x.title = armed ? '한 번 더 클릭하면 닫기' : '세션 닫기';
    x.onclick = (e) => {
      e.stopPropagation();
      if (armed) {
        ArmedConfirm.disarm();
        App.closeSession(s.id);
      } else {
        ArmedConfirm.arm(['session-close', s.id], renderSidebar);
      }
    };
    row.appendChild(x);
    row.onclick = () => App.activateSession(s.id);
    return row;
  };

  for (const p of projects) {
    const mySessions = sessions.filter((s) => s.projectId === p.id);
    const folded = Collapsed.has(p.id);
    // 현재 활성 세션이 이 프로젝트 소속이면 프로젝트 행도 파랑으로 강조
    const hasActive = mySessions.some((s) => s.id === activeId);

    const box = document.createElement('div');
    box.className = 'project';
    box.dataset.id = p.id;

    const row = document.createElement('div');
    row.className = 'project-row' + (hasActive ? ' active' : '');

    // 폴딩 토글: 접힘 ❯(희미) / 펼침은 CSS 로 90도 회전(선명)
    const chev = document.createElement('span');
    chev.className = 'chevron ' + (folded ? 'folded' : 'open');
    chev.textContent = '❯';
    chev.title = folded ? '펼치기' : '접기';
    chev.onclick = (e) => { e.stopPropagation(); Collapsed.toggle(p.id); renderSidebar(); };
    row.appendChild(chev);

    // 컬러 아이콘 대신 프로젝트 이름에 색상 적용
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    name.style.color = p.color;
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
    addBtn.onclick = (e) => {
      e.stopPropagation();
      // 접힌 프로젝트에 세션을 추가하면 자동으로 펼친다 — 새 세션이 바로 보이도록
      if (Collapsed.has(p.id)) Collapsed.toggle(p.id);
      App.createSession(p.id); // activateSession → renderAll 이 펼침 상태로 다시 그린다
    };
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = '수정';
    editBtn.onclick = (e) => { e.stopPropagation(); App.showProjectModal(p); };
    actions.appendChild(addBtn);
    actions.appendChild(editBtn);
    row.appendChild(actions);
    // 클릭 = 폴딩 접기/펼치기 (세션 추가는 ＋ 버튼으로만). 경로는 호버 툴팁으로만 표시
    row.onclick = () => { Collapsed.toggle(p.id); renderSidebar(); };
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
    row.className = 'project-row' + (orphans.some((s) => s.id === activeId) ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = '일반 터미널';
    name.style.color = 'var(--fg-dim)';
    row.appendChild(name);
    box.appendChild(row);
    for (const s of orphans) box.appendChild(sessionRow(s));
    list.appendChild(box);
  }

  initSidebarSort();
}
