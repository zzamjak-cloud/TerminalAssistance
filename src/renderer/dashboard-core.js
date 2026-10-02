// 대시보드 공용 순수 로직 — 데스크톱 dashboard.js 와 모바일 원격 웹앱이 함께 쓴다.
// DOM·App 에 의존하지 않는다 (모바일은 서버가 이 파일을 그대로 서빙한다).

// 정렬 우선순위 — 내가 개입해야 하는 세션이 항상 먼저 온다 (이 뷰의 존재 이유)
const DASH_STATUS_RANK = { waiting: 0, done: 1, running: 2, idle: 3, exited: 4 };

const DASH_STATUS_TEXT = { idle: '대기중', running: '진행중', waiting: '허가 대기', done: '완료', exited: '종료됨' };

// 그룹 요약 칩에 세는 순서 — 급한 상태부터
const DASH_CHIP_ORDER = ['waiting', 'done', 'running', 'idle', 'exited'];

function dashboardStatusRank(status) {
  const rank = DASH_STATUS_RANK[status];
  return rank === undefined ? 3 : rank;
}

const DASH_SORTS = [
  { id: 'status', label: '상태' },
  { id: 'project', label: '프로젝트' },
  { id: 'activity', label: '최근 활동' }
];

// 표시 순서를 계산한다. 렌더는 이 순서의 인덱스를 CSS order 로 적용하므로
// DOM 은 세션 순서로 고정되고, 순서가 바뀌어도 카드가 이동만 한다 (재생성·깜빡임 없음).
// 어떤 기준이든 동순위는 세션 생성 순서(원본 배열 순서)로 갈린다.
// ctx: { projectIndex: Map(projectId → 표시 순서), lastChangeAt: Map(sessionId → ms) }
function sortSessionsForDashboard(sessions, mode, ctx) {
  const c = ctx || {};
  const projectIndex = c.projectIndex || new Map();
  const lastChangeAt = c.lastChangeAt || new Map();
  // 프로젝트가 없는 홈 터미널은 목록 끝으로 (등록된 프로젝트보다 뒤)
  const projRank = (s) => {
    const idx = s.projectId === null || s.projectId === undefined
      ? undefined : projectIndex.get(s.projectId);
    return idx === undefined ? Number.MAX_SAFE_INTEGER : idx;
  };
  const key = {
    status: (s) => dashboardStatusRank(s.status),
    project: projRank,
    // 최근일수록 앞 — 음수로 뒤집어 오름차순 비교에 태운다
    activity: (s) => -(lastChangeAt.get(s.id) || 0)
  }[mode] || ((s) => dashboardStatusRank(s.status));

  return (sessions || [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (key(a.s) - key(b.s)) || (a.i - b.i))
    .map((x) => x.s);
}

// 그룹(프로젝트) 표시 순서. 그룹의 대표값은 '그 안에서 가장 앞서는 세션'이다 —
// 상태 정렬이면 가장 급한 세션이, 활동 정렬이면 가장 최근에 움직인 세션이 그룹을 끌어올린다.
// groups: [{ key, projectId, index, sessions }]
function sortGroupsForDashboard(groups, mode, ctx) {
  const c = ctx || {};
  const projectIndex = c.projectIndex || new Map();
  const lastChangeAt = c.lastChangeAt || new Map();
  const projRank = (g) => {
    const idx = g.projectId === null || g.projectId === undefined
      ? undefined : projectIndex.get(g.projectId);
    return idx === undefined ? Number.MAX_SAFE_INTEGER : idx;
  };
  const key = {
    status: (g) => Math.min(...g.sessions.map((s) => dashboardStatusRank(s.status))),
    project: projRank,
    activity: (g) => -Math.max(...g.sessions.map((s) => lastChangeAt.get(s.id) || 0))
  }[mode] || ((g) => Math.min(...g.sessions.map((s) => dashboardStatusRank(s.status))));

  return groups
    .slice()
    .sort((a, b) => (key(a) - key(b)) || (a.index - b.index));
}

// 진행 시간 표기 — 1분 미만은 초, 그 이상은 분:초
function formatRunElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return total + '초';
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

// 마지막 활동 표기 — 초 단위까지 보여 줄 이유가 없다 (매초 글자가 바뀌면 눈만 피로하다)
function formatSinceChange(nowMs, atMs) {
  const sec = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (sec < 45) return '방금';
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + '분 전';
  if (sec < 86400) return Math.round(sec / 3600) + '시간 전';
  return Math.round(sec / 86400) + '일 전';
}

// 세션 집합·소속·프로젝트 표기가 바뀌었는지 판별하는 서명.
// 이 값이 그대로면 골격을 다시 만들지 않고 값만 갱신한다.
function dashboardSignature(sessions, projects) {
  const proj = new Map(projects.map((p) => [p.id, p]));
  return sessions.map((s) => {
    const p = proj.get(s.projectId);
    return [s.projectId, s.id, s.title, p ? p.name : '', p ? p.color || '' : '', p ? p.branch || '' : ''].join('\u001f');
  }).join('\u001e');
}

// 세션을 프로젝트 단위로 묶는다 — 그룹 순서는 세션 배열에서 처음 등장한 순서.
// 접두사로 이름공간을 나눈다 — 프로젝트 id 가 어떤 문자열이어도 홈 그룹과 부딪히지 않는다
function groupSessionsByProject(sessions, projects) {
  const groups = [];
  const byKey = new Map();
  for (const s of sessions || []) {
    const key = s.projectId === null || s.projectId === undefined ? 'home' : 'p:' + s.projectId;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        projectId: s.projectId === undefined ? null : s.projectId,
        project: (projects || []).find((p) => p.id === s.projectId) || null,
        index: groups.length,
        sessions: []
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.sessions.push(s);
  }
  return groups;
}
