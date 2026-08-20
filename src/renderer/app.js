// 앱 상태·부트스트랩·세션 수명주기.
// 나머지 책임은 파일로 분리: 초안 drafts.js / 프롬프트 히스토리 prompt-history.js /
// 패널 레이아웃 panel-layout.js / 모달 modals.js / 사이드바·프리셋 렌더 sidebar.js·presets.js /
// 터미널 terminal-view.js. 각 파일이 Object.assign(App, ...) 으로 메서드를 붙인다.
const App = {
  state: {
    projects: [],
    presets: [],
    settings: { fontSize: 13, shell: '', notifyOnDone: true },
    sessions: [],   // { id, projectId, title, status, cwd }
    activeId: null,
    platform: '',   // 백엔드가 알려주는 OS (windows | macos | linux)
    images: {},     // sessionId → [{ path, src }] 최근 첨부 이미지
    prompts: {},    // sessionId → [{ n, text, ts, marker, line }] 제출한 프롬프트 히스토리
    drafts: {}      // projectId(또는 '') → [{ id, text }] 다음 프롬프트 초안 (영속화)
  },
  _inputBufs: {}, // sessionId → 입력 중인 라인 버퍼 (프롬프트 추적용)

  async boot() {
    TerminalView.init();
    const st = await ta.getState();
    Object.assign(App.state, {
      projects: st.projects, presets: st.presets, settings: st.settings, sessions: st.sessions,
      drafts: st.drafts || {}, platform: st.platform || ''
    });
    // 사이드바 제목 우측 버전 표기
    document.getElementById('app-version').textContent = st.version ? 'v' + st.version : '';

    // 앱 재시작 복원: 백엔드가 보관한 프롬프트 히스토리 시드.
    // 스냅샷은 외부 파일이므로 원소 단위로 검증 — 손상 항목 하나가 렌더 전체를 죽이지 않게.
    // xterm 마커는 소실되고 이전 버퍼 기준 line 도 무의미 → 텍스트 검색 폴백으로만 점프.
    for (const [sid, list] of Object.entries(st.prompts || {})) {
      if (!Array.isArray(list)) continue;
      const items = list
        .filter((it) => it && typeof it.text === 'string' && Number.isFinite(it.n))
        .map((it) => ({
          n: it.n, text: it.text,
          ts: Number.isFinite(it.ts) ? new Date(it.ts) : new Date(0),
          marker: null, line: -1
        }));
      if (items.length) App.state.prompts[sid] = items;
    }

    // 웹뷰 리로드/크래시 복구: 백엔드에 살아있는 세션의 터미널 뷰를 먼저 frozen 으로 만들어
    // 리스너 등록 후 도착하는 라이브 출력을 큐에 담아 두고, 스크롤백 주입 뒤 이어붙인다.
    const restoring = st.sessions.slice();
    for (const s of restoring) {
      TerminalView.create(s, App.state.settings.fontSize, { frozen: true });
    }

    ta.onData((p) => TerminalView.feed(p));
    ta.onStatus(({ sessionId, status, busyMs }) => {
      const s = App.state.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      s.status = status;
      if (status === 'done') App.onDone(s, busyMs);
      updateSessionStatus(s); // 전체 재구축 대신 해당 행만 갱신 (호버·드래그 유지)
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
    document.getElementById('btn-add-preset').onclick = () => App.showPresetManager();
    document.getElementById('btn-settings').onclick = () => App.showSettingsModal();
    document.getElementById('btn-toggle-prompts').onclick = () => App.togglePromptPanel();
    document.getElementById('btn-draft-add').onclick = () => App.addDraft();
    // 시스템 메모리 폴링 (2초)
    setInterval(() => App.pollStatus(), 2000);
    App.pollStatus();
    document.getElementById('btn-clear-prompts').onclick = () => {
      if (!App.state.activeId) return;
      delete App.state.prompts[App.state.activeId];
      App.syncPrompts(App.state.activeId, 0); // 비운 상태를 백엔드 스냅샷에 즉시 반영
      App.renderPromptList();
    };
    if (localStorage.getItem('ta-prompt-panel') === '1') {
      document.getElementById('prompt-panel').classList.remove('hidden');
    }
    App.initPanelUI();

    // 터미널 밖에 포커스가 있을 때의 단축키
    window.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key >= '1' && ev.key <= '9') { ev.preventDefault(); App.activateByIndex(Number(ev.key) - 1); }
      if (mod && ev.key.toLowerCase() === 't') { ev.preventDefault(); App.newSessionInActiveProject(); }
    });

    // 세션 내용 복원: 스냅샷을 병렬 조회하고 도착 즉시 주입 (세션 간 순서 의존성 없음)
    await Promise.all(restoring.map(async (s) => {
      try {
        const snap = await ta.getScrollback(s.id);
        TerminalView.restore(s.id, snap);
      } catch (_) {
        TerminalView.restore(s.id, null); // 스냅샷 실패해도 라이브 출력은 살린다
      }
    }));
    if (restoring.length) {
      // 리로드 전 활성 세션 우선, 없으면 마지막 세션
      const saved = localStorage.getItem('ta-active-session');
      const target = restoring.find((s) => s.id === saved) || restoring[restoring.length - 1];
      App.activateSession(target.id);
    }

    App.renderAll();

    // 자동 업데이트 확인 (백그라운드 — 실패는 조용히 무시)
    setTimeout(() => App.checkUpdate(), 2500);
  },

  renderAll() {
    renderSidebar();
    renderPresets();
    App.renderTopbar();
    App.renderImageStrip();
    App.renderPromptList();
    App.renderDraftList();
    document.getElementById('empty-state').style.display = App.state.sessions.length ? 'none' : 'flex';
  },

  // ── 시스템 메모리 폴링 ──
  async pollStatus() {
    try {
      const m = await ta.getMemory();
      const el = document.getElementById('mem-indicator');
      let cls = 'ok';                       // < 60% : 원활 (녹색)
      if (m.pct >= 85) cls = 'crit';        // ≥ 85% : 위험 (빨강, 점멸)
      else if (m.pct >= 75) cls = 'warn';   // ≥ 75% : 버거움 (주황)
      else if (m.pct >= 60) cls = 'mid';    // ≥ 60% : 주의 (노랑)
      el.className = cls;
      el.textContent = `메모리 ${m.pct}% 사용중`;
      el.title = `시스템 메모리 ${m.usedGb} / ${m.totalGb} GB`;
    } catch (_) { /* 조회 실패는 무시 */ }
  },

  // ── 프리셋/프로젝트 드래그 정렬 ──
  async movePreset(srcId, targetId, before) {
    const arr = App.state.presets;
    const from = arr.findIndex((p) => p.id === srcId);
    if (from < 0) return;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex((p) => p.id === targetId);
    if (to < 0) { arr.splice(from, 0, moved); return; }
    if (!before) to += 1;
    arr.splice(to, 0, moved);
    renderPresets();
    await ta.reorderPresets(arr.map((p) => p.id)).catch((e) => console.warn('프리셋 순서 저장 실패:', e));
  },

  async moveProject(srcId, targetId, before) {
    const arr = App.state.projects;
    const from = arr.findIndex((p) => p.id === srcId);
    if (from < 0) return;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex((p) => p.id === targetId);
    if (to < 0) { arr.splice(from, 0, moved); return; }
    if (!before) to += 1;
    arr.splice(to, 0, moved);
    renderSidebar();
    await ta.reorderProjects(arr.map((p) => p.id)).catch((e) => console.warn('프로젝트 순서 저장 실패:', e));
  },

  renderTopbar() {
    const el = document.getElementById('active-info');
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    if (!s) { el.textContent = '세션 없음'; return; }
    el.textContent = '';
    el.appendChild(statusTag(s.status));
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
    for (const im of imgs.slice(0, IMAGE_STRIP_MAX)) {
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
    localStorage.setItem('ta-active-session', id); // 웹뷰 리로드 복구 시 활성 세션 유지용
    TerminalView.activate(id);
    App.ackIfDone(id);
    App.renderAll();
  },

  activateByIndex(i) {
    const s = App.state.sessions[i];
    if (s) App.activateSession(s.id);
  },

  newSessionInActiveProject() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    App.createSession(s ? s.projectId : null);
  },

  async closeSession(id) {
    await ta.closeSession(id);
    App.state.sessions = App.state.sessions.filter((s) => s.id !== id);
    delete App.state.images[id];
    delete App.state.prompts[id];
    delete App._inputBufs[id];
    clearTimeout(App._promptSyncTimers[id]); // 닫힌 세션으로의 늦은 동기화 IPC 방지
    delete App._promptSyncTimers[id];
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
    TerminalView.paste(id, quotePath(path) + ' ');
    if (!App.state.images[id]) App.state.images[id] = [];
    App.state.images[id].unshift({ path, src: ta.fileSrc(path) });
    if (App.state.images[id].length > IMAGE_STRIP_MAX) App.state.images[id].length = IMAGE_STRIP_MAX;
    App.renderImageStrip();
  },

  handleDrop(paths) {
    const id = App.state.activeId;
    if (!id) return;
    for (const p of paths) {
      if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(p)) App.attachImage(id, p);
      else TerminalView.paste(id, quotePath(p) + ' ');
    }
  },

  runPreset(preset, execute) {
    const id = App.state.activeId;
    if (!id) return;
    TerminalView.paste(id, preset.command);
    if (execute) { ta.write(id, '\r'); App.trackInput(id, '\r'); }
    TerminalView.activate(id);
  }
};

document.addEventListener('DOMContentLoaded', () => App.boot());
