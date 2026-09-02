// 사이드바: 프로젝트 목록(폴딩·포인터 드래그 정렬) + 프로젝트별 세션 목록 + 상태 시각화
// 세션 상태를 한글 태그로 표시 (원형 점보다 직관적)
function statusTag(status) {
  const t = document.createElement('span');
  t.className = 'status-tag ' + status;
  t.textContent = { idle: '대기중', running: '진행중', waiting: '허가 대기', done: '완료', exited: '종료됨' }[status] || status;
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

let editingSessionId = null;
let sidebarSessionRenameKeyReady = false;

function isSessionRenameInput(target) {
  return !!(target && target.classList && target.classList.contains('session-rename'));
}

function isSessionRowControl(target) {
  return !!(target && (target.tagName === 'BUTTON' || (target.classList && target.classList.contains('session-close'))));
}

function initSidebarSessionRenameKeys() {
  if (sidebarSessionRenameKeyReady) return;
  sidebarSessionRenameKeyReady = true;
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'F2') return;
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.isContentEditable)) return;
    const id = App.state.activeId;
    if (!id) return;
    const s = App.state.sessions.find((x) => x.id === id);
    if (!s) return;
    ev.preventDefault();
    startSessionTitleRename(id);
  });
}

function refreshSessionTitleSurfaces() {
  renderSidebar();
  if (App.renderTopbar) App.renderTopbar();
  if (App.renderPanePickers) App.renderPanePickers();
  if (App.renderPanePresets) App.renderPanePresets();
}

function startSessionTitleRename(id) {
  const s = App.state.sessions.find((x) => x.id === id);
  const row = s && document.querySelector(`#project-list .session-row[data-sid="${id}"]`);
  const titleEl = row && row.querySelector('.session-title');
  if (!s || !row || !titleEl || editingSessionId) return;

  const oldTitle = s.title;
  editingSessionId = id;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename';
  input.value = oldTitle;
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    editingSessionId = null;

    const next = input.value.trim();
    if (!commit || !next || next === oldTitle) {
      renderSidebar();
      return;
    }

    s.title = next;
    refreshSessionTitleSurfaces();
    const rollback = (error) => {
      s.title = oldTitle;
      refreshSessionTitleSurfaces();
      if (App.showToast) App.showToast('세션 제목을 바꾸지 못했습니다: ' + String(error));
      else console.warn('세션 제목 저장 실패:', error);
    };
    try {
      const result = ta.renameSession(id, next);
      if (result && typeof result.catch === 'function') result.catch(rollback);
    } catch (error) {
      rollback(error);
    }
  };

  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
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
  initSidebarSessionRenameKeys();
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
    row.onclick = (e) => {
      if (isSessionRenameInput(e.target) || isSessionRowControl(e.target)) return;
      if (e.detail >= 2) {
        startSessionTitleRename(s.id);
        return;
      }
      if (s.id !== App.state.activeId) App.activateSession(s.id);
    };
    row.ondblclick = (e) => {
      if (isSessionRenameInput(e.target) || isSessionRowControl(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (s.id !== App.state.activeId) App.activateSession(s.id);
      startSessionTitleRename(s.id);
    };
    return row;
  };

  // ── '일반 터미널' 고정 블록 (목록 최상단) ──
  // 프로젝트에 속하지 않은 세션(홈 디렉토리 터미널)의 상주 프로젝트.
  // 세션이 없어도 항상 표시 — 신규 일반 세션은 여기의 ＋ 로 추가한다.
  {
    const HOME_FOLD_KEY = '__home__'; // Collapsed 저장용 가상 id (실프로젝트 id 와 충돌 없음)
    const orphans = sessions.filter((s) => !s.projectId || !projects.some((p) => p.id === s.projectId));
    const folded = Collapsed.has(HOME_FOLD_KEY);
    const box = document.createElement('div');
    box.className = 'project'; // data-id 없음 → 드래그 정렬 대상에서 제외 (상단 고정)
    const row = document.createElement('div');
    row.className = 'project-row' + (orphans.some((s) => s.id === activeId) ? ' active' : '');

    const chev = document.createElement('span');
    if (orphans.length) {
      chev.className = 'chevron ' + (folded ? 'folded' : 'open');
      chev.textContent = '❯';
      chev.title = folded ? '펼치기' : '접기';
      chev.onclick = (e) => { e.stopPropagation(); Collapsed.toggle(HOME_FOLD_KEY); renderSidebar(); };
    } else {
      chev.className = 'chevron';
    }
    row.appendChild(chev);

    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = '일반 터미널';
    name.style.color = 'var(--fg-dim)';
    row.appendChild(name);

    if (folded && orphans.length) {
      const mini = document.createElement('span');
      mini.className = 'mini-dots';
      for (const s of orphans.slice(0, 5)) {
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
    addBtn.title = '새 일반 터미널 세션 (홈 디렉토리)';
    addBtn.onclick = (e) => {
      e.stopPropagation();
      if (Collapsed.has(HOME_FOLD_KEY)) Collapsed.toggle(HOME_FOLD_KEY); // 새 세션이 바로 보이도록 펼침
      App.createSession(null);
    };
    actions.appendChild(addBtn);
    row.appendChild(actions);

    // 클릭 = 세션이 없으면 즉시 새 일반 세션, 있으면 마지막 세션으로 복귀 (접힘이면 펼침)
    row.onclick = () => {
      if (Collapsed.has(HOME_FOLD_KEY)) Collapsed.toggle(HOME_FOLD_KEY);
      if (!orphans.length) { App.createSession(null); return; }
      App.activateSession(orphans[orphans.length - 1].id);
    };
    row.title = '홈 디렉토리에서 여는 일반 터미널';
    box.appendChild(row);
    if (!folded) {
      for (const s of orphans) box.appendChild(sessionRow(s));
    }
    list.appendChild(box);
  }

  for (const p of projects) {
    const mySessions = sessions.filter((s) => s.projectId === p.id);
    const folded = Collapsed.has(p.id);
    // 현재 활성 세션이 이 프로젝트 소속(또는 빈 프로젝트 선택 중)이면 프로젝트 행도 파랑으로 강조
    const hasActive = mySessions.some((s) => s.id === activeId) || p.id === App.state.projectEmptyId;

    const box = document.createElement('div');
    box.className = 'project';
    box.dataset.id = p.id;

    const row = document.createElement('div');
    row.className = 'project-row' + (hasActive ? ' active' : '');

    // 폴딩 토글: 접힘 ❯(희미) / 펼침은 CSS 로 90도 회전(선명).
    // 세션이 없으면 접을 것도 없으므로 아이콘 없이 자리만 맞춘다
    const chev = document.createElement('span');
    if (mySessions.length) {
      chev.className = 'chevron ' + (folded ? 'folded' : 'open');
      chev.textContent = '❯';
      chev.title = folded ? '펼치기' : '접기';
      chev.onclick = (e) => { e.stopPropagation(); Collapsed.toggle(p.id); renderSidebar(); };
    } else {
      chev.className = 'chevron';
    }
    row.appendChild(chev);

    // 컬러 아이콘 대신 프로젝트 이름에 색상 적용
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    // 라이트 테마에서 밝은 프로젝트 색이 배경에 묻히지 않도록 명도를 눌러 쓴다
    name.style.color = p.color ? Theme.adjustText(p.color) : '';
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
    // 클릭 = 프로젝트 선택: 세션이 없으면 즉시 새 세션 시작,
    // 있으면 이 프로젝트에서 마지막으로 선택했던 세션으로 복귀 (접힘 상태면 펼침).
    // 폴딩 접기/펼치기는 chevron 으로만 한다. 경로는 호버 툴팁으로만 표시.
    row.onclick = () => {
      if (Collapsed.has(p.id)) Collapsed.toggle(p.id); // 선택한 세션이 바로 보이도록 펼침
      if (!mySessions.length) { App.createSession(p.id); return; }
      const lastId = App.lastSessionByProject[p.id];
      const target = mySessions.find((s) => s.id === lastId) || mySessions[mySessions.length - 1];
      App.activateSession(target.id);
    };
    row.title = p.path;
    box.appendChild(row);

    if (!folded) {
      for (const s of mySessions) box.appendChild(sessionRow(s));
    }
    list.appendChild(box);
  }

  initSidebarSort();
}
