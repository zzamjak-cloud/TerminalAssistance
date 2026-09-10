// 예약 프롬프트 큐 — 세션당 하나씩, 전달을 확인한 뒤에만 큐에서 지운다.
//
// 설계 원칙: 유실 0 > 중복 0 > 자동화.
//   - 항목은 '전송 확인' 전까지 App.state.drafts 에 그대로 남는다. 앱이 죽어도
//     ta-config.json 에 남아 다음 실행에서 복원된다 (예전의 지우고-보내기는 at-most-once 였다).
//   - 붙여넣기가 화면에 뜬 것을 확인한 뒤에만 Enter 를 보낸다. TUI 가 붙여넣기 직후의
//     Enter 를 삼키던 문제를 고정 지연(120ms) 대신 실제 관측으로 막는다.
//   - 확인에 실패하면 자동 재시도로 밀어붙이지 않고 멈춘다. 붙여넣기는 재시도하지
//     않는다 — 화면 판정이 틀렸을 때 같은 프롬프트가 두 번 들어가는 쪽이 더 나쁘다.
//     멈춘 사유는 배너로 노출하고 사용자가 결정한다.
//
// 완료 판정 근거는 두 가지이며 하나만 맞아도 인정한다.
//   ① 세션이 running 으로 들어감 — 가장 확실하다.
//   ② 붙여넣은 텍스트가 입력상자에서 사라짐 — Claude Code 는 보낸 프롬프트를 대화
//      기록에 그대로 다시 그려서 ② 만으로는 부족할 때가 있어 ① 을 함께 본다.
const PromptQueue = {
  SETTLE_MS: 350,        // done 관측 후 TUI 가 턴 종료 렌더를 끝낼 시간
  PASTE_TRIES: 6,        // 확인 A: 붙여넣기가 입력상자에 떴는가
  PASTE_POLL_MS: 100,
  SUBMIT_TRIES: 13,      // 확인 B: 전송됐는가 (Rust 상태 폴링 500ms 를 여러 번 덮는다)
  SUBMIT_POLL_MS: 150,

  _inflight: new Map(),  // sessionId → { draftId, text } — 전송 확인이 끝날 때까지
  _paused: new Map(),    // sessionId → { reason, text } — 'leftover' | 'paste' | 'submit' | 'error'
  _sawRunning: new Set(),// 이번 전달 이후 running 을 관측한 세션

  // ── 외부 진입점 ──

  // running → done 전이 관측. 큐가 있으면 딱 한 항목을 전달한다.
  async onSessionDone(sessionId) {
    if (!sessionId || this._inflight.has(sessionId)) return;
    const paused = this._paused.get(sessionId);
    if (paused) {
      // 잔여 입력 때문에 멈춘 것은 입력줄이 비면 스스로 재개한다.
      // 전송 확인 실패는 사용자가 배너에서 결정할 때까지 기다린다.
      if (paused.reason !== 'leftover' || this._leftoverText(sessionId)) return;
      this._paused.delete(sessionId);
    }
    await this._pump(sessionId);
  },

  // running 관측 — 전달 확인의 1순위 근거
  onSessionRunning(sessionId) {
    if (sessionId) this._sawRunning.add(sessionId);
  },

  onSessionGone(sessionId) {
    this._inflight.delete(sessionId);
    this._paused.delete(sessionId);
    this._sawRunning.delete(sessionId);
  },

  // 멈춰 있는 사유 (배너용). 없으면 null.
  pausedInfo(sessionId) {
    return this._paused.get(sessionId) || null;
  },

  // 배너 [다시 시도]
  async retry(sessionId) {
    this._paused.delete(sessionId);
    this._render();
    await this._pump(sessionId);
  },

  // 배너 [취소] — 멈춘 항목만 버리고 뒤 항목은 그대로 둔다
  async cancelPaused(sessionId) {
    const head = this._head(sessionId);
    this._paused.delete(sessionId);
    if (head) await this._drop(sessionId, head.id);
    else this._render();
  },

  // 배너 [입력창으로] — 내용을 프롬프트 입력창으로 되돌리고 큐에서 뺀다
  async releaseToComposer(sessionId) {
    const head = this._head(sessionId);
    this._paused.delete(sessionId);
    if (!head) { this._render(); return; }
    const current = App.composerText(sessionId);
    App.setComposerText(sessionId, current.trim() ? `${current.replace(/\n+$/, '')}\n${head.text}` : head.text);
    await this._drop(sessionId, head.id);
  },

  // ── 내부 ──

  _head(sessionId) {
    const list = App.state.drafts[App.queueKey(sessionId)] || [];
    return list[0] || null;
  },

  _render() {
    App.renderComposerQueue();
  },

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  // 조건이 참이 될 때까지 폴링. 마지막 대기 뒤에도 한 번 더 본다.
  async _poll(check, tries, intervalMs) {
    for (let i = 0; i < tries; i++) {
      if (check()) return true;
      await this._sleep(intervalMs);
    }
    return !!check();
  },

  // 지금 입력상자를 점유하고 있는 남의 텍스트. 없으면 ''.
  _leftoverText(sessionId) {
    const stuck = this._paused.get(sessionId);
    // 앞서 붙여넣기에 실패한 항목이 뒤늦게 화면에 떠 있을 수 있다 — 그 위에 또 붙이지 않는다
    if (stuck && stuck.text && TerminalView.textOnInputLine(sessionId, stuck.text)) return stuck.text;
    return TerminalView.pendingTypedLine(sessionId) || '';
  },

  // 큐 선두 하나를 전달한다. 확인에 성공했을 때만 큐에서 지운다.
  async _pump(sessionId) {
    const draft = this._head(sessionId);
    if (!draft) return;

    const text = App.normalizeComposerSubmitText(draft.text);
    if (!text.trim()) { await this._drop(sessionId, draft.id); return; } // 빈 항목은 조용히 정리
    if (!TerminalView.views.has(sessionId)) return; // 뷰가 없다 — 큐를 지키고 다음 기회를 기다린다

    this._inflight.set(sessionId, { draftId: draft.id, text });
    this._sawRunning.delete(sessionId);
    try {
      const reason = await this._deliver(sessionId, text);
      if (reason) this._pause(sessionId, reason, text);
      else await this._drop(sessionId, draft.id);
    } catch (e) {
      console.warn('예약 전송 실패:', e);
      this._pause(sessionId, 'error', text);
    } finally {
      this._inflight.delete(sessionId);
    }
  },

  // 전달 시도. 성공하면 '' , 실패하면 사유 문자열을 돌려준다.
  async _deliver(sessionId, text) {
    await this._sleep(this.SETTLE_MS);
    if (!TerminalView.views.has(sessionId)) return 'gone';

    // 이 내용이 이미 입력상자에 떠 있으면 다시 붙이지 않는다 — 앞선 시도가 뒤늦게
    // 들어갔을 수 있고, 그 위에 또 붙이면 같은 프롬프트가 두 번 들어간다.
    let landed = TerminalView.textOnInputLine(sessionId, text);
    if (!landed) {
      if (this._leftoverText(sessionId)) return 'leftover';
      App.noteSessionActivity(sessionId); // 프롬프트 전송도 사용자 활동 — 복원 표시를 걷는다
      TerminalView.paste(sessionId, text);
      landed = await this._poll(
        () => TerminalView.textOnInputLine(sessionId, text), this.PASTE_TRIES, this.PASTE_POLL_MS
      );
    }
    if (!landed) return 'paste'; // 붙여넣기 자체가 안 들어갔다 — Enter 를 보내면 안 된다

    // Enter 는 붙여넣기와 분리된 별도 write 로 보낸다.
    // ESC+CR 을 한 번에 쓰면 TUI(crossterm)가 Alt+Enter 로 읽어 줄바꿈만 넣는다.
    // 빈 입력줄에 Enter 가 한 번 더 가는 것은 무해하므로 재전송은 허용한다.
    for (let attempt = 1; attempt <= 2; attempt++) {
      ta.write(sessionId, '\r');
      TerminalView.resetTypedLine(sessionId);
      const sent = await this._poll(
        () => this._looksSubmitted(sessionId, text), this.SUBMIT_TRIES, this.SUBMIT_POLL_MS
      );
      if (sent) return '';
    }
    return 'submit';
  },

  _looksSubmitted(sessionId, text) {
    if (this._sawRunning.has(sessionId)) return true;
    return !TerminalView.textOnInputLine(sessionId, text);
  },

  _pause(sessionId, reason, text) {
    this._paused.set(sessionId, { reason, text });
    this._render();
  },

  // 전달이 확인된 항목만 큐에서 제거한다.
  // 저장이 실패하면 메모리 큐는 이미 진행한 상태라 재시작 시 한 번 더 나갈 수 있다 —
  // 유실보다 중복이 낫다는 판단이며, 확인 로직이 중복 전송을 대부분 흡수한다.
  async _drop(sessionId, draftId) {
    const key = App.queueKey(sessionId);
    const before = App.state.drafts[key] || [];
    const next = before.filter((d) => d.id !== draftId);
    App.state.drafts[key] = next;
    this._render();
    try {
      await App.persistDraftList(key, next);
    } catch (e) {
      console.warn('예약 큐 저장 실패:', e);
    }
  },
};
