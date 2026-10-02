// 모바일 원격 웹앱의 순수 로직 — DOM·WebSocket 에 의존하지 않는다 (scripts/test 에서 vm 으로 검증).
// 전역 함수로 노출한다 (데스크톱 렌더러와 같은 무번들 스크립트 방식).

// ── 출력 중복 제거 ──
// 데스크톱 terminal-view.js restore 와 같은 규칙: data.off 는 청크 시작 오프셋, snap.off 는
// 스냅샷 끝의 누적 오프셋이다. off < snap.off 인 청크는 스냅샷에 이미 들어 있는 중복이다.
function shouldKeepChunk(chunkOff, snapOff) {
  if (snapOff === null || snapOff === undefined) return true;
  return Number(chunkOff) >= Number(snapOff);
}

// ── 특수키 바 ──
const REMOTE_KEYS = {
  esc: '\x1b',
  ctrlc: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  y: 'y',
  '1': '1',
  '2': '2'
};

const REMOTE_KEY_BAR = [
  { key: 'esc', label: 'Esc' },
  { key: 'ctrlc', label: 'Ctrl+C' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'enter', label: 'Enter' },
  { key: 'y', label: 'y' },
  { key: '1', label: '1' },
  { key: '2', label: '2' }
];

function remoteKeySequence(name) {
  return Object.prototype.hasOwnProperty.call(REMOTE_KEYS, name) ? REMOTE_KEYS[name] : null;
}

// ── 프롬프트 입력창 ──
// 한 줄이면 text + '\r' 단일 write (데스크톱 runPreset 실행 방식).
// 여러 줄이면 줄바꿈이 Enter 로 읽혀 한 줄씩 제출되므로, 앱이 bracketed paste 를 켰을 때만
// 붙여넣기로 감싸고 Enter 는 늦춘 별도 write 로 보낸다 (drafts.js deliverDraft 와 같은 이유 —
// 붙여넣기 직후 도착한 Enter 를 TUI 가 붙여넣기의 일부로 삼킨다).
const PROMPT_ENTER_DELAY_MS = 120;

function buildPromptWrites(text, bracketedPaste) {
  const body = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!body.trim()) return [];
  if (!body.includes('\n')) return [{ data: body + '\r', delayMs: 0 }];
  if (bracketedPaste) {
    return [
      { data: '\x1b[200~' + body.replace(/\n/g, '\r') + '\x1b[201~', delayMs: 0 },
      { data: '\r', delayMs: PROMPT_ENTER_DELAY_MS }
    ];
  }
  // bracketed paste 를 모르는 셸 — 줄마다 실행되는 것이 xterm 붙여넣기와 같은 결과다
  return [{ data: body.replace(/\n/g, '\r') + '\r', delayMs: 0 }];
}

// ── 프리셋 치환 (app.js expandPresetCommand 포팅) ──
// 차이: {clipboard} 는 폰에서 읽지 않으므로 빈 문자열, {branch} 는 데스크톱의 실시간 브랜치 대신
// ctx.branch(호출자가 아는 값, 없으면 빈 문자열)를 쓴다.
// ctx: { session, project, branch }
// askSlot(label) → Promise<string|null>, null 이면 실행 취소
function remoteSessionLabel(session, project) {
  if (!session) return '';
  return project ? project.name + ' — ' + session.title : session.title;
}

async function expandRemotePreset(command, ctx, askSlot, slotValues) {
  const c = ctx || {};
  const s = c.session || null;
  const project = c.project || null;
  let out = String(command).replace(/\{(branch|projectPath|projectName|session|clipboard)\}/g, (_, name) => {
    if (name === 'branch') return s ? (c.branch || '') : '';
    if (name === 'projectPath') return s ? s.cwd : '';
    if (name === 'projectName') return project ? project.name : '';
    if (name === 'session') return s ? remoteSessionLabel(s, project) : '';
    return '';
  });
  const labels = [...new Set([...out.matchAll(/\{input:([^{}]+)\}/g)].map((m) => m[1].trim()).filter(Boolean))];
  for (const label of labels) {
    const value = slotValues && Object.prototype.hasOwnProperty.call(slotValues, label)
      ? slotValues[label]
      : await askSlot(label);
    if (value === null || value === undefined) return null;
    if (slotValues) slotValues[label] = value;
    out = out.replaceAll('{input:' + label + '}', value);
  }
  return out;
}

// 세션에 보여 줄 프리셋 — 전역 먼저, 그다음 그 세션 프로젝트 전용 (split-view.js 와 같은 순서)
function presetsForSession(presets, session) {
  const list = presets || [];
  const globals = list.filter((p) => !p.projectId);
  const projs = session && session.projectId
    ? list.filter((p) => p.projectId && p.projectId === session.projectId) : [];
  return globals.concat(projs);
}

// ── 터미널 글꼴 크기 맞춤 ──
// PTY 크기(cols)는 데스크톱이 정한다. 폰은 글꼴만 줄여 화면 폭에 맞추고,
// 최소 크기로도 넘치면 가로 스크롤한다.
// cellWidthPerPx: 글꼴 1px 당 셀 폭 (측정값, 모노스페이스는 대략 0.6)
const REMOTE_FONT_MIN = 7;
const REMOTE_FONT_MAX = 14;

function fitTerminalFont(availWidth, cols, cellWidthPerPx, opts) {
  const o = opts || {};
  const min = o.min || REMOTE_FONT_MIN;
  const max = o.max || REMOTE_FONT_MAX;
  const ratio = cellWidthPerPx > 0 ? cellWidthPerPx : 0.6;
  if (!(availWidth > 0) || !(cols > 0)) return { fontSize: max, scroll: false };
  // 0.5px 단위로 내림 — 올림하면 마지막 열이 잘린다
  const ideal = Math.floor((availWidth / cols / ratio) * 2) / 2;
  if (ideal < min) return { fontSize: min, scroll: true };
  return { fontSize: Math.min(max, ideal), scroll: false };
}

// ── 재연결 백오프 ──
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15000;

function reconnectDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(n, 16)));
}

// ── 서버 메시지 파싱 ──
const SERVER_MESSAGE_TYPES = new Set([
  'sessions', 'status', 'created', 'createResult', 'exited', 'snap', 'data', 'resize', 'error', 'pong'
]);

function parseServerMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch (_) { return null; }
  if (!msg || typeof msg !== 'object' || !SERVER_MESSAGE_TYPES.has(msg.t)) return null;
  return msg;
}

// ── 페어링 코드 ──
// QR URL 의 해시(#pair=<code>)에서 코드를 꺼낸다
function pairCodeFromHash(hash) {
  const m = /(?:^#|&)pair=([^&]+)/.exec(String(hash || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim() || null; } catch (_) { return null; }
}

function normalizePairCode(input) {
  return String(input || '').replace(/\s+/g, '').toUpperCase();
}

// 세션 목록 갱신 — 같은 id 는 교체, 새 id 는 끝에 추가 (생성 순서 유지)
function upsertSession(list, info) {
  if (!info || !info.id) return list;
  const idx = list.findIndex((s) => s.id === info.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = Object.assign({}, list[idx], info);
    return next;
  }
  return list.concat([info]);
}

// ── 스냅샷 → xterm 초기화 시퀀스 ──
// reset() 은 즉시 실행돼 아직 큐에 남은 이전 write 가 그 뒤에 그려질 수 있다.
// RIS(ESC c)를 write 큐에 넣어 순서를 보장하고, 서버가 추적한 bracketed paste 상태를
// 같은 큐로 되살린다 — 스냅샷 tail 에 \e[?2004h 가 잘려 나가도 xterm 의 modes 가 맞는다.
// 필드가 없으면(구버전 서버) 모드를 건드리지 않고 스트림 추적에 맡긴다.
const SNAP_RESET = '\x1bc';

function snapModeSuffix(snap) {
  if (!snap || typeof snap.bracketedPaste !== 'boolean') return '';
  return snap.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l';
}

// ── 새 세션 요청 추적 ──
// create 에 reqId 를 실어 보내고 createResult/error 의 reqId 로만 짝을 맞춘다
// (projectId 로 맞추면 데스크톱이 같은 프로젝트에 만든 세션을 잘못 열 수 있다)
const CREATE_TIMEOUT_MS = 10000;

function newReqId(rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  return 'c' + Date.now().toString(36) + Math.floor(r() * 1e9).toString(36);
}

function isReplyTo(pending, msg) {
  return !!(pending && msg && msg.reqId !== undefined && msg.reqId === pending.reqId);
}

// ── 키보드 열림 판정 ──
// 기준 높이는 같은 폭(=같은 방향)에서 본 가장 큰 뷰포트 높이 — 회전하면 폭이 바뀌어 다시 잰다
function nextViewportBaseline(prev, width, height) {
  if (!prev || prev.width !== width) return { width, height };
  return { width, height: Math.max(prev.height, height) };
}

function isKeyboardOpen(baseline, height) {
  return !!baseline && height < baseline.height * 0.8;
}
