// 업데이트·자동 이어하기·종료 확인의 판단 로직 — DOM·IPC 없이 테스트할 수 있게 분리했다.
const UpdateCore = {
  IDLE_POLL_MS: 5000,        // '작업 끝나면 설치' 대기 중 작업 상태 확인 간격
  IDLE_STREAK_NEEDED: 3,     // 연속으로 이만큼 '작업 없음'이어야 설치 카운트다운 시작 (출력 공백 오판 방지)
  COUNTDOWN_SEC: 10,
  RECHECK_MS: 6 * 60 * 60 * 1000,
  FIRST_OUTPUT_WAIT_MS: 3000, // 복원된 셸의 첫 출력(프롬프트)을 기다리는 상한
  RESUME_QUEUE_HOLD_MS: 10000, // 이어하기 명령을 보낸 뒤에도 예약 프롬프트를 잠시 붙잡는다 (에이전트 기동 시간)
  IDLE_INSTALL_MAX_MS: 30 * 60 * 1000, // 이만큼 기다려도 작업이 안 끝나면 다시 묻는다

  // 작업 중 = 에이전트가 실행·허가 대기 중이거나, 멈추지 않은 예약 프롬프트가 남은 세션.
  // opts.agentIds(백엔드가 가린 에이전트 탭)를 주면 실행 상태는 그 목록만 믿는다 —
  // 출력 기반 상태로는 `npm run dev` 같은 셸 작업도 running 이라 설치 대기가 끝나지 않는다.
  // opts.pausedIds: 전송 확인 실패로 멈춘 예약 — 사용자가 결정할 때까지 자동으로 나가지 않으므로 작업이 아니다
  busySessionIds(sessions, drafts, opts) {
    const o = opts || {};
    const out = [];
    for (const s of sessions || []) {
      const queued = drafts && drafts['queued:' + s.id];
      const running = o.agentIds ? o.agentIds.has(s.id) : (s.status === 'running' || s.status === 'waiting');
      const pending = Array.isArray(queued) && queued.length > 0 && !(o.pausedIds && o.pausedIds.has(s.id));
      if (running || pending) out.push(s.id);
    }
    return out;
  },

  idleInstallExpired(startedAt, now) {
    return now - startedAt >= this.IDLE_INSTALL_MAX_MS;
  },

  nextIdleStreak(streak, busyCount) {
    return busyCount > 0 ? 0 : streak + 1;
  },

  readyToInstall(streak) {
    return streak >= this.IDLE_STREAK_NEEDED;
  },

  // 업데이트 안내 모달을 띄울지 — 같은 실행에서 '나중에'를 누른 버전, 다른 모달 위, 설치 대기 중에는 띄우지 않는다
  shouldPromptUpdate(info, ctx) {
    if (!info || !info.version) return false;
    const c = ctx || {};
    if (c.idleInstalling || c.modalOpen) return false;
    return !(c.dismissed && c.dismissed.has(info.version));
  },

  updateButtonLabel(busyCount) {
    return busyCount > 0 ? `지금 업데이트 (${busyCount}개 중단 후 이어하기)` : '지금 업데이트';
  },

  // 백엔드가 돌려준 이어하기 목록 중 실제로 복원된 세션만, 세션당 하나씩
  resumePlan(entries, sessions) {
    const alive = new Set((sessions || []).map((s) => s.id));
    const seen = new Set();
    const out = [];
    for (const e of entries || []) {
      if (!e || typeof e.command !== 'string' || !e.command.trim()) continue;
      if (!alive.has(e.sessionId) || seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      out.push({ sessionId: e.sessionId, command: e.command });
    }
    return out;
  },

  // 재개 명령에서 에이전트 실행 부분만 — `cd '<경로>' && ` 접두를 벗겨 다음 업데이트의 플래그 출처로 남긴다
  agentPartOf(command) {
    return String(command || '').replace(/^cd '(?:[^']|'\\'')*' && /, '');
  },

  // 종료 확인 모달에 나열할 세션 — 백엔드가 본 실행 중 세션 + 예약 프롬프트만 남은 세션
  quitTargets(backendSessions, sessions, drafts, pausedIds) {
    const out = (backendSessions || []).map((s) => ({ id: s.id, title: s.title, queued: false }));
    const seen = new Set(out.map((s) => s.id));
    for (const id of this.busySessionIds(sessions, drafts, { agentIds: new Set(), pausedIds })) {
      if (seen.has(id)) continue;
      const s = (sessions || []).find((x) => x.id === id);
      out.push({ id, title: s ? s.title : id, queued: true });
    }
    return out;
  }
};
