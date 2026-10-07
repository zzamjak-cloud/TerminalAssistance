// 예약 큐 상태 머신 — 유실 없는 단계별 전송 검증.
// prompt-queue.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
// 대기(_sleep)는 즉시 해소되도록 갈아끼워, 타이밍이 아니라 순서·확인·복구 로직을 본다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'prompt-queue.js');

exports.name = '예약 큐 단계별 전송';

// 터미널 대역 — 입력상자에 무엇이 떠 있는지를 문자열 하나로 흉내 낸다
function makeTerminal() {
  return {
    views: new Map([['s1', {}]]),
    inputLine: '',   // 지금 입력상자에 보이는 텍스트
    leftover: '',    // 사용자가 치다 만 잔여 입력
    pasted: [],      // 붙여넣기 호출 기록
    landPaste: true, // false = 붙여넣기가 화면에 안 뜸(확인 A 실패)
    landAfterChecks: 0, // N = 붙여넣기 뒤 N 번째 확인부터 화면에 뜸 (느린 TUI 렌더)
    checks: 0,
    clearOnEnter: true, // false = Enter 를 먹음(확인 B 실패)
    paste(id, text) {
      this.pasted.push(text);
      if (!this.landPaste) return;
      if (this.landAfterChecks > 0) { this.lateText = text; this.checks = 0; }
      else this.inputLine = text;
    },
    textOnInputLine(id, text) {
      if (this.lateText && ++this.checks >= this.landAfterChecks) { this.inputLine = this.lateText; this.lateText = ''; }
      return !!text && this.inputLine === text;
    },
    pendingTypedLine() { return this.leftover; },
    placeholder: false, // 입력상자에 [Pasted text #N] 표지가 보인다
    pastePlaceholderOnScreen() { return this.placeholder; },
    resetTypedLine() {},
  };
}

// hook: 훅 대역 { hooked, stateTs, entries, submitOnEnter, wrap } — 없으면 훅 미지원(화면 경로)
//   submitOnEnter: Enter 에 입력상자 내용이 실제로 전송되며 훅이 기록된다
//   wrap: 훅에 넘어가는 원문 가공 (Claude Code 의 <pasted_content> 감싸기 흉내)
function makeHarness(queueTexts, hook) {
  const term = makeTerminal();
  let seq = 0;
  const saved = [];   // persistDraftList 로 넘어간 스냅샷 이력
  const writes = [];  // ta.write 로 나간 바이트
  const App = {
    state: { drafts: { 'queued:s1': queueTexts.map((t, i) => ({ id: 'd' + i, text: t })) } },
    queueKey: (id) => 'queued:' + id,
    normalizeComposerSubmitText: (t) => String(t || '').replace(/\s+$/g, ''),
    persistDraftList(key, list) {
      saved.push(list.map((d) => d.text));
      return Promise.resolve();
    },
    renderComposerQueue() {},
    noteSessionActivity() {},
    composerText: () => '',
    setComposerText(id, text) { this.composerValue = text; },
    composerValue: '',
  };
  const sandbox = {
    App, TerminalView: term, console, Map, Set, Promise,
    ta: {
      write(id, data) {
        writes.push(data);
        if (data !== '\r') return;
        if (hook && hook.submitOnEnter && term.inputLine) {
          hook.entries.push({ id: 'p' + (++seq), prompt: hook.wrap ? hook.wrap(term.inputLine) : term.inputLine });
        }
        if (term.clearOnEnter) term.inputLine = '';
      },
      ...(hook ? { hookPrompt: async () => ({ hooked: hook.hooked, stateTs: hook.stateTs, entries: hook.entries.slice() }) } : {}),
    },
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8') + ';globalThis.__q = PromptQueue;', sandbox);
  const q = sandbox.__q;
  q._sleep = () => Promise.resolve(); // 실제 대기 제거
  q._runningAt.set('s1', 100000); // 방금 끝난 턴이 100000ms 에 시작됐다
  return { q, App, term, saved, writes };
}

const queueOf = (App) => (App.state.drafts['queued:s1'] || []).map((d) => d.text);

exports.run = async (t) => {
  // 1. 세 개를 예약하면 done 마다 정확히 하나씩, 순서대로 나가고 확인 뒤 제거된다
  {
    const { q, App, term } = makeHarness(['하나', '둘', '셋']);
    await q.onSessionDone('s1');
    t.check('첫 done 에 1번만 전달', term.pasted.join('|') === '하나', term.pasted.join('|'));
    t.check('전달 확인 뒤 큐에서 제거', queueOf(App).join(',') === '둘,셋', queueOf(App).join(','));

    await q.onSessionDone('s1');
    t.check('둘째 done 에 2번 전달', term.pasted.join('|') === '하나|둘', term.pasted.join('|'));

    await q.onSessionDone('s1');
    t.check('셋째 done 에 3번 전달', term.pasted.join('|') === '하나|둘|셋', term.pasted.join('|'));
    t.check('전부 비워짐', queueOf(App).length === 0, queueOf(App).join(','));

    await q.onSessionDone('s1');
    t.check('빈 큐에서는 아무것도 안 보냄', term.pasted.length === 3, String(term.pasted.length));
  }

  // 2. Enter 는 붙여넣기가 화면에 뜬 것을 확인한 뒤에만 나간다
  {
    const { q, term, writes } = makeHarness(['하나']);
    await q.onSessionDone('s1');
    t.check('확인된 뒤 Enter 1회', writes.filter((w) => w === '\r').length === 1, writes.join('|'));
  }

  // 3. 붙여넣기가 화면에 안 뜨면(확인 A 실패) Enter 를 보내지 않고 항목을 큐에 남긴다
  {
    const { q, App, term, writes } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    t.check('확인 A 실패 시 Enter 미전송', writes.length === 0, writes.join('|'));
    t.check('확인 A 실패해도 유실 없음', queueOf(App).join(',') === '하나,둘', queueOf(App).join(','));
    t.check('확인 A 실패는 일시정지', (q.pausedInfo('s1') || {}).reason === 'paste', JSON.stringify(q.pausedInfo('s1')));
    t.check('붙여넣기 자동 재시도 없음', term.pasted.length === 1, String(term.pasted.length));
  }

  // 3-1. TUI 가 붙여넣기를 늦게 그려도(Claude Code 실측 0.5~1.4초 = 확인 15회) 보류 없이 전송된다
  {
    const { q, App, term, writes } = makeHarness(['하나', '둘']);
    term.landAfterChecks = 15;
    await q.onSessionDone('s1');
    t.check('늦게 뜬 붙여넣기도 보류 안 함', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
    t.check('늦게 뜬 뒤 Enter 1회', writes.filter((w) => w === '\r').length === 1, writes.join('|'));
    t.check('늦게 뜬 항목도 확인 뒤 제거', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 4. 일시정지 중에는 뒤 항목도 순서를 지키며 멈춰 있는다
  {
    const { q, App, term } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    await q.onSessionDone('s1');
    t.check('일시정지 중 추가 전송 없음', term.pasted.length === 1, String(term.pasted.length));
    t.check('일시정지 중 큐 순서 유지', queueOf(App).join(',') === '하나,둘', queueOf(App).join(','));
  }

  // 5. Enter 가 먹히면 한 번 더 보내고, 그래도 안 되면 항목을 남긴 채 멈춘다
  {
    const { q, App, term, writes } = makeHarness(['하나']);
    term.clearOnEnter = false;
    await q.onSessionDone('s1');
    t.check('Enter 재전송 1회', writes.filter((w) => w === '\r').length === 2, writes.join('|'));
    t.check('확인 B 실패해도 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
    t.check('확인 B 실패는 일시정지', (q.pausedInfo('s1') || {}).reason === 'submit', JSON.stringify(q.pausedInfo('s1')));
  }

  // 6. 화면에서 안 사라져도 세션이 running 으로 들어가면 전송된 것으로 본다
  //    (Claude Code 는 보낸 프롬프트를 대화 기록에 그대로 다시 그린다)
  {
    const { q, App, term } = makeHarness(['하나']);
    term.clearOnEnter = false;
    q._sleep = () => { q.onSessionRunning('s1'); return Promise.resolve(); };
    await q.onSessionDone('s1');
    t.check('running 관측을 전송 근거로 인정', queueOf(App).length === 0, queueOf(App).join(','));
  }

  // 7. 입력상자에 잔여 입력이 있으면 그 위에 붙여넣지 않는다
  {
    const { q, App, term } = makeHarness(['하나']);
    term.leftover = '사용자가 치던 것';
    await q.onSessionDone('s1');
    t.check('잔여 입력 위에 붙여넣지 않음', term.pasted.length === 0, term.pasted.join('|'));
    t.check('잔여 입력이면 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
    t.check('잔여 입력은 leftover 로 일시정지', (q.pausedInfo('s1') || {}).reason === 'leftover', JSON.stringify(q.pausedInfo('s1')));

    // 입력줄이 비면 다음 done 에서 스스로 재개한다
    term.leftover = '';
    await q.onSessionDone('s1');
    t.check('입력줄이 비면 자동 재개', term.pasted.join('|') === '하나', term.pasted.join('|'));
    t.check('자동 재개 후 일시정지 해제', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }

  // 8. 전송이 진행 중이면 겹쳐 들어온 done 은 무시한다 (중복 전송 방지)
  {
    const { q, term } = makeHarness(['하나', '둘']);
    let release;
    q._sleep = () => new Promise((r) => { release = r; });
    const first = q.onSessionDone('s1');
    await q.onSessionDone('s1'); // 진행 중 — 무시돼야 한다
    t.check('진행 중 done 은 무시', term.pasted.length <= 1, String(term.pasted.length));
    q._sleep = () => Promise.resolve();
    if (release) release();
    await first;
  }

  // 9. 배너 조작 — 다시 시도 / 취소 / 입력창으로
  {
    const { q, App, term } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    term.landPaste = true;
    await q.retry('s1');
    t.check('다시 시도로 재개', queueOf(App).join(',') === '둘', queueOf(App).join(','));
    t.check('재개 후 일시정지 해제', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }
  {
    const { q, App, term } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    await q.cancelPaused('s1');
    t.check('취소는 해당 항목만 제거', queueOf(App).join(',') === '둘', queueOf(App).join(','));
    t.check('취소 후 일시정지 해제', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }
  {
    const { q, App, term } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    await q.releaseToComposer('s1');
    t.check('입력창으로 되돌리면 내용 보존', App.composerValue === '하나', App.composerValue);
    t.check('입력창으로 되돌리면 큐에서 제거', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 10. 확인이 끝나기 전에는 절대 영속 큐에서 지우지 않는다 (앱이 죽어도 살아남는 조건)
  {
    const { q, term, saved } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    t.check('확인 실패 시 저장 호출 없음', saved.length === 0, JSON.stringify(saved));

    const ok = makeHarness(['하나', '둘']);
    await ok.q.onSessionDone('s1');
    t.check('확인 성공 뒤에만 저장', JSON.stringify(ok.saved) === '[["둘"]]', JSON.stringify(ok.saved));
  }

  // 11. 터미널 뷰가 사라진 세션은 보내지 않고 큐를 지킨다
  {
    const { q, App, term } = makeHarness(['하나']);
    term.views = new Map();
    await q.onSessionDone('s1');
    t.check('뷰 없으면 전송 안 함', term.pasted.length === 0, term.pasted.join('|'));
    t.check('뷰 없어도 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
  }

  // 12. 이미 입력상자에 떠 있는 내용은 다시 붙이지 않는다 (중복 전송 방지).
  //     앞선 시도의 붙여넣기가 뒤늦게 들어간 뒤 [다시 시도] 를 누른 상황.
  {
    const { q, App, term } = makeHarness(['하나', '둘']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    term.landPaste = true;
    term.inputLine = '하나'; // 실패한 줄 알았던 붙여넣기가 뒤늦게 들어와 있다
    await q.retry('s1');
    t.check('이미 떠 있으면 다시 붙이지 않음', term.pasted.length === 1, term.pasted.join('|'));
    t.check('그래도 전송은 마무리된다', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 13. 세션 종료 시 그 세션의 진행·정지 상태만 정리된다
  {
    const { q, term } = makeHarness(['하나']);
    term.landPaste = false;
    await q.onSessionDone('s1');
    q.onSessionGone('s1');
    t.check('세션 종료 시 일시정지 정리', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }

  // ── 훅 경로: UserPromptSubmit 훅이 받은 원문으로 전송을 확정한다 ──
  // stateTs(매우 큼) ≥ running 시작 → 방금 턴 동안 훅이 기록했다 = 살아 있는 훅
  const hookOf = (extra) => ({ hooked: true, stateTs: Number.MAX_SAFE_INTEGER, entries: [{ id: 'p0', prompt: '이전 프롬프트' }], submitOnEnter: true, ...extra });
  const enters = (writes) => writes.filter((w) => w === '\r').length;
  const reasonOf = (q) => (q.pausedInfo('s1') || {}).reason;

  // 14. 훅이 같은 원문을 받으면 전송 확정
  {
    const hook = hookOf();
    const { q, App, writes } = makeHarness(['하나', '둘'], hook);
    await q.onSessionDone('s1');
    t.check('훅 확정 뒤 큐에서 제거', queueOf(App).join(',') === '둘', queueOf(App).join(','));
    t.check('훅 확정 시 Enter 1회', enters(writes) === 1, writes.join('|'));
    t.check('훅 확정이면 일시정지 없음', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }

  // 15. 긴 붙여넣기 — 화면엔 [Pasted text #1] 만 보여 원문 확인이 안 되지만, 훅 원문으로 확정된다
  {
    // Claude Code 실측 형태: 앞뒤 줄바꿈 + <pasted_content id="..."> 감싸기
    const hook = hookOf({ wrap: () => '\n\n<pasted_content id="143e">\n아주 긴 프롬프트\n</pasted_content id="143e">\n' });
    const { q, App, term } = makeHarness(['아주 긴 프롬프트', '둘'], hook);
    term.textOnInputLine = () => false; // 화면 판정은 끝내 실패
    term.paste = function (id, text) { this.pasted.push(text); this.inputLine = '[Pasted text #1]'; this.placeholder = true; };
    await q.onSessionDone('s1');
    t.check('접힌 붙여넣기도 훅으로 확정', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 16. 내용이 입력상자에 그대로 남아 있으면(Enter 가 먹힘) Enter 를 다시 보내고, 끝내 안 되면 멈춘다
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App, term, writes } = makeHarness(['하나'], hook);
    term.clearOnEnter = false;
    await q.onSessionDone('s1');
    t.check('입력상자에 남아 있으면 Enter 재시도', enters(writes) === 3, writes.join('|'));
    t.check('훅 미확정이면 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
    t.check('훅 미확정은 submit 일시정지', reasonOf(q) === 'submit', JSON.stringify(q.pausedInfo('s1')));
  }

  // 17. 입력상자가 비었는데 훅이 없으면 Enter 를 다시 보내지 않는다 (허가 창·선택 목록을 누를 수 있다)
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App, writes } = makeHarness(['하나'], hook);
    await q.onSessionDone('s1');
    t.check('입력상자가 비면 Enter 재전송 안 함', enters(writes) === 1, writes.join('|'));
    t.check('입력상자가 비어도 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
  }

  // 18. Claude 가 움직였는데(running) 훅이 없으면 재전송하지 않고 unconfirmed 로 멈춘다.
  //     running 만으로는 지우지 않는다 — 백그라운드 작업으로 스스로 깨어났을 수 있다
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App, term, writes } = makeHarness(['하나'], hook);
    term.clearOnEnter = false;
    q._sleep = () => { q.onSessionRunning('s1'); return Promise.resolve(); };
    await q.onSessionDone('s1');
    t.check('running 관측 후 Enter 재전송 안 함', enters(writes) === 1, writes.join('|'));
    t.check('running 만으로는 훅 경로에서 제거 안 함', queueOf(App).join(',') === '하나', queueOf(App).join(','));
    t.check('running 후 미확정은 unconfirmed', reasonOf(q) === 'unconfirmed', JSON.stringify(q.pausedInfo('s1')));
  }

  // 19. 사용자가 치기 시작했으면 Enter 를 다시 보내지 않는다 (남의 입력을 전송하지 않는다)
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, term, writes } = makeHarness(['하나'], hook);
    term.clearOnEnter = false;
    q._sleep = () => { if (writes.includes(String.fromCharCode(13))) term.leftover = '사용자 입력'; return Promise.resolve(); }; // 첫 Enter 뒤 사용자가 치기 시작
    await q.onSessionDone('s1');
    t.check('사용자 입력 중엔 Enter 재전송 안 함', enters(writes) === 1, writes.join('|'));
  }

  // 20. 다른 내용만 전송됐다면 확정하지 않고 mismatch 로 멈춘다
  {
    const hook = hookOf({ wrap: () => '전혀 다른 내용' });
    const { q, App } = makeHarness(['하나'], hook);
    await q.onSessionDone('s1');
    t.check('다른 원문이면 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
    t.check('다른 원문은 mismatch 일시정지', reasonOf(q) === 'mismatch', JSON.stringify(q.pausedInfo('s1')));
  }

  // 21. 다른 프롬프트가 먼저 끼어들어도 뒤이어 우리 것이 기록되면 확정한다 (기록은 누적된다)
  {
    const hook = hookOf();
    hook.wrap = (s) => { hook.entries.push({ id: 'pX', prompt: '끼어든 것' }); return s; };
    const { q, App } = makeHarness(['하나', '둘'], hook);
    await q.onSessionDone('s1');
    t.check('끼어든 기록이 있어도 우리 것을 찾아 확정', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 22. 멈춘 항목을 사용자가 터미널에서 직접 전송하면, 훅 확정으로 큐에서 정리된다 (중복 재전송 방지)
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App, term } = makeHarness(['하나', '둘'], hook);
    term.clearOnEnter = false;
    await q.onSessionDone('s1');
    t.check('사전 조건: 멈춤', reasonOf(q) === 'submit', JSON.stringify(q.pausedInfo('s1')));
    while (q._resolving.size) await new Promise((r) => setImmediate(r)); // 멈춘 직후의 감시가 끝나길 기다린다
    hook.entries.push({ id: 'p-user', prompt: '하나' }); // 사용자가 Enter 를 눌러 전송됨
    term.inputLine = '';
    await q._resolvePausedByHook('s1');
    t.check('사용자 전송이 확정되면 큐에서 정리', queueOf(App).join(',') === '둘', queueOf(App).join(','));
    t.check('정리 후 일시정지 해제', q.pausedInfo('s1') === null, JSON.stringify(q.pausedInfo('s1')));
  }

  // 23. [다시 시도] 전에 이미 전송됐는지 훅으로 확인한다 — 전송됐다면 다시 보내지 않는다
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App, term } = makeHarness(['하나', '둘'], hook);
    term.clearOnEnter = false;
    await q.onSessionDone('s1');
    hook.entries.push({ id: 'p-late', prompt: '하나' }); // 훅이 늦게 도착했다
    const pastedBefore = term.pasted.length;
    await q.retry('s1');
    t.check('이미 전송됐으면 다시 시도해도 재전송 없음', term.pasted.length === pastedBefore, term.pasted.join('|'));
    t.check('이미 전송된 항목은 정리', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 24. 낡은 상태 파일(이번 턴 시작 전 기록)은 훅이 살아 있다는 근거가 아니다 → 화면 경로
  {
    const hook = hookOf({ stateTs: 10, submitOnEnter: false });
    const { q, App, writes } = makeHarness(['하나', '둘'], hook);
    await q.onSessionDone('s1');
    t.check('낡은 훅은 화면 판정으로 확정', queueOf(App).join(',') === '둘', queueOf(App).join(','));
    t.check('화면 경로에선 Enter 1회', enters(writes) === 1, writes.join('|'));
  }

  // 25. '/'·'!' 로 시작하는 입력은 훅이 오지 않는다(실측) → 화면 경로
  {
    const hook = hookOf({ submitOnEnter: false });
    const { q, App } = makeHarness(['/compact', '!npm test', '셋'], hook);
    await q.onSessionDone('s1');
    t.check('슬래시 명령은 화면 판정', queueOf(App).join(',') === '!npm test,셋', queueOf(App).join(','));
    await q.onSessionDone('s1');
    t.check('bash 모드는 화면 판정', queueOf(App).join(',') === '셋', queueOf(App).join(','));
  }

  // 26. 훅이 없는 세션(hooked=false)은 기존 화면 판정으로 동작한다
  {
    const hook = hookOf({ hooked: false, submitOnEnter: false });
    const { q, App } = makeHarness(['하나', '둘'], hook);
    await q.onSessionDone('s1');
    t.check('훅 없는 세션은 화면 판정', queueOf(App).join(',') === '둘', queueOf(App).join(','));
  }

  // 27. 입력상자에 접힌 붙여넣기 표지가 남아 있으면 그 위에 또 붙이지 않는다
  {
    const hook = hookOf();
    const { q, App, term } = makeHarness(['하나'], hook);
    term.placeholder = true;
    await q.onSessionDone('s1');
    t.check('접힌 표지 위에 붙여넣지 않음', term.pasted.length === 0, term.pasted.join('|'));
    t.check('접힌 표지는 leftover 로 멈춤', reasonOf(q) === 'leftover', JSON.stringify(q.pausedInfo('s1')));
    t.check('접힌 표지가 있어도 유실 없음', queueOf(App).join(',') === '하나', queueOf(App).join(','));
  }
};
