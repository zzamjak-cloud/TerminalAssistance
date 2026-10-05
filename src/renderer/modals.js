// 모달 공통 골격 + 프로젝트/프리셋/설정 폼 + 업데이트 확인
Object.assign(App, {
  _modalCleanup: null, // 이전 모달의 keydown(Esc) 리스너 해제 함수
  _modalClose: null,   // 현재 모달의 close — 탐색기 스페이스 토글이 외부에서 닫을 때 사용
  _modalIsPreview: false, // 현재 모달이 파일 미리보기인가 (스페이스로 닫기 허용 판별)

  // opts.wide: 문서 열람 등 넓은 팝업 (기본 420px → 680px)
  // opts.xl: 파일 미리보기 등 대형 팝업 (900px)
  // opts.full: 편집기 등 화면을 최대한 쓰는 팝업 (96vw × 94vh)
  modal(html, onOpen, opts) {
    // close() 를 거치지 않고 모달 위에 새 모달을 여는 경로(프리셋 관리 → 수정 등)에서
    // 이전 Esc 리스너가 document 에 남지 않도록 먼저 정리한다
    if (App._modalCleanup) { App._modalCleanup(); App._modalCleanup = null; }
    const bd = document.getElementById('modal-backdrop');
    const m = document.getElementById('modal');
    m.classList.toggle('wide', !!(opts && opts.wide));
    m.classList.toggle('xl', !!(opts && opts.xl));
    m.classList.toggle('full', !!(opts && opts.full));
    m.innerHTML = html;
    bd.classList.remove('hidden');
    // 바깥 클릭으로는 닫지 않는다 — 입력 중 드래그가 배경 클릭으로 판정돼
    // 작성 내용이 날아가는 실수가 잦았음. 닫기는 버튼 또는 Esc 로만.
    bd.onclick = null;
    const esc = (e) => {
      if (e.key === 'Escape') { close(); return; }
      // 미리보기 모달은 스페이스로도 닫기 (탐색기 스페이스 열기와 짝을 이루는 토글).
      // 버튼/입력에 포커스가 있으면 스페이스의 본래 동작을 존중한다.
      if ((e.key === ' ' || e.code === 'Space') && App._modalIsPreview
        && !/^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
        e.preventDefault();
        close();
      }
    };
    const close = () => {
      bd.classList.add('hidden');
      document.removeEventListener('keydown', esc);
      App._modalCleanup = null;
      App._modalClose = null;
      App._modalIsPreview = false;
    };
    document.addEventListener('keydown', esc);
    App._modalCleanup = () => document.removeEventListener('keydown', esc);
    App._modalClose = close;
    App._modalIsPreview = false; // 미리보기 모달만 onOpen 에서 켠다 (preview.js)
    onOpen(m, close);
  },

  // ── 세션 모두 초기화 ──
  // 삭제 대상을 먼저 나열해 보여 준 뒤 확인을 받는다 — 되돌릴 수 없는 작업이므로
  // “몇 개가 닫히는가”를 숫자가 아니라 이름으로 확인할 수 있게 한다.
  showClearSessionsModal() {
    const { sessions, projects } = App.state;
    if (!sessions.length) {
      App.showToast('닫을 세션이 없습니다');
      return;
    }
    // 프로젝트가 없거나 사라진 세션은 사이드바와 동일하게 ‘일반 터미널’로 묶어 보인다
    const projectName = (s) => {
      const p = projects.find((x) => x.id === s.projectId);
      return p ? p.name : '일반 터미널';
    };
    const rows = sessions.map((s) => `
      <li>
        <span class="clear-session-project">${escapeHtml(projectName(s))}</span>
        <span class="clear-session-title">${escapeHtml(s.title)}</span>
      </li>`).join('');
    App.modal(`
      <h3>세션 모두 초기화</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:8px">
        아래 ${sessions.length}개 세션이 모두 닫힙니다. 실행 중인 명령과 예약된 프롬프트도 함께 종료되며, 되돌릴 수 없습니다.
      </p>
      <ul id="m-clear-list">${rows}</ul>
      <p style="margin-top:12px;font-weight:700">정말로 초기화하시겠습니까?</p>
      <div class="modal-actions">
        <button id="m-cancel">취소</button>
        <button id="m-clear" class="confirm">모두 초기화</button>
      </div>`,
      (m, close) => {
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-clear').onclick = async () => {
          const btn = m.querySelector('#m-clear');
          btn.disabled = true;
          btn.textContent = '초기화 중…';
          try {
            await App.closeAllSessions();
          } catch (error) {
            App.showToast('세션 초기화 중 오류가 발생했습니다: ' + String(error));
          }
          close();
        };
        m.querySelector('#m-cancel').focus(); // 기본 포커스는 취소 — Enter 연타로 삭제되지 않게
      });
  },

  CHANGELOG_URL: 'https://github.com/zzamjak-cloud/TerminalAssistance/blob/main/CHANGELOG.md',

  async checkUpdate() {
    let info = null;
    try { info = await ta.checkUpdate(); } catch (_) { return; }
    if (!info) return;
    App.modal(`
      <h3>새 버전 v${escapeHtml(info.version)} 이 있습니다</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:6px">
        ${info.notes ? escapeHtml(String(info.notes)).slice(0, 400) : '업데이트를 설치하면 앱이 자동으로 재시작됩니다.'}
      </p>
      <p><a href="#" id="m-changelog" style="color:var(--done)">전체 변경 사항 보기 (CHANGELOG)</a></p>
      <div class="modal-actions">
        <button id="m-cancel">나중에</button>
        <button id="m-update">지금 업데이트</button>
      </div>`,
      (m, close) => {
        m.querySelector('#m-changelog').onclick = (e) => { e.preventDefault(); ta.openUrl(App.CHANGELOG_URL); };
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-update').onclick = async () => {
          const btn = m.querySelector('#m-update');
          btn.disabled = true;
          btn.textContent = '다운로드 중…';
          try { await ta.installUpdate(); } // 성공 시 앱이 재시작되므로 이후 코드는 실행되지 않음
          catch (e) { btn.disabled = false; btn.textContent = '지금 업데이트'; alert('업데이트 실패: ' + e); }
        };
      });
  },

  // ── 프리셋 관리 팝업: 전역/프로젝트 전용 구분, 추가·수정·삭제 ──
  // forProjectId 지정 시 그 프로젝트 기준 (패널 드롭다운의 '+ 프리셋 추가'), 생략 시 활성 세션 기준
  showPresetManager(forProjectId) {
    const active = App.state.sessions.find((s) => s.id === App.state.activeId);
    const projectId = forProjectId !== undefined ? forProjectId : (active ? active.projectId : null);
    const proj = App.state.projects.find((p) => p.id === projectId);

    App.modal(`
      <h3>프리셋 관리</h3>
      <div class="pm-title">◆ 전역 프리셋 <button id="pm-add-g">+ 추가</button></div>
      <div class="pm-list" id="pm-globals"></div>
      <div class="pm-title">▸ ${proj ? escapeHtml(proj.name) + ' 전용' : '프로젝트 전용'} <button id="pm-add-p" ${proj ? '' : 'disabled'}>+ 추가</button></div>
      <div class="pm-list" id="pm-projs"></div>
      <div class="modal-actions"><button id="m-close">닫기</button></div>`,
      (m, close) => {
        const back = () => App.showPresetManager(projectId); // 추가/수정 후 관리 팝업으로 복귀
        const row = (p) => {
          const r = document.createElement('div');
          r.className = 'pm-row';
          const lb = document.createElement('b');
          lb.textContent = p.label;
          const cmd = document.createElement('span');
          cmd.textContent = p.command;
          cmd.title = p.command;
          const edit = document.createElement('button');
          edit.textContent = '수정';
          edit.onclick = () => App.showPresetModal(p, { back });
          const del = document.createElement('button');
          del.textContent = '삭제';
          del.className = 'pm-del';
          del.onclick = async () => {
            if (!confirm(`프리셋 "${p.label}" 을 삭제할까요?`)) return;
            try { await ta.removePreset(p.id); }
            catch (e) { alert('삭제 실패: ' + e); return; }
            App.state.presets = App.state.presets.filter((x) => x.id !== p.id);
            App.renderPanePresets();
            back();
          };
          r.append(lb, cmd, edit, del);
          return r;
        };
        const gl = m.querySelector('#pm-globals');
        const pl = m.querySelector('#pm-projs');
        const globals = App.state.presets.filter((p) => !p.projectId);
        const projs = App.state.presets.filter((p) => p.projectId === projectId && projectId);
        if (!globals.length) gl.innerHTML = '<div class="pm-empty">등록된 전역 프리셋이 없습니다.</div>';
        else for (const p of globals) gl.appendChild(row(p));
        if (!proj) pl.innerHTML = '<div class="pm-empty">프로젝트 세션을 열면 전용 프리셋을 관리할 수 있습니다.</div>';
        else if (!projs.length) pl.innerHTML = '<div class="pm-empty">이 프로젝트 전용 프리셋이 없습니다.</div>';
        else for (const p of projs) pl.appendChild(row(p));

        m.querySelector('#pm-add-g').onclick = () => App.showPresetModal(null, { scope: '', back });
        if (proj) m.querySelector('#pm-add-p').onclick = () => App.showPresetModal(null, { scope: proj.id, back });
        m.querySelector('#m-close').onclick = close;
      });
  },

  // ── 빈 분할 패널의 '+ 세션 추가': 프로젝트를 골라 그 패널에 새 세션을 연다 ──
  showSessionAddModal(paneIdx) {
    const projs = App.state.projects;
    App.modal(`
      <h3>새 세션 시작</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:6px">세션을 추가할 프로젝트를 선택하세요.</p>
      <div class="pm-list" id="sa-list"></div>
      <div class="modal-actions">
        <button id="sa-home">홈 디렉토리 터미널</button>
        <button id="sa-new-proj">+ 프로젝트 등록</button>
        <button id="m-cancel">취소</button>
      </div>`,
      (m, close) => {
        const start = (projectId) => {
          close();
          App.createSession(projectId, { paneIdx });
        };
        const list = m.querySelector('#sa-list');
        if (!projs.length) {
          list.innerHTML = '<div class="pm-empty">등록된 프로젝트가 없습니다. 프로젝트를 먼저 등록하거나 홈 디렉토리 터미널로 시작하세요.</div>';
        }
        for (const p of projs) {
          const btn = document.createElement('button');
          btn.className = 'sa-item';
          btn.textContent = p.name;
          btn.title = p.path;
          if (p.color) btn.style.color = Theme.adjustText(p.color);
          btn.onclick = () => start(p.id);
          list.appendChild(btn);
        }
        m.querySelector('#sa-home').onclick = () => start(null);
        m.querySelector('#sa-new-proj').onclick = () => { close(); App.showProjectModal(); };
        m.querySelector('#m-cancel').onclick = close;
      });
  },

  // ── 런치 레시피: 여러 세션을 만들고 각 줄의 명령을 실행하는 작업 묶음 ──
  showRecipeManager() {
    const active = App.state.sessions.find((s) => s.id === App.state.activeId);
    const projectId = active ? active.projectId : null;
    const proj = App.state.projects.find((p) => p.id === projectId);

    App.modal(`
      <h3>런치 레시피 관리</h3>
      <div class="pm-title">◆ 전역 레시피 <button id="rc-add-g">+ 추가</button></div>
      <div class="pm-list" id="rc-globals"></div>
      <div class="pm-title">▸ ${proj ? escapeHtml(proj.name) + ' 전용' : '프로젝트 전용'} <button id="rc-add-p" ${proj ? '' : 'disabled'}>+ 추가</button></div>
      <div class="pm-list" id="rc-projs"></div>
      <div class="modal-actions"><button id="m-close">닫기</button></div>`,
      (m, close) => {
        const back = () => App.showRecipeManager();
        const row = (r) => {
          const commands = (r.commands || []).filter((c) => c.trim());
          const first = commands[0] || '';
          const el = document.createElement('div');
          el.className = 'pm-row';
          const lb = document.createElement('b');
          lb.textContent = r.label;
          const cmd = document.createElement('span');
          cmd.textContent = `${commands.length}개 세션` + (first ? ' · ' + first : '');
          cmd.title = commands.join('\n');
          const run = document.createElement('button');
          run.textContent = '실행';
          run.onclick = () => { close(); App.runRecipe(r); };
          const edit = document.createElement('button');
          edit.textContent = '수정';
          edit.onclick = () => App.showRecipeModal(r, { back });
          const del = document.createElement('button');
          del.textContent = '삭제';
          del.className = 'pm-del';
          del.onclick = async () => {
            if (!confirm(`레시피 "${r.label}" 을 삭제할까요?`)) return;
            try { await ta.removeRecipe(r.id); }
            catch (e) { alert('삭제 실패: ' + e); return; }
            App.state.recipes = App.state.recipes.filter((x) => x.id !== r.id);
            back();
          };
          el.append(lb, cmd, run, edit, del);
          return el;
        };
        const gl = m.querySelector('#rc-globals');
        const pl = m.querySelector('#rc-projs');
        const globals = (App.state.recipes || []).filter((r) => !r.projectId);
        const projs = (App.state.recipes || []).filter((r) => r.projectId === projectId && projectId);
        if (!globals.length) gl.innerHTML = '<div class="pm-empty">등록된 전역 레시피가 없습니다.</div>';
        else for (const r of globals) gl.appendChild(row(r));
        if (!proj) pl.innerHTML = '<div class="pm-empty">프로젝트 세션을 열면 전용 레시피를 관리할 수 있습니다.</div>';
        else if (!projs.length) pl.innerHTML = '<div class="pm-empty">이 프로젝트 전용 레시피가 없습니다.</div>';
        else for (const r of projs) pl.appendChild(row(r));

        m.querySelector('#rc-add-g').onclick = () => App.showRecipeModal(null, { scope: '', back });
        if (proj) m.querySelector('#rc-add-p').onclick = () => App.showRecipeModal(null, { scope: proj.id, back });
        m.querySelector('#m-close').onclick = close;
      });
  },

  showRecipeModal(existing, mgrOpts) {
    const opts = App.state.projects
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} 전용</option>`).join('');
    App.modal(`
      <h3>${existing ? '런치 레시피 수정' : '런치 레시피 추가'}</h3>
      <label>이름</label><input type="text" id="m-label" placeholder="예: 개발 서버 + AI">
      <label>명령 (한 줄 = 새 세션 하나)</label><textarea id="m-commands" placeholder="npm run dev&#10;claude&#10;cargo test"></textarea>
      <div class="form-help">각 줄마다 새 터미널 세션을 만들고 즉시 실행합니다. 변수: {branch}, {projectPath}, {projectName}, {session}, {clipboard}, {input:작업명}</div>
      <label>범위</label><select id="m-scope"><option value="">전역 (현재 프로젝트에서 실행)</option>${opts}</select>
      <div class="modal-actions">
        ${existing ? '<button id="m-del" class="danger">삭제</button>' : ''}
        <button id="m-cancel">취소</button><button id="m-save">저장</button>
      </div>`,
      (m, close) => {
        const finish = () => { close(); if (mgrOpts && mgrOpts.back) mgrOpts.back(); };
        const label = m.querySelector('#m-label');
        const commands = m.querySelector('#m-commands');
        const scope = m.querySelector('#m-scope');
        if (existing) {
          label.value = existing.label;
          commands.value = (existing.commands || []).join('\n');
          scope.value = existing.projectId || '';
        } else if (mgrOpts && mgrOpts.scope !== undefined) {
          scope.value = mgrOpts.scope;
        } else {
          const s = App.state.sessions.find((x) => x.id === App.state.activeId);
          if (s && s.projectId) scope.value = s.projectId;
        }
        m.querySelector('#m-cancel').onclick = finish;
        if (existing) m.querySelector('#m-del').onclick = async () => {
          try { await ta.removeRecipe(existing.id); }
          catch (e) { alert('삭제 실패: ' + e); return; }
          App.state.recipes = App.state.recipes.filter((r) => r.id !== existing.id);
          finish();
        };
        m.querySelector('#m-save').onclick = async () => {
          const list = commands.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          if (!label.value.trim() || !list.length) return alert('이름과 하나 이상의 명령을 입력하세요.');
          try {
            if (existing) {
              const patch = { label: label.value.trim(), commands: list };
              if (scope.value) patch.projectId = scope.value; else patch.clearProject = true;
              await ta.updateRecipe(existing.id, patch);
              Object.assign(existing, { label: patch.label, commands: list, projectId: scope.value || null });
            } else {
              const r = await ta.addRecipe({ label: label.value.trim(), commands: list, projectId: scope.value || null });
              App.state.recipes.push(r);
            }
          } catch (e) { alert('저장 실패: ' + e); return; }
          finish();
        };
        label.focus();
      });
  },

  // 프로젝트 색상 프리셋 12종 (다크 테마에서 서로 구분되는 계열)
  PRESET_COLORS: [
    '#4f8cc9', '#58a6ff', '#39c5cf', '#2dd4bf',
    '#3fb950', '#e3b341', '#d29922', '#f0883e',
    '#f85149', '#ec5f9c', '#a371f7', '#8b949e'
  ],

  // 컬러칩 UI 구성: 프리셋 12개 + 커스텀 1개. 현재 선택값을 돌려주는 getter 반환
  buildColorChips(container, initial) {
    let value = initial || App.PRESET_COLORS[0];
    const chips = [];
    const sync = () => chips.forEach((c) => c.el.classList.toggle('selected', c.get() === value));
    for (const col of App.PRESET_COLORS) {
      const el = document.createElement('div');
      el.className = 'color-chip';
      el.style.background = col;
      el.title = col;
      el.onclick = () => { value = col; sync(); };
      chips.push({ el, get: () => col });
      container.appendChild(el);
    }
    // 커스텀 칩: 클릭 시 네이티브 색상 선택기(input[type=color]) 열림
    const custom = document.createElement('div');
    custom.className = 'color-chip custom';
    custom.title = '커스텀 색상';
    const inp = document.createElement('input');
    inp.type = 'color';
    let customColor = null;
    if (initial && !App.PRESET_COLORS.includes(initial)) {
      customColor = initial;
      custom.style.background = initial;
      custom.classList.add('has-color');
      inp.value = initial;
    }
    inp.oninput = () => {
      customColor = inp.value;
      custom.style.background = customColor;
      custom.classList.add('has-color');
      value = customColor;
      sync();
    };
    custom.appendChild(inp);
    chips.push({ el: custom, get: () => customColor });
    container.appendChild(custom);
    sync();
    return () => value;
  },

  showProjectModal(existing) {
    App.modal(`
      <h3>${existing ? '프로젝트 수정' : '프로젝트 등록'}</h3>
      <label>이름</label><input type="text" id="m-name" placeholder="예: 내 게임 서버">
      <label>경로</label>
      <div class="row"><input type="text" id="m-path" placeholder="/Users/me/dev/project"><button id="m-browse" style="flex:0 0 auto">찾아보기…</button></div>
      <label>색상</label><div class="color-chips" id="m-chips"></div>
      <div class="modal-actions">
        ${existing ? '<button id="m-del" class="danger">삭제</button>' : ''}
        <button id="m-cancel">취소</button><button id="m-save">저장</button>
      </div>`,
      (m, close) => {
        const name = m.querySelector('#m-name'), path = m.querySelector('#m-path');
        const getColor = App.buildColorChips(m.querySelector('#m-chips'), existing ? existing.color : null);
        if (existing) { name.value = existing.name; path.value = existing.path; }
        m.querySelector('#m-browse').onclick = async () => {
          const p = await ta.pickFolder();
          if (p) { path.value = p; if (!name.value) name.value = p.split(/[\\/]/).filter(Boolean).pop(); }
        };
        m.querySelector('#m-cancel').onclick = close;
        if (existing) m.querySelector('#m-del').onclick = async () => {
          if (!confirm('프로젝트와 해당 프리셋을 삭제할까요? (열린 세션은 유지됩니다)')) return;
          try { await ta.removeProject(existing.id); }
          catch (e) { alert('삭제 실패: ' + e); return; }
          App.state.projects = App.state.projects.filter((p) => p.id !== existing.id);
          App.state.presets = App.state.presets.filter((p) => p.projectId !== existing.id);
          App.state.recipes = App.state.recipes.filter((r) => r.projectId !== existing.id);
          close(); App.renderAll();
        };
        m.querySelector('#m-save').onclick = async () => {
          if (!name.value.trim() || !path.value.trim()) return alert('이름과 경로를 입력하세요.');
          const chosen = getColor() || '#4f8cc9';
          try {
            if (existing) {
              const patch = { name: name.value.trim(), path: path.value.trim(), color: chosen };
              await ta.updateProject(existing.id, patch);
              Object.assign(existing, patch);
            } else {
              const p = await ta.addProject({ name: name.value.trim(), path: path.value.trim(), color: chosen });
              App.state.projects.unshift(p); // 백엔드와 같은 규칙 — 새 프로젝트는 목록 맨 앞
            }
          } catch (e) { alert('저장 실패: ' + e); return; }
          close(); App.renderAll();
        };
        name.focus();
      });
  },

  showPresetModal(existing, mgrOpts) {
    const opts = App.state.projects
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} 전용</option>`).join('');
    App.modal(`
      <h3>${existing ? '프리셋 수정' : '명령 프리셋 추가'}</h3>
      <label>이름(메뉴에 표시)</label><input type="text" id="m-label" placeholder="예: 빌드 & 테스트">
      <label>명령</label><input type="text" id="m-cmd" placeholder="예: npm run build && npm test">
      <div class="form-help">변수: {branch}, {projectPath}, {projectName}, {session}, {clipboard}, {input:작업명}</div>
      <label>범위</label><select id="m-scope"><option value="">전역 (모든 세션)</option>${opts}</select>
      <div class="modal-actions">
        ${existing ? '<button id="m-del" class="danger">삭제</button>' : ''}
        <button id="m-cancel">취소</button><button id="m-save">저장</button>
      </div>`,
      (m, close) => {
        const finish = () => { close(); App.renderPanePresets(); if (mgrOpts && mgrOpts.back) mgrOpts.back(); };
        const label = m.querySelector('#m-label'), cmd = m.querySelector('#m-cmd'), scope = m.querySelector('#m-scope');
        if (existing) { label.value = existing.label; cmd.value = existing.command; scope.value = existing.projectId || ''; }
        else if (mgrOpts && mgrOpts.scope !== undefined) {
          scope.value = mgrOpts.scope; // 관리 팝업에서 지정한 범위
        } else {
          // 기본 범위 = 현재 활성 세션의 프로젝트
          const s = App.state.sessions.find((x) => x.id === App.state.activeId);
          if (s && s.projectId) scope.value = s.projectId;
        }
        m.querySelector('#m-cancel').onclick = finish;
        if (existing) m.querySelector('#m-del').onclick = async () => {
          try { await ta.removePreset(existing.id); }
          catch (e) { alert('삭제 실패: ' + e); return; }
          App.state.presets = App.state.presets.filter((p) => p.id !== existing.id);
          finish();
        };
        m.querySelector('#m-save').onclick = async () => {
          if (!label.value.trim() || !cmd.value.trim()) return alert('이름과 명령을 입력하세요.');
          try {
            if (existing) {
              const patch = { label: label.value.trim(), command: cmd.value.trim() };
              if (scope.value) patch.projectId = scope.value; else patch.clearProject = true;
              await ta.updatePreset(existing.id, patch);
              Object.assign(existing, { label: patch.label, command: patch.command, projectId: scope.value || null });
            } else {
              const p = await ta.addPreset({ label: label.value.trim(), command: cmd.value.trim(), projectId: scope.value || null });
              App.state.presets.push(p);
            }
          } catch (e) { alert('저장 실패: ' + e); return; }
          finish();
        };
        label.focus();
      });
  },

  async showSettingsModal() {
    const st = App.state.settings;
    // 설치된 코딩 글꼴 감지 → 드롭다운. 과거 직접 입력값이 목록에 없으면 보존용으로 노출
    const curFont = st.fontFamily || '';
    const fonts = detectInstalledFonts(FONT_CANDIDATES);
    if (curFont && !fonts.includes(curFont)) fonts.unshift(curFont);
    const fontOptions = [`<option value="">기본 (Menlo · Consolas · D2Coding)</option>`]
      .concat(fonts.map((f) =>
        `<option value="${escapeHtml(f)}" style="font-family:'${escapeHtml(f)}'"${f === curFont ? ' selected' : ''}>${escapeHtml(f)}</option>`))
      .join('');
    // 연동 설치 여부는 외부 설정 파일(~/.claude, ~/.codex)이 진실 — 열 때마다 조회
    let hooks = { claude: false, codex: false };
    try { hooks = await ta.hooksStatus(); } catch (_) {}
    // 설치된 셸 자동 감지 — 수동 입력 대신 드롭다운에서 선택
    let shells = [{ label: 'OS 기본', value: '' }];
    try { shells = await ta.listShells(); } catch (_) {}
    // 과거 버전에서 직접 입력해 둔 값이 감지 목록에 없으면 보존용 항목으로 노출
    if (st.shell && !shells.some((s) => s.value === st.shell)) {
      shells.push({ label: `사용자 지정 (${st.shell})`, value: st.shell });
    }
    const shellOptions = shells.map((s) =>
      `<option value="${escapeHtml(s.value)}"${s.value === (st.shell || '') ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
    const themeChips = Theme.PRESETS.map((p) => `
      <button type="button" class="theme-chip${Theme.state.id === p.id ? ' selected' : ''}" data-theme-id="${p.id}" title="${p.bg} / ${p.accent}">
        <span class="theme-swatch" style="background:${p.bg}"><i class="theme-dot" style="background:${p.accent}"></i></span>
        <span class="theme-chip-name">${escapeHtml(p.name)}</span>
      </button>`).join('');
    App.modal(`
      <h3>설정</h3>
      <label>테마</label>
      <div class="theme-grid" id="m-theme-grid">${themeChips}</div>
      <label>직접 지정 (배경 / 강조색)</label>
      <div class="theme-custom">
        <input type="color" id="m-theme-bg-pick" value="${Theme.state.bg}" title="배경색">
        <input type="text" id="m-theme-bg" class="hex" value="${Theme.state.bg}" placeholder="#14161c" spellcheck="false">
        <input type="color" id="m-theme-accent-pick" value="${Theme.state.accent}" title="강조색">
        <input type="text" id="m-theme-accent" class="hex" value="${Theme.state.accent}" placeholder="#2e6cd6" spellcheck="false">
        <button id="m-theme-apply">적용</button>
      </div>
      <div class="form-help">배경 밝기로 라이트/다크를 판별해 글자·상태·프로젝트 색을 자동 보정합니다. 테마는 즉시 적용되며 저장 버튼과 무관하게 유지됩니다.</div>
      <label>글꼴 (선택하면 터미널에 즉시 반영)</label>
      <div class="font-row">
        <select id="m-font-family">${fontOptions}</select>
        <button type="button" id="m-font-pick" title="시스템 글꼴 폴더에서 파일 선택">파일에서 선택…</button>
      </div>
      <div class="form-help">목록은 자동 감지된 코딩 글꼴입니다. 다른 글꼴은 '파일에서 선택'으로 시스템 글꼴 폴더에서 고르세요. 지정 글꼴이 못 그리는 문자는 기본 글꼴로 대체됩니다.</div>
      <label>글꼴 크기</label><input type="number" id="m-font" min="9" max="24" value="${st.fontSize}">
      <label>가독성 (조절하면 터미널에 즉시 반영)</label>
      <div class="range-row"><span>줄 간격</span><input type="range" id="m-line-height" min="1" max="2" step="0.05" value="${Number(st.lineHeight) || 1}"><span id="m-line-height-v"></span></div>
      <div class="range-row"><span>자간</span><input type="range" id="m-letter-spacing" min="0" max="4" step="0.5" value="${Number(st.letterSpacing) || 0}"><span id="m-letter-spacing-v"></span></div>
      <div class="range-row"><span>최소 대비</span><input type="range" id="m-min-contrast" min="1" max="7" step="0.5" value="${Number(st.minContrast) || 1}"><span id="m-min-contrast-v"></span></div>
      <div class="form-help">최소 대비는 Claude/Codex 가 즐겨 쓰는 흐린 회색·dim 출력이 배경에 묻힐 때 글자색만 배경 대비 기준까지 자동으로 끌어올립니다 (1 = 끔, 4.5 = WCAG AA).</div>
      <label>셸</label><select id="m-shell">${shellOptions}</select>
      <div class="form-help">설치된 셸만 표시됩니다. 새로 만드는 세션부터 적용됩니다.</div>
      <div class="check"><input type="checkbox" id="m-notify" ${st.notifyOnDone ? 'checked' : ''}><label for="m-notify" style="margin:0">비활성 세션 작업 완료 시 알림</label></div>
      <div class="check"><input type="checkbox" id="m-notify-wait" ${st.notifyOnWaiting ? 'checked' : ''}><label for="m-notify-wait" style="margin:0">비활성 세션 허가 대기 시 알림</label></div>
      <div class="check"><input type="checkbox" id="m-show-prompt-input" ${st.showPromptInput === true ? 'checked' : ''}><label for="m-show-prompt-input" style="margin:0">하단 프롬프트 입력창 사용</label></div>
      <div class="form-help">기본적으로 숨깁니다. 사용하지 않으면 Cmd/Ctrl+J 커서 전환도 비활성화됩니다.</div>
      <label>AI 도구 연동 — 허가 대기(🟡) 감지</label>
      <div class="check"><input type="checkbox" id="m-hook-claude" ${hooks.claude ? 'checked' : ''}><label for="m-hook-claude" style="margin:0">Claude Code 훅 (~/.claude/settings.json 병합, 백업 생성)</label></div>
      <div class="check"><input type="checkbox" id="m-hook-codex" ${hooks.codex ? 'checked' : ''}><label for="m-hook-codex" style="margin:0">Codex 알림 (~/.codex/config.toml 병합, 백업 생성)</label></div>
      <details class="remote-section" id="m-remote">
        <summary>모바일 원격 제어</summary>
        <div id="m-remote-body"><div class="form-help">불러오는 중…</div></div>
      </details>
      <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-save">저장</button></div>`,
      (m, close) => {
        App.initRemoteSettings(m.querySelector('#m-remote-body'));
        // ── 테마: 즉시 적용 (렌더러 로컬 설정이라 저장 버튼과 별도로 유지된다) ──
        const bgHex = m.querySelector('#m-theme-bg');
        const accentHex = m.querySelector('#m-theme-accent');
        const bgPick = m.querySelector('#m-theme-bg-pick');
        const accentPick = m.querySelector('#m-theme-accent-pick');
        const syncThemeInputs = () => {
          bgHex.value = Theme.state.bg;
          accentHex.value = Theme.state.accent;
          bgPick.value = Theme.state.bg;
          accentPick.value = Theme.state.accent;
          for (const b of m.querySelectorAll('.theme-chip')) {
            b.classList.toggle('selected', b.dataset.themeId === Theme.state.id);
          }
        };
        for (const btn of m.querySelectorAll('.theme-chip')) {
          btn.onclick = () => { Theme.set(btn.dataset.themeId); syncThemeInputs(); };
        }
        bgPick.oninput = () => { bgHex.value = bgPick.value; };
        accentPick.oninput = () => { accentHex.value = accentPick.value; };
        m.querySelector('#m-theme-apply').onclick = () => {
          if (!Theme.set('custom', bgHex.value, accentHex.value)) { alert('색상은 #RRGGBB 형식으로 입력하세요.'); return; }
          syncThemeInputs();
        };

        // ── 글꼴: 선택 즉시 미리보기, 취소·Esc 시 원래 글꼴로 되돌린다 ──
        const fontSel = m.querySelector('#m-font-family');
        const fontBefore = curFont;
        const selectedFont = () => fontSel.value.trim();
        const previewFont = () => {
          App.state.settings.fontFamily = selectedFont();
          TerminalView.setFontFamily();
        };
        fontSel.onchange = previewFont;
        // 시스템 글꼴 폴더에서 파일을 고르면 그 파일의 패밀리 이름을 목록에 넣고 즉시 미리보기
        m.querySelector('#m-font-pick').onclick = async () => {
          let name = null;
          try { name = await ta.pickFont(); } catch (e) { alert('글꼴 읽기 실패: ' + e); return; }
          if (!name) return;
          if (![...fontSel.options].some((o) => o.value === name)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            opt.style.fontFamily = `'${name}'`;
            fontSel.add(opt, 1); // '기본' 바로 다음 위치
          }
          fontSel.value = name;
          previewFont();
        };

        // ── 가독성: 조절 즉시 터미널에 반영, 취소하면 원래 값으로 되돌린다 ──
        const readKeys = [
          ['#m-line-height', 'lineHeight', (n) => n.toFixed(2)],
          ['#m-letter-spacing', 'letterSpacing', (n) => n.toFixed(1) + 'px'],
          ['#m-min-contrast', 'minContrast', (n) => (n <= 1 ? '끔' : n.toFixed(1))]
        ];
        const readBefore = {};
        for (const [, key] of readKeys) readBefore[key] = App.state.settings[key];
        const previewRead = () => {
          for (const [sel, key] of readKeys) {
            App.state.settings[key] = Number(m.querySelector(sel).value);
          }
          TerminalView.applyReadability();
        };
        for (const [sel, , fmt] of readKeys) {
          const input = m.querySelector(sel);
          const out = m.querySelector(sel + '-v');
          const sync = () => { out.textContent = fmt(Number(input.value)); };
          input.oninput = () => { sync(); previewRead(); };
          sync();
        }
        // Esc 로 닫는 경로는 모달 공통 close() 만 부르므로, 캡처 단계에서 먼저 되돌린다
        const escRestore = (e) => { if (e.key === 'Escape') { restoreRead(); dropEscRestore(); } };
        const dropEscRestore = () => document.removeEventListener('keydown', escRestore, true);
        const restoreRead = () => {
          Object.assign(App.state.settings, readBefore);
          App.state.settings.fontFamily = fontBefore;
          TerminalView.applyReadability();
          TerminalView.setFontFamily();
        };
        document.addEventListener('keydown', escRestore, true);

        m.querySelector('#m-cancel').onclick = () => { dropEscRestore(); restoreRead(); close(); };
        m.querySelector('#m-save').onclick = async () => {
          dropEscRestore();
          const patch = {
            fontSize: Math.max(9, Math.min(24, Number(m.querySelector('#m-font').value) || 13)),
            fontFamily: selectedFont(),
            shell: m.querySelector('#m-shell').value,
            notifyOnDone: m.querySelector('#m-notify').checked,
            notifyOnWaiting: m.querySelector('#m-notify-wait').checked,
            showPromptInput: m.querySelector('#m-show-prompt-input').checked,
            lineHeight: Number(m.querySelector('#m-line-height').value),
            letterSpacing: Number(m.querySelector('#m-letter-spacing').value),
            minContrast: Number(m.querySelector('#m-min-contrast').value)
          };
          try { App.state.settings = await ta.updateSettings(patch); }
          catch (e) { restoreRead(); alert('저장 실패: ' + e); return; }
          // 연동 토글은 변경된 것만 반영 — 실패해도 설정 저장은 유지되므로 개별 보고
          const wantClaude = m.querySelector('#m-hook-claude').checked;
          const wantCodex = m.querySelector('#m-hook-codex').checked;
          try { if (wantClaude !== hooks.claude) await ta.setClaudeHooks(wantClaude); }
          catch (e) { alert('Claude Code 연동 실패: ' + e); }
          try { if (wantCodex !== hooks.codex) await ta.setCodexHooks(wantCodex); }
          catch (e) { alert('Codex 연동 실패: ' + e); }
          TerminalView.setFontSize(App.state.settings.fontSize);
          TerminalView.setFontFamily();
          TerminalView.applyReadability();
          close();
          TerminalView.syncComposerStates();
        };
      });
  }
});

// ── 모바일 원격 제어 설정 (설정 팝업 안의 접이식 섹션) ──
// 서버를 즉시 켜고 끄는 설정이라 팝업의 저장 버튼과 별개로 '적용' 시 바로 반영한다.
Object.assign(App, {
  _remotePairTimer: null,

  async initRemoteSettings(body) {
    let view;
    try { view = await ta.remoteGetConfig(); }
    catch (e) {
      body.innerHTML = '<div class="form-help warn"></div>';
      body.firstChild.textContent = '원격 설정을 불러오지 못했습니다: ' + e;
      return;
    }
    App.renderRemoteSettings(body, view);
  },

  renderRemoteSettings(body, view) {
    if (!body.isConnected) return;
    clearInterval(App._remotePairTimer);
    const push = view.push || {};
    const autoNote = String(view.bind || '').toLowerCase() === 'auto' && view.resolvedBind ? ` (auto → ${view.resolvedBind})` : '';
    const statusText = (view.running ? '실행 중' : view.enabled ? '중지됨 (오류)' : '꺼짐') + autoNote;
    body.innerHTML = `
      <div class="check"><input type="checkbox" id="m-rm-enabled" ${view.enabled ? 'checked' : ''}><label for="m-rm-enabled" style="margin:0">원격 서버 사용</label>
        <span class="remote-state${view.running ? ' on' : ''}" id="m-rm-state"></span></div>
      <div class="remote-row">
        <div><label>바인드 주소</label><input type="text" id="m-rm-bind" spellcheck="false" placeholder="auto 또는 127.0.0.1"></div>
        <div class="remote-port"><label>포트</label><input type="number" id="m-rm-port" min="1" max="65535"></div>
      </div>
      <div class="form-help"><b>auto</b> 는 이 컴퓨터의 Tailscale IP(100.x)를 찾아 바인드하고, IP 가 바뀌면 자동으로 다시 엽니다 (권장 — 상단 📱 버튼이 이 값으로 설정). 0.0.0.0·사설망 주소는 같은 네트워크의 누구나 접속을 시도할 수 있습니다 (HTTP 평문).</div>
      <div class="form-help warn hidden" id="m-rm-warn"></div>
      <div class="form-help warn hidden" id="m-rm-error"></div>
      <div class="remote-urls hidden" id="m-rm-urls"></div>
      <label>푸시 알림 (ntfy)</label>
      <div class="check"><input type="checkbox" id="m-rm-push" ${push.kind === 'ntfy' ? 'checked' : ''}><label for="m-rm-push" style="margin:0">ntfy 로 알림 보내기</label></div>
      <div class="remote-row">
        <div><label>서버</label><input type="text" id="m-rm-ntfy-url" spellcheck="false" placeholder="https://ntfy.sh"></div>
        <div><label>토픽</label><input type="text" id="m-rm-ntfy-topic" spellcheck="false"></div>
      </div>
      <div class="check"><input type="checkbox" id="m-rm-on-done" ${push.onDone ? 'checked' : ''}><label for="m-rm-on-done" style="margin:0">작업 완료 시</label></div>
      <div class="check"><input type="checkbox" id="m-rm-on-waiting" ${push.onWaiting ? 'checked' : ''}><label for="m-rm-on-waiting" style="margin:0">허가 대기 시</label></div>
      <div class="check"><input type="checkbox" id="m-rm-include-project" ${push.includeProject ? 'checked' : ''}><label for="m-rm-include-project" style="margin:0">알림에 프로젝트 이름 포함</label></div>
      <div class="form-help">기본은 세션 제목과 상태만 보냅니다. 공개 ntfy.sh 는 토픽을 아는 누구나 구독할 수 있으니 추측하기 어려운 토픽을 쓰세요.</div>
      <div class="form-help warn hidden" id="m-rm-push-warn"></div>
      <div class="remote-actions">
        <button type="button" id="m-rm-test">테스트 발송</button>
        <button type="button" id="m-rm-apply">원격 설정 적용</button>
      </div>
      <label>기기 페어링</label>
      <div class="remote-actions"><button type="button" id="m-rm-pair" ${view.running ? '' : 'disabled'}>페어링 시작</button></div>
      <div class="remote-pair hidden" id="m-rm-pairbox">
        <img id="m-rm-qr" alt="페어링 QR">
        <div class="remote-pair-info">
          <div class="remote-code" id="m-rm-code"></div>
          <div class="form-help" id="m-rm-expire"></div>
          <div class="remote-url" id="m-rm-pair-url"></div>
        </div>
      </div>
      <label>연결된 기기</label>
      <div class="remote-devices" id="m-rm-devices"></div>`;

    // 사용자·백엔드 값은 전부 textContent/value 로 넣는다 (템플릿 문자열에 끼우지 않는다)
    const $ = (sel) => body.querySelector(sel);
    $('#m-rm-state').textContent = statusText;
    $('#m-rm-bind').value = view.bind || '';
    $('#m-rm-port').value = view.port || '';
    $('#m-rm-ntfy-url').value = push.url || '';
    $('#m-rm-ntfy-topic').value = push.topic || '';
    if (view.bindWarning) { $('#m-rm-warn').textContent = '⚠ ' + view.bindWarning; $('#m-rm-warn').classList.remove('hidden'); }
    if (view.pushWarning) { $('#m-rm-push-warn').textContent = '⚠ ' + view.pushWarning; $('#m-rm-push-warn').classList.remove('hidden'); }
    if (view.error) { $('#m-rm-error').textContent = '서버 오류: ' + view.error; $('#m-rm-error').classList.remove('hidden'); }
    const urls = view.running ? (view.urls || []) : [];
    if (urls.length) {
      const box = $('#m-rm-urls');
      box.classList.remove('hidden');
      const head = document.createElement('div');
      head.className = 'form-help';
      head.textContent = '접속 주소';
      box.appendChild(head);
      for (const u of urls) {
        const row = document.createElement('div');
        row.className = 'remote-url';
        row.textContent = u;
        box.appendChild(row);
      }
    }
    App.renderRemoteDevices($('#m-rm-devices'), view.devices || [], body);

    const readCfg = () => ({
      enabled: $('#m-rm-enabled').checked,
      bind: $('#m-rm-bind').value.trim() || '127.0.0.1',
      port: Math.max(1, Math.min(65535, Math.floor(Number($('#m-rm-port').value)) || 7788)),
      push: {
        kind: $('#m-rm-push').checked ? 'ntfy' : 'off',
        url: $('#m-rm-ntfy-url').value.trim() || 'https://ntfy.sh',
        topic: $('#m-rm-ntfy-topic').value.trim(),
        onDone: $('#m-rm-on-done').checked,
        onWaiting: $('#m-rm-on-waiting').checked,
        includeProject: $('#m-rm-include-project').checked
      }
    });
    const apply = async () => {
      const cfg = readCfg();
      if (cfg.push.kind === 'ntfy' && !cfg.push.topic) { alert('ntfy 토픽을 입력하세요.'); return null; }
      if (needsRemoteBindConfirm(view, cfg) && !confirm(remoteBindConfirmText(remoteBindLevel(cfg.bind)))) return null;
      try {
        const next = await ta.remoteSetConfig(cfg);
        App.renderRemoteSettings(body, next);
        return next;
      } catch (e) { alert('원격 설정 적용 실패: ' + e); return null; }
    };
    $('#m-rm-apply').onclick = () => { void apply(); };
    // 테스트는 저장된 설정으로 보낸다 — 화면 값이 다르면 먼저 적용한다
    $('#m-rm-test').onclick = async () => {
      const btn = $('#m-rm-test');
      const pick = (x) => JSON.stringify({ kind: x.kind, url: x.url, topic: x.topic, includeProject: !!x.includeProject });
      if (pick(readCfg().push) !== pick(push)) {
        if (!(await apply())) return;
        // apply 가 섹션을 다시 그렸으므로 새 버튼에서 이어서 보낸다
        return void body.querySelector('#m-rm-test').onclick();
      }
      btn.disabled = true;
      try { await ta.remoteTestPush(); btn.textContent = '발송됨 ✓'; }
      catch (e) { alert('테스트 발송 실패: ' + e); }
      finally { btn.disabled = false; setTimeout(() => { btn.textContent = '테스트 발송'; }, 2000); }
    };
    $('#m-rm-pair').onclick = () => { void App.startRemotePairing(body); };
  },

  // onRevoked(view): 폐기 후 다시 그리기 — 생략하면 설정 섹션을 다시 그린다
  renderRemoteDevices(box, devices, body, onRevoked) {
    box.textContent = '';
    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'form-help';
      empty.textContent = '페어링된 기기가 없습니다.';
      box.appendChild(empty);
      return;
    }
    const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'remote-device';
      const main = document.createElement('div');
      main.className = 'remote-device-main';
      const name = document.createElement('div');
      name.className = 'remote-device-name';
      name.textContent = d.name || d.id;
      const meta = document.createElement('div');
      meta.className = 'form-help';
      meta.textContent = '등록 ' + fmt(d.createdMs) + ' · 마지막 접속 ' + fmt(d.lastSeenMs);
      // Tailscale 상 온라인 여부 — 폰이 VPN 을 끊으면 PC 에 닿을 수 없다
      const st = remoteDeviceStatus(d);
      const dot = document.createElement('span');
      dot.className = 'remote-dot ' + st;
      dot.title = st === 'online' ? 'Tailscale 온라인' : st === 'offline' ? 'Tailscale 오프라인' : 'Tailscale 상태 알 수 없음';
      name.prepend(dot);
      main.append(name, meta);
      if (d.needsRepair) {
        const re = document.createElement('div');
        re.className = 'form-help warn';
        re.textContent = '재페어링 필요 — HTTPS 로 바뀌기 전에 연결한 기기입니다. 새 QR 로 다시 페어링하세요.';
        main.appendChild(re);
      }
      if (st === 'offline') {
        const help = document.createElement('div');
        help.className = 'form-help warn';
        const seen = d.tailscaleLastSeen ? ' (마지막 ' + new Date(d.tailscaleLastSeen).toLocaleString() + ')' : '';
        help.textContent = '폰의 Tailscale 이 꺼져 있습니다' + seen + '. ' + remoteOfflineHelp(d.platform);
        main.appendChild(help);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '폐기';
      // 2단계 확인 — 폐기하면 그 기기는 다시 페어링해야 한다
      btn.onclick = async () => {
        if (!btn.classList.contains('armed')) {
          btn.classList.add('armed');
          btn.textContent = '정말 폐기';
          setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = '폐기'; } }, 3000);
          return;
        }
        try {
          const next = await ta.remoteRevokeDevice(d.id);
          if (onRevoked) onRevoked(next); else App.renderRemoteSettings(body, next);
        }
        catch (e) { alert('기기 폐기 실패: ' + e); }
      };
      row.append(main, btn);
      box.appendChild(row);
    }
  },

  async startRemotePairing(body) {
    let p;
    try { p = await ta.remoteStartPairing(); }
    catch (e) { alert('페어링 시작 실패: ' + e); return; }
    if (!body.isConnected) return;
    const $ = (sel) => body.querySelector(sel);
    $('#m-rm-pairbox').classList.remove('hidden');
    // SVG 는 img 의 data URL 로만 띄운다 — img 로 렌더한 SVG 는 스크립트·외부 리소스를 실행하지 않는다
    $('#m-rm-qr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.qrSvg || '');
    $('#m-rm-code').textContent = p.code;
    $('#m-rm-pair-url').textContent = p.url;
    const expireEl = $('#m-rm-expire');
    // 절대 시각(epoch ms)과 남은 시간(ms) 어느 쪽으로 와도 같은 마감 시각으로 맞춘다
    const expiresAt = p.expiresMs > 1e12 ? p.expiresMs : Date.now() + (p.expiresMs || 0);
    const knownDevices = body.querySelectorAll('.remote-device').length;
    let ticks = 0;
    clearInterval(App._remotePairTimer);
    const tick = () => {
      // 팝업이 닫혔거나 섹션이 다시 그려졌으면 멈춘다
      const bd = document.getElementById('modal-backdrop');
      if (!expireEl.isConnected || (bd && bd.classList.contains('hidden'))) { clearInterval(App._remotePairTimer); return; }
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      // 폰에서 페어링을 마치면 기기 목록이 늘어난다 — 3초마다 확인해 QR 을 거둔다
      if (left && ++ticks % 3 === 0) {
        ta.remoteGetConfig().then((v) => {
          if (!expireEl.isConnected || (v.devices || []).length <= knownDevices) return;
          clearInterval(App._remotePairTimer);
          App.renderRemoteSettings(body, v);
        }).catch(() => {});
      }
      if (!left) {
        clearInterval(App._remotePairTimer);
        expireEl.textContent = '코드가 만료되었습니다. 다시 시작하세요.';
        $('#m-rm-pairbox').classList.add('expired');
        // 만료 시점에 페어링이 끝났을 수 있으니 기기 목록을 새로 받는다
        ta.remoteGetConfig().then((v) => App.renderRemoteDevices($('#m-rm-devices'), v.devices || [], body)).catch(() => {});
        return;
      }
      expireEl.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' 후 만료 · 1회용';
    };
    $('#m-rm-pairbox').classList.remove('expired');
    tick();
    App._remotePairTimer = setInterval(tick, 1000);
  },

  // ── 📱 폰 연결 (원클릭) ──
  _remoteView: null,
  _phone: null, // 열린 폰 연결 모달의 현재 요청 { root, baseline, timer, devKey }

  onRemoteStatus(view) {
    if (!view) return;
    App._remoteView = view;
    const btn = document.getElementById('btn-phone');
    if (btn) {
      const n = view.connectedDevices || 0;
      btn.classList.toggle('connected', n > 0);
      btn.title = n > 0 ? `폰 연결 — ${n}대 연결됨` : '폰 연결 — QR 로 폰에서 이 앱의 세션을 보고 조작합니다';
    }
    const ph = App._phone;
    if (!ph || !ph.root.isConnected) return;
    const devBox = ph.root.querySelector('#pc-devices');
    if (devBox) App.renderPhoneDevices(ph, devBox, view);
    if (ph.baseline && remotePhoneConnected(ph.baseline, view)) {
      const done = ph.root.querySelector('#pc-done');
      if (done) done.classList.remove('hidden');
    }
  },

  // opts.wizard: 모두 끝난 사용자도 요약 대신 단계 화면을 본다 ('설정 다시 보기')
  showPhoneConnectModal(opts) {
    App.modal(`
      <h3>📱 폰 연결</h3>
      <div id="pc-root" class="phone-connect"><div class="form-help">상태 확인 중…</div></div>
      <div class="modal-actions"><button id="pc-close">닫기</button></div>`,
    (m, close) => {
      m.querySelector('#pc-close').onclick = close;
      void App.startPhoneWizard(m.querySelector('#pc-root'), !!(opts && opts.wizard));
    }, { wide: true });
  },

  // ── 단계별 마법사: 3초마다 상태를 다시 읽어 끝난 단계를 접고 다음으로 넘어간다 ──
  _wizard: null,

  stopPhoneWizard(wz) {
    const cur = wz || App._wizard;
    if (!cur) return;
    clearInterval(cur.timer);
    cur.timer = null;
    if (App._wizard === cur) App._wizard = null;
  },

  async startPhoneWizard(root, forceWizard) {
    App.stopPhoneWizard();
    const wz = { root, timer: null, key: null, forceWizard, st: null };
    App._wizard = wz;
    const poll = async () => {
      const bd = document.getElementById('modal-backdrop');
      if (!phoneWizardShouldPoll(App._wizard === wz, root.isConnected, !!(bd && bd.classList.contains('hidden')))) {
        App.stopPhoneWizard(wz);
        return;
      }
      let st = null;
      try { st = await ta.remoteSetupStatus(); } catch (_) {}
      if (App._wizard !== wz || !root.isConnected) return;
      App.renderPhoneWizard(wz, st);
    };
    wz.poll = poll;
    await poll();
    if (App._wizard === wz && !wz.timer && !wz.summary) wz.timer = setInterval(poll, PHONE_WIZARD_POLL_MS);
  },

  renderPhoneWizard(wz, st) {
    const root = wz.root;
    if (!st) {
      if (wz.key !== 'error') {
        wz.key = 'error';
        root.innerHTML = '<div class="form-help warn">Tailscale 상태를 확인하지 못했습니다. 잠시 후 다시 시도합니다.</div>';
      }
      return;
    }
    wz.st = st;
    const plan = phoneWizardPlan(st, phoneWizardFlags());
    if (plan.allDone && !wz.forceWizard) {
      // 요약은 한 번 그리고 폴링을 멈춘다 — 기기 목록은 ta:remote-status 로 갱신된다
      App.stopPhoneWizard(wz);
      wz.summary = true;
      App._wizard = wz;
      void App.renderPhoneSummary(wz, st);
      return;
    }
    // 현재 단계 본문이 같으면 머리글(✓·안내)만 고친다 — 진행 중인 페어링 코드를 재발급하지 않게
    const bodyKey = phoneWizardBodyKey(plan, st);
    if (wz.key === bodyKey && wz.list && wz.list.isConnected) {
      App.updateWizardHeads(wz.list, plan);
      return;
    }
    wz.key = bodyKey;
    root.textContent = '';
    const list = document.createElement('div');
    list.className = 'pw-steps';
    plan.steps.forEach((step, i) => {
      const el = document.createElement('div');
      el.dataset.step = step.id;
      const head = document.createElement('div');
      head.className = 'pw-head';
      const badge = document.createElement('span');
      badge.className = 'pw-badge';
      badge.dataset.n = String(i + 1);
      const title = document.createElement('span');
      title.textContent = step.title;
      head.append(badge, title);
      const note = document.createElement('div');
      note.className = 'form-help warn pw-note';
      el.append(head, note);
      if (step.id === plan.current) {
        const body = document.createElement('div');
        body.className = 'pw-body';
        el.appendChild(body);
        App.renderWizardStep(wz, step.id, body, st);
      }
      list.appendChild(el);
    });
    root.appendChild(list);
    wz.list = list;
    App.updateWizardHeads(list, plan);
  },

  updateWizardHeads(list, plan) {
    for (const step of plan.steps) {
      const el = list.querySelector(`[data-step="${step.id}"]`);
      if (!el) continue;
      el.className = 'pw-step' + (step.done ? ' done' : '') + (step.id === plan.current ? ' current' : '');
      const badge = el.querySelector('.pw-badge');
      badge.textContent = step.done ? '✓' : badge.dataset.n;
      const note = el.querySelector('.pw-note');
      note.textContent = step.note || '';
      note.classList.toggle('hidden', !step.note);
    }
  },

  renderWizardStep(wz, id, body, st) {
    const btn = (label, fn, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.onclick = fn;
      return b;
    };
    const help = (text, cls) => {
      const d = document.createElement('div');
      d.className = cls || 'form-help';
      d.textContent = text;
      body.appendChild(d);
      return d;
    };
    const actions = document.createElement('div');
    actions.className = 'remote-actions';
    const recheck = () => { wz.key = null; void wz.poll(); };
    if (id === 'mac') {
      if (st.macTailscale === 'missing') {
        help('이 PC 에 Tailscale 이 없습니다. 설치하고 로그인하면 자동으로 다음 단계로 넘어갑니다.');
        actions.append(btn('Tailscale 다운로드', () => { ta.openUrl(tailscaleDownloadUrl(st.hostOs)).catch(() => {}); }, true));
      } else {
        help(st.macTailscale === 'needs-login'
          ? 'Tailscale 에 로그인이 필요합니다. 앱을 열어 로그인하세요 (폰과 같은 계정).'
          : 'Tailscale 이 꺼져 있습니다. 앱을 열어 Connect 를 누르세요.');
        actions.append(btn('Tailscale 열기', async () => {
          try { await ta.remoteOpenTailscale(); } catch (e) { alert(String(e)); }
        }, true));
      }
      actions.append(btn('다시 확인', recheck));
      body.appendChild(actions);
      return;
    }
    if (id === 'phone') {
      help('폰에 Tailscale 앱을 설치하고 이 PC 와 같은 계정으로 로그인하세요. 폰이 tailnet 에 보이면 자동으로 넘어갑니다.');
      const note = document.createElement('div');
      note.className = 'form-help';
      note.innerHTML = SAMSUNG_WALLET_NOTE;
      body.appendChild(note);
      const qrs = document.createElement('div');
      qrs.className = 'pw-qrs';
      for (const [label, url] of [['Android (Play 스토어)', STORE_URL_ANDROID], ['iPhone (App Store)', STORE_URL_IOS]]) {
        const cell = document.createElement('div');
        cell.className = 'pw-qr';
        const img = document.createElement('img');
        img.className = 'phone-qr small';
        img.alt = label + ' QR';
        const cap = document.createElement('div');
        cap.className = 'form-help';
        cap.textContent = label;
        cell.append(img, cap);
        qrs.appendChild(cell);
        ta.remoteQr(url).then((svg) => {
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        }).catch(() => { cap.textContent = label + ' — ' + url; });
      }
      body.appendChild(qrs);
      return;
    }
    if (id === 'https') {
      help('Tailscale 관리 페이지 → DNS → HTTPS Certificates 에서 Enable 을 누르세요. 크롬 앱 설치·연결 안내·암호화가 좋아집니다.');
      actions.append(
        btn('Tailscale DNS 설정 열기', () => { ta.openUrl(TAILSCALE_DNS_ADMIN_URL).catch(() => {}); }, true),
        btn('켰어요, 다시 확인', recheck),
        btn('건너뛰기 (HTTP 로 진행)', () => { phoneWizardSetFlag(PHONE_HTTPS_SKIP_KEY); recheck(); })
      );
      body.appendChild(actions);
      return;
    }
    if (id === 'pair') {
      const box = document.createElement('div');
      box.dataset.compact = '1';
      body.appendChild(box);
      void App.runPhoneConnect(box);
      return;
    }
    // finish
    help('폰에서 열린 페이지를 홈 화면에 추가하세요 — Android 크롬: 메뉴(⋮) → 앱 설치 / iPhone 사파리: 공유 → 홈 화면에 추가.');
    const push = document.createElement('div');
    body.appendChild(push);
    const ph = { root: body, baseline: null, timer: null, devKey: null };
    App._phone = ph;
    ta.remoteGetConfig().then((v) => {
      if (App._phone === ph && push.isConnected) App.renderPhonePush(ph, push, v, null);
    }).catch(() => {});
    actions.append(btn('완료', () => { phoneWizardSetFlag(PHONE_FINISH_KEY); wz.forceWizard = false; recheck(); }, true));
    body.appendChild(actions);
  },

  async renderPhoneSummary(wz, st) {
    const root = wz.root;
    let view = App._remoteView;
    try { view = await ta.remoteGetConfig(); } catch (_) {}
    if (App._wizard !== wz || !root.isConnected) return;
    view = view || {};
    root.innerHTML = `
      <div class="pw-summary-line" id="pw-sum-line"></div>
      <label>페어링된 기기</label>
      <div class="remote-devices" id="pc-devices"></div>
      <div class="remote-actions">
        <button type="button" id="pw-open" class="primary">📱 폰에서 열기</button>
        <button type="button" id="pw-add">새 기기 추가</button>
        <button type="button" id="pw-again">설정 다시 보기</button>
      </div>
      <div id="pw-add-box"></div>
      <label>폰 알림</label>
      <div id="pc-push"></div>`;
    const $ = (sel) => root.querySelector(sel);
    $('#pw-sum-line').textContent = phoneSummaryLine(st, view);
    const ph = { root, baseline: null, timer: null, devKey: null };
    App._phone = ph;
    App.renderPhoneDevices(ph, $('#pc-devices'), view);
    App.renderPhonePush(ph, $('#pc-push'), view, null);
    $('#pw-open').onclick = () => { void App.openOnPhone(App.state && App.state.activeId); };
    $('#pw-add').onclick = () => {
      const box = $('#pw-add-box');
      box.dataset.compact = '1';
      void App.runPhoneConnect(box);
    };
    $('#pw-again').onclick = () => { void App.startPhoneWizard(root, true); };
  },

  // 요청마다 새 ph — 늦게 온 이전 응답이 새 화면을 덮어쓰지 않게 한다
  async runPhoneConnect(root) {
    if (App._phone) clearInterval(App._phone.timer);
    const ph = { root, baseline: null, timer: null, devKey: null };
    App._phone = ph;
    const btns = root.querySelectorAll('button');
    for (const b of btns) b.disabled = true;
    if (btns.length) {
      const busy = document.createElement('div');
      busy.className = 'form-help';
      busy.textContent = '연결 준비 중…';
      root.prepend(busy);
    }
    let r;
    try { r = await ta.remoteQuickConnect(); }
    catch (e) { r = { ok: false, reason: 'start-failed', error: String(e) }; }
    if (App._phone !== ph || !root.isConnected) return;
    if (r.view) App.onRemoteStatus(r.view);
    if (!r.ok) { App.renderPhoneFailure(ph, r); return; }
    App.renderPhonePairing(ph, r);
  },

  renderPhoneFailure(ph, r) {
    const root = ph.root;
    const noTs = r.reason === 'no-tailscale';
    root.innerHTML = `
      <div class="phone-fail">
        <div class="phone-fail-title"></div>
        <div class="form-help" id="pc-fail-detail"></div>
        <div class="remote-actions">
          ${noTs ? '<button type="button" id="pc-ts-open">Tailscale 설치 페이지 열기</button>' : ''}
          <button type="button" id="pc-retry" class="primary"></button>
        </div>
      </div>`;
    root.querySelector('.phone-fail-title').textContent = noTs
      ? '이 컴퓨터에 Tailscale 이 연결돼 있지 않습니다'
      : '원격 서버를 시작하지 못했습니다';
    root.querySelector('#pc-fail-detail').textContent = noTs
      ? '폰과 이 컴퓨터를 안전하게 잇기 위해 Tailscale(무료 VPN)을 씁니다. 이 컴퓨터에 설치하고 로그인한 뒤 다시 시도하세요.'
      : (r.error || '알 수 없는 오류') + ' — 설정 → 모바일 원격 제어에서 포트를 바꿔 볼 수 있습니다.';
    root.querySelector('#pc-retry').textContent = noTs ? '설치 후 다시 시도' : '다시 시도';
    root.querySelector('#pc-retry').onclick = () => { void App.runPhoneConnect(root); };
    const open = root.querySelector('#pc-ts-open');
    if (open) open.onclick = () => { ta.openUrl(TAILSCALE_DOWNLOAD_URL).catch((e) => alert('링크 열기 실패: ' + e)); };
  },

  renderPhonePairing(ph, r) {
    const root = ph.root;
    const p = r.pairing;
    // 마법사·요약 안에서 쓰일 때 — 다른 단계가 맡는 섹션은 빼고 QR 만
    const compact = root.dataset.compact === '1';
    root.innerHTML = `
      <div class="form-help warn hidden" id="pc-changed"></div>
      <div class="phone-pair">
        <img id="pc-qr" class="phone-qr" alt="페어링 QR">
        <div class="phone-code" id="pc-code"></div>
        <div class="form-help" id="pc-expire"></div>
        <div class="phone-done hidden" id="pc-done">연결됨 ✓</div>
      </div>
      <ol class="phone-steps">
        <li>폰에 <a href="#" id="pc-ts">Tailscale</a> 을 설치하고 이 컴퓨터와 <b>같은 계정</b>으로 로그인 (VPN On Demand·상시 VPN 을 켜 두면 편합니다)
          <div class="phone-steps-note">${SAMSUNG_WALLET_NOTE}</div></li>
        <li>폰 카메라로 QR 스캔 — 또는 아래 주소를 열고 코드 입력</li>
        <li>열린 페이지를 <b>홈 화면에 추가</b> — 다음부터 아이콘으로 바로 접속</li>
      </ol>
      <div class="remote-url" id="pc-url"></div>
      ${compact ? '' : `<div id="pc-https"></div>
      <label>페어링된 기기</label>
      <div class="remote-devices" id="pc-devices"></div>`}
      <div class="remote-actions"><button type="button" id="pc-new">새 코드</button></div>
      ${compact ? '' : `<label>폰 알림 · 폰에서 열기</label>
      <div id="pc-push"></div>`}`;
    const $ = (sel) => root.querySelector(sel);
    if (r.changedFrom) {
      $('#pc-changed').textContent = `바인드 주소를 ${r.changedFrom} → auto(Tailscale) 로 바꿨습니다.`;
      $('#pc-changed').classList.remove('hidden');
    }
    // SVG 는 img 의 data URL 로만 — img 로 렌더한 SVG 는 스크립트를 실행하지 않는다
    $('#pc-qr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.qrSvg || '');
    $('#pc-code').textContent = p.code;
    $('#pc-url').textContent = p.url;
    $('#pc-ts').onclick = (e) => { e.preventDefault(); ta.openUrl(TAILSCALE_DOWNLOAD_URL).catch(() => {}); };
    $('#pc-new').onclick = () => { void App.runPhoneConnect(root); };
    const view = r.view || App._remoteView || {};
    ph.baseline = remotePhoneBaseline(view);
    if (!compact) {
      App.renderPhoneHttps(ph, $('#pc-https'), view);
      App.renderPhonePush(ph, $('#pc-push'), view, null);
      App.renderPhoneDevices(ph, $('#pc-devices'), view);
    }
    const expiresAt = p.expiresMs > 1e12 ? p.expiresMs : Date.now() + (p.expiresMs || 0);
    let timer = null;
    const tick = () => {
      const bd = document.getElementById('modal-backdrop');
      if (!root.isConnected || (bd && bd.classList.contains('hidden')) || App._phone !== ph) {
        clearInterval(timer);
        if (App._phone === ph) App._phone = null;
        return;
      }
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (!left) {
        clearInterval(timer);
        $('#pc-expire').textContent = '코드가 만료되었습니다 — 새 코드를 누르세요.';
        $('#pc-qr').classList.add('expired');
        return;
      }
      $('#pc-expire').textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' 후 만료 · 1회용';
    };
    tick();
    timer = setInterval(tick, 1000);
    ph.timer = timer;
  },

  // HTTPS(tailscale serve) 권장 안내 — 이미 HTTPS 면 상태 한 줄만
  renderPhoneHttps(ph, box, view) {
    box.textContent = '';
    if (view.mode === 'https') {
      const ok = document.createElement('div');
      ok.className = 'form-help';
      ok.textContent = '🔒 HTTPS 로 연결됩니다 (Tailscale 인증서)';
      box.appendChild(ok);
      return;
    }
    const advice = remoteHttpsAdvice(view);
    if (!advice) return;
    box.innerHTML = `
      <div class="phone-https">
        <div class="phone-https-title">HTTPS 켜기 (권장)</div>
        <ul class="phone-https-why">
          <li>크롬에서 '앱 설치'(홈 화면 앱)가 제대로 동작합니다</li>
          <li>PC 에 연결할 수 없을 때 앱이 안내 화면을 띄울 수 있습니다</li>
          <li>Tailscale 위에서 한 번 더 TLS 로 암호화됩니다</li>
        </ul>
        <div class="form-help warn hidden" id="pc-https-err"></div>
        <div class="form-help">Tailscale 관리 페이지 → DNS → <b>HTTPS Certificates</b> 의 Enable 을 누르세요. 전환하면 기존 기기는 주소가 바뀌어 한 번 다시 페어링해야 합니다.</div>
        <div class="remote-actions">
          <button type="button" id="pc-https-open">Tailscale DNS 설정 열기</button>
          <button type="button" id="pc-https-recheck" class="primary">켰어요, 다시 확인</button>
        </div>
      </div>`;
    if (advice === 'error' && view.httpsError) {
      const e = box.querySelector('#pc-https-err');
      e.textContent = 'HTTPS 전환 실패 — HTTP 로 동작 중: ' + view.httpsError;
      e.classList.remove('hidden');
    }
    box.querySelector('#pc-https-open').onclick = () => {
      ta.openUrl(TAILSCALE_DNS_ADMIN_URL).catch((e) => alert('링크 열기 실패: ' + e));
    };
    box.querySelector('#pc-https-recheck').onclick = () => { void App.runPhoneConnect(ph.root); };
  },

  // 폰 알림(ntfy) 원클릭 + 구독 QR + '폰에서 열기'
  renderPhonePush(ph, box, view, setup) {
    box.textContent = '';
    const on = view.push && view.push.kind === 'ntfy';
    const actions = document.createElement('div');
    actions.className = 'remote-actions';
    const help = document.createElement('div');
    help.className = 'form-help';
    if (!on) {
      help.textContent = '작업 완료·허가 대기 알림을 폰으로 받고, 알림을 누르면 그 세션이 바로 열립니다 (ntfy 앱). '
        + '알림 링크에는 이 PC 의 접속 주소(Tailscale 이름·IP)가 포함됩니다.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = '폰 알림 켜기';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await ta.remoteEnablePush();
          if (App._phone !== ph || !box.isConnected) return;
          App.onRemoteStatus(r.view);
          App.renderPhonePush(ph, box, r.view, r);
        } catch (e) { alert('알림 설정 실패: ' + e); btn.disabled = false; }
      };
      actions.appendChild(btn);
      box.append(help, actions);
      return;
    }
    if (setup) {
      const wrap = document.createElement('div');
      wrap.className = 'phone-pair';
      const img = document.createElement('img');
      img.className = 'phone-qr small';
      img.alt = 'ntfy 구독 QR';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(setup.qrSvg || '');
      const t = document.createElement('div');
      t.className = 'form-help';
      t.textContent = '폰에 ntfy 앱을 설치하고 이 QR 을 찍어 구독하세요. 앱에서 직접 추가: ' + setup.deepLink;
      const u = document.createElement('div');
      u.className = 'remote-url';
      u.textContent = setup.subscribeUrl;
      wrap.append(img, t, u);
      box.appendChild(wrap);
    } else {
      help.textContent = '폰 알림 켜짐 (ntfy). 알림을 누르면 해당 세션이 폰에서 열립니다. 알림 링크에는 이 PC 의 접속 주소가 포함됩니다.';
      box.appendChild(help);
      const qr = document.createElement('button');
      qr.type = 'button';
      qr.textContent = '구독 QR 보기';
      qr.onclick = async () => {
        try {
          const r = await ta.remoteEnablePush();
          if (App._phone === ph && box.isConnected) App.renderPhonePush(ph, box, r.view, r);
        } catch (e) { alert('알림 설정 실패: ' + e); }
      };
      actions.appendChild(qr);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = '📱 폰에서 열기';
    open.title = '현재 세션을 폰에서 여는 알림을 보냅니다';
    open.onclick = () => { void App.openOnPhone(App.state && App.state.activeId); };
    actions.appendChild(open);
    box.appendChild(actions);
  },

  // ntfy 로 '폰에서 열기' 알림 — 미설정이면 📱 모달로 설정을 유도한다
  async openOnPhone(sessionId) {
    try {
      await ta.remoteOpenOnPhone(sessionId || null);
      App.showToast('폰으로 보냈습니다 — 알림을 누르면 열립니다');
    } catch (e) {
      const kind = remoteOpenOnPhoneError(e);
      if (kind === 'other') { alert('폰에서 열기 실패: ' + e); return; }
      App.showToast(kind === 'setup-push' ? '먼저 폰 알림을 켜세요' : '먼저 폰을 연결하세요');
      App.showPhoneConnectModal();
    }
  },

  // 세션 우클릭 메뉴 (사이드바) — 지금은 '폰에서 열기' 하나
  showSessionPhoneMenu(ev, sessionId) {
    App.closeTerminalContextMenu();
    const menu = document.createElement('div');
    menu.className = 'term-context-menu';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'term-context-item';
    btn.textContent = '📱 폰에서 열기';
    btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
    btn.onclick = (e) => {
      e.stopPropagation();
      App.closeTerminalContextMenu();
      void App.openOnPhone(sessionId);
    };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(ev.clientX, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(0, Math.min(ev.clientY, window.innerHeight - rect.height - 6)) + 'px';
    const closeOnOutside = (e) => { if (!menu.contains(e.target)) App.closeTerminalContextMenu(); };
    const closeOnKey = (e) => { if (e.key === 'Escape') App.closeTerminalContextMenu(); };
    const closeNow = () => App.closeTerminalContextMenu();
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnKey, true);
    window.addEventListener('blur', closeNow);
    // 터미널 메뉴와 같은 슬롯을 써서 둘이 동시에 뜨지 않게 한다
    App._termMenu = {
      el: menu,
      cleanup: () => {
        document.removeEventListener('mousedown', closeOnOutside, true);
        document.removeEventListener('keydown', closeOnKey, true);
        window.removeEventListener('blur', closeNow);
      }
    };
  },

  // 상태 통지가 잦아도(연결 수 변화 등) 목록이 바뀐 경우에만 다시 그린다 — 폐기 버튼 2단계 확인이 풀리지 않게
  renderPhoneDevices(ph, box, view) {
    const devices = view.devices || [];
    const key = remoteDevicesKey(devices);
    if (ph.devKey === key && box.childNodes.length) return;
    ph.devKey = key;
    App.renderRemoteDevices(box, devices, null, (next) => App.onRemoteStatus(next));
  }
});

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';
const STORE_URL_ANDROID = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
const STORE_URL_IOS = 'https://apps.apple.com/app/tailscale/id1470499037';
const PHONE_WIZARD_POLL_MS = 3000;
const PHONE_HTTPS_SKIP_KEY = 'ta-phone-https-skip';
const PHONE_FINISH_KEY = 'ta-phone-wizard-finished';

function tailscaleDownloadUrl(hostOs) {
  return 'https://tailscale.com/download/' + (hostOs === 'windows' ? 'windows' : hostOs === 'linux' ? 'linux' : 'mac');
}

function phoneWizardFlags() {
  const get = (k) => { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } };
  return { httpsSkipped: get(PHONE_HTTPS_SKIP_KEY), finished: get(PHONE_FINISH_KEY) };
}

function phoneWizardSetFlag(key) {
  try { localStorage.setItem(key, '1'); } catch (_) {}
}

// 모달이 닫혔거나 새 마법사로 바뀌었으면 폴링을 멈춘다
function phoneWizardShouldPoll(isCurrent, rootConnected, backdropHidden) {
  return !!(isCurrent && rootConnected && !backdropHidden);
}

// 단계 판정 — 현재 상태만으로 결정한다. current = 첫 미완료 단계
function phoneWizardPlan(st, flags) {
  const f = flags || {};
  const phones = st.phones || [];
  const offline = phones.length > 0 && !phones.some((p) => p.online);
  const steps = [
    { id: 'mac', title: 'PC 에 Tailscale 켜기', done: st.macTailscale === 'running' },
    {
      id: 'phone', title: '폰에 Tailscale 설치·로그인', done: phones.length > 0,
      note: offline ? '폰의 Tailscale 이 오프라인입니다. ' + remoteOfflineHelp(phoneOsPlatform(phones[0].os)) : null
    },
    { id: 'https', title: 'HTTPS 켜기 (권장)', done: !!st.httpsAvailable || !!f.httpsSkipped },
    {
      id: 'pair', title: '폰 페어링 (QR)', done: (st.pairedDevices || 0) > 0,
      note: st.staleDevices ? `HTTPS 로 바뀌어 기존 기기 ${st.staleDevices}대는 다시 페어링해야 합니다.` : null
    },
    { id: 'finish', title: '마무리 — 홈 화면 앱 · 알림', done: !!st.pushConfigured || !!f.finished }
  ];
  const first = steps.find((s) => !s.done);
  return {
    steps,
    current: first ? first.id : null,
    allDone: steps.every((s) => s.done)
  };
}

// 현재 단계 본문을 다시 그릴지 판단하는 열쇠 — 본문 내용이 달라지는 값만 넣는다.
// 안내 문구·다른 단계 완료 여부는 머리글 갱신으로 처리한다 (페어링 QR·알림 QR 유지)
function phoneWizardBodyKey(plan, st) {
  return plan.current + '|' + (plan.current === 'mac' ? st.macTailscale : '');
}

function phoneOsPlatform(os) {
  const o = String(os || '').toLowerCase();
  return o === 'android' ? 'android' : o === 'ios' ? 'ios' : 'other';
}

function phoneSummaryLine(st, view) {
  const phones = st.phones || [];
  const online = phones.filter((p) => p.online).length;
  const mode = view && view.mode === 'https' ? 'HTTPS' : 'HTTP';
  const running = view && view.running ? '실행 중' : '꺼짐';
  return `✓ PC Tailscale · 폰 ${phones.length}대 (온라인 ${online}) · 원격 서버 ${running} (${mode})`;
}

// HTTPS 권장 안내 분기 — 이미 HTTPS 면 null, 인증서는 있는데 전환 실패면 'error', 아니면 'enable'
function remoteHttpsAdvice(view) {
  if (!view || view.mode === 'https') return null;
  return view.httpsAvailable && view.httpsError ? 'error' : 'enable';
}

function remoteDeviceStatus(d) {
  if (!d || d.tailscaleOnline === null || d.tailscaleOnline === undefined) return 'unknown';
  return d.tailscaleOnline ? 'online' : 'offline';
}

// 삼성 월렛(삼성페이)은 VPN 이 켜져 있으면 결제를 막는다 — Tailscale 분할 터널링으로 월렛만 제외하면 해결된다
const SAMSUNG_WALLET_NOTE = '갤럭시에서 삼성 월렛(삼성페이)이 "VPN 해제" 를 요구하면: Tailscale 앱 → 프로필 아이콘 → <b>App-based split tunneling</b> 에서 삼성 월렛·삼성 패스를 체크해 제외하세요 (한글 앱은 목록 맨 아래, 검색은 spay).';

// 폰이 VPN 을 놓치지 않게 하는 설정 — 플랫폼별
function remoteOfflineHelp(platform) {
  if (platform === 'android') {
    return '폰 설정 → 연결 → 기타 연결 설정 → VPN → Tailscale ⚙ → 상시 VPN 을 켜고, 설정 → 애플리케이션 → Tailscale → 배터리 → 제한 없음으로 두세요.';
  }
  if (platform === 'ios') return 'Tailscale 앱 설정에서 VPN On Demand 를 켜 두세요.';
  return '폰에서 Tailscale 을 켜고 이 PC 와 같은 계정으로 로그인했는지 확인하세요.';
}

// 폰에서 열기 실패 분기 — 백엔드 오류 문자열 기준
function remoteOpenOnPhoneError(e) {
  const msg = String(e || '');
  if (msg.includes('no-push')) return 'setup-push';
  if (msg.includes('실행 중이 아닙니다')) return 'start-server';
  return 'other';
}

// 모달을 연 시점의 페어링 기기 — 이후 새 기기 id 가 생기면 '연결됨'
function remotePhoneBaseline(view) {
  return { ids: (view.devices || []).map((d) => d.id) };
}

function remotePhoneConnected(baseline, view) {
  if (!baseline || !view) return false;
  // 기존 기기의 재접속은 '이번에 연결함' 이 아니므로 새 기기 페어링으로만 판정한다
  return (view.devices || []).some((d) => !baseline.ids.includes(d.id));
}

function remoteDevicesKey(devices) {
  // 온라인 점이 바뀌어도 다시 그린다
  return (devices || []).map((d) => d.id + ':' + (d.lastSeenMs || 0) + ':' + remoteDeviceStatus(d)).join('|');
}

// 바인드 주소 위험 등급 — 백엔드 remote/auth.rs 분류와 같은 기준 (적용 전 확인용).
// 형식을 모르는 값은 null — 판정은 백엔드 검증에 맡긴다.
function remoteBindLevel(bind) {
  const b = String(bind || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  // auto 는 Tailscale IP 로만 해석된다 (백엔드 resolve_bind)
  if (b === 'auto') return 'tailscale';
  if (b === 'localhost' || b === '::1') return 'loopback';
  if (b === '::' || b === '0.0.0.0') return 'public';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(b);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    if (o[0] === 127) return 'loopback';
    if (o[0] === 100 && (o[1] & 0xc0) === 64) return 'tailscale';
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
      || (o[0] === 169 && o[1] === 254)) return 'lan';
    return 'public';
  }
  if (b.includes(':')) {
    const head = parseInt(b.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80) return 'lan';
    return 'public';
  }
  return null;
}

// 켜진 상태로 LAN·공인 주소에 새로 여는 경우에만 묻는다 (푸시 설정만 바꿀 때마다 묻지 않게)
function needsRemoteBindConfirm(view, cfg) {
  if (!cfg.enabled) return false;
  const level = remoteBindLevel(cfg.bind);
  if (level !== 'lan' && level !== 'public') return false;
  return !(view.enabled && view.bind === cfg.bind && view.port === cfg.port);
}

function remoteBindConfirmText(level) {
  const where = level === 'lan' ? '같은 네트워크(LAN·공용 Wi-Fi)의 기기' : '인터넷의 누구나';
  return `${where}가 이 원격 서버에 접속을 시도할 수 있습니다.\n\n`
    + '통신은 암호화되지 않은 HTTP 라, 같은 망에서 엿보면 기기 인증 토큰과 터미널 내용이 노출될 수 있습니다.\n'
    + 'Tailscale IP(100.x) 바인드를 권장합니다.\n\n그래도 적용할까요?';
}

// 설정 팝업 글꼴 드롭다운 후보 — 널리 쓰이는 코딩·모노스페이스 글꼴 (설치된 것만 표시)
const FONT_CANDIDATES = [
  'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'D2Coding', 'D2Coding Ligature',
  'Fira Code', 'Hack', 'IBM Plex Mono', 'Inconsolata', 'Intel One Mono', 'JetBrains Mono',
  'Lucida Console', 'Menlo', 'MesloLGS NF', 'Monaspace Neon', 'Nanum Gothic Coding',
  'Noto Sans Mono', 'Roboto Mono', 'Sarasa Mono K', 'Source Code Pro', 'Ubuntu Mono', 'Victor Mono'
];

// 설치된 글꼴 감지 — 후보 글꼴을 폴백(monospace/sans-serif)과 캔버스 폭으로 비교한다.
// 어느 한쪽 폴백과라도 폭이 다르면 해당 글꼴이 실제로 렌더링된 것 → 설치됨으로 판정.
function detectInstalledFonts(candidates) {
  const ctx = document.createElement('canvas').getContext('2d');
  const SAMPLE = 'mmmMMM111lliIWw한글코딩@#%';
  const width = (font) => { ctx.font = `24px ${font}`; return ctx.measureText(SAMPLE).width; };
  const base = { monospace: width('monospace'), 'sans-serif': width('sans-serif') };
  return candidates.filter((name) =>
    ['monospace', 'sans-serif'].some((fb) => width(`"${name}", ${fb}`) !== base[fb]));
}
