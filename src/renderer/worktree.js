// git 워크트리 런처 — 같은 저장소를 브랜치별 폴더로 펼쳐 에이전트를 병렬로 돌린다.
// 만들어진 워크트리는 부모에 종속된 프로젝트(parentId + branch)로 등록되며,
// 세션·프리셋·탐색기·Pull 은 일반 프로젝트와 완전히 같은 경로를 탄다.
//
// 앞부분의 순수 함수(경로 제안·정렬)는 DOM 없이 단독으로 테스트한다
// (scripts/test/worktree.test.js 가 이 파일을 그대로 로드해 호출한다).

// 경로 구분자 추정 — 이미 쓰고 있는 구분자를 그대로 따라간다.
// Windows 에서도 git 은 `C:/Users/...` 처럼 슬래시로 경로를 돌려주므로,
// 드라이브 문자만 보고 역슬래시를 붙이면 `C:/a/b\c` 같은 혼합 경로가 된다.
function pathSep(dir) {
  const s = String(dir || '');
  if (s.includes('/')) return '/';
  if (s.includes('\\') || /^[A-Za-z]:/.test(s)) return '\\';
  return '/';
}

function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return d + pathSep(dir) + name;
}

// 브랜치명을 폴더명으로 — `feat/login` → `feat-login`.
// 슬래시·공백·OS 금지문자를 하이픈으로 접고, 앞뒤 점·하이픈은 떼어낸다.
function worktreeFolderName(branch) {
  const cleaned = String(branch || '')
    .trim()
    .replace(/^[a-z]+\//i, (m) => (/^(origin|upstream)\//i.test(m) ? '' : m)) // origin/x → x
    .replace(/[\\/\s]+/g, '-')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return cleaned || 'worktree';
}

// 형제 폴더 방식의 기본 경로 제안: `<부모의 상위>/<레포명>-<브랜치>`.
// 이미 쓰이는 경로(taken)와 겹치면 `-2`, `-3` … 을 붙인다.
function suggestWorktreePath(parentDir, repoName, branch, taken) {
  const used = new Set((taken || []).map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
  const base = `${repoName || 'repo'}-${worktreeFolderName(branch)}`;
  for (let n = 1; n < 100; n++) {
    const candidate = joinPath(parentDir, n === 1 ? base : `${base}-${n}`);
    if (!used.has(candidate.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())) return candidate;
  }
  return joinPath(parentDir, `${base}-${Date.now()}`);
}

// 사이드바 표시 순서 — 최상위 프로젝트 뒤에 그 워크트리들을 붙여 평평한 배열로 만든다.
// 부모가 사라진 워크트리(고아)는 최상위로 올려 목록에서 누락되지 않게 한다.
// 반환: [{ project, depth }] (depth 1 = 워크트리)
function orderProjectsWithWorktrees(projects) {
  const list = projects || [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const isChild = (p) => !!(p.parentId && p.branch && byId.has(p.parentId) && p.parentId !== p.id);
  const children = new Map();
  for (const p of list) {
    if (!isChild(p)) continue;
    if (!children.has(p.parentId)) children.set(p.parentId, []);
    children.get(p.parentId).push(p);
  }
  const out = [];
  for (const p of list) {
    if (isChild(p)) continue;
    out.push({ project: p, depth: 0 });
    for (const c of children.get(p.id) || []) out.push({ project: c, depth: 1 });
  }
  return out;
}

// 새 워크트리 프로젝트를 목록에 끼워 넣는다 — 백엔드(add_project)와 같은 규칙으로
// 부모 뒤, 기존 형제 워크트리들 다음에 넣어 저장 순서와 표시 순서를 어긋나지 않게 한다.
function insertWorktreeProject(projects, project) {
  const start = projects.findIndex((p) => p.id === project.parentId);
  if (start < 0) { projects.push(project); return projects; }
  let idx = start + 1;
  while (idx < projects.length && projects[idx].parentId === project.parentId) idx++;
  projects.splice(idx, 0, project);
  return projects;
}

// 드래그 정렬 — 최상위 프로젝트를 옮길 때 딸린 워크트리를 통째로 데려간다.
// 워크트리 자신이나 워크트리 위로의 이동은 호출 전에 막지만, 여기서도 방어한다.
function moveProjectGroup(projects, srcId, dstId, before) {
  const src = projects.find((p) => p.id === srcId);
  const dst = projects.find((p) => p.id === dstId);
  if (!src || !dst || srcId === dstId) return projects;
  if (src.parentId || dst.parentId) return projects; // 워크트리는 부모를 따라만 움직인다

  const group = projects.filter((p) => p.id === srcId || p.parentId === srcId);
  const rest = projects.filter((p) => !group.includes(p));
  let to = rest.findIndex((p) => p.id === dstId);
  if (to < 0) return projects;
  if (!before) {
    // 뒤에 놓을 때는 대상의 워크트리들 다음 자리로 간다
    to += 1;
    while (to < rest.length && rest[to].parentId === dstId) to++;
  }
  rest.splice(to, 0, ...group);
  projects.length = 0;
  projects.push(...rest);
  return projects;
}

// 브랜치 아이콘 — 상단바 아이콘과 같은 외곽선 스타일(1.35px, 둥근 끝)로 맞춘 인라인 SVG.
// 글리프(⑂)는 Windows 기본 글꼴에 없어 네모로 뜨거나 다른 아이콘과 크기가 어긋난다.
function branchIconSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" `
    + 'stroke="currentColor" stroke-width="1.35" stroke-linecap="round">'
    + '<line x1="4" y1="2.4" x2="4" y2="10"/>'
    + '<circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/>'
    + '<path d="M12 6a6 6 0 0 1-6 6"/></svg>';
}

// ── 여기서부터는 UI (App 메서드) ──
Object.assign(App, {
  _repoProbe: new Map(), // 프로젝트 path → true/false (git 저장소인가). 앱 실행당 1회만 조회

  // 최상위 프로젝트 행에 워크트리 버튼을 띄울지 판단한다.
  // 결과를 모르는 동안에는 숨겼다가, 조회가 끝나면 사이드바를 한 번 다시 그린다.
  isGitRepo(project) {
    const key = project.path;
    if (App._repoProbe.has(key)) return App._repoProbe.get(key) === true;
    App._repoProbe.set(key, 'pending');
    ta.repoInfo(key)
      .then((info) => { App._repoProbe.set(key, !!info); })
      .catch(() => { App._repoProbe.set(key, false); })
      .then(() => { if (typeof renderSidebar === 'function') renderSidebar(); });
    return false;
  },

  async showWorktreeModal(parent) {
    let info = null;
    try { info = await ta.repoInfo(parent.path); }
    catch (e) { App.showToast('⚠ 저장소 정보를 읽지 못했습니다 — ' + e); return; }
    if (!info) { App.showToast('⚠ git 저장소가 아닙니다 — 워크트리를 만들 수 없습니다'); return; }

    // 이미 쓰이는 경로: 기존 워크트리 + 등록된 프로젝트 경로
    const taken = info.worktrees.map((w) => w.path).concat(App.state.projects.map((p) => p.path));
    const branches = info.branches;

    App.modal(`
      <h3>워크트리 만들기 — ${escapeHtml(info.repoName)}</h3>
      <label>브랜치</label>
      <input type="text" id="w-branch" placeholder="예: feat/login (없는 이름이면 새로 만듭니다)" autocomplete="off">
      <div class="form-help" id="w-branch-state"></div>
      <div class="wt-branch-list" id="w-list"></div>
      <label id="w-base-label">새 브랜치의 기준</label>
      <select id="w-base"></select>
      <label>폴더</label>
      <input type="text" id="w-path" placeholder="워크트리를 만들 경로">
      <div class="form-help">부모 저장소 옆(형제 폴더)에 만듭니다. 직접 고쳐도 됩니다.</div>
      <div class="modal-actions">
        <button id="w-cancel">취소</button><button id="w-create">만들고 세션 열기</button>
      </div>`,
      (m, close) => {
        const input = m.querySelector('#w-branch');
        const stateEl = m.querySelector('#w-branch-state');
        const listEl = m.querySelector('#w-list');
        const pathEl = m.querySelector('#w-path');
        const baseEl = m.querySelector('#w-base');
        const baseLabel = m.querySelector('#w-base-label');
        const createBtn = m.querySelector('#w-create');
        let pathEdited = false; // 사용자가 경로를 직접 고쳤으면 자동 갱신을 멈춘다

        // 기준 커밋 후보: 현재 브랜치를 맨 앞에 둔다
        const baseOptions = [];
        if (info.currentBranch) baseOptions.push(info.currentBranch);
        for (const b of branches) if (b.name !== info.currentBranch) baseOptions.push(b.name);
        baseEl.innerHTML = baseOptions.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');

        // 입력값이 기존 브랜치와 정확히 일치하는지 — 일치하면 체크아웃, 아니면 새 브랜치
        const findBranch = (v) => branches.find((b) => b.name === v)
          || branches.find((b) => b.remote && b.name.replace(/^[^/]+\//, '') === v);

        function refresh() {
          const raw = input.value.trim();
          const hit = raw ? findBranch(raw) : null;
          const createNew = !!raw && !hit;
          baseLabel.style.display = createNew ? '' : 'none';
          baseEl.style.display = createNew ? '' : 'none';

          if (!raw) {
            stateEl.textContent = '만들거나 체크아웃할 브랜치 이름을 입력하세요.';
            stateEl.className = 'form-help';
            createBtn.disabled = true;
          } else if (hit && hit.checkedOutAt) {
            stateEl.textContent = `이미 다른 워크트리가 쓰는 중입니다 — ${hit.checkedOutAt}`;
            stateEl.className = 'form-help warn';
            createBtn.disabled = true;
          } else if (hit) {
            stateEl.textContent = hit.remote
              ? `원격 브랜치 ${hit.name} 을 받아 체크아웃합니다.`
              : `기존 브랜치 ${hit.name} 을 체크아웃합니다.`;
            stateEl.className = 'form-help';
            createBtn.disabled = false;
          } else {
            stateEl.textContent = `새 브랜치 ${raw} 을 만듭니다.`;
            stateEl.className = 'form-help';
            createBtn.disabled = false;
          }

          if (!pathEdited) {
            // 원격 브랜치는 로컬 이름(origin/ 제거)을 폴더명 기준으로 쓴다
            const forName = hit && hit.remote ? hit.name.replace(/^[^/]+\//, '') : raw;
            pathEl.value = raw ? suggestWorktreePath(info.parentDir, info.repoName, forName, taken) : '';
          }

          // 목록은 입력값으로 걸러 보여주고, 클릭하면 그 브랜치를 채운다
          listEl.innerHTML = '';
          const shown = branches.filter((b) => fuzzyMatch([b.name], raw)).slice(0, 40);
          for (const b of shown) {
            const row = document.createElement('div');
            row.className = 'wt-branch' + (b.checkedOutAt ? ' disabled' : '') + (b.name === raw ? ' active' : '');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'wt-branch-name';
            nameSpan.textContent = b.name;
            row.appendChild(nameSpan);
            const tag = document.createElement('span');
            tag.className = 'wt-branch-tag';
            tag.textContent = b.checkedOutAt ? '사용 중' : (b.remote ? '원격' : (b.name === info.currentBranch ? '현재' : ''));
            row.appendChild(tag);
            if (!b.checkedOutAt) {
              row.onclick = () => { input.value = b.name; pathEdited = false; refresh(); input.focus(); };
            }
            listEl.appendChild(row);
          }
        }

        input.oninput = refresh;
        pathEl.oninput = () => { pathEdited = true; };
        m.querySelector('#w-cancel').onclick = close;

        createBtn.onclick = async () => {
          const raw = input.value.trim();
          const hit = raw ? findBranch(raw) : null;
          if (!raw || (hit && hit.checkedOutAt)) return;
          const path = pathEl.value.trim();
          if (!path) return alert('워크트리를 만들 경로를 입력하세요.');

          // 원격 브랜치를 고르면 같은 이름의 로컬 브랜치를 새로 만들어 추적하게 한다
          const useRemote = hit && hit.remote;
          const localName = useRemote ? hit.name.replace(/^[^/]+\//, '') : raw;
          const createNew = !hit || useRemote;
          const base = useRemote ? hit.name : (createNew ? baseEl.value : null);

          createBtn.disabled = true;
          createBtn.textContent = '만드는 중…';
          let created;
          try {
            created = await ta.worktreeAdd({ root: info.root, path, branch: localName, createNew, base });
          } catch (e) {
            createBtn.disabled = false;
            createBtn.textContent = '만들고 세션 열기';
            alert('워크트리 생성 실패:\n' + e);
            return;
          }

          let project;
          try {
            project = await ta.addProject({
              name: localName, path: created, color: parent.color,
              parentId: parent.id, branch: localName
            });
          } catch (e) {
            close();
            App.showToast('⚠ 워크트리는 만들어졌지만 프로젝트 등록에 실패했습니다 — ' + e);
            return;
          }

          insertWorktreeProject(App.state.projects, project);
          App._repoProbe.set(created, true);
          close();
          App.renderAll();
          App.showToast(`워크트리 생성 — ${localName} (${created})`);
          App.createSession(project.id);
        };

        refresh();
        input.focus();
      },
      { wide: true }); // 브랜치 목록과 전체 경로가 잘리지 않도록 넓은 팝업
  },

  // 워크트리 제거 — 세션이 살아 있거나 잃을 변경이 있으면 그 자리에서 막고 사유를 보여준다
  async removeWorktree(project) {
    const parent = App.state.projects.find((p) => p.id === project.parentId);
    const root = parent ? parent.path : project.path; // 부모 등록이 없으면 워크트리 자신을 기준으로
    const live = App.state.sessions.filter((s) => s.projectId === project.id && s.status !== 'exited');
    if (live.length) {
      App.showToast(`⚠ 이 워크트리의 세션 ${live.length}개가 열려 있습니다 — 먼저 닫아주세요`);
      return;
    }

    let check;
    try { check = await ta.worktreeCheck(root, project.path); }
    catch (e) { App.showToast('⚠ 상태를 확인하지 못했습니다 — ' + e); return; }

    const warnings = [];
    if (check.dirtyCount) warnings.push(`커밋하지 않은 변경 ${check.dirtyCount}개`);
    if (check.ahead) warnings.push(`아직 push 하지 않은 커밋 ${check.ahead}개`);
    if (check.noUpstream) warnings.push('원격에 올린 적 없는 브랜치');
    const risky = warnings.length > 0;

    if (!check.isWorktree) {
      // git 이 모르는 경로 — 등록만 지우면 된다
      App.modal(`
        <h3>워크트리 등록 해제</h3>
        <p class="modal-text">${escapeHtml(project.path)} 은 이 저장소의 워크트리가 아닙니다.
        폴더는 그대로 두고 목록에서만 지웁니다.</p>
        <div class="modal-actions"><button id="w-cancel">취소</button><button id="w-ok" class="danger">목록에서 지우기</button></div>`,
        (m, close) => {
          m.querySelector('#w-cancel').onclick = close;
          m.querySelector('#w-ok').onclick = async () => { close(); await App._dropWorktreeProject(project); };
        });
      return;
    }

    App.modal(`
      <h3>워크트리 제거 — ${escapeHtml(project.branch || project.name)}</h3>
      <p class="modal-text">${escapeHtml(project.path)}</p>
      ${check.missing ? '<p class="modal-text warn">폴더가 이미 사라졌습니다 — git 등록만 정리합니다.</p>' : ''}
      ${risky ? `<p class="modal-text warn">제거하면 사라지는 것: ${escapeHtml(warnings.join(' · '))}. 되돌릴 수 없습니다.</p>
        <label class="check-row"><input type="checkbox" id="w-force"> 알고 있습니다 — 강제로 제거합니다</label>` : ''}
      <div class="form-help">브랜치 자체는 지우지 않습니다. 필요하면 나중에 <code>git branch -d</code> 로 정리하세요.</div>
      <div class="modal-actions">
        <button id="w-cancel">취소</button><button id="w-ok" class="danger">제거</button>
      </div>`,
      (m, close) => {
        const force = m.querySelector('#w-force');
        const ok = m.querySelector('#w-ok');
        if (force) {
          ok.disabled = true;
          force.onchange = () => { ok.disabled = !force.checked; };
        }
        m.querySelector('#w-cancel').onclick = close;
        ok.onclick = async () => {
          ok.disabled = true;
          ok.textContent = '제거 중…';
          try {
            await ta.worktreeRemove(root, project.path, !!(force && force.checked) || check.missing);
          } catch (e) {
            close();
            App.showToast('⚠ 워크트리 제거 실패 — ' + e);
            return;
          }
          close();
          await App._dropWorktreeProject(project);
          App.showToast(`워크트리를 제거했습니다 — ${project.branch || project.name}`);
        };
      });
  },

  // 레지스트리에서 워크트리 프로젝트를 지우고 화면을 갱신한다
  async _dropWorktreeProject(project) {
    try { await ta.removeProject(project.id); }
    catch (e) { App.showToast('⚠ 프로젝트 등록 해제 실패 — ' + e); return; }
    App.state.projects = App.state.projects.filter((p) => p.id !== project.id);
    App.state.presets = App.state.presets.filter((p) => p.projectId !== project.id);
    App.state.recipes = App.state.recipes.filter((r) => r.projectId !== project.id);
    App._repoProbe.delete(project.path);
    App.renderAll();
  }
});
