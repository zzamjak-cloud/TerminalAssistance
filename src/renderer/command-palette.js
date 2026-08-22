// 전역 커맨드 팔레트: 프로젝트, 세션, 프리셋, AI 세션 기록, 계획 문서를 한 곳에서 실행한다.
Object.assign(App, {
  _cpItems: [],
  _cpSelected: 0,
  _cpPointerX: null,
  _cpPointerY: null,
  _cpLoadToken: 0,

  openCommandPalette() {
    const root = document.getElementById('command-palette');
    const input = document.getElementById('cp-input');
    root.classList.remove('hidden');
    input.value = '';
    App._cpSelected = 0;
    App._cpPointerX = null;
    App._cpPointerY = null;
    App._cpItems = App.commandPaletteBaseItems();
    App.renderCommandPalette();
    App.loadCommandPaletteContext(++App._cpLoadToken);
    requestAnimationFrame(() => input.focus());
  },

  closeCommandPalette(restoreFocus) {
    document.getElementById('command-palette').classList.add('hidden');
    App._cpLoadToken++;
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (restoreFocus !== false && s) TerminalView.activate(s.id);
  },

  commandPaletteBaseItems() {
    const active = App.state.sessions.find((s) => s.id === App.state.activeId);
    const activeProjectId = active ? active.projectId : null;
    const items = [];
    const add = (kind, title, subtitle, run, keywords) => {
      items.push({ kind, title, subtitle: subtitle || '', keywords: keywords || '', run });
    };

    add('action', '홈 디렉토리 터미널 열기', '새 홈 세션을 시작합니다.', () => App.createSession(null), 'new terminal home');
    add('action', '현재 프로젝트 새 세션', '활성 세션의 프로젝트에 새 터미널을 엽니다.', () => App.newSessionInActiveProject(), 'new session');
    add('action', '터미널 검색', '활성 터미널 스크롤백에서 검색합니다.', () => App.openTerminalSearch(), 'find search');
    add('action', '프리셋 관리', '전역/프로젝트 프리셋을 추가하거나 수정합니다.', () => App.showPresetManager(), 'preset');
    add('action', '런치 레시피 관리', '여러 세션을 한 번에 여는 작업 묶음을 관리합니다.', () => App.showRecipeManager(), 'recipe launch workspace');
    add('action', '설정', '글꼴, 셸, 알림, AI 도구 연동을 설정합니다.', () => App.showSettingsModal(), 'settings');
    add('action', '우측 패널 토글', '세션 기록, 계획 문서와 메모 패널을 열고 닫습니다.', () => App.togglePromptPanel(), 'panel');
    add('action', '업데이트 확인', '새 릴리즈가 있는지 확인합니다.', () => App.checkUpdate(), 'update');

    for (const p of App.state.projects) {
      const sessions = App.state.sessions.filter((s) => s.projectId === p.id && s.status !== 'exited');
      add('project', p.name, p.path, () => {
        if (sessions.length) App.activateSession(sessions[sessions.length - 1].id);
        else App.showProjectEmpty(p.id);
      }, 'project ' + p.path);
      add('session', p.name + ' 새 세션', p.path, () => App.createSession(p.id), 'new session project');
    }

    for (const s of App.state.sessions.filter((x) => x.status !== 'exited')) {
      add('session', App.sessionLabel(s), s.cwd, () => App.activateSession(s.id), 'session terminal ' + s.status);
    }

    for (const p of App.state.presets) {
      const project = p.projectId && App.state.projects.find((x) => x.id === p.projectId);
      const scope = project ? project.name + ' 전용' : '전역';
      const usable = !p.projectId || p.projectId === activeProjectId;
      if (!usable) continue;
      add('preset', '프리셋 실행: ' + p.label, scope + ' · ' + p.command, () => App.runPreset(p, true), p.command + ' ' + scope);
      add('preset', '프리셋 입력만: ' + p.label, scope + ' · ' + p.command, () => App.runPreset(p, false), p.command + ' insert');
    }

    for (const r of App.state.recipes || []) {
      const project = r.projectId && App.state.projects.find((x) => x.id === r.projectId);
      const scope = project ? project.name + ' 전용' : '전역';
      const usable = !r.projectId || r.projectId === activeProjectId;
      if (!usable) continue;
      const count = (r.commands || []).filter((c) => c.trim()).length;
      add('recipe', '레시피 실행: ' + r.label, scope + ' · 세션 ' + count + '개', () => App.runRecipe(r), (r.commands || []).join(' '));
    }

    return items;
  },

  async loadCommandPaletteContext(token) {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (!s) return;
    const cwd = s.cwd;
    try {
      const [claude, codex, plans] = await Promise.all([
        ta.listClaudeSessions(cwd).catch(() => []),
        ta.listCodexSessions(cwd).catch(() => []),
        ta.listPlanDocs(cwd).catch(() => [])
      ]);
      if (token !== App._cpLoadToken) return;
      const history = [
        ...claude.map((it) => ({ ...it, source: 'claude', label: 'Claude' })),
        ...codex.map((it) => ({ ...it, source: 'codex', label: 'Codex' }))
      ].sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const it of history) {
        App._cpItems.push({
          kind: it.source,
          title: it.label + ' 세션: ' + it.preview,
          subtitle: new Date(it.mtimeMs).toLocaleString() + ' · ' + it.id.slice(0, 8),
          keywords: it.id + ' ' + it.source + ' resume history',
          run: () => App.showSessionHistoryPopup({ ...it, cwd })
        });
      }
      for (const it of plans) {
        App._cpItems.push({
          kind: 'plan',
          title: '계획 문서: ' + it.title,
          subtitle: new Date(it.createdMs).toLocaleString() + ' · 세션 ' + it.sessionId.slice(0, 8),
          keywords: it.id + ' plan document',
          run: () => App.showPlanDoc(cwd, it)
        });
      }
      App.renderCommandPalette();
    } catch (_) {
      // 부가 기록 로딩 실패는 팔레트 기본 기능에 영향을 주지 않는다.
    }
  },

  commandPaletteMatches(item, q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = (item.kind + ' ' + item.title + ' ' + item.subtitle + ' ' + item.keywords).toLowerCase();
    return words.every((w) => hay.includes(w));
  },

  filteredCommandPaletteItems() {
    const q = document.getElementById('cp-input').value;
    return App._cpItems.filter((it) => App.commandPaletteMatches(it, q)).slice(0, 80);
  },

  renderCommandPalette() {
    const list = document.getElementById('cp-list');
    const items = App.filteredCommandPaletteItems();
    if (App._cpSelected >= items.length) App._cpSelected = Math.max(0, items.length - 1);
    list.textContent = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = '일치하는 항목이 없습니다.';
      list.appendChild(empty);
      return;
    }
    for (const [idx, it] of items.entries()) {
      const row = document.createElement('button');
      row.className = 'cp-item' + (idx === App._cpSelected ? ' selected' : '');
      row.type = 'button';
      row.onpointermove = (ev) => {
        if (App._cpPointerX === ev.clientX && App._cpPointerY === ev.clientY) return;
        App._cpPointerX = ev.clientX;
        App._cpPointerY = ev.clientY;
        if (App._cpSelected === idx) return;
        App._cpSelected = idx;
        App.renderCommandPalette();
      };
      row.onclick = () => App.runCommandPaletteItem(it);
      const kind = document.createElement('span');
      kind.className = 'cp-kind';
      kind.textContent = App.commandPaletteKindLabel(it.kind);
      const body = document.createElement('span');
      body.className = 'cp-body';
      const title = document.createElement('span');
      title.className = 'cp-title';
      title.textContent = it.title;
      const sub = document.createElement('span');
      sub.className = 'cp-subtitle';
      sub.textContent = it.subtitle;
      body.append(title, sub);
      row.append(kind, body);
      list.appendChild(row);
    }
  },

  commandPaletteKindLabel(kind) {
    return ({ action: '동작', project: '프로젝트', session: '세션', preset: '프리셋', recipe: '레시피', claude: 'Claude', codex: 'Codex', plan: '계획' })[kind] || kind;
  },

  async runCommandPaletteItem(item) {
    App.closeCommandPalette(false);
    await item.run();
  },

  initCommandPaletteUI() {
    const root = document.getElementById('command-palette');
    const input = document.getElementById('cp-input');
    root.onclick = (ev) => { if (ev.target === root) App.closeCommandPalette(); };
    input.oninput = () => { App._cpSelected = 0; App.renderCommandPalette(); };
    input.onkeydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); App.closeCommandPalette(); return; }
      const items = App.filteredCommandPaletteItems();
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        App._cpSelected = Math.min(items.length - 1, App._cpSelected + 1);
        App.renderCommandPalette();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        App._cpSelected = Math.max(0, App._cpSelected - 1);
        App.renderCommandPalette();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const item = items[App._cpSelected];
        if (item) App.runCommandPaletteItem(item);
      }
    };
  }
});
