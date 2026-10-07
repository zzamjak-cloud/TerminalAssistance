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
// 완료 판정은 두 경로다.
//   훅 경로 (Claude Code + TA 훅 동작 중): UserPromptSubmit 훅이 받은 프롬프트 원문이
//     예약 내용과 같을 때만 전송으로 확정한다. 화면을 추측하지 않으므로 긴 붙여넣기가
//     [Pasted text #N] 로 접혀도, 백그라운드 작업으로 Claude 가 스스로 깨어나도 틀리지 않는다.
//     Enter 재전송은 우리 내용이 아직 입력상자에 보이고 Claude 가 움직이지 않았을 때만 한다.
//     훅이 살아 있는지는 상태 파일 존재가 아니라 '방금 턴 동안 기록했는가'로 본다.
//   화면 경로 (훅이 없는 세션 — Codex·셸 등): 하나만 맞아도 인정한다.
//     ① 세션이 running 으로 들어감.
//     ② 붙여넣은 텍스트가 입력상자에서 사라짐 — Claude Code 는 보낸 프롬프트를 대화
//        기록에 그대로 다시 그려서 ② 만으로는 부족할 때가 있어 ① 을 함께 본다.
const PromptQueue = {
  SETTLE_MS: 350,        // done 관측 후 TUI 가 턴 종료 렌더를 끝낼 시간
  // 확인 A: 붙여넣기가 입력상자에 떴는가. Claude Code 2.1.x 는 붙여넣기를 그리기까지
  // 유휴 세션에서도 0.5~1.4초가 걸린다(실측) — 긴 턴 직후·훅 실행 중엔 더 늦다.
  // 뜨는 즉시 폴링을 끝내므로 넉넉히 잡아도 평소 지연은 늘지 않는다.
  PASTE_TRIES: 50,
  PASTE_POLL_MS: 100,
  SUBMIT_TRIES: 13,      // 확인 B: 전송됐는가 (Rust 상태 폴링 500ms 를 여러 번 덮는다)
  SUBMIT_POLL_MS: 150,
  // 훅 경로: Enter 한 번마다 훅 기록을 기다리는 시간. Windows 훅은 PowerShell 기동이라 1초 안팎 걸린다.
  HOOK_TRIES: 25,
  HOOK_POLL_MS: 250,
  HOOK_ENTER_ATTEMPTS: 3,
  HOOK_CLOCK_SLACK_MS: 2000, // 훅 시각(스크립트 시계)과 running 관측 시각(렌더러 시계)의 어긋남 허용치

  _inflight: new Map(),  // sessionId → { draftId, text } — 전송 확인이 끝날 때까지
  // sessionId → { reason, text, hookBase? }
  //   reason: 'leftover' | 'paste' | 'submit' | 'unconfirmed' | 'mismatch' | 'error'
  _paused: new Map(),
  _sawRunning: new Set(),// 이번 전달 이후 running 을 관측한 세션
  _runningAt: new Map(), // sessionId → 마지막 running 관측 시각(ms) — 훅 생존 판정용
  _hookBase: new Map(),  // sessionId → 이번 전달 직전 훅이 이미 받은 프롬프트 id 목록 (훅 경로가 아니면 없음)
  _resolving: new Set(), // 멈춘 항목의 뒤늦은 전송을 지켜보는 중인 세션

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
    if (!sessionId) return;
    this._sawRunning.add(sessionId);
    this._runningAt.set(sessionId, Date.now());
    // 멈춰 있던 항목이 결국 전송됐을 수 있다(사용자가 터미널에서 Enter 등) — 훅이 확정하면 정리한다
    if (this._paused.has(sessionId) && !this._inflight.has(sessionId)) void this._resolvePausedByHook(sessionId);
  },

  onSessionGone(sessionId) {
    this._inflight.delete(sessionId);
    this._paused.delete(sessionId);
    this._sawRunning.delete(sessionId);
    this._runningAt.delete(sessionId);
    this._hookBase.delete(sessionId);
  },

  // 멈춰 있는 사유 (배너용). 없으면 null.
  pausedInfo(sessionId) {
    return this._paused.get(sessionId) || null;
  },

  // 배너 [다시 시도]
  async retry(sessionId) {
    const paused = this._paused.get(sessionId);
    if (this._inflight.has(sessionId)) return;
    // 중복 전송의 마지막 관문 — 그사이 실제로 전송됐다면 다시 보내지 않고 정리만 한다
    if (paused && Array.isArray(paused.hookBase)) {
      const verdict = this._hookVerdict(await this._hookSnapshot(sessionId), paused.hookBase, paused.text);
      if (this._paused.get(sessionId) !== paused) return;
      if (verdict === 'match') {
        this._paused.delete(sessionId);
        const head = this._head(sessionId);
        if (head && App.normalizeComposerSubmitText(head.text) === paused.text) await this._drop(sessionId, head.id);
        else this._render();
        return;
      }
    }
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
    // 접힌 긴 붙여넣기는 원문 비교가 안 된다 — 표지가 보이면 무언가 입력상자에 남아 있는 것이다
    if (TerminalView.pastePlaceholderOnScreen && TerminalView.pastePlaceholderOnScreen(sessionId)) return '[Pasted text]';
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
    // 훅 경로에서 멈췄다면 훅이 뒤늦게 올 수 있다 — 한 번 더 지켜보고 전송이 확정되면 정리한다
    if (this._paused.has(sessionId)) void this._resolvePausedByHook(sessionId);
  },

  // 훅 스냅샷 { hooked, stateTs, entries:[{id, prompt}] }. 조회 실패·미지원이면 null (화면 경로로 간다).
  async _hookSnapshot(sessionId) {
    if (typeof ta === 'undefined' || typeof ta.hookPrompt !== 'function') return null;
    try {
      const s = await ta.hookPrompt(sessionId);
      if (!s || typeof s !== 'object') return null;
      const entries = Array.isArray(s.entries)
        ? s.entries.filter((e) => e && e.id).map((e) => ({ id: String(e.id), prompt: e.prompt == null ? null : String(e.prompt) }))
        : [];
      return { hooked: !!s.hooked, stateTs: Number(s.stateTs) || 0, entries };
    } catch (_) {
      return null;
    }
  },

  // 훅 경로를 쓸 수 있는가. 상태 파일이 남아 있는 것만으로는 부족하다 — Claude 가 비정상 종료됐거나
  // 같은 세션에서 Codex·셸로 바뀌면 낡은 파일이 남는다. 방금 끝난 턴 동안 훅이 기록했어야
  // (상태 시각 ≥ 이번 running 시작) 지금도 살아 있는 것으로 본다.
  // '/'·'!' 로 시작하는 입력(슬래시 명령·bash 모드)은 UserPromptSubmit 이 발생하지 않는다(실측).
  _hookUsable(sessionId, snap, text) {
    if (!snap || !snap.hooked) return false;
    if (/^[/!]/.test(text.trimStart())) return false;
    const since = this._runningAt.get(sessionId);
    return typeof since === 'number' && snap.stateTs >= since - this.HOOK_CLOCK_SLACK_MS;
  },

  // 훅이 받은 프롬프트와 예약 내용이 같은가. Claude Code 는 긴 붙여넣기를
  // <pasted_content id="..."> 로 감싸 넘기고 앞뒤 줄바꿈을 붙이므로, 태그를 벗기고 공백을 접어 비교한다.
  _samePrompt(received, text) {
    if (received == null) return false;
    const norm = (s) => String(s)
      .replace(/<\/?pasted_content(?:\s+id="[^"]*")?>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const a = norm(received);
    return !!a && a === norm(text);
  },

  // 기준선 이후 새로 들어온 프롬프트 중 예약 내용과 같은 것이 있는가.
  // 반환: 'match' | 'other'(새 프롬프트는 있으나 다른 내용) | ''(새 프롬프트 없음)
  _hookVerdict(snap, baseIds, text) {
    if (!snap) return '';
    const fresh = snap.entries.filter((e) => !baseIds.includes(e.id));
    if (!fresh.length) return '';
    return fresh.some((e) => this._samePrompt(e.prompt, text)) ? 'match' : 'other';
  },

  // 멈춘 항목이 기준선 이후 실제로 전송됐다면 큐에서 정리한다 (중복 재전송 방지).
  // 사용자가 터미널에서 직접 Enter 를 눌렀거나, 훅이 확인 시간보다 늦게 온 경우다.
  async _resolvePausedByHook(sessionId) {
    const paused = this._paused.get(sessionId);
    if (!paused || !Array.isArray(paused.hookBase)) return; // 훅 경로에서 멈춘 것만 판정할 수 있다
    if (this._resolving.has(sessionId)) return; // 이미 지켜보는 중 — running 이벤트가 겹쳐도 하나만 돈다
    this._resolving.add(sessionId);
    try {
      await this._watchPausedHook(sessionId, paused);
    } finally {
      this._resolving.delete(sessionId);
    }
  },

  async _watchPausedHook(sessionId, paused) {
    for (let i = 0; i < this.HOOK_TRIES; i++) {
      const snap = await this._hookSnapshot(sessionId);
      if (this._paused.get(sessionId) !== paused) return; // 그새 사용자가 결정했다
      if (this._hookVerdict(snap, paused.hookBase, paused.text) === 'match') {
        const head = this._head(sessionId);
        this._paused.delete(sessionId);
        if (head && App.normalizeComposerSubmitText(head.text) === paused.text) await this._drop(sessionId, head.id);
        else this._render();
        return;
      }
      await this._sleep(this.HOOK_POLL_MS);
    }
  },

  // 훅 경로 전달. 붙여넣기 → (화면에 뜨길 기다림) → Enter → 훅 확정.
  // 붙여넣기가 화면에 안 보여도 첫 Enter 는 보낸다 — 긴 글은 [Pasted text #N] 으로 접혀 원문이
  // 안 보이고, 정말 안 들어갔다면 빈 입력상자에 Enter 가 갈 뿐이다.
  // Enter 재전송은 '우리 내용이 아직 입력상자에 그대로 있을 때'만 한다. 이미 전송돼 Claude 가
  // 일하는 중이라면 그 Enter 가 허가 창의 기본값(Yes)이나 선택 목록을 누를 수 있다.
  async _deliverHooked(sessionId, text, baseIds) {
    if (!TerminalView.textOnInputLine(sessionId, text)) {
      if (this._leftoverText(sessionId)) return 'leftover';
      App.noteSessionActivity(sessionId);
      TerminalView.paste(sessionId, text);
      await this._poll(
        () => TerminalView.textOnInputLine(sessionId, text) || TerminalView.pastePlaceholderOnScreen(sessionId),
        this.PASTE_TRIES, this.PASTE_POLL_MS
      );
    }
    let sawOther = false;
    for (let attempt = 1; attempt <= this.HOOK_ENTER_ATTEMPTS; attempt++) {
      if (!TerminalView.views.has(sessionId)) return 'gone';
      if (attempt > 1) {
        const stillInBox = TerminalView.textOnInputLine(sessionId, text) || TerminalView.pastePlaceholderOnScreen(sessionId);
        const userTyping = !!TerminalView.pendingTypedLine(sessionId);
        if (this._sawRunning.has(sessionId) || userTyping || !stillInBox) break; // 다시 누르면 위험하거나 의미 없다
      }
      ta.write(sessionId, '\r');
      TerminalView.resetTypedLine(sessionId);
      for (let i = 0; i < this.HOOK_TRIES; i++) {
        await this._sleep(this.HOOK_POLL_MS);
        const verdict = this._hookVerdict(await this._hookSnapshot(sessionId), baseIds, text);
        if (verdict === 'match') return '';
        if (verdict === 'other') sawOther = true; // 다른 프롬프트가 끼어들었다 — 우리 것이 뒤따를 수 있어 조금 더 본다
      }
    }
    if (sawOther) return 'mismatch';
    // Claude 가 일을 시작했는데 훅 기록이 없다 — 전송됐을 가능성이 높으니 재시도를 막는 사유로 멈춘다
    return this._sawRunning.has(sessionId) ? 'unconfirmed' : 'submit';
  },

  // 전달 시도. 성공하면 '' , 실패하면 사유 문자열을 돌려준다.
  async _deliver(sessionId, text) {
    await this._sleep(this.SETTLE_MS);
    if (!TerminalView.views.has(sessionId)) return 'gone';

    // 훅이 살아 있는 세션이면 훅으로 확정한다. 기준선(이미 받은 프롬프트 id)은 붙여넣기 전에 잡는다.
    const snap = await this._hookSnapshot(sessionId);
    if (this._hookUsable(sessionId, snap, text)) {
      const baseIds = snap.entries.map((e) => e.id);
      this._hookBase.set(sessionId, baseIds);
      return this._deliverHooked(sessionId, text, baseIds);
    }
    this._hookBase.delete(sessionId);

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
    const info = { reason, text };
    const hookBase = this._hookBase.get(sessionId);
    if (Array.isArray(hookBase)) info.hookBase = hookBase; // 훅 경로였다 — 뒤늦은 전송을 확정할 기준선
    this._paused.set(sessionId, info);
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
