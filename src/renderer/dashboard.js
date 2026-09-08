// 전 세션 대시보드 — 세션이 분할 최대치(6개)를 넘어갈 때
// "무엇이 돌고, 무엇이 나를 기다리는가"를 한 화면에서 보는 읽기 전용 뷰.
//
// 타일 본문은 백엔드를 다시 부르지 않고 살아 있는 xterm 버퍼에서 읽는다:
//  · ta.getScrollback() 은 흐름 제어 상태(outstanding)를 리셋하므로 주기 호출이 불가하다.
//  · 스크롤백 '바이트'를 잘라내면 TUI(Claude Code·Codex)의 대체 버퍼 그리기 명령이라 읽을 수 없다.
//  · term.buffer.active 는 이미 렌더된 화면이라 TUI 도 그대로 읽힌다 (terminal-search.js 와 같은 방식).
//
// 화면은 #term-area 위에 덮는 오버레이다 — 홀더를 숨기거나 옮기지 않으므로
// xterm 리플로우·fit 재계산이 발생하지 않고, 껐다 켜도 터미널·분할 배치가 그대로다.

const DASH_TAIL_LINES = 10;
const DASH_REFRESH_MS = 1000;

// 정렬 우선순위 — 내가 개입해야 하는 세션이 항상 먼저 온다 (이 뷰의 존재 이유)
const DASH_STATUS_RANK = { waiting: 0, done: 1, running: 2, idle: 3, exited: 4 };

function dashboardStatusRank(status) {
  const rank = DASH_STATUS_RANK[status];
  return rank === undefined ? 3 : rank;
}

// 표시 순서 = [상태 우선순위, 세션 생성 순서]. 렌더는 이 순서를 CSS order 로 적용하므로
// DOM 은 세션 순서로 고정되고 상태가 바뀌어도 타일이 이동만 한다 (재생성·깜빡임 없음).
function sortSessionsForDashboard(sessions) {
  return (sessions || [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (dashboardStatusRank(a.s.status) - dashboardStatusRank(b.s.status)) || (a.i - b.i))
    .map((x) => x.s);
}

// 화면 아래쪽 빈 줄을 건너뛴 뒤의 마지막 n 행.
// TUI 대체 버퍼는 하단이 입력 영역이라 그냥 마지막 n 행을 뜨면 빈 줄만 잡힌다.
function tailFromBuffer(view, n) {
  if (!view || !view.term || !view.term.buffer) return [];
  let buf;
  try { buf = view.term.buffer.active; } catch (_) { return []; }
  if (!buf) return [];
  const out = [];
  for (let row = buf.length - 1; row >= 0 && out.length < n; row--) {
    const line = buf.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true).replace(/\s+$/, '');
    if (!text && !out.length) continue; // 아직 내용을 만나지 못했으면 빈 줄은 버린다
    out.push(text);
  }
  out.reverse();
  // 위쪽 빈 줄도 걷는다 — 좁은 타일에서 한 행은 아깝다 (내용 사이의 빈 줄은 그대로 둔다)
  while (out.length && !out[0]) out.shift();
  return out;
}

// 진행 시간 표기 — 1분 미만은 초, 그 이상은 분:초
function formatRunElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return total + '초';
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

Object.assign(App, {
  _dashOpen: false,
  _dashTimer: null,
  _dashTiles: new Map(), // sessionId → { root, statusEl, metaEl, timeEl, bodyEl, lastBody }
  _dashKeyHandler: null,
  _runStartedAt: new Map(), // sessionId → running 진입 시각 (진행 시간 표시용)

  // 상태 전이 기록 — 대시보드가 닫혀 있어도 진행 시작 시각은 알고 있어야
  // 열었을 때 경과 시간을 바로 보여줄 수 있다 (Map 쓰기 1회 — 무시할 수 있는 비용)
  noteStatusForDashboard(sessionId, status) {
    if (status === 'running') {
      if (!App._runStartedAt.has(sessionId)) App._runStartedAt.set(sessionId, Date.now());
    } else {
      App._runStartedAt.delete(sessionId);
    }
    if (App._dashOpen) App.refreshDashboard();
  },

  toggleDashboard() {
    if (App._dashOpen) App.closeDashboard();
    else App.openDashboard();
  },

  openDashboard() {
    const root = document.getElementById('dashboard');
    if (!root) return;
    App._dashOpen = true;
    root.classList.remove('hidden');
    document.getElementById('btn-dashboard').classList.add('on');
    App.renderDashboard();
    App._dashTimer = setInterval(() => {
      // 창이 숨겨져 있으면 갱신하지 않는다 (pollStatus 등 기존 관례와 동일)
      if (document.visibilityState === 'visible') App.refreshDashboard();
    }, DASH_REFRESH_MS);
    // Esc 로 닫기 — 모달이 열려 있으면 모달의 Esc 를 빼앗지 않는다
    App._dashKeyHandler = (ev) => {
      if (ev.key !== 'Escape') return;
      const backdrop = document.getElementById('modal-backdrop');
      if (backdrop && !backdrop.classList.contains('hidden')) return;
      ev.preventDefault();
      App.closeDashboard();
    };
    document.addEventListener('keydown', App._dashKeyHandler, true);
  },

  closeDashboard() {
    App._dashOpen = false;
    const root = document.getElementById('dashboard');
    if (root) root.classList.add('hidden');
    const btn = document.getElementById('btn-dashboard');
    if (btn) btn.classList.remove('on');
    clearInterval(App._dashTimer);
    App._dashTimer = null;
    if (App._dashKeyHandler) {
      document.removeEventListener('keydown', App._dashKeyHandler, true);
      App._dashKeyHandler = null;
    }
    App._dashTiles.clear();
    const grid = document.getElementById('dashboard-grid');
    if (grid) grid.textContent = '';
  },

  // 타일 골격을 세션 순서대로 만든다 (세션 집합이 바뀔 때만 호출)
  renderDashboard() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    grid.textContent = '';
    App._dashTiles.clear();

    const sessions = App.state.sessions;
    document.getElementById('dashboard-count').textContent =
      sessions.length ? `세션 ${sessions.length}개` : '';

    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'dash-empty';
      empty.textContent = '열려 있는 세션이 없습니다. 좌측에서 프로젝트를 클릭해 터미널을 시작하세요.';
      grid.appendChild(empty);
      return;
    }

    for (const s of sessions) {
      const tile = document.createElement('div');
      tile.className = 'dash-tile';
      tile.dataset.sid = s.id;

      const head = document.createElement('div');
      head.className = 'dash-head';
      const dot = document.createElement('span');
      dot.className = 'dash-dot ' + s.status;
      const name = document.createElement('span');
      name.className = 'dash-name';
      name.textContent = App.sessionLabel(s);
      const time = document.createElement('span');
      time.className = 'dash-time';
      head.append(dot, name, time);

      const meta = document.createElement('div');
      meta.className = 'dash-meta';

      const body = document.createElement('pre');
      body.className = 'dash-body';

      tile.append(head, meta, body);
      // 클릭 = 그 세션으로 전환 (대시보드는 읽기 전용이므로 전환 후 닫는다)
      tile.onclick = () => {
        App.closeDashboard();
        App.activateSession(s.id);
      };
      grid.appendChild(tile);
      App._dashTiles.set(s.id, { root: tile, statusEl: dot, metaEl: meta, timeEl: time, bodyEl: body, lastBody: null });
    }
    App.refreshDashboard();
  },

  // 매 tick 갱신 — DOM 은 값이 실제로 달라졌을 때만 건드린다
  refreshDashboard() {
    if (!App._dashOpen) return;
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    // 세션이 열리거나 닫혔으면 골격부터 다시 만든다
    const ids = App.state.sessions.map((s) => s.id);
    if (ids.length !== App._dashTiles.size || ids.some((id) => !App._dashTiles.has(id))) {
      App.renderDashboard();
      return;
    }

    const project = (s) => App.state.projects.find((p) => p.id === s.projectId);
    for (const s of App.state.sessions) {
      const tile = App._dashTiles.get(s.id);
      if (!tile) continue;

      // 상태 — 점 색과 정렬 위치 (CSS order 라 DOM 이동이 없다)
      const dotClass = 'dash-dot ' + s.status;
      if (tile.statusEl.className !== dotClass) tile.statusEl.className = dotClass;
      const order = String(dashboardStatusRank(s.status));
      if (tile.root.style.order !== order) tile.root.style.order = order;
      if (tile.root.classList.contains('active') !== (s.id === App.state.activeId)) {
        tile.root.classList.toggle('active', s.id === App.state.activeId);
      }

      // 진행 시간 (진행 중일 때만)
      const startedAt = App._runStartedAt.get(s.id);
      const timeText = s.status === 'running' && startedAt
        ? formatRunElapsed(Date.now() - startedAt)
        : '';
      if (tile.timeEl.textContent !== timeText) tile.timeEl.textContent = timeText;

      // 부제 — 상태 한글 표기 + 워크트리 브랜치
      const proj = project(s);
      const statusText = { idle: '대기중', running: '진행중', waiting: '허가 대기', done: '완료', exited: '종료됨' }[s.status] || s.status;
      // 워크트리 세션은 어느 브랜치인지가 곧 정체성이다 (글리프는 글꼴 의존이라 텍스트로)
      const branch = proj && proj.parentId && proj.branch ? ' · ' + proj.branch : '';
      const metaText = statusText + branch;
      if (tile.metaEl.textContent !== metaText) tile.metaEl.textContent = metaText;

      // 본문 tail
      const lines = tailFromBuffer(TerminalView.views.get(s.id), DASH_TAIL_LINES);
      const text = lines.join('\n');
      if (tile.lastBody !== text) {
        tile.lastBody = text;
        tile.bodyEl.textContent = text;
      }
    }
  }
});
