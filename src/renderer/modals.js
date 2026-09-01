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
              App.state.projects.push(p);
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
      <label>AI 도구 연동 — 허가 대기(🟡) 감지</label>
      <div class="check"><input type="checkbox" id="m-hook-claude" ${hooks.claude ? 'checked' : ''}><label for="m-hook-claude" style="margin:0">Claude Code 훅 (~/.claude/settings.json 병합, 백업 생성)</label></div>
      <div class="check"><input type="checkbox" id="m-hook-codex" ${hooks.codex ? 'checked' : ''}><label for="m-hook-codex" style="margin:0">Codex 알림 (~/.codex/config.toml 병합, 백업 생성)</label></div>
      <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-save">저장</button></div>`,
      (m, close) => {
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
        };
      });
  }
});

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
