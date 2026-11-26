// 사용 중 업데이트 — 안내 모달, '작업 끝나면 설치', 업데이트 재시작 후 자동 이어하기, 작업 중 종료 확인.
// 판단 로직은 update-core.js(UpdateCore)에 있고, 여기서는 화면과 IPC 만 다룬다.
Object.assign(App, {
  _dismissedUpdates: new Set(), // 이번 실행에서 '나중에'를 누른 버전
  _idleInstall: null,           // { version, streak, timer, countdown } — '작업 끝나면 설치' 대기 상태
  _autoResumeHold: new Set(),   // 이어하기 명령 전·직후라 예약 프롬프트를 붙잡아 둘 세션
  _autoResumeMissedDone: new Set(), // 붙잡는 동안 턴이 끝난 세션 — 해제할 때 예약 큐를 한 번 돌린다
  _autoResumed: new Set(),      // 이번 부팅에 자동 이어하기 대상이 된 세션 — '이어서 하기' 배너 생략
  _sawOutput: new Set(),        // 첫 출력을 본 세션
  _outputWaiters: new Map(),    // sessionId → 첫 출력 대기 해제 함수

  CHANGELOG_URL: 'https://github.com/zzamjak-cloud/TerminalAssistance/blob/main/CHANGELOG.md',

  initUpdateUI() {
    ta.onUpdateProgress((p) => App.onUpdateProgress(p));
    ta.onConfirmQuit((p) => App.showQuitConfirm(p));
    setTimeout(() => App.checkUpdate(), 2500);
    setInterval(() => App.checkUpdate(), UpdateCore.RECHECK_MS);
  },

  _modalOpen() {
    const bd = document.getElementById('modal-backdrop');
    return !!bd && !bd.classList.contains('hidden');
  },

  async checkUpdate() {
    let info = null;
    try { info = await ta.checkUpdate(); } catch (_) { return; }
    const ctx = { dismissed: App._dismissedUpdates, modalOpen: App._modalOpen(), idleInstalling: !!App._idleInstall };
    if (!UpdateCore.shouldPromptUpdate(info, ctx)) return;
    const busy = await App._busyIds();
    if (App._modalOpen()) return; // 판정하는 사이 다른 모달이 열렸다
    const busyNote = busy.length
      ? `<p class="update-busy">${tr('작업 중인 세션 {n}개 — 지금 업데이트하면 중단되고, 재시작 뒤 실행 중이던 Claude·Codex 를 자동으로 이어 실행합니다.', { n: busy.length })}</p>`
      : '';
    App.modal(`
      <h3>${tr('새 버전 v{version} 이 있습니다', { version: escapeHtml(info.version) })}</h3>
      <p style="color:var(--fg-dim);line-height:1.6;margin-bottom:6px">
        ${info.notes ? escapeHtml(String(info.notes)).slice(0, 400) : tr('업데이트를 설치하면 앱이 자동으로 재시작됩니다.')}
      </p>
      ${busyNote}
      <p><a href="#" id="m-changelog" style="color:var(--done)">${tr('전체 변경 사항 보기 (CHANGELOG)')}</a></p>
      <div class="modal-actions">
        <button id="m-cancel">${tr('나중에')}</button>
        ${busy.length ? '<button id="m-idle">' + tr('작업 끝나면 설치') + '</button>' : ''}
        <button id="m-update">${escapeHtml(UpdateCore.updateButtonLabel(busy.length))}</button>
      </div>`,
      (m, close) => {
        m.querySelector('#m-changelog').onclick = (e) => { e.preventDefault(); ta.openUrl(App.CHANGELOG_URL); };
        m.querySelector('#m-cancel').onclick = () => { App._dismissedUpdates.add(info.version); close(); };
        const idle = m.querySelector('#m-idle');
        if (idle) idle.onclick = () => { close(); void App.installWhenIdle(info.version); };
        const btn = m.querySelector('#m-update');
        btn.onclick = async () => {
          const label = btn.textContent;
          btn.disabled = true;
          btn.textContent = tr('다운로드 중…');
          App._progressButton = btn;
          try { await ta.installUpdate(); } // 성공 시 앱이 재시작되므로 이후 코드는 실행되지 않음
          catch (e) { btn.disabled = false; btn.textContent = label; alert(tr('업데이트 실패: {e}', { e })); }
          finally { App._progressButton = null; }
        };
      });
  },

  onUpdateProgress(p) {
    if (!p || !p.total) return;
    const pct = Math.min(100, Math.round((p.done / p.total) * 100));
    if (App._progressButton) App._progressButton.textContent = tr('다운로드 중… {pct}%', { pct });
  },

  // 작업 중 탭 id — 에이전트 탭은 백엔드가 가리고, 예약 프롬프트는 멈춘 것을 뺀다
  async _busyIds() {
    let agentIds = [];
    try { agentIds = (await ta.busyAgentSessions()) || []; } catch (_) {}
    const paused = (typeof PromptQueue !== 'undefined' && PromptQueue._paused) ? new Set(PromptQueue._paused.keys()) : new Set();
    return UpdateCore.busySessionIds(App.state.sessions, App.state.drafts, { agentIds: new Set(agentIds), pausedIds: paused });
  },

  // '작업 끝나면 설치' — 미리 받아 두고, 작업 없음이 연속으로 관측되면 취소 가능한 카운트다운 후 설치
  async installWhenIdle(version) {
    if (App._idleInstall) return;
    const st = App._idleInstall = { version, streak: 0, timer: null, countdown: null, startedAt: Date.now(), ticking: false };
    App.showToast(tr('업데이트를 내려받는 중입니다 — 작업이 끝나면 자동으로 설치합니다'));
    try { await ta.downloadUpdate(); }
    catch (e) {
      if (App._idleInstall === st) App._idleInstall = null;
      App.showToast(tr('업데이트 다운로드 실패: {e}', { e }));
      return;
    }
    if (App._idleInstall !== st) return; // 다운로드 중 취소됨
    App.showToast(tr('업데이트 준비 완료 — 모든 세션의 작업이 끝나면 설치합니다'));
    App._startIdleWatch(st);
  },

  _startIdleWatch(st) {
    st.startedAt = Date.now();
    st.streak = 0;
    st.timer = setInterval(() => { void App._idleInstallTick(st); }, UpdateCore.IDLE_POLL_MS);
  },

  async _idleInstallTick(st) {
    if (App._idleInstall !== st || st.countdown || st.ticking) return;
    // 오래 기다려도 작업이 안 끝나면 계속 기다릴지 묻는다 (상태 판정이 틀려 영영 안 끝나는 경우 대비)
    if (UpdateCore.idleInstallExpired(st.startedAt, Date.now())) {
      clearInterval(st.timer);
      st.timer = null;
      App.showActionToast(tr('30분째 작업이 끝나지 않아 업데이트를 기다리는 중입니다'), [
        { label: tr('지금 설치'), onClick: () => { App.hideActionToast(); void App._installNow(st); } },
        { label: tr('계속 대기'), onClick: () => { App.hideActionToast(); if (App._idleInstall === st) App._startIdleWatch(st); } },
        { label: tr('취소'), onClick: () => App.cancelIdleInstall() }
      ]);
      return;
    }
    st.ticking = true;
    try {
      const busy = (await App._busyIds()).length;
      if (App._idleInstall !== st || st.countdown) return;
      st.streak = UpdateCore.nextIdleStreak(st.streak, busy);
      if (UpdateCore.readyToInstall(st.streak)) App._startInstallCountdown(st);
    } finally {
      st.ticking = false;
    }
  },

  _startInstallCountdown(st) {
    let left = UpdateCore.COUNTDOWN_SEC;
    const cancel = [{ label: tr('취소'), onClick: () => App.cancelIdleInstall() }];
    const text = () => tr('작업이 모두 끝났습니다 — {n}초 후 업데이트를 설치하고 재시작합니다', { n: left });
    App.showActionToast(text(), cancel);
    let checking = false;
    st.countdown = setInterval(async () => {
      if (App._idleInstall !== st || checking) return;
      checking = true;
      try {
        // 카운트다운 중 새 작업이 시작되면 설치를 미루고 다시 기다린다
        if ((await App._busyIds()).length > 0) {
          clearInterval(st.countdown);
          st.countdown = null;
          st.streak = 0;
          App.hideActionToast();
          return;
        }
        left -= 1;
        if (left > 0) { App.showActionToast(text(), cancel); return; }
        clearInterval(st.countdown);
        await App._installNow(st);
      } finally {
        checking = false;
      }
    }, 1000);
  },

  async _installNow(st) {
    if (App._idleInstall !== st) return;
    clearInterval(st.timer);
    clearInterval(st.countdown);
    App.showActionToast(tr('업데이트를 설치하는 중…'), []);
    try { await ta.installUpdate(); } // 성공 시 앱이 재시작된다
    catch (e) {
      App._idleInstall = null;
      App.hideActionToast();
      App.showToast(tr('업데이트 설치 실패: {e}', { e }), 9000);
    }
  },

  cancelIdleInstall() {
    const st = App._idleInstall;
    if (!st) return;
    clearInterval(st.timer);
    clearInterval(st.countdown);
    App._idleInstall = null;
    App.hideActionToast();
    App.showToast(tr('자동 설치를 취소했습니다 — 다음 업데이트 확인 때 다시 안내합니다'));
  },

  // 버튼이 달린 토스트 (카운트다운 취소 등). 일반 토스트(#app-toast)와 겹치지 않게 위쪽에 띄운다.
  // buttons = [{ label, onClick }]
  showActionToast(message, buttons) {
    let el = document.getElementById('action-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'action-toast';
      el.appendChild(document.createElement('span'));
      document.body.appendChild(el);
    }
    el.querySelector('span').textContent = message;
    for (const old of el.querySelectorAll('button')) old.remove();
    for (const b of buttons || []) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      el.appendChild(btn);
    }
    el.classList.add('show');
  },

  hideActionToast() {
    const el = document.getElementById('action-toast');
    if (el) el.classList.remove('show');
  },

  // ── 업데이트 재시작 후 자동 이어하기 ──

  _autoResumeKind: null, // 'update' | 'crash' — 완료 토스트 문구
  _crashed: false,       // 지난 실행이 비정상 종료였다 (남은 프로세스를 바로 확인한다)

  // getState 직후 호출 — 업데이트 재시작 기록(우선) 또는 비정상 종료 스냅샷을 가져오고,
  // 대상 세션의 예약 프롬프트를 붙잡는다
  async takeAutoResume(restoreResult) {
    if (!restoreResult || restoreResult.alreadyRunning) return [];
    let r = null;
    try { r = await ta.takePendingResume(); } catch (_) { return []; }
    App._crashed = !!(r && r.crashed);
    App._autoResumeKind = r && r.kind;
    const plan = UpdateCore.resumePlan(r && r.entries, App.state.sessions);
    for (const e of plan) {
      App._autoResumeHold.add(e.sessionId);
      App._autoResumed.add(e.sessionId);
    }
    return plan;
  },

  // 셸이 프롬프트를 그린 뒤(첫 출력, 최대 3초) 재개 명령을 입력한다
  async runAutoResume(plan) {
    if (!plan || !plan.length) return;
    let started = 0;
    await Promise.all(plan.map(async (e) => {
      await App.waitFirstOutput(e.sessionId, UpdateCore.FIRST_OUTPUT_WAIT_MS);
      if (!TerminalView.views.has(e.sessionId)) { App._releaseResumeHold(e.sessionId); return; }
      App.noteSessionActivity(e.sessionId);
      TerminalView.noteSubmittedLine(e.sessionId, UpdateCore.agentPartOf(e.command));
      // 그새 사용자가 입력줄에 무언가 쳤으면 지우고 입력한다 — 명령 앞에 붙어 엉뚱한 명령이 되지 않게
      const v = TerminalView.views.get(e.sessionId);
      const dirty = v && (v.typedValid === false || !!v.typedText);
      ta.write(e.sessionId, (dirty ? '\x15' : '') + e.command + '\r');
      TerminalView.resetTypedLine(e.sessionId);
      started++;
      setTimeout(() => App._releaseResumeHold(e.sessionId), UpdateCore.RESUME_QUEUE_HOLD_MS);
    }));
    if (started) {
      App.showToastWhenFree(App._autoResumeKind === 'crash'
        ? tr('비정상 종료 후 복구 — 세션 {n}개 이어하기', { n: started })
        : tr('업데이트 완료 — 세션 {n}개 이어하기', { n: started }));
    }
  },

  _releaseResumeHold(sessionId) {
    App._autoResumeHold.delete(sessionId);
    if (App._autoResumeMissedDone.delete(sessionId)) App.handleQueuedDone(sessionId);
  },

  waitFirstOutput(sessionId, ms) {
    if (App._sawOutput.has(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        App._outputWaiters.delete(sessionId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      App._outputWaiters.set(sessionId, done);
    });
  },

  noteOutput(sessionId) {
    if (App._sawOutput.has(sessionId)) return;
    App._sawOutput.add(sessionId);
    const w = App._outputWaiters.get(sessionId);
    if (w) w();
  },

  // ── 작업 중 종료 확인 ──
  showQuitConfirm(payload) {
    const m = document.getElementById('modal');
    if (App._modalOpen() && m && m.querySelector('#m-quit')) return; // 이미 떠 있다 — 중복 요청
    const paused = (typeof PromptQueue !== 'undefined' && PromptQueue._paused) ? new Set(PromptQueue._paused.keys()) : new Set();
    const targets = UpdateCore.quitTargets(payload && payload.sessions, App.state.sessions, App.state.drafts, paused);
    if (!targets.length) { void ta.confirmQuit(); return; }
    const items = targets.slice(0, 8).map((t) =>
      `<li>${escapeHtml(t.title || '')}${t.queued ? ' <span style="color:var(--fg-dim)">(' + tr('예약 프롬프트 남음') + ')</span>' : ''}</li>`).join('');
    const more = targets.length > 8 ? `<li style="color:var(--fg-dim)">${tr('외 {n}개', { n: targets.length - 8 })}</li>` : '';
    App.modal(`
      <h3>${tr('작업 중인 세션 {n}개가 중단됩니다', { n: targets.length })}</h3>
      <ul class="quit-list">${items}${more}</ul>
      <p style="color:var(--fg-dim);line-height:1.6">${tr('종료해도 세션 배치는 다음 실행에서 복원됩니다. (5초 안에 다시 종료하면 묻지 않고 종료합니다)')}</p>
      <div class="modal-actions">
        <button id="m-cancel">${tr('취소')}</button>
        <button id="m-quit" class="danger">${tr('종료')}</button>
      </div>`,
      (el, close) => {
        el.querySelector('#m-cancel').onclick = close;
        el.querySelector('#m-quit').onclick = () => {
          App.flushComposerPersists();
          void ta.confirmQuit();
        };
        el.querySelector('#m-cancel').focus(); // Enter 연타로 종료되지 않게
      });
  }
});
