// 앱 상태·이벤트 배선·모달. (렌더 함수는 sidebar.js / presets.js, 터미널은 terminal-view.js)
const App = {
  state: {
    projects: [],
    presets: [],
    settings: { fontSize: 13, shell: '', notifyOnDone: true },
    sessions: [],   // { id, projectId, title, status, cwd }
    activeId: null,
    images: {}      // sessionId → [{ path, src }] 최근 첨부 이미지
  },

  async boot() {
    TerminalView.init();
    const st = await ta.getState();
    Object.assign(App.state, {
      projects: st.projects, presets: st.presets, settings: st.settings, sessions: st.sessions
    });

    ta.onData(({ sessionId, data }) => TerminalView.write(sessionId, data));
    ta.onStatus(({ sessionId, status, busyMs }) => {
      const s = App.state.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      s.status = status;
      if (status === 'done') App.onDone(s, busyMs);
      renderSidebar();
      App.renderTopbar();
    });
    ta.onExit(({ sessionId }) => {
      TerminalView.write(sessionId, '\r\n\x1b[31m[세션 종료됨 — 닫기(✕)로 정리]\x1b[0m\r\n');
    });
    ta.onFileDrop((payload) => {
      const paths = payload && payload.paths ? payload.paths : [];
      if (paths.length) App.handleDrop(paths);
    });

    document.getElementById('btn-add-project').onclick = () => App.showProjectModal();
    document.getElementById('btn-home-session').onclick = () => App.createSession(null);
    document.getElementById('btn-add-preset').onclick = () => App.showPresetModal();
    document.getElementById('btn-settings').onclick = () => App.showSettingsModal();

    // 터미널 밖에 포커스가 있을 때의 단축키
    window.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key >= '1' && ev.key <= '9') { ev.preventDefault(); App.activateByIndex(Number(ev.key) - 1); }
      if (mod && ev.key.toLowerCase() === 't') { ev.preventDefault(); App.newSessionInActiveProject(); }
    });

    App.renderAll();

    // 자동 업데이트 확인 (백그라운드 — 실패는 조용히 무시)
    setTimeout(() => App.checkUpdate(), 2500);
  },

  CHANGELOG_URL: 'https://github.com/zzamjak-cloud/TerminalAssistance/blob/main/CHANGELOG.md',

  async checkUpdate() {
    let info = null;
    try { info = await ta.checkUpdate(); } catch (_) { return; }
    if (!info) return;
    App.modal(`
      <h3>새 버전 v${info.version} 이 있습니다</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:6px">
        ${info.notes ? String(info.notes).replace(/</g, '&lt;').slice(0, 400) : '업데이트를 설치하면 앱이 자동으로 재시작됩니다.'}
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

  renderAll() {
    renderSidebar();
    renderPresets();
    App.renderTopbar();
    App.renderImageStrip();
    document.getElementById('empty-state').style.display = App.state.sessions.length ? 'none' : 'flex';
  },

  renderTopbar() {
    const el = document.getElementById('active-info');
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (!s) { el.textContent = '세션 없음'; return; }
    el.textContent = '';
    el.appendChild(statusDot(s.status));
    const t = document.createElement('span');
    t.textContent = s.title;
    el.appendChild(t);
    const c = document.createElement('span');
    c.style.cssText = 'color:var(--fg-dim);font-weight:400;font-size:11px';
    c.textContent = s.cwd;
    el.appendChild(c);
  },

  renderImageStrip() {
    const strip = document.getElementById('image-strip');
    strip.textContent = '';
    const imgs = App.state.images[App.state.activeId] || [];
    if (!imgs.length) return;
    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = '최근 첨부:';
    strip.appendChild(label);
    for (const im of imgs.slice(0, 12)) {
      const el = document.createElement('img');
      el.className = 'strip-thumb';
      el.src = im.src;
      el.title = im.path + ' (클릭=원본 열기)';
      el.onclick = () => ta.openPath(im.path);
      strip.appendChild(el);
    }
  },

  // ── 세션 ──
  async createSession(projectId) {
    try {
      const info = await ta.createSession(projectId);
      App.state.sessions.push(info);
      TerminalView.create(info, App.state.settings.fontSize);
      App.activateSession(info.id);
    } catch (e) {
      alert('세션 생성 실패: ' + e);
    }
  },

  activateSession(id) {
    App.state.activeId = id;
    TerminalView.activate(id);
    App.ackIfDone(id);
    App.renderAll();
  },

  activateByIndex(i) {
    const s = App.state.sessions[i];
    if (s) App.activateSession(s.id);
  },

  openProject(projectId) {
    const existing = App.state.sessions.find((s) => s.projectId === projectId && s.status !== 'exited');
    if (existing) App.activateSession(existing.id);
    else App.createSession(projectId);
  },

  newSessionInActiveProject() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    App.createSession(s ? s.projectId : null);
  },

  async closeSession(id) {
    await ta.closeSession(id);
    App.state.sessions = App.state.sessions.filter((s) => s.id !== id);
    delete App.state.images[id];
    TerminalView.dispose(id);
    if (App.state.activeId === id) {
      const next = App.state.sessions[App.state.sessions.length - 1];
      App.state.activeId = null;
      if (next) App.activateSession(next.id);
    }
    App.renderAll();
  },

  ackIfDone(id) {
    const s = App.state.sessions.find((x) => x.id === id);
    if (s && s.status === 'done') ta.ackSession(id);
  },

  // 작업 완료: 보고 있지 않은 세션이면 데스크톱 알림, 보고 있으면 즉시 배지 해제
  onDone(s, busyMs) {
    const watching = s.id === App.state.activeId && document.hasFocus();
    if (watching) {
      ta.ackSession(s.id);
      s.status = 'idle';
    } else {
      const secs = Math.round((busyMs || 0) / 1000);
      ta.notify('작업 완료 — ' + s.title, secs + '초 동안 실행되던 작업이 끝났습니다.');
    }
  },

  // ── 붙여넣기 / 드롭 / 이미지 ──
  async pasteToSession(id) {
    const imgPath = await ta.clipboardImage();
    if (imgPath) { App.attachImage(id, imgPath); return; }
    const text = await ta.clipboardText();
    if (text) TerminalView.paste(id, text);
  },

  attachImage(id, path) {
    // 공백 포함 경로만 따옴표 (Claude Code 가 경로를 이미지 칩으로 인식)
    const quoted = /\s/.test(path) ? '"' + path + '"' : path;
    TerminalView.paste(id, quoted + ' ');
    if (!App.state.images[id]) App.state.images[id] = [];
    App.state.images[id].unshift({ path, src: ta.fileSrc(path) });
    App.renderImageStrip();
  },

  handleDrop(paths) {
    const id = App.state.activeId;
    if (!id) return;
    for (const p of paths) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(p)) App.attachImage(id, p);
      else TerminalView.paste(id, (/\s/.test(p) ? '"' + p + '"' : p) + ' ');
    }
  },

  runPreset(preset, execute) {
    const id = App.state.activeId;
    if (!id) return;
    TerminalView.paste(id, preset.command);
    if (execute) ta.write(id, '\r');
    TerminalView.activate(id);
  },

  // ── 모달 ──
  modal(html, onOpen) {
    const bd = document.getElementById('modal-backdrop');
    const m = document.getElementById('modal');
    m.innerHTML = html;
    bd.classList.remove('hidden');
    const close = () => bd.classList.add('hidden');
    bd.onclick = (e) => { if (e.target === bd) close(); };
    onOpen(m, close);
  },

  showProjectModal(existing) {
    App.modal(`
      <h3>${existing ? '프로젝트 수정' : '프로젝트 등록'}</h3>
      <label>이름</label><input type="text" id="m-name" placeholder="예: 내 게임 서버">
      <label>경로</label>
      <div class="row"><input type="text" id="m-path" placeholder="/Users/me/dev/project"><button id="m-browse" style="flex:0 0 auto">찾아보기…</button></div>
      <label>색상</label><input type="text" id="m-color" placeholder="#4f8cc9">
      <div class="modal-actions">
        ${existing ? '<button id="m-del" class="danger">삭제</button>' : ''}
        <button id="m-cancel">취소</button><button id="m-save">저장</button>
      </div>`,
      (m, close) => {
        const name = m.querySelector('#m-name'), path = m.querySelector('#m-path'), color = m.querySelector('#m-color');
        if (existing) { name.value = existing.name; path.value = existing.path; color.value = existing.color; }
        m.querySelector('#m-browse').onclick = async () => {
          const p = await ta.pickFolder();
          if (p) { path.value = p; if (!name.value) name.value = p.split(/[\\/]/).filter(Boolean).pop(); }
        };
        m.querySelector('#m-cancel').onclick = close;
        if (existing) m.querySelector('#m-del').onclick = async () => {
          if (!confirm('프로젝트와 해당 프리셋을 삭제할까요? (열린 세션은 유지됩니다)')) return;
          await ta.removeProject(existing.id);
          App.state.projects = App.state.projects.filter((p) => p.id !== existing.id);
          App.state.presets = App.state.presets.filter((p) => p.projectId !== existing.id);
          close(); App.renderAll();
        };
        m.querySelector('#m-save').onclick = async () => {
          if (!name.value.trim() || !path.value.trim()) return alert('이름과 경로를 입력하세요.');
          if (existing) {
            const patch = { name: name.value.trim(), path: path.value.trim(), color: color.value.trim() || '#4f8cc9' };
            await ta.updateProject(existing.id, patch);
            Object.assign(existing, patch);
          } else {
            const p = await ta.addProject({ name: name.value.trim(), path: path.value.trim(), color: color.value.trim() || undefined });
            App.state.projects.push(p);
          }
          close(); App.renderAll();
        };
        name.focus();
      });
  },

  showPresetModal(existing) {
    const opts = App.state.projects
      .map((p) => `<option value="${p.id}">${p.name} 전용</option>`).join('');
    App.modal(`
      <h3>${existing ? '프리셋 수정' : '명령 프리셋 추가'}</h3>
      <label>이름(칩에 표시)</label><input type="text" id="m-label" placeholder="예: 빌드 & 테스트">
      <label>명령</label><input type="text" id="m-cmd" placeholder="예: npm run build && npm test">
      <label>범위</label><select id="m-scope"><option value="">전역 (모든 세션)</option>${opts}</select>
      <div class="modal-actions">
        ${existing ? '<button id="m-del" class="danger">삭제</button>' : ''}
        <button id="m-cancel">취소</button><button id="m-save">저장</button>
      </div>`,
      (m, close) => {
        const label = m.querySelector('#m-label'), cmd = m.querySelector('#m-cmd'), scope = m.querySelector('#m-scope');
        if (existing) { label.value = existing.label; cmd.value = existing.command; scope.value = existing.projectId || ''; }
        else {
          // 기본 범위 = 현재 활성 세션의 프로젝트
          const s = App.state.sessions.find((x) => x.id === App.state.activeId);
          if (s && s.projectId) scope.value = s.projectId;
        }
        m.querySelector('#m-cancel').onclick = close;
        if (existing) m.querySelector('#m-del').onclick = async () => {
          await ta.removePreset(existing.id);
          App.state.presets = App.state.presets.filter((p) => p.id !== existing.id);
          close(); renderPresets();
        };
        m.querySelector('#m-save').onclick = async () => {
          if (!label.value.trim() || !cmd.value.trim()) return alert('이름과 명령을 입력하세요.');
          if (existing) {
            const patch = { label: label.value.trim(), command: cmd.value.trim() };
            if (scope.value) patch.projectId = scope.value; else patch.clearProject = true;
            await ta.updatePreset(existing.id, patch);
            Object.assign(existing, { label: patch.label, command: patch.command, projectId: scope.value || null });
          } else {
            const p = await ta.addPreset({ label: label.value.trim(), command: cmd.value.trim(), projectId: scope.value || null });
            App.state.presets.push(p);
          }
          close(); renderPresets();
        };
        label.focus();
      });
  },

  showSettingsModal() {
    const st = App.state.settings;
    App.modal(`
      <h3>설정</h3>
      <label>글꼴 크기</label><input type="number" id="m-font" min="9" max="24" value="${st.fontSize}">
      <label>셸 (비우면 OS 기본)</label><input type="text" id="m-shell" placeholder="${navigator.platform.startsWith('Win') ? 'powershell.exe' : '/bin/zsh'}" value="${st.shell || ''}">
      <div class="check"><input type="checkbox" id="m-notify" ${st.notifyOnDone ? 'checked' : ''}><label for="m-notify" style="margin:0">비활성 세션 작업 완료 시 알림</label></div>
      <div class="modal-actions"><button id="m-cancel">취소</button><button id="m-save">저장</button></div>`,
      (m, close) => {
        m.querySelector('#m-cancel').onclick = close;
        m.querySelector('#m-save').onclick = async () => {
          const patch = {
            fontSize: Math.max(9, Math.min(24, Number(m.querySelector('#m-font').value) || 13)),
            shell: m.querySelector('#m-shell').value.trim(),
            notifyOnDone: m.querySelector('#m-notify').checked
          };
          App.state.settings = await ta.updateSettings(patch);
          TerminalView.setFontSize(App.state.settings.fontSize);
          close();
        };
      });
  }
};

document.addEventListener('DOMContentLoaded', () => App.boot());
