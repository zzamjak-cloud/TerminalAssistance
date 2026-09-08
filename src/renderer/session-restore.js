// 재시작 세션 복원 — 지난 실행에서 열려 있던 세션의 '자리'(프로젝트·경로·제목·id)를 되살린다.
// 화면 내용은 복원하지 않는다. 대신 그 경로의 최근 Claude/Codex 기록이 있으면
// 터미널 위에 배너를 띄워 `--resume` 으로 실제 작업을 이어가게 한다.
//
// 백엔드가 세션 id 를 그대로 되살리므로 분할 배치(ta-split-panes)는 기존 복원 경로가 그대로 처리한다.

// 배너를 제안할 기록의 신선도 상한 — 이보다 오래된 기록은 '이어서 하기'가 아니라 소음이다
const RESUME_SUGGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 건너뛴 세션들을 사용자에게 한 줄로 알린다 (사유별로 묶어서)
function describeSkippedSessions(skipped) {
  // 폴더 이름만 뽑는다 — 전체 경로는 토스트 한 줄에 들어가지 않고,
  // 사라진 워크트리는 폴더 이름(`레포-브랜치`)만으로 충분히 식별된다
  const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const byReason = { project: [], cwd: [], other: [] };
  for (const s of skipped || []) {
    // 사유마다 사용자에게 쓸모 있는 식별자가 다르다:
    // 폴더가 사라진 경우엔 '어느 폴더인지', 그 외엔 '어느 세션인지'
    if (s.reason === 'cwd') byReason.cwd.push(folderName(s.cwd) || s.title);
    else if (s.reason === 'project') byReason.project.push(s.title || folderName(s.cwd));
    else byReason.other.push(s.title || folderName(s.cwd));
  }
  const parts = [];
  if (byReason.project.length) parts.push(`프로젝트가 삭제됨 ${byReason.project.length}개`);
  if (byReason.cwd.length) parts.push(`작업 폴더가 없어짐 ${byReason.cwd.length}개 (${byReason.cwd.slice(0, 2).join(', ')}${byReason.cwd.length > 2 ? ' 외' : ''})`);
  if (byReason.other.length) parts.push(`시작 실패 ${byReason.other.length}개`);
  return parts.join(' · ');
}

Object.assign(App, {
  _restoredSessions: new Set(), // 이번 부팅에서 되살린 세션 id — '복원됨' 태그·배너 대상
  _resumeBanners: new Map(),    // sessionId → 배너 엘리먼트

  // 부팅 초반에 호출 — getState 보다 먼저 돌려서 복원된 세션이 상태에 함께 실려오게 한다
  async restoreSessions() {
    let r = null;
    try { r = await ta.restoreSessions(); }
    catch (e) { console.warn('세션 복원 실패:', e); return null; }
    if (!r || r.alreadyRunning) return r;
    for (const s of r.restored || []) App._restoredSessions.add(s.id);
    return r;
  },

  // UI 가 그려진 뒤 호출 — 건너뛴 항목 알림 + 이어서 하기 배너
  async afterSessionRestore(result) {
    if (!result || result.alreadyRunning) return;
    const skippedText = describeSkippedSessions(result.skipped);
    if (skippedText) {
      App.showToast(`⚠ 복원하지 못한 세션이 있습니다 — ${skippedText}`, 9000);
    }
    // '복원됨' 표시는 실제 키 입력으로만 걷는다.
    // term.onData 는 셸 시작 출력에 대한 터미널 자동 응답(커서 위치 보고 등)도 실어 나르므로
    // 사용자 활동 신호로 쓸 수 없다 — 부팅 직후 표시가 그대로 사라져 버린다.
    for (const id of App._restoredSessions) App.markActivityOnInput(id);
    // 세션마다 기록 조회가 필요하므로 경로 단위로 묶어 중복 호출을 없앤다
    const byCwd = new Map();
    for (const id of App._restoredSessions) {
      const s = App.state.sessions.find((x) => x.id === id);
      if (!s || !s.cwd) continue;
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd).push(s.id);
    }
    await Promise.all([...byCwd.entries()].map(async ([cwd, ids]) => {
      let claude = [];
      let codex = [];
      try {
        [claude, codex] = await Promise.all([
          ta.listClaudeSessions(cwd).catch(() => []),
          ta.listCodexSessions(cwd).catch(() => [])
        ]);
      } catch (_) { return; }
      const items = App.buildSessionHistoryItems(cwd, claude, codex);
      const latest = items[0];
      if (!latest || Date.now() - latest.mtimeMs > RESUME_SUGGEST_MAX_AGE_MS) return;
      // 같은 경로의 세션이 여러 개면 첫 세션에만 제안한다 — 같은 대화를 두 곳에서 재개하면
      // Claude/Codex 쪽 기록이 엉킨다
      App.mountResumeBanner(ids[0], latest);
    }));
  },

  // 복원된 세션에 일회성 keydown 감시를 건다 — 첫 키 입력이 곧 '이 세션을 쓰기 시작했다'는 신호
  markActivityOnInput(sessionId) {
    const view = TerminalView.views.get(sessionId);
    if (!view || !view.holder) return;
    const onKey = () => {
      view.holder.removeEventListener('keydown', onKey, true);
      App.noteSessionActivity(sessionId);
    };
    view.holder.addEventListener('keydown', onKey, true);
  },

  // 기록에서 '마지막으로 보낸 요청'을 찾는다 — 어떤 작업을 하다 멈췄는지 떠올리는 단서.
  // 목록의 preview 는 '첫' 요청이라 세션을 식별하는 데는 쓸모 있지만 진행 상황을 알려주지 못한다.
  // 열람 팝업과 같은 파서를 쓰므로(파일 끝에서 읽음) 대형 세션에서도 비용이 일정하다.
  async loadLastUserRequest(item) {
    const cwd = item.cwd || App.sessionHistoryCwd();
    if (!cwd || !item.id) return '';
    let msgs = [];
    try {
      msgs = item.source === 'codex'
        ? await ta.codexSessionMessages(cwd, item.id)
        : await ta.claudeSessionMessages(cwd, item.id);
    } catch (_) { return ''; }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user' && m.kind === 'text' && String(m.text || '').trim()) {
        return String(m.text).trim();
      }
    }
    return '';
  },

  mountResumeBanner(sessionId, item) {
    const view = TerminalView.views.get(sessionId);
    if (!view || !view.holder || App._resumeBanners.has(sessionId)) return;

    const bar = document.createElement('div');
    bar.className = 'resume-banner';

    const body = document.createElement('div');
    body.className = 'rb-body';

    // 첫 줄 = 이 기록이 무엇인지 (도구 · 시각 · 세션을 시작한 첫 요청)
    const meta = document.createElement('div');
    meta.className = 'rb-meta';
    const label = item.source === 'codex' ? 'Codex' : 'Claude';
    meta.textContent = `${label} · ${formatRelativeTime(item.mtimeMs)} · ${item.preview}`;
    meta.title = item.preview;

    // 둘째 줄 = 마지막 실행 요청 (비동기로 채운다 — 배너 표시를 지연시키지 않는다)
    const last = document.createElement('div');
    last.className = 'rb-last loading';
    last.textContent = '마지막 요청 불러오는 중…';

    body.append(meta, last);

    const go = document.createElement('button');
    go.className = 'rb-go';
    go.textContent = '이어서 하기';
    go.onclick = () => {
      App.dismissResumeBanner(sessionId);
      App.resumeSessionHistory(item, { sessionId });
    };

    const close = document.createElement('button');
    close.className = 'rb-close';
    close.textContent = '✕';
    close.title = '닫기';
    close.onclick = () => App.dismissResumeBanner(sessionId);

    bar.append(body, go, close);
    view.holder.appendChild(bar);
    App._resumeBanners.set(sessionId, bar);
    // 첫 키 입력 시 걷는 일은 markActivityOnInput 이 이미 맡고 있다 (noteSessionActivity 경유)

    void App.loadLastUserRequest(item).then((text) => {
      // 조회 중 사용자가 배너를 닫았거나 세션을 쓰기 시작했으면 손대지 않는다
      if (App._resumeBanners.get(sessionId) !== bar) return;
      last.classList.remove('loading');
      if (!text) {
        last.remove(); // 찾지 못하면 빈 줄을 남기지 않는다
        return;
      }
      last.textContent = '마지막 요청 · ' + text.replace(/\s+/g, ' ');
      last.title = text;
    });
  },

  dismissResumeBanner(sessionId) {
    const bar = App._resumeBanners.get(sessionId);
    if (!bar) return;
    App._resumeBanners.delete(sessionId);
    bar.remove();
    App._restoredSessions.delete(sessionId); // 사이드바의 '복원됨' 태그도 함께 걷는다
    renderSidebar();
  },

  // 세션이 실제로 돌기 시작하면(프롬프트 전송·재개 실행) 배너를 걷는다
  noteSessionActivity(sessionId) {
    if (App._resumeBanners.has(sessionId)) App.dismissResumeBanner(sessionId);
    else if (App._restoredSessions.delete(sessionId)) renderSidebar();
  }
});
