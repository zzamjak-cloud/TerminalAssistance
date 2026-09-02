// 탐색기 사이드바: 활성 프로젝트의 파일 트리(지연 로딩) + git 변경 표시 +
// 드래그로 경로 전달(초안·터미널) + 더블클릭/스페이스 미리보기(preview.js)
const TREE_POLL_MS = 5000;      // git 상태·펼친 폴더 목록 갱신 주기
const TREE_OPEN_KEY = 'ta-tree-open'; // 루트별 펼침 상태 영속화 (localStorage)

// 경로 구분자 정규화 — Rust(역슬래시)와 git(슬래시) 경로를 같은 키로 맞춘다
function normPath(p) {
  return String(p).replace(/\\/g, '/');
}

Object.assign(App, {
  _tree: {
    root: null,          // 현재 트리 루트 (활성 프로젝트 경로)
    gen: 0,              // 루트 전환 세대 — await 사이 전환 시 낡은 응답 폐기
    entries: new Map(),  // 디렉토리 절대경로(정규화) → [{ name, path, isDir }]
    open: new Set(),     // 펼친 디렉토리 절대경로(정규화)
    gitFiles: new Map(), // 변경 파일 절대경로(정규화) → 상태 문자 (M/A/U/D/R)
    gitDirs: new Set(),  // 변경을 포함한 디렉토리 절대경로(정규화) — 폴더 점 표시
    selected: null,      // 선택 항목 절대경로 — 스페이스 미리보기 대상
    renaming: null       // F2 이름 변경 중인 항목 절대경로 (재렌더 억제)
  },

  // 트리 루트: 활성 세션의 프로젝트 경로 → 없으면 세션 cwd → 빈 프로젝트 선택 시 그 경로
  explorerRoot() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (s) {
      const p = App.state.projects.find((p) => p.id === s.projectId);
      return p ? p.path : s.cwd;
    }
    const pe = App.state.projects.find((p) => p.id === App.state.projectEmptyId);
    return pe ? pe.path : null;
  },

  initExplorer() {
    document.getElementById('btn-tree-refresh').onclick = (e) => {
      e.stopPropagation();
      App.refreshExplorer(true);
    };
    document.getElementById('btn-tree-new').onclick = (e) => {
      e.stopPropagation();
      App.showNewFileModal();
    };
    // 스페이스 = 선택 항목 미리보기 토글, Enter = 터미널 입력 라인 끝에 경로 삽입
    const tree = document.getElementById('file-tree');
    tree.addEventListener('keydown', (ev) => {
      const t = App._tree;
      if (ev.target.tagName === 'INPUT') return; // 이름 변경 입력 중 — 트리 단축키 금지
      if (ev.key === 'F2') {
        ev.preventDefault();
        if (t.selected) App.startTreeRename(t.selected);
        return;
      }
      if (ev.key === ' ' || ev.code === 'Space') {
        ev.preventDefault(); // 스크롤 방지
        // 이미 미리보기가 열려 있으면 닫기 — 한 키로 여닫는 토글
        if (App._modalIsPreview && App._modalClose) { App._modalClose(); return; }
        if (t.selected) {
          const e = App._findTreeEntry(t.selected);
          if (e && !e.isDir) App.showFilePreview(t.selected);
        }
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!t.selected) return;
        const e = App._findTreeEntry(t.selected);
        if (!e) return;
        if (e.isDir) {
          App._toggleTreeDir(t.selected); // 폴더는 Enter 로도 접기/펼치기
        } else if (App.state.activeId) {
          // 파일은 활성 화면의 프롬프트 입력창에, 입력창이 없으면 터미널 입력 라인에 삽입.
          // 포커스는 트리에 남긴다 — 여러 파일을 연달아 Enter 로 넣을 수 있게
          App.insertPathToActiveInput(e.path);
          tree.focus();
        }
        return;
      }
      // 방향키: ↑↓ = 선택 이동, ←→ = 폴딩 접기/펼치기 (일반 코드 에디터와 동일)
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault(); // 트리 스크롤 방지 — 선택 이동이 nearest 스크롤을 대신한다
        const rows = [...document.querySelectorAll('#file-tree .tree-row')];
        if (!rows.length) return;
        const i = rows.findIndex((r) => r.dataset.path === t.selected);
        const next = i < 0
          ? (ev.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1]) // 선택 없음 → 끝에서 시작
          : rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
        App._selectTreeRow(next);
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        if (!t.selected) return;
        const e = App._findTreeEntry(t.selected);
        if (!e) return;
        const isOpenDir = e.isDir && t.open.has(t.selected);
        if (ev.key === 'ArrowRight') {
          if (e.isDir && !isOpenDir) {
            App._toggleTreeDir(t.selected); // 닫힌 폴더 → 펼치기
          } else if (isOpenDir) {
            // 이미 펼친 폴더 → 첫 자식으로 이동
            const rows = [...document.querySelectorAll('#file-tree .tree-row')];
            const i = rows.findIndex((r) => r.dataset.path === t.selected);
            const child = rows[i + 1];
            if (child && child.dataset.path.startsWith(t.selected + '/')) App._selectTreeRow(child);
          }
        } else if (isOpenDir) {
          App._toggleTreeDir(t.selected); // 펼친 폴더 → 접기
        } else {
          // 파일/닫힌 폴더 → 부모 폴더로 이동 (루트 직속이면 이동할 부모 없음)
          const parent = t.selected.slice(0, t.selected.lastIndexOf('/'));
          if (parent.length >= t.root.length) {
            const row = document.querySelector(`#file-tree .tree-row[data-path="${CSS.escape(parent)}"]`);
            if (row) App._selectTreeRow(row);
          }
        }
      }
    });
    setInterval(() => App.pollExplorer(), TREE_POLL_MS);
  },

  // 트리 항목 → 터미널/초안으로 경로 드래그.
  // Tauri 네이티브 파일드롭 핸들러가 HTML5 DnD 를 가로채므로(dnd.js 와 같은 이유)
  // mousedown/mousemove/mouseup 포인터 추적으로 직접 구현한다.
  _wireTreeDrag(row, absPath, name, isDir) {
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.tagName === 'INPUT') return; // 이름 변경 입력 중에는 캐럿 조작이 우선
      e.preventDefault(); // 드래그 중 텍스트 선택 방지 — click/dblclick 에는 영향 없음
      const startX = e.clientX, startY = e.clientY;
      let dragging = false, ghost = null, hover = null;

      const setHover = (el) => {
        if (hover === el) return;
        if (hover) hover.classList.remove('drop-hover');
        hover = el;
        if (hover) hover.classList.add('drop-hover');
      };
      // 포인터 아래의 드롭 대상: 메모·패널 프롬프트 입력창 또는 터미널 영역
      const findTarget = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) return null;
        // 트리 안 = 파일 이동. 폴더 행이면 그 폴더, 파일 행이면 그 파일이 든 폴더, 빈 영역이면 루트.
        const treeHost = el.closest('#file-tree');
        if (treeHost) {
          const hit = el.closest('.tree-row');
          if (!hit) return treeHost;
          const hp = hit.dataset.path;
          const hitEntry = App._findTreeEntry(hp);
          if (hitEntry && hitEntry.isDir) return hit;
          const parent = hp.slice(0, hp.lastIndexOf('/'));
          return document.querySelector(`#file-tree .tree-row[data-path="${CSS.escape(parent)}"]`) || treeHost;
        }
        const memo = el.closest('.memo-modal-editor');
        if (memo) return memo;
        const prompt = el.closest('.pane-prompt-input');
        if (prompt) return prompt;
        // 헤더·빈 목록·문서 행 어디에 올려도 패널 전체를 하나의 드롭 지점으로 취급한다.
        const planPanel = el.closest('#plan-panel');
        if (planPanel) return planPanel;
        return el.closest('#term-area');
      };

      const move = (ev) => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
          dragging = true;
          document.body.classList.add('sorting');
          ghost = document.createElement('div');
          ghost.className = 'tree-drag-ghost';
          ghost.textContent = name;
          document.body.appendChild(ghost);
        }
        ghost.style.left = ev.clientX + 12 + 'px';
        ghost.style.top = ev.clientY + 8 + 'px';
        setHover(findTarget(ev));
      };

      const up = (ev) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (!dragging) return; // 일반 클릭 — row.onclick 에 맡긴다
        document.body.classList.remove('sorting');
        if (ghost) ghost.remove();
        setHover(null);
        const target = findTarget(ev);
        const quoted = quotePath(absPath);
        if (target && (target.id === 'file-tree' || target.classList.contains('tree-row'))) {
          // 탐색기 안에서의 이동 — 대상 폴더로 rename
          void App.moveTreeEntry(absPath, target.id === 'file-tree' ? App._tree.root : target.dataset.path);
        } else if (target && target.id === 'plan-panel') {
          // 문서 패널에서 처리한 드롭은 유효성 오류여도 터미널 paste로 절대 흘리지 않는다.
          if (isDir) {
            App.showPlanDropFeedback('폴더는 계획 문서로 등록할 수 없습니다.', 'error');
          } else if (!/\.md$/i.test(name)) {
            App.showPlanDropFeedback('Markdown(.md) 파일만 계획 문서로 등록할 수 있습니다.', 'error');
          } else {
            void App.registerPlanFile(absPath);
          }
        } else if (target && target.classList.contains('memo-modal-editor')) {
          App.insertMemoPlainText(target, quoted + ' ');
          target.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (target && target.classList.contains('pane-prompt-input')) {
          // 패널 프롬프트에 드롭 — 커서 위치에 경로 삽입, 이미지면 첨부 목록에도 기록
          const composer = App.composerAtPoint(ev.clientX, ev.clientY);
          const sid = composer ? App.paneSessionId(composer.paneIdx) : null;
          if (composer && sid) {
            if (!isDir && /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(name)) App.attachImage(sid, absPath, composer);
            else App.insertComposerText(composer, sid, quoted + ' ');
          }
        } else if (target && target.tagName === 'TEXTAREA') {
          target.value = target.value + (target.value && !/\s$/.test(target.value) ? ' ' : '') + quoted + ' ';
          target.dispatchEvent(new Event('input'));
        } else if (target && App.state.activeId) {
          // 터미널 영역에 드롭 — 분할 중이면 커서 아래 패널의 세션, 아니면 활성 세션에 삽입
          const dropId = App.sessionAtPoint(ev.clientX, ev.clientY) || App.state.activeId;
          if (dropId !== App.state.activeId) App.activateSession(dropId, { noFocus: true });
          TerminalView.paste(dropId, quoted + ' ');
          TerminalView.activate(dropId, { noFocus: true });
        }
        // 드래그를 끝낸 mouseup 과 같은 틱의 click 만 차단 (선택/미리보기 오발동 방지)
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },

  // 행 선택 (제자리 갱신 — 재구축하면 더블클릭 판정이 깨진다) + 화면 안으로 스크롤
  _selectTreeRow(row) {
    App._tree.selected = row.dataset.path;
    document.querySelectorAll('#file-tree .tree-row.selected')
      .forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
  },

  // 폴더 접기/펼치기 + 상태 저장 + 재렌더 (선택 행은 유지되므로 스크롤만 보정)
  _toggleTreeDir(p) {
    const t = App._tree;
    t.open.has(p) ? t.open.delete(p) : t.open.add(p);
    App._saveOpenSet();
    App._renderTreeDom();
    const row = document.querySelector(`#file-tree .tree-row[data-path="${CSS.escape(p)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  },

  _findTreeEntry(path) {
    for (const list of App._tree.entries.values()) {
      const hit = list.find((e) => normPath(e.path) === path);
      if (hit) return hit;
    }
    return null;
  },

  // 루트별 펼침 상태 저장/복원
  _loadOpenSet(root) {
    try {
      const all = JSON.parse(localStorage.getItem(TREE_OPEN_KEY) || '{}');
      return new Set(all[root] || []);
    } catch (_) { return new Set(); }
  },
  _saveOpenSet() {
    const t = App._tree;
    if (!t.root) return;
    try {
      const all = JSON.parse(localStorage.getItem(TREE_OPEN_KEY) || '{}');
      all[t.root] = [...t.open];
      localStorage.setItem(TREE_OPEN_KEY, JSON.stringify(all));
    } catch (_) { /* 저장 실패는 무시 — 다음 세션에 접힌 채로 열릴 뿐 */ }
  },

  // 루트가 바뀌었으면 상태를 갈아끼우고, 아니면 캐시로 즉시 그린다 (renderAll 에서 호출)
  renderExplorer() {
    const ex = document.getElementById('explorer');
    if (ex.classList.contains('hidden')) return;
    const root = App.explorerRoot();
    const t = App._tree;
    if ((root && normPath(root)) !== t.root) {
      t.root = root ? normPath(root) : null;
      t.gen++;
      t.entries = new Map();
      t.gitFiles = new Map();
      t.gitDirs = new Set();
      t.selected = null;
      t.renaming = null;
      t.open = t.root ? App._loadOpenSet(t.root) : new Set();
      if (t.root) App.refreshExplorer(true);
    }
    App._renderTreeDom();
  },

  // 트리 데이터 갱신: 루트 + 펼친 폴더 재목록 + git 상태 (force = 수동 새로고침/루트 전환)
  async refreshExplorer(force) {
    const t = App._tree;
    if (!t.root) { App._renderTreeDom(); return; }
    const gen = t.gen;
    const dirs = [t.root, ...t.open];
    const [git, lists] = await Promise.all([
      ta.gitStatus(t.root).catch(() => null),
      Promise.all(dirs.map((d) =>
        ta.listDir(d).then((es) => [d, es]).catch(() => [d, null])))
    ]);
    if (gen !== t.gen) return; // await 사이에 프로젝트가 바뀜 — 낡은 응답 폐기
    let changed = !!force;
    for (const [d, es] of lists) {
      if (es === null) {
        // 폴더가 사라짐(삭제·이름변경) — 펼침 목록에서 정리
        if (t.open.delete(d)) { App._saveOpenSet(); changed = true; }
        if (t.entries.delete(normPath(d))) changed = true;
        continue;
      }
      const key = normPath(d);
      const next = JSON.stringify(es.map((e) => [e.name, e.isDir]));
      const prev = t.entries.get(key);
      if (!prev || JSON.stringify(prev.map((e) => [e.name, e.isDir])) !== next) changed = true;
      t.entries.set(key, es);
    }
    changed = App._applyGitStatus(git) || changed;
    if (changed) App._renderTreeDom();
  },

  // git 응답 → 절대경로 맵 + 조상 폴더 집합으로 변환. 변경 여부를 반환.
  _applyGitStatus(git) {
    const t = App._tree;
    const files = new Map();
    const dirs = new Set();
    if (git && git.files) {
      const root = normPath(git.root);
      for (const [rel, st] of Object.entries(git.files)) {
        const abs = root + '/' + normPath(rel);
        files.set(abs, st);
        // 트리 루트까지의 조상 폴더에 '변경 포함' 점 표시
        let d = abs;
        while (d.includes('/')) {
          d = d.slice(0, d.lastIndexOf('/'));
          if (d.length < t.root.length) break;
          dirs.add(d);
        }
      }
    }
    const changed =
      files.size !== t.gitFiles.size ||
      [...files].some(([k, v]) => t.gitFiles.get(k) !== v);
    t.gitFiles = files;
    t.gitDirs = dirs;
    return changed;
  },

  // 주기 갱신 — 탐색기가 보이고 루트가 있을 때만 (트리는 지연 로딩이라 비용이 작다)
  pollExplorer() {
    const ex = document.getElementById('explorer');
    if (ex.classList.contains('hidden')) return;
    if (!App._tree.root) return;
    App.refreshExplorer(false);
  },

  // ── DOM 렌더 ──
  _renderTreeDom() {
    const t = App._tree;
    if (t.renaming && document.querySelector('#file-tree .tree-rename')) return; // 이름 변경 중 — 입력이 사라지면 안 된다
    const treeEl = document.getElementById('file-tree');
    const title = document.getElementById('explorer-title');
    treeEl.textContent = '';
    if (!t.root) {
      title.textContent = '탐색기';
      const e = document.createElement('div');
      e.className = 'tree-empty';
      e.textContent = '프로젝트 세션을 열면 해당 프로젝트의 파일 트리가 표시됩니다.';
      treeEl.appendChild(e);
      return;
    }
    // 제목은 '탐색기' 고정 — 프로젝트명은 사이드바 선택 항목에 이미 드러난다 (경로는 툴팁으로)
    title.title = t.root;
    const frag = document.createDocumentFragment();
    App._renderDirChildren(frag, t.root, 0);
    if (!frag.childNodes.length) {
      const e = document.createElement('div');
      e.className = 'tree-empty';
      e.textContent = '비어 있는 폴더입니다.';
      frag.appendChild(e);
    }
    treeEl.appendChild(frag);
  },

  _renderDirChildren(parent, dirPath, depth) {
    const t = App._tree;
    const list = t.entries.get(normPath(dirPath));
    if (!list) {
      // 아직 목록이 없으면 로드 후 전체 재렌더 (지연 로딩)
      const gen = t.gen;
      ta.listDir(dirPath).then((es) => {
        if (gen !== t.gen) return;
        t.entries.set(normPath(dirPath), es);
        App._renderTreeDom();
      }).catch(() => { /* 접근 불가 폴더 — 표시 생략 */ });
      return;
    }
    for (const e of list) {
      const p = normPath(e.path);
      const row = document.createElement('div');
      row.className = 'tree-row' + (t.selected === p ? ' selected' : '');
      row.dataset.path = p; // 방향키 내비게이션의 행 식별자
      row.style.paddingLeft = 8 + depth * 14 + 'px';
      row.title = e.path;
      // 드래그로 경로 전달 (초안 카드·터미널) — 포인터 추적 방식
      App._wireTreeDrag(row, e.path, e.name, e.isDir);

      const chev = document.createElement('span');
      if (e.isDir) {
        chev.className = 'chevron tree-chev ' + (t.open.has(p) ? 'open' : 'folded');
        chev.textContent = '❯';
      } else {
        chev.className = 'chevron tree-chev';
      }
      row.appendChild(chev);

      const name = document.createElement('span');
      name.className = 'tree-name' + (e.isDir ? ' dir' : '');
      name.textContent = e.name;
      row.appendChild(name);

      // git 상태: 파일은 상태 문자, 폴더는 변경 포함 점
      const st = e.isDir ? null : t.gitFiles.get(p);
      if (st) {
        row.classList.add('git-' + st.toLowerCase());
        const badge = document.createElement('span');
        badge.className = 'git-badge';
        badge.textContent = st;
        badge.title = { M: '수정됨', A: '추가됨(스테이지)', U: '미추적(새 파일)', D: '삭제됨', R: '이름 변경' }[st] || st;
        row.appendChild(badge);
      } else if (e.isDir && t.gitDirs.has(p)) {
        const dot = document.createElement('span');
        dot.className = 'git-dot';
        dot.title = '변경된 파일 포함';
        row.appendChild(dot);
      }

      // 이름 변경 입력 안의 클릭은 행 동작(선택·트리 포커스)으로 넘기지 않는다 —
      // 트리에 포커스를 주면 입력이 blur 돼 편집이 끝나 버린다 (캐럿 이동·드래그 선택 불가)
      const inRenameInput = (ev) => ev.target.classList.contains('tree-rename');
      row.onclick = (ev) => {
        if (inRenameInput(ev)) return;
        t.selected = p;
        document.getElementById('file-tree').focus(); // 스페이스/방향키 내비게이션 활성화
        if (e.isDir) {
          App._toggleTreeDir(p);
        } else {
          // 제자리 갱신 — 재구축하면 두 번째 클릭이 새 노드에 떨어져
          // 더블클릭이 발생하지 않는 웹뷰가 있다 (sidebar.js 의 이름변경과 같은 문제)
          App._selectTreeRow(row);
        }
      };
      row.ondblclick = (ev) => { if (!inRenameInput(ev) && !e.isDir) App.showFilePreview(e.path); };
      row.oncontextmenu = (ev) => {
        if (inRenameInput(ev)) return; // 입력 안에서는 기본 편집 메뉴(붙여넣기 등)를 살린다
        ev.preventDefault();
        if (e.isDir) return; // 파일 전용 메뉴 (미리보기·편집·삭제)
        App._selectTreeRow(row);
        App.showTreeContextMenu(ev, e.path);
      };

      parent.appendChild(row);
      if (e.isDir && t.open.has(p)) {
        App._renderDirChildren(parent, e.path, depth + 1);
      }
    }
  },

  // 새 파일을 만들 폴더 — 선택한 폴더, 파일을 골랐으면 그 파일이 든 폴더, 선택이 없으면 루트
  _newFileDir() {
    const t = App._tree;
    if (!t.root) return null;
    if (t.selected) {
      const e = App._findTreeEntry(t.selected);
      if (e && e.isDir) return t.selected;
      if (e) return t.selected.slice(0, t.selected.lastIndexOf('/')) || t.root;
    }
    return t.root;
  },

  // 탐색기 헤더 '＋' — 선택한 폴더 안에 파일 또는 폴더를 만든다.
  // 파일은 확장자(.md/.html/.js …)에 따라 편집기 형태가 정해지고, 만든 직후 편집기가 열린다.
  showNewFileModal() {
    const dir = App._newFileDir();
    if (!dir) { App.showToast('프로젝트 세션을 먼저 열어 주세요'); return; }
    App.modal(`
      <h3>새로 만들기</h3>
      <div class="modal-sub"></div>
      <label>종류</label>
      <select id="m-kind"><option value="file">파일</option><option value="dir">폴더</option></select>
      <label>이름</label><input type="text" id="m-name" placeholder="예: NOTES.md, index.html, util.js">
      <div class="form-help" id="m-hint">확장자에 따라 마크다운·JSON·코드 편집기로 열립니다.</div>
      <div class="form-error" id="m-err"></div>
      <div class="modal-actions">
        <button id="m-cancel">취소</button><button id="m-create">만들기</button>
      </div>`,
      (m, close) => {
        m.querySelector('.modal-sub').textContent = dir;
        const input = m.querySelector('#m-name');
        const kind = m.querySelector('#m-kind');
        const hint = m.querySelector('#m-hint');
        const err = m.querySelector('#m-err');
        kind.onchange = () => {
          const isDir = kind.value === 'dir';
          input.placeholder = isDir ? '예: docs, src/ 없이 폴더 이름만' : '예: NOTES.md, index.html, util.js';
          hint.textContent = isDir
            ? '선택한 폴더 안에 새 폴더를 만듭니다.'
            : '확장자에 따라 마크다운·JSON·코드 편집기로 열립니다.';
          input.focus();
        };
        const create = async () => {
          const name = input.value.trim();
          if (!name) { err.textContent = '이름을 입력하세요.'; return; }
          const isDir = kind.value === 'dir';
          let path = null;
          try {
            path = isDir ? await ta.createDir(dir, name) : await ta.createFile(dir, name);
          } catch (e) {
            err.textContent = String(e);
            return;
          }
          close();
          const t = App._tree;
          t.open.add(normPath(dir)); // 만든 항목이 보이도록 대상 폴더를 펼친다
          App._saveOpenSet();
          t.selected = normPath(path);
          await App.refreshExplorer(true);
          if (!isDir) App.showFileEditor(path);
        };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-create').onclick = create;
        input.focus();
      });
  },

  // ── 드래그 이동 (탐색기 안에서 다른 폴더 위에 놓기) ──
  async moveTreeEntry(srcPath, destDir) {
    const t = App._tree;
    const src = normPath(srcPath);
    const dest = destDir ? normPath(destDir) : null;
    if (!dest) return;
    const name = src.split('/').pop();
    if (src.slice(0, src.lastIndexOf('/')) === dest) return; // 제자리 — 아무 일도 하지 않는다
    if (dest === src || dest.startsWith(src + '/')) {
      App.showToast('폴더를 자기 하위로 옮길 수 없습니다');
      return;
    }
    let moved = null;
    try {
      moved = await ta.movePath(srcPath, dest + '/' + name);
    } catch (e) {
      App.showToast('이동 실패 — ' + String(e));
      return;
    }
    App._rebaseTreeState(src, normPath(moved));
    t.open.add(dest);
    App._saveOpenSet();
    await App.refreshExplorer(true);
  },

  // 경로가 바뀐 뒤의 펼침 목록·선택 보정 (폴더를 옮기면 하위 경로도 함께 바뀐다)
  _rebaseTreeState(oldPath, newPath) {
    const t = App._tree;
    const next = new Set();
    for (const d of t.open) {
      if (d === oldPath) next.add(newPath);
      else if (d.startsWith(oldPath + '/')) next.add(newPath + d.slice(oldPath.length));
      else next.add(d);
    }
    t.open = next;
    t.entries.delete(oldPath);
    t.selected = newPath;
    App._saveOpenSet();
  },

  // ── F2 이름 변경 (Enter·바깥 클릭 = 저장, Esc = 취소) ──
  startTreeRename(path) {
    const t = App._tree;
    const p = normPath(path);
    const row = document.querySelector(`#file-tree .tree-row[data-path="${CSS.escape(p)}"]`);
    const nameEl = row && row.querySelector('.tree-name');
    if (!nameEl || t.renaming) return;
    const entry = App._findTreeEntry(p);
    const oldName = nameEl.textContent;
    t.renaming = p; // 편집 중에는 주기 갱신이 트리를 다시 그리지 않게 막는다

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-rename';
    input.value = oldName;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    // 확장자를 뺀 이름만 선택 — 확장자는 그대로 두고 고치는 경우가 대부분이다
    const dot = entry && !entry.isDir ? oldName.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : oldName.length);

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      t.renaming = null;
      const next = input.value.trim();
      if (!commit || !next || next === oldName) {
        App._renderTreeDom(); // 원래 이름으로 되돌린다
        document.getElementById('file-tree').focus();
        return;
      }
      const parent = p.slice(0, p.lastIndexOf('/'));
      let moved = null;
      try {
        moved = await ta.movePath(path, parent + '/' + next);
      } catch (e) {
        App.showToast('이름을 바꾸지 못했습니다 — ' + String(e));
        App._renderTreeDom();
        return;
      }
      App._rebaseTreeState(p, normPath(moved));
      await App.refreshExplorer(true);
      document.getElementById('file-tree').focus();
    };
    input.onkeydown = (e) => {
      e.stopPropagation(); // 트리 단축키(스페이스 미리보기 등) 차단
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    };
    input.onblur = () => void finish(true); // 바깥 클릭 = 즉시 저장
  },

  // ── 탐색기 파일 우클릭 메뉴 (미리보기 · 편집하기 · 탐색기에서 보기 · 삭제하기) ──
  _treeMenu: null, // { el, cleanup }

  closeTreeContextMenu() {
    const menu = App._treeMenu;
    if (!menu) return;
    App._treeMenu = null;
    menu.cleanup();
    menu.el.remove();
  },

  showTreeContextMenu(ev, path) {
    App.closeTreeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'term-context-menu';
    const mkItem = (label, fn, cls) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'term-context-item' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      btn.onclick = (e) => { e.stopPropagation(); fn(btn); };
      menu.appendChild(btn);
      return btn;
    };
    mkItem('미리보기', () => { App.closeTreeContextMenu(); App.showFilePreview(path); });
    mkItem('편집하기', () => { App.closeTreeContextMenu(); App.showFileEditor(path); });
    // OS 탐색기에서 파일이 든 폴더를 열고 그 파일을 선택 상태로 둔다
    mkItem('탐색기에서 보기', async () => {
      App.closeTreeContextMenu();
      try {
        await ta.revealPath(path);
      } catch (e) {
        App.showToast('탐색기에서 열지 못했습니다 — ' + String(e));
      }
    });
    // 삭제는 되돌릴 수 없으므로 같은 자리에서 '삭제 확인'으로 한 번 더 받는다
    let armed = false, armTimer = null;
    mkItem('삭제하기', async (btn) => {
      if (!armed) {
        armed = true;
        btn.textContent = '삭제 확인';
        btn.classList.add('confirm');
        armTimer = setTimeout(() => {
          armed = false;
          btn.textContent = '삭제하기';
          btn.classList.remove('confirm');
        }, CONFIRM_ARM_MS);
        return;
      }
      clearTimeout(armTimer);
      App.closeTreeContextMenu();
      try {
        await ta.deleteFile(path);
      } catch (e) {
        App.showToast('삭제 실패 — ' + String(e));
        return;
      }
      const t = App._tree;
      if (t.selected === normPath(path)) t.selected = null;
      App.refreshExplorer(true);
    }, 'danger');

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(ev.clientX, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(0, Math.min(ev.clientY, window.innerHeight - rect.height - 6)) + 'px';
    const closeOnOutside = (e) => { if (!menu.contains(e.target)) App.closeTreeContextMenu(); };
    const closeOnKey = (e) => { if (e.key === 'Escape') App.closeTreeContextMenu(); };
    const closeNow = () => App.closeTreeContextMenu();
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnKey, true);
    window.addEventListener('blur', closeNow);
    window.addEventListener('wheel', closeNow, { passive: true });
    App._treeMenu = {
      el: menu,
      cleanup: () => {
        document.removeEventListener('mousedown', closeOnOutside, true);
        document.removeEventListener('keydown', closeOnKey, true);
        window.removeEventListener('blur', closeNow);
        window.removeEventListener('wheel', closeNow);
      }
    };
  }
});
