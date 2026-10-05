// 모바일 원격 웹앱 순수 로직 — remote-core.js 를 vm 샌드박스에 로드해 실제 구현을 돌린다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'mobile', 'remote-core.js');
const TV = path.join(__dirname, '..', '..', 'src', 'renderer', 'terminal-view.js');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__r = { shouldKeepChunk, remoteKeySequence, REMOTE_KEY_BAR, buildPromptWrites,'
  + ' fitTerminalFont, reconnectDelay, parseServerMessage, pairCodeFromHash, normalizePairCode,'
  + ' upsertSession, presetsForSession, REMOTE_FONT_MIN, RECONNECT_MAX_MS,'
  + ' SNAP_RESET, snapModeSuffix, newReqId, isReplyTo, nextViewportBaseline, isKeyboardOpen };',
  sandbox
);
const r = sandbox.__r;

exports.name = '모바일 원격 순수 로직 (remote-core)';

exports.run = function (t) {
  // ── off 중복 제거: 데스크톱 restore 와 같은 비교식 ──
  t.check('데스크톱 terminal-view.js restore 의 비교식이 off >= snap.off 그대로다',
    /p\.off >= snap\.off/.test(fs.readFileSync(TV, 'utf8')));
  t.check('스냅샷 끝 이전에서 시작한 청크는 버린다', r.shouldKeepChunk(90, 100) === false);
  t.check('스냅샷 끝에서 바로 시작하는 청크는 살린다', r.shouldKeepChunk(100, 100) === true);
  t.check('스냅샷 이후 청크는 살린다', r.shouldKeepChunk(150, 100) === true);
  t.check('스냅샷이 없으면 모두 살린다', r.shouldKeepChunk(0, null) === true);

  // ── 특수키 ──
  const expect = { esc: '\x1b', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B', enter: '\r' };
  t.check('특수키 시퀀스 매핑',
    Object.entries(expect).every(([k, v]) => r.remoteKeySequence(k) === v));
  t.check('모르는 키는 null', r.remoteKeySequence('toString') === null && r.remoteKeySequence('x') === null && r.remoteKeySequence('y') === null);
  t.check('키 바는 Esc·Ctrl+C·↑·↓·Enter 순서',
    r.REMOTE_KEY_BAR.map((k) => k.key).join(',') === 'esc,ctrlc,up,down,enter');

  // ── 프롬프트 입력 ──
  const one = r.buildPromptWrites('hello', true);
  t.check('한 줄은 text + \\r 단일 write', one.length === 1 && one[0].data === 'hello\r' && one[0].delayMs === 0);
  t.check('끝 줄바꿈은 제출 Enter 와 겹치지 않게 지운다', r.buildPromptWrites('hi\n\n', false)[0].data === 'hi\r');
  t.check('빈 입력은 보내지 않는다', r.buildPromptWrites('   ', true).length === 0);
  const multi = r.buildPromptWrites('a\nb', true);
  t.check('여러 줄 + bracketed paste: 붙여넣기 후 늦춘 Enter',
    multi.length === 2 && multi[0].data === '\x1b[200~a\rb\x1b[201~' && multi[1].data === '\r' && multi[1].delayMs > 0,
    JSON.stringify(multi));
  t.check('여러 줄 + bracketed paste 없음: 줄마다 Enter',
    r.buildPromptWrites('a\r\nb', false)[0].data === 'a\rb\r');

  // ── 글꼴 맞춤 ──
  const wide = r.fitTerminalFont(1200, 100, 0.6);
  t.check('넓은 화면은 최대 크기로 제한', wide.fontSize === 14 && !wide.scroll);
  const fit = r.fitTerminalFont(400, 80, 0.6); // 400/80/0.6 = 8.33 → 8
  t.check('화면 폭에 맞춰 0.5 단위로 내림', fit.fontSize === 8 && !fit.scroll, JSON.stringify(fit));
  t.check('맞춘 크기로 그린 폭이 화면을 넘지 않는다', fit.fontSize * 0.6 * 80 <= 400);
  const narrow = r.fitTerminalFont(300, 200, 0.6);
  t.check('최소 크기 밑이면 최소 크기 + 가로 스크롤', narrow.fontSize === r.REMOTE_FONT_MIN && narrow.scroll);
  t.check('측정 전(폭 0)에는 기본값', r.fitTerminalFont(0, 80, 0.6).scroll === false);

  // ── 재연결 백오프 ──
  t.check('지수 증가', r.reconnectDelay(0) === 500 && r.reconnectDelay(1) === 1000 && r.reconnectDelay(3) === 4000);
  t.check('상한 고정', r.reconnectDelay(10) === r.RECONNECT_MAX_MS && r.reconnectDelay(1e9) === r.RECONNECT_MAX_MS);
  t.check('잘못된 입력은 첫 단계', r.reconnectDelay(-1) === 500 && r.reconnectDelay(NaN) === 500);

  // ── 메시지 파싱 ──
  t.check('알려진 메시지는 파싱', r.parseServerMessage('{"t":"data","id":"a","off":3,"data":"x"}').off === 3);
  t.check('깨진 JSON 은 null', r.parseServerMessage('{oops') === null);
  t.check('t 가 없거나 모르는 종류면 null',
    r.parseServerMessage('{"id":1}') === null && r.parseServerMessage('{"t":"nope"}') === null
    && r.parseServerMessage('null') === null);

  // ── 페어링 코드 ──
  t.check('#pair=코드 추출', r.pairCodeFromHash('#pair=AB12-CD') === 'AB12-CD');
  t.check('다른 해시 인자와 함께', r.pairCodeFromHash('#x=1&pair=ZZ') === 'ZZ');
  t.check('없으면 null', r.pairCodeFromHash('') === null && r.pairCodeFromHash('#pair=') === null);
  t.check('수동 입력 공백 제거 + 대문자화 (코드는 대문자 영숫자)', r.normalizePairCode(' ab 12 ') === 'AB12');

  // ── 세션 목록 갱신 ──
  const list = [{ id: 'a', status: 'idle' }];
  const added = r.upsertSession(list, { id: 'b', status: 'running' });
  t.check('새 세션은 끝에 추가 (원본 불변)', added.map((s) => s.id).join(',') === 'a,b' && list.length === 1);
  const replaced = r.upsertSession(added, { id: 'a', status: 'done' });
  t.check('같은 id 는 교체 (중복 없음)', replaced.length === 2 && replaced[0].status === 'done');

  // ── 프리셋 목록 ──
  const presets = [{ id: 'p1', projectId: 'x' }, { id: 'g1', projectId: null }, { id: 'p2', projectId: 'y' }];
  t.check('전역 먼저, 그다음 세션 프로젝트 전용',
    r.presetsForSession(presets, { projectId: 'x' }).map((p) => p.id).join(',') === 'g1,p1');
  t.check('홈 세션은 전역만', r.presetsForSession(presets, { projectId: null }).map((p) => p.id).join(',') === 'g1');

  // ── 스냅샷 초기화 · bracketed paste 상태 ──
  t.check('스냅샷 초기화는 write 큐를 타는 RIS', r.SNAP_RESET === '\x1bc');
  t.check('서버가 켜짐을 알리면 2004h', r.snapModeSuffix({ bracketedPaste: true }) === '\x1b[?2004h');
  t.check('서버가 꺼짐을 알리면 2004l', r.snapModeSuffix({ bracketedPaste: false }) === '\x1b[?2004l');
  t.check('필드가 없으면 스트림 추적에 맡긴다', r.snapModeSuffix({}) === '' && r.snapModeSuffix(null) === '');

  // ── 새 세션 요청 짝 맞추기 ──
  const a = r.newReqId();
  t.check('reqId 는 매번 다르다', a !== r.newReqId() && typeof a === 'string');
  t.check('같은 reqId 응답만 짝', r.isReplyTo({ reqId: 'x' }, { t: 'createResult', reqId: 'x' })
    && !r.isReplyTo({ reqId: 'x' }, { t: 'createResult', reqId: 'y' })
    && !r.isReplyTo({ reqId: 'x' }, { t: 'error', msg: 'e' })
    && !r.isReplyTo(null, { reqId: 'x' }));
  t.check('createResult 는 알려진 메시지', r.parseServerMessage('{"t":"createResult","reqId":"x"}').reqId === 'x');

  // ── 키보드 판정 · 회전 ──
  let base = r.nextViewportBaseline(null, 390, 800);
  t.check('키보드 없으면 닫힘', !r.isKeyboardOpen(base, 800));
  base = r.nextViewportBaseline(base, 390, 450);
  t.check('같은 폭에서 높이가 크게 줄면 열림', r.isKeyboardOpen(base, 450) && base.height === 800);
  base = r.nextViewportBaseline(base, 800, 390);
  t.check('회전(폭 변경) 시 기준을 다시 잰다 → 가로 화면을 키보드로 오판하지 않는다',
    base.height === 390 && !r.isKeyboardOpen(base, 390));
};
