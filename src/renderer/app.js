// 앱 상태·이벤트 배선·모달. (렌더 함수는 sidebar.js / presets.js, 터미널은 terminal-view.js)
const App = {
  state: {
    projects: [],
    presets: [],
    settings: { fontSize: 13, shell: '', notifyOnDone: true },
    sessions: [],   // { id, projectId, title, status, cwd }
    activeId: null,
    images: {},     // sessionId → [{ path, src }] 최근 첨부 이미지
    prompts: {},    // sessionId → [{ n, text, ts, marker }] 제출한 프롬프트 히스토리
    drafts: {},     // projectId(또는 '') → [{ id, text }] 다음 프롬프트 초안 (영속화)
    manualPlans: {} // sessionId → [{ id, text, done }] 수동 진행 계획 (백엔드 보관)
  },
  _inputBufs: {},   // sessionId → 입력 중인 라인 버퍼 (프롬프트 추적용)
  _autoPlanCache: '', // 자동 연동 계획의 마지막 렌더 내용 (불필요한 재렌더 방지)
  _draftSaveTimer: null,

  async boot() {
    TerminalView.init();
    const st = await ta.getState();
    Object.assign(App.state, {
      projects: st.projects, presets: st.presets, settings: st.settings, sessions: st.sessions,
      drafts: st.drafts || {}
    });

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
    document.getElementById('btn-add-preset').onclick = () => App.showPresetManager();
    document.getElementById('btn-settings').onclick = () => App.showSettingsModal();
    document.getElementById('btn-toggle-prompts').onclick = () => App.togglePromptPanel();
    document.getElementById('btn-toggle-work').onclick = () => App.toggleWorkPanel();
    document.getElementById('btn-draft-add').onclick = () => App.addDraft();
    document.getElementById('plan-add-input').onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) App.addManualItem(ev.target);
    };
    // 시스템 메모리 + 자동 연동 계획 폴링 (2초)
    setInterval(() => App.pollStatus(), 2000);
    App.pollStatus();
    document.getElementById('btn-clear-prompts').onclick = () => {
      delete App.state.prompts[App.state.activeId];
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

    // 세션 내용 복원: 스크롤백 스냅샷 주입 → 큐잉된 라이브 출력 이어붙임
    for (const s of restoring) {
      try {
        const snap = await ta.getScrollback(s.id);
        TerminalView.restore(s.id, snap);
      } catch (_) {
        TerminalView.restore(s.id, null); // 스냅샷 실패해도 라이브 출력은 살린다
      }
    }
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
    App.renderPromptList();
    App.renderWorkPanel();
    document.getElementById('empty-state').style.display = App.state.sessions.length ? 'none' : 'flex';
  },

  // ── 시스템 메모리 + 자동 연동 계획 폴링 ──
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

    // 작업 패널이 열려 있을 때만 자동 연동 계획 갱신
    const wp = document.getElementById('work-panel');
    if (!wp.classList.contains('hidden') && App.state.activeId) {
      try {
        const auto = await ta.getAutoPlan(App.state.activeId);
        const key = App.state.activeId + '|' + JSON.stringify(auto);
        if (key !== App._autoPlanCache) {
          App._autoPlanCache = key;
          App.renderPlanList(auto);
        }
      } catch (_) {}
    }
  },

  // ── 우측 작업 패널 (진행 계획 + 다음 프롬프트) ──
  toggleWorkPanel() {
    const wp = document.getElementById('work-panel');
    const hidden = wp.classList.toggle('hidden');
    document.getElementById('resize-work').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-work-panel', hidden ? '0' : '1');
    TerminalView.fitActive();
    if (!hidden) { App._autoPlanCache = ''; App.renderWorkPanel(); }
  },

  renderWorkPanel() {
    const wp = document.getElementById('work-panel');
    if (wp.classList.contains('hidden')) return;
    App.renderPlanList(null); // 자동 연동분은 폴링이 채움 (캐시 무효화)
    App._autoPlanCache = '';
    App.renderDraftList();
  },

  // 진행 계획 렌더: 자동 연동(Claude Code) 섹션 + 수동 섹션
  renderPlanList(auto) {
    const el = document.getElementById('plan-list');
    el.textContent = '';
    const manual = App.state.manualPlans[App.state.activeId] || [];
    const srcEl = document.getElementById('plan-src');
    srcEl.textContent = auto && auto.length ? 'Claude Code 연동됨' : '';

    if (auto && auto.length) {
      const sec = document.createElement('div');
      sec.className = 'plan-sec';
      sec.textContent = '자동 (Claude Code)';
      el.appendChild(sec);
      for (const it of auto) {
        const row = document.createElement('div');
        row.className = 'plan-item auto' + (it.done ? ' done' : '') + (it.active ? ' active' : '');
        const box = document.createElement('span');
        box.className = 'pi-box';
        box.textContent = it.done ? '✓' : (it.active ? '▶' : '○');
        const t = document.createElement('span');
        t.className = 'pi-text';
        t.textContent = it.text;
        row.append(box, t);
        el.appendChild(row);
      }
    }

    if (manual.length) {
      const sec = document.createElement('div');
      sec.className = 'plan-sec';
      sec.textContent = '수동 항목';
      el.appendChild(sec);
      for (const it of manual) {
        const row = document.createElement('div');
        row.className = 'plan-item manual' + (it.done ? ' done' : '');
        const box = document.createElement('span');
        box.className = 'pi-box';
        box.textContent = it.done ? '✓' : '○';
        const t = document.createElement('span');
        t.className = 'pi-text';
        t.textContent = it.text;
        const del = document.createElement('button');
        del.className = 'pi-del';
        del.textContent = '✕';
        del.onclick = (ev) => {
          ev.stopPropagation();
          App.saveManualPlan(manual.filter((x) => x.id !== it.id));
        };
        row.onclick = () => {
          it.done = !it.done;
          App.saveManualPlan(manual);
        };
        row.append(box, t, del);
        el.appendChild(row);
      }
    }

    if ((!auto || !auto.length) && !manual.length) {
      const e = document.createElement('div');
      e.className = 'plan-empty';
      e.textContent = 'Claude Code 가 작업 계획을 만들면 자동으로 표시됩니다. 다른 AI 는 아래 입력란으로 항목을 직접 추가하세요.';
      el.appendChild(e);
    }
  },

  addManualItem(input) {
    const text = input.value.trim();
    if (!text || !App.state.activeId) return;
    const list = App.state.manualPlans[App.state.activeId] || [];
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false });
    input.value = '';
    App.saveManualPlan(list);
  },

  saveManualPlan(list) {
    const id = App.state.activeId;
    if (!id) return;
    App.state.manualPlans[id] = list;
    ta.setManualPlan(id, list); // 백엔드 보관 → 웹뷰 리로드에도 유지
    App._autoPlanCache = '';    // 다음 폴링에서 자동분과 함께 재렌더
    App.renderPlanList(null);
  },

  // ── 다음 프롬프트 초안 ──
  draftKey() {
    const s = App.state.sessions.find((x) => x.id === App.state.activeId);
    return s && s.projectId ? s.projectId : '';
  },

  renderDraftList() {
    const el = document.getElementById('draft-list');
    el.textContent = '';
    const list = App.state.drafts[App.draftKey()] || [];
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'draft-empty';
      e.textContent = '다음에 보낼 프롬프트를 미리 작성해 두세요. [입력] 을 누르면 터미널 입력 라인으로 전달됩니다. (멀티라인 지원)';
      el.appendChild(e);
      return;
    }
    for (const d of list) {
      const card = document.createElement('div');
      card.className = 'draft-card';
      const tx = document.createElement('textarea');
      tx.value = d.text;
      tx.placeholder = '프롬프트 작성…';
      tx.oninput = () => { d.text = tx.value; App.saveDraftsDebounced(); };
      const actions = document.createElement('div');
      actions.className = 'draft-actions';
      const send = document.createElement('button');
      send.className = 'draft-send';
      send.textContent = '입력';
      send.title = '터미널 입력 라인으로 전달 (실행은 터미널에서 Enter)';
      send.onclick = () => App.sendDraft(d);
      const del = document.createElement('button');
      del.className = 'draft-del';
      del.textContent = '✕';
      del.onclick = () => {
        const k = App.draftKey();
        App.state.drafts[k] = (App.state.drafts[k] || []).filter((x) => x.id !== d.id);
        ta.setDrafts(k, App.state.drafts[k]);
        App.renderDraftList();
      };
      actions.append(send, del);
      card.append(tx, actions);
      el.appendChild(card);
    }
  },

  addDraft() {
    const k = App.draftKey();
    const list = App.state.drafts[k] || (App.state.drafts[k] = []);
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: '' });
    App.renderDraftList();
    App.saveDraftsDebounced();
    const areas = document.querySelectorAll('#draft-list textarea');
    if (areas.length) areas[areas.length - 1].focus();
  },

  saveDraftsDebounced() {
    clearTimeout(App._draftSaveTimer);
    App._draftSaveTimer = setTimeout(() => {
      const k = App.draftKey();
      ta.setDrafts(k, App.state.drafts[k] || []);
    }, 600);
  },

  // 초안을 터미널 입력 라인으로 전달 (bracketed paste 로 멀티라인 안전 전달)
  sendDraft(d) {
    const id = App.state.activeId;
    if (!id || !d.text.trim()) return;
    TerminalView.paste(id, d.text);
    TerminalView.activate(id);
  },

  // ── 프롬프트 히스토리 ──
  // PTY 로 가는 사용자 입력을 라인 단위로 추적해, Enter 로 제출된 텍스트를 히스토리에 쌓는다.
  trackInput(id, data) {
    let buf = App._inputBufs[id] || '';
    // 브래킷 붙여넣기 래퍼는 제거하고 내용은 유지
    data = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r') { App.commitPrompt(id, buf); buf = ''; }
      else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') buf = '';              // Ctrl+C / Ctrl+U
      else if (ch === '\x1b') {                                        // ESC 시퀀스(방향키 등)는 통째로 스킵
        i++;
        if (data[i] === '[' || data[i] === 'O') {
          i++;
          while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) i++;
        }
      }
      else if (ch >= ' ' || ch === '\n' || ch === '\t') buf += ch;
    }
    App._inputBufs[id] = buf;
  },

  commitPrompt(id, text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < 2) return; // 단타 엔터/한 글자 명령은 노이즈로 간주
    const marker = TerminalView.addPromptMarker(id);
    const list = App.state.prompts[id] || (App.state.prompts[id] = []);
    list.push({ n: list.length + 1, text, ts: new Date(), marker });
    if (list.length > 300) {
      const old = list.shift();
      if (old.marker) { try { old.marker.dispose(); } catch (_) {} }
    }
    if (id === App.state.activeId) App.renderPromptList();
  },

  renderPromptList() {
    const el = document.getElementById('prompt-list');
    el.textContent = '';
    const items = App.state.prompts[App.state.activeId] || [];
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '이 세션에서 입력한 프롬프트가 여기에 쌓입니다. 클릭하면 해당 위치로 이동합니다.';
      el.appendChild(e);
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      const gone = it.marker ? (it.marker.isDisposed || it.marker.line < 0) : true;
      row.className = 'prompt-item' + (gone ? ' gone' : '');
      const n = document.createElement('span');
      n.className = 'pn';
      n.textContent = it.n;
      const t = document.createElement('span');
      t.className = 'pt';
      t.textContent = it.text.length > 90 ? it.text.slice(0, 90) + '…' : it.text;
      row.title = it.text + '\n' + it.ts.toLocaleTimeString() + (gone ? '\n(스크롤백에서 밀려나 이동 불가)' : '');
      row.append(n, t);
      row.onclick = () => {
        if (!TerminalView.scrollToMarker(App.state.activeId, it.marker)) row.classList.add('gone');
      };
      el.appendChild(row);
    }
    el.scrollTop = el.scrollHeight; // 최신 항목이 보이도록
  },

  togglePromptPanel() {
    const p = document.getElementById('prompt-panel');
    const hidden = p.classList.toggle('hidden');
    document.getElementById('resize-right').style.display = hidden ? 'none' : '';
    localStorage.setItem('ta-prompt-panel', hidden ? '0' : '1');
    setTimeout(() => TerminalView.fitActive(), 230); // 슬라이딩 종료 후 리핏
  },

  toggleLeftSidebar() {
    const sb = document.getElementById('sidebar');
    const collapsed = sb.classList.toggle('collapsed');
    document.getElementById('resize-left').style.display = collapsed ? 'none' : '';
    localStorage.setItem('ta-left-fold', collapsed ? '1' : '0');
    setTimeout(() => TerminalView.fitActive(), 230);
  },

  // 패널 UI 초기화: 저장된 너비/폴딩 복원 + 리사이즈 핸들 배선
  initPanelUI() {
    const sb = document.getElementById('sidebar');
    const pp = document.getElementById('prompt-panel');
    const lw = Number(localStorage.getItem('ta-left-w'));
    const rw = Number(localStorage.getItem('ta-right-w'));
    if (lw >= 180) sb.style.width = lw + 'px';
    if (rw >= 200) pp.style.width = rw + 'px';
    if (localStorage.getItem('ta-left-fold') === '1') {
      sb.classList.add('collapsed');
      document.getElementById('resize-left').style.display = 'none';
    }
    document.getElementById('resize-right').style.display = pp.classList.contains('hidden') ? 'none' : '';

    document.getElementById('btn-fold-left').onclick = (e) => { e.stopPropagation(); App.toggleLeftSidebar(); };
    document.getElementById('btn-fold-right').onclick = () => App.togglePromptPanel();
    sb.onclick = () => { if (sb.classList.contains('collapsed')) App.toggleLeftSidebar(); }; // 슬림 레일 클릭 = 펼치기

    // 드래그로 너비 조절 (드래그 중엔 트랜지션 끔)
    const wireResize = (handleId, panel, key, min, max, fromLeft) => {
      document.getElementById(handleId).onmousedown = (e) => {
        e.preventDefault();
        const handle = e.target;
        const startX = e.clientX, startW = panel.offsetWidth;
        panel.classList.add('no-anim');
        handle.classList.add('active');
        const move = (ev) => {
          const delta = ev.clientX - startX;
          let w = fromLeft ? startW + delta : startW - delta;
          w = Math.max(min, Math.min(max, w));
          panel.style.width = w + 'px';
          TerminalView.fitActive();
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          panel.classList.remove('no-anim');
          handle.classList.remove('active');
          localStorage.setItem(key, panel.offsetWidth);
          TerminalView.fitActive();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      };
    };
    wireResize('resize-left', sb, 'ta-left-w', 180, 420, true);
    wireResize('resize-right', pp, 'ta-right-w', 200, 460, false);

    // ── 작업 패널 (진행 계획 + 다음 프롬프트) 복원 + 리사이즈 ──
    const wp = document.getElementById('work-panel');
    const ww = Number(localStorage.getItem('ta-work-w'));
    if (ww >= 240) wp.style.width = ww + 'px';
    if (localStorage.getItem('ta-work-panel') === '1') wp.classList.remove('hidden');
    document.getElementById('resize-work').style.display = wp.classList.contains('hidden') ? 'none' : '';
    wireResize('resize-work', wp, 'ta-work-w', 240, 560, false);

    // 계획/초안 사이 가로 분할선: 드래그로 상단(계획) 높이 조절
    const planPanel = document.getElementById('plan-panel');
    const ph = Number(localStorage.getItem('ta-plan-h'));
    if (ph >= 90) planPanel.style.height = ph + 'px';
    document.getElementById('work-divider').onmousedown = (e) => {
      e.preventDefault();
      const handle = e.target;
      const startY = e.clientY, startH = planPanel.offsetHeight;
      handle.classList.add('active');
      const move = (ev) => {
        const max = wp.offsetHeight - 130; // 하단 최소 공간 확보
        const h = Math.max(90, Math.min(max, startH + (ev.clientY - startY)));
        planPanel.style.height = h + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        handle.classList.remove('active');
        localStorage.setItem('ta-plan-h', planPanel.offsetHeight);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
  },

  // ── 프리셋 드래그 정렬 ──
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
    await ta.reorderPresets(arr.map((p) => p.id));
  },

  // ── 프리셋 관리 팝업: 전역/프로젝트 전용 구분, 추가·수정·삭제 ──
  showPresetManager() {
    const active = App.state.sessions.find((s) => s.id === App.state.activeId);
    const projectId = active ? active.projectId : null;
    const proj = App.state.projects.find((p) => p.id === projectId);

    App.modal(`
      <h3>프리셋 관리</h3>
      <div class="pm-title">◆ 전역 프리셋 <button id="pm-add-g">+ 추가</button></div>
      <div class="pm-list" id="pm-globals"></div>
      <div class="pm-title">▸ ${proj ? proj.name + ' 전용' : '프로젝트 전용'} <button id="pm-add-p" ${proj ? '' : 'disabled'}>+ 추가</button></div>
      <div class="pm-list" id="pm-projs"></div>
      <div class="modal-actions"><button id="m-close">닫기</button></div>`,
      (m, close) => {
        const back = () => App.showPresetManager(); // 추가/수정 후 관리 팝업으로 복귀
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
            await ta.removePreset(p.id);
            App.state.presets = App.state.presets.filter((x) => x.id !== p.id);
            renderPresets();
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

  // ── 프로젝트 드래그 정렬 ──
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
    await ta.reorderProjects(arr.map((p) => p.id));
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
    localStorage.setItem('ta-active-session', id); // 웹뷰 리로드 복구 시 활성 세션 유지용
    TerminalView.activate(id);
    App.ackIfDone(id);
    App._autoPlanCache = ''; // 세션 전환 → 계획 패널 재렌더 유도
    if (!(id in App.state.manualPlans)) {
      // 백엔드 보관분 로드 (웹뷰 리로드 후에도 수동 항목 유지)
      ta.getManualPlan(id)
        .then((items) => { App.state.manualPlans[id] = items || []; App.renderWorkPanel(); })
        .catch(() => {});
    }
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
    delete App.state.manualPlans[id];
    delete App._inputBufs[id];
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
    if (App.state.images[id].length > 12) App.state.images[id].length = 12; // 표시 상한만큼만 보관
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
    if (execute) { ta.write(id, '\r'); App.trackInput(id, '\r'); }
    TerminalView.activate(id);
  },

  // ── 모달 ──
  modal(html, onOpen) {
    const bd = document.getElementById('modal-backdrop');
    const m = document.getElementById('modal');
    m.innerHTML = html;
    bd.classList.remove('hidden');
    // 바깥 클릭으로는 닫지 않는다 — 입력 중 드래그가 배경 클릭으로 판정돼
    // 작성 내용이 날아가는 실수가 잦았음. 닫기는 버튼 또는 Esc 로만.
    bd.onclick = null;
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { bd.classList.add('hidden'); document.removeEventListener('keydown', esc); };
    document.addEventListener('keydown', esc);
    onOpen(m, close);
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
          await ta.removeProject(existing.id);
          App.state.projects = App.state.projects.filter((p) => p.id !== existing.id);
          App.state.presets = App.state.presets.filter((p) => p.projectId !== existing.id);
          close(); App.renderAll();
        };
        m.querySelector('#m-save').onclick = async () => {
          if (!name.value.trim() || !path.value.trim()) return alert('이름과 경로를 입력하세요.');
          const chosen = getColor() || '#4f8cc9';
          if (existing) {
            const patch = { name: name.value.trim(), path: path.value.trim(), color: chosen };
            await ta.updateProject(existing.id, patch);
            Object.assign(existing, patch);
          } else {
            const p = await ta.addProject({ name: name.value.trim(), path: path.value.trim(), color: chosen });
            App.state.projects.push(p);
          }
          close(); App.renderAll();
        };
        name.focus();
      });
  },

  showPresetModal(existing, mgrOpts) {
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
        const finish = () => { close(); renderPresets(); if (mgrOpts && mgrOpts.back) mgrOpts.back(); };
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
          await ta.removePreset(existing.id);
          App.state.presets = App.state.presets.filter((p) => p.id !== existing.id);
          finish();
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
          finish();
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
