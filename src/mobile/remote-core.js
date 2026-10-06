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
  enter: '\r'
};

const REMOTE_KEY_BAR = [
  { key: 'esc', label: 'Esc' },
  { key: 'ctrlc', label: 'Ctrl+C' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'enter', label: 'Enter' }
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

// ── 터미널 글꼴 확대 (두 손가락) ──
// 브라우저 확대는 하단 특수키·입력창까지 키워 화면을 가린다. 대신 터미널 글꼴만 배율로 키운다.
// 배율 1 = 화면 폭 맞춤(fitTerminalFont). 키우면 넘치는 만큼 가로 스크롤한다.
const TERM_ZOOM_KEY = 'ta-remote-term-zoom';
const TERM_ZOOM_MIN = 1;
const TERM_ZOOM_MAX = 3;
// 배율을 곱해도 이 크기는 넘지 않는다 (큰 태블릿에서 과하게 커지지 않게)
const TERM_FONT_ZOOM_CAP = 32;

function clampZoom(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return TERM_ZOOM_MIN;
  return Math.min(TERM_ZOOM_MAX, Math.max(TERM_ZOOM_MIN, z));
}

// 저장된 배율 문자열 → 유효 배율 (없거나 깨졌으면 1)
function parseStoredZoom(raw) {
  if (raw === null || raw === undefined || raw === '') return TERM_ZOOM_MIN;
  return clampZoom(parseFloat(raw));
}

// 맞춤 글꼴 × 배율 → 실제 글꼴 크기 (0.5px 단위 내림, 상한 적용)
function zoomedFontSize(baseSize, zoom) {
  const base = baseSize > 0 ? baseSize : REMOTE_FONT_MAX;
  const raw = Math.floor(base * clampZoom(zoom) * 2) / 2;
  return Math.max(REMOTE_FONT_MIN, Math.min(TERM_FONT_ZOOM_CAP, raw));
}

// 두 터치점 사이 거리
function touchDistance(a, b) {
  const dx = (a.clientX || 0) - (b.clientX || 0);
  const dy = (a.clientY || 0) - (b.clientY || 0);
  return Math.hypot(dx, dy);
}

// 핀치 시작 시 배율·거리 기준으로 현재 거리의 배율
function pinchZoom(startZoom, startDist, curDist) {
  if (!(startDist > 0) || !(curDist > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (curDist / startDist));
}

// 두 번 탭 판정 — 짧은 간격·가까운 위치의 한 손가락 탭이면 true
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 24;
function isDoubleTap(prev, now, x, y) {
  if (!prev) return false;
  return now - prev.t <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_DIST;
}

// ── 대체 버퍼 TUI 스와이프 ──
// Claude Code 같은 전체 화면 TUI 는 대체 버퍼라 xterm 스크롤백이 없다 — 데스크톱의 휠처럼
// 스와이프를 TUI 로 보내야 TUI 가 자기 이전 내용을 스크롤한다. 터미널이 화면보다 커서(확대)
// 감싸는 영역이 스크롤되는 중이면 그 끝에 닿았을 때만 TUI 로 넘긴다.
// deltaY: 휠 기준 부호 (양수 = 아래로 스크롤 = 손가락은 위로)
function swipeTarget(altBuffer, deltaY, atTop, atBottom, locked) {
  if (!altBuffer) return 'native';
  if (locked) return 'tui';
  if (deltaY < 0) return atTop ? 'tui' : 'native';
  if (deltaY > 0) return atBottom ? 'tui' : 'native';
  return 'native';
}

// 터치 이동 → 휠 delta (손가락이 위로 가면 양수)
function wheelDeltaFromTouch(prevY, curY) {
  return prevY - curY;
}

// 누적 이동(px)을 셀 높이 단위 휠 이벤트 개수로 쪼갠다 — TUI 는 휠 이벤트 하나에 몇 줄씩 움직이므로
// 손가락이 한 셀 움직일 때마다 하나씩 보내야 손가락을 따라오는 느낌이 난다. 나머지는 이월.
function wheelStepsFor(accPx, cellH) {
  const h = cellH > 0 ? cellH : 16;
  const count = Math.trunc(accPx / h);
  return { count, rest: accPx - count * h };
}

// 플링(관성) 한 프레임 — 속도(px/ms)에 마찰을 곱해 줄이고 그 동안 이동한 거리를 돌려준다
const FLING_FRICTION = 0.0035; // ms 당 감쇠 비율
const FLING_MIN_V = 0.03; // px/ms — 이보다 느리면 멈춘다
function flingStep(v, dtMs) {
  const dt = Math.max(0, Math.min(64, dtMs || 16));
  const decay = Math.max(0, 1 - FLING_FRICTION * dt);
  const nv = v * decay;
  if (Math.abs(nv) < FLING_MIN_V) return { travel: v * dt * 0.5, v: 0 };
  return { travel: (v + nv) * 0.5 * dt, v: nv };
}

// 최근 터치 샘플로 놓는 순간의 속도(px/ms, 손가락이 위로 가면 양수) — 너무 오래된 샘플은 버린다
function flingVelocity(samples, now) {
  const recent = (samples || []).filter((s) => now - s.t <= 100);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  return (a.y - b.y) / dt;
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
  'sessions', 'status', 'created', 'createResult', 'exited', 'snap', 'data', 'resize', 'error', 'pong',
  'control'
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

// ── 이미지 첨부 ──
// 데스크톱 util.js quotePath 와 같은 규칙 — 공백 포함 경로만 따옴표 (Claude Code 가 이미지 칩으로 인식)
function quoteRemotePath(p) {
  return /\s/.test(p) ? '"' + p + '"' : p;
}

const IMAGE_MAX_SIDE = 2048;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
// 이 크기 이하·지원 형식이면 원본 그대로 올린다 (재인코딩으로 화질을 잃을 이유가 없다)
const IMAGE_PASSTHROUGH_BYTES = 4 * 1024 * 1024;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic']);

// 긴 변을 maxSide 로 줄인 크기 (이미 작으면 그대로)
function scaledImageSize(width, height, maxSide) {
  const max = maxSide || IMAGE_MAX_SIDE;
  const long = Math.max(width, height);
  if (!(long > max)) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// 캔버스로 다시 그려 JPEG 로 보낼지 — HEIC(서버 디코드 불확실)·미지원 형식·큰 파일·큰 해상도
function imageNeedsReencode(info) {
  const type = String(info.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif' || !UPLOAD_TYPES.has(type)) return true;
  if (info.size > IMAGE_PASSTHROUGH_BYTES) return true;
  return Math.max(info.width || 0, info.height || 0) > IMAGE_MAX_SIDE;
}

// 재인코딩 형식 — PNG 는 투명을 지키려 PNG 로, 나머지는 JPEG (흰 배경 위에)
function reencodeType(type) {
  return String(type || '').toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
}

function isHeicFile(file) {
  return /^image\/hei[cf]$/i.test(String(file.type || '')) || /\.hei[cf]$/i.test(String(file.name || ''));
}

// 브라우저가 디코드하지 못한 파일 처리 — 'heic': 업로드하지 않고 안내(서버도 못 열 가능성이 높다),
// 'raw': 서버가 받는 형식이면 원본 그대로, 'fail': 열 수 없음
function undecodableAction(file) {
  if (isHeicFile(file)) return 'heic';
  const type = String(file.type || '').toLowerCase();
  if (UPLOAD_TYPES.has(type) && file.size <= IMAGE_MAX_BYTES) return 'raw';
  return 'fail';
}

// 입력창 커서 위치에 경로 삽입 → { value, caret }
function insertAtCaret(value, start, end, text) {
  const v = String(value || '');
  const s = start == null ? v.length : start;
  const e = end == null ? s : end;
  return { value: v.slice(0, s) + text + v.slice(e), caret: s + text.length };
}

// ── 제어권 ──
const CONTROL_FONT_SIZE = 12;
const CONTROL_MIN_COLS = 40;
const CONTROL_MIN_ROWS = 10;
// control/release 응답을 기다리는 한도 — 넘기면 요청 실패로 보고 화면 맞춤으로 돌아간다
const CONTROL_REPLY_TIMEOUT_MS = 5000;

// 화면에 들어가는 PTY 크기 — 셀 크기는 제어용 글꼴로 실측한 값
function controlSize(availWidth, availHeight, cellWidth, cellHeight) {
  const cols = cellWidth > 0 ? Math.floor(availWidth / cellWidth) : 0;
  const rows = cellHeight > 0 ? Math.floor(availHeight / cellHeight) : 0;
  return {
    cols: Math.min(500, Math.max(CONTROL_MIN_COLS, cols)),
    rows: Math.min(200, Math.max(CONTROL_MIN_ROWS, rows))
  };
}

// 서버 control 메시지 → 이 기기가 쥐고 있는지
function holdsControl(control, myDeviceId) {
  return !!(control && control.holder && myDeviceId && control.holder === myDeviceId);
}

// 최적보기(제어권)가 나에게서 떠났을 때 알릴 문구 (null = 알릴 것 없음)
function controlLostText(prev, next, myDeviceId) {
  if (!holdsControl(prev, myDeviceId) || holdsControl(next, myDeviceId)) return null;
  if (next && next.holder) return '최적보기가 ' + (next.deviceName || '다른 기기') + '(으)로 넘어갔습니다';
  return '최적보기가 해제되었습니다 (PC 에서 되찾음)';
}

// ── 홈 화면 앱화 ──
// 홈 화면에서 연 앱인가 — iOS 는 navigator.standalone, 그 외는 display-mode 미디어쿼리
function isStandaloneMode(navStandalone, displayModeStandalone) {
  return navStandalone === true || displayModeStandalone === true;
}

// 설치 안내 분기. iPadOS 사파리는 데스크톱(Mac) UA 를 쓰므로 터치 포인트로 구분한다
function installPlatform(ua, maxTouchPoints) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && (maxTouchPoints || 0) > 1)) return 'ios';
  if (/Android/.test(s)) return 'android';
  return 'other';
}

const INSTALL_DISMISS_KEY = 'ta-remote-install-dismissed';

function shouldShowInstallSheet(standalone, dismissed) {
  return !standalone && !dismissed;
}

// 페어링 화면의 기기 이름 기본값. UA 축소(Chrome)로 모델명이 'K' 로만 오면 일반 이름을 쓴다
function deviceNameFromUA(ua, maxTouchPoints) {
  const s = String(ua || '');
  if (/iPad/.test(s) || (/Macintosh/.test(s) && (maxTouchPoints || 0) > 1)) return 'iPad';
  if (/iPhone/.test(s)) return 'iPhone';
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(s);
  if (android && android[1].trim().length > 1) return android[1].trim().slice(0, 40);
  if (/Android/.test(s)) return 'Android';
  return '모바일 브라우저';
}

// ── 폰에서 열기 · 오프라인 ──
// 알림 링크의 해시(#session=<id>)에서 세션 id — 페어링 해시(#pair=)와 함께 올 수 있다
function sessionFromHash(hash) {
  const m = /(?:^#|&)session=([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(String(hash || ''));
  return m ? m[1] : null;
}

// 해시에서 session= 만 지운 나머지 (#pair= 는 남긴다) — 같은 세션을 새로고침마다 다시 열지 않게
function stripSessionHash(hash) {
  const rest = String(hash || '').replace(/^#/, '').split('&').filter((p) => p && !/^session=/.test(p));
  return rest.length ? '#' + rest.join('&') : '';
}

// 부팅 분기 — 서버에 닿지 않으면(네트워크 오류·시간 초과) 페어링보다 '연결할 수 없음' 안내가 먼저다
function bootRoute(me, netFail, code) {
  if (netFail) return 'offline';
  if (me && !code) return 'start';
  return 'pair';
}

const OFFLINE_RETRY_BASE_MS = 3000;
const OFFLINE_RETRY_MAX_MS = 30000;

function offlineRetryDelay(attempt) {
  return Math.min(OFFLINE_RETRY_MAX_MS, OFFLINE_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt)));
}

// ── 상시 VPN 안내 ──
function shouldShowVpnTips(platform, dismissed) {
  return (platform === 'android' || platform === 'ios') && !dismissed;
}

// 기기별 설정 경로. 아이콘은 이모지(외부 이미지 없이 단계 구분용)
function vpnTipSteps(platform) {
  if (platform === 'android') {
    return [
      {
        title: '상시 VPN (갤럭시 기준)',
        steps: [
          { icon: '⚙️', text: '설정 → 연결' },
          { icon: '🔗', text: '기타 연결 설정 → VPN' },
          { icon: '🛡️', text: 'Tailscale 옆 ⚙ → 상시 VPN 켜기' }
        ]
      },
      {
        title: '배터리 제한 해제',
        steps: [
          { icon: '📱', text: '설정 → 애플리케이션 → Tailscale' },
          { icon: '🔋', text: '배터리 → 제한 없음' }
        ]
      },
      {
        // 삼성 월렛(삼성페이)은 VPN 이 켜져 있으면 결제를 막는다 — Tailscale 에서 월렛만 제외하면 둘 다 쓸 수 있다
        title: '삼성 월렛(삼성페이)이 VPN 해제를 요구하면',
        steps: [
          { icon: '🛡️', text: 'Tailscale 앱 → 왼쪽 위 프로필 아이콘' },
          { icon: '🔀', text: 'App-based split tunneling' },
          { icon: '✅', text: '삼성 월렛·삼성 패스 체크 (한글 앱은 목록 맨 아래, 검색은 spay)' }
        ]
      }
    ];
  }
  if (platform === 'ios') {
    return [
      {
        title: 'VPN On Demand',
        steps: [
          { icon: '🛡️', text: 'Tailscale 앱 열기 → 설정' },
          { icon: '🔁', text: 'VPN On Demand 켜기' }
        ]
      }
    ];
  }
  return [];
}

// 410 {moved} 응답의 새 주소 — https 만 받는다 (임의 스킴으로 이동하지 않게)
function movedTarget(status, body) {
  if (status !== 410 || !body || typeof body.moved !== 'string') return null;
  return /^https:\/\/[^\s/]+(?::\d+)?\/?$/.test(body.moved) ? body.moved : null;
}
