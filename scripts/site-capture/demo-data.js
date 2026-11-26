// 홍보용 가상 데모 데이터 — 실제 사용자·경로·IP 는 전혀 쓰지 않는다.
module.exports = (lang) => {
const t = (ko, en) => (lang === 'en' ? en : ko);
const ESC = '\x1b[';
const c = {
  r: ESC + '0m', dim: ESC + '2m', b: ESC + '1m',
  orange: ESC + '38;5;173m', green: ESC + '38;5;78m', red: ESC + '38;5;203m',
  yellow: ESC + '38;5;221m', blue: ESC + '38;5;75m', gray: ESC + '38;5;245m', cyan: ESC + '38;5;80m',
  addBg: ESC + '48;2;22;70;38m', delBg: ESC + '48;2;80;28;34m'
};
const wid = (t) => [...t.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
// 표시 폭 기준으로 오른쪽을 맞춘 상자 (한글은 2칸)
const box = (color, lines, w) => [color + '╭' + '─'.repeat(w) + '╮' + c.r]
  .concat(lines.map((l) => color + '│' + c.r + l + ' '.repeat(Math.max(0, w - wid(l))) + color + '│' + c.r))
  .concat([color + '╰' + '─'.repeat(w) + '╯' + c.r]);
const nl = (...lines) => lines.join('\r\n') + '\r\n';

const projects = [
  { id: 'p1', name: 'web-app', path: '/Users/demo/projects/web-app', color: '#58a6ff' },
  { id: 'p2', name: 'api-server', path: '/Users/demo/projects/api-server', color: '#3fb950' },
  { id: 'p3', name: 'mobile-app', path: '/Users/demo/projects/mobile-app', color: '#f0883e' },
  { id: 'p4', name: 'docs-site', path: '/Users/demo/projects/docs-site', color: '#a371f7' },
  { id: 'p5', name: 'web-app · checkout', path: '/Users/demo/projects/web-app-checkout', color: '#58a6ff', parentId: 'p1', branch: 'feature/checkout' }
];

const presets = [
  { id: 'g1', label: 'Claude', command: 'claude', projectId: null, color: '#d97757' },
  { id: 'g2', label: 'Codex', command: 'codex', projectId: null, color: '#3b82f6' },
  { id: 'g3', label: t('빌드 & 테스트', 'Build & Test'), command: 'npm run build && npm test', projectId: null, color: '#2f9e5b' },
  { id: 'g4', label: t('PR 리뷰', 'PR Review'), command: t('claude "현재 브랜치 변경사항을 PR 리뷰해줘"', 'claude "Review the changes on this branch as a PR"'), projectId: null, color: '#a371f7' },
  { id: 'g5', label: 'git status', command: 'git status -sb', projectId: null, color: null },
  { id: 'a1', label: t('개발 서버', 'Dev server'), command: 'npm run dev', projectId: 'p1', color: '#0e7490' },
  { id: 'a2', label: t('린트 수정', 'Lint fix'), command: 'npm run lint -- --fix', projectId: 'p1', color: null },
  { id: 'a3', label: t('타입 체크', 'Type check'), command: 'npx tsc --noEmit', projectId: 'p1', color: '#b45309' },
  { id: 'b1', label: t('DB 마이그레이션', 'DB migration'), command: 'npm run db:migrate', projectId: 'p2', color: '#9a3412' }
];

// status: running | waiting | done | idle
const sessions = [
  { id: 's1', projectId: 'p1', title: t('검색 디바운스', 'Search debounce'), status: 'running', cwd: projects[0].path },
  { id: 's2', projectId: 'p1', title: t('빌드 & 테스트', 'Build & Test'), status: 'done', cwd: projects[0].path },
  { id: 's3', projectId: 'p1', title: t('Codex 리뷰', 'Codex review'), status: 'waiting', cwd: projects[0].path },
  { id: 's4', projectId: 'p2', title: t('마이그레이션', 'Migration'), status: 'running', cwd: projects[1].path },
  { id: 's5', projectId: 'p2', title: t('API 문서', 'API docs'), status: 'idle', cwd: projects[1].path },
  { id: 's6', projectId: 'p3', title: t('푸시 알림', 'Push alerts'), status: 'waiting', cwd: projects[2].path },
  { id: 's7', projectId: 'p4', title: t('문서 정리', 'Docs cleanup'), status: 'done', cwd: projects[3].path },
  { id: 's8', projectId: 'p5', title: t('결제 플로우', 'Checkout flow'), status: 'running', cwd: projects[4].path }
].map((s) => ({ ...s, createdAtMs: Date.now() - 3600e3, controlHolder: null, controlDeviceName: null, cols: 80, rows: 24 }));

const branches = {
  [projects[0].path]: 'feature/search-debounce', [projects[1].path]: 'feat/db-migration',
  [projects[2].path]: 'feat/push-notify', [projects[3].path]: 'main', [projects[4].path]: 'feature/checkout'
};
const remote = {
  [projects[0].path]: { branch: 'feature/search-debounce', hasUpstream: true, behind: 3, ahead: 0, fetchFailed: false },
  [projects[1].path]: { branch: 'feat/db-migration', hasUpstream: true, behind: 0, ahead: 2, fetchFailed: false },
  [projects[2].path]: { branch: 'feat/push-notify', hasUpstream: true, behind: 0, ahead: 0, fetchFailed: false },
  [projects[3].path]: { branch: 'main', hasUpstream: true, behind: 1, ahead: 0, fetchFailed: false },
  [projects[4].path]: { branch: 'feature/checkout', hasUpstream: true, behind: 0, ahead: 1, fetchFailed: false }
};

const repo = {
  [projects[0].path]: {
    repoName: 'web-app', root: projects[0].path, parentDir: '/Users/demo/projects', currentBranch: 'feature/search-debounce',
    branches: [
      { name: 'main', remote: false, checkedOutAt: null }, { name: 'feature/search-debounce', remote: false, checkedOutAt: projects[0].path },
      { name: 'feature/checkout', remote: false, checkedOutAt: projects[4].path }, { name: 'fix/login-redirect', remote: false, checkedOutAt: null },
      { name: 'origin/feature/coupon-ui', remote: true, checkedOutAt: null }],
    worktrees: [{ path: projects[0].path, branch: 'feature/search-debounce' }, { path: projects[4].path, branch: 'feature/checkout' }]
  }
};

const claudeHead = nl(...box(c.orange, [
  ' ' + c.orange + '✻' + c.r + ' Claude Code',
  c.gray + '   /Users/demo/projects/web-app' + c.r], 46), '');

// s1: 진행 중인 Claude 작업 (스크롤백) + 이어 흘려 보낼 라이브 청크
const s1Scroll = claudeHead + nl(
  c.gray + '> ' + c.r + t('검색창 입력에 디바운스를 적용하고 테스트도 추가해줘', 'Debounce the search input and add tests too'), '',
  c.green + '●' + c.r + t(' 먼저 현재 검색 컴포넌트를 확인합니다.', ' Let me check the current search component first.'), '',
  c.green + '●' + c.r + ' Read(' + c.dim + 'src/components/SearchBar.tsx' + c.r + ')',
  c.gray + '  ⎿  Read 84 lines' + c.r, '',
  c.green + '●' + c.r + ' Search(' + c.dim + 'pattern: "useDebounce"' + c.r + ')',
  c.gray + '  ⎿  Found 0 files' + c.r, '',
  c.green + '●' + c.r + t(' 공용 훅이 없어 새로 만들겠습니다.', " No shared hook yet, so I'll add one."), '');
const s1Live = [
  nl(c.green + '●' + c.r + ' Write(' + c.dim + 'src/hooks/useDebounce.ts' + c.r + ')',
    c.gray + '  ⎿  Wrote 18 lines' + c.r, ''),
  nl(c.green + '●' + c.r + ' Update(' + c.dim + 'src/components/SearchBar.tsx' + c.r + ')',
    c.gray + '  ⎿  Updated with 5 additions and 2 removals' + c.r,
    c.dim + '     12' + c.r + c.delBg + '- const [q, setQ] = useState("")  ' + c.r,
    c.dim + '     12' + c.r + c.addBg + '+ const [q, setQ] = useState("")  ' + c.r,
    c.dim + '     13' + c.r + c.addBg + '+ const debounced = useDebounce(q, 300)' + c.r,
    c.dim + '     21' + c.r + c.delBg + '-   onSearch(q)                     ' + c.r,
    c.dim + '     21' + c.r + c.addBg + '+   onSearch(debounced)             ' + c.r, ''),
  nl(c.green + '●' + c.r + ' Bash(' + c.dim + 'npm test -- SearchBar' + c.r + ')',
    c.gray + '  ⎿  PASS src/components/SearchBar.test.tsx' + c.r,
    c.gray + '     Tests: ' + c.green + '6 passed' + c.gray + ', 6 total' + c.r, ''),
  nl(c.green + '●' + c.r + t(' 디바운스(300ms) 적용과 테스트 6건 통과를 확인했습니다.', ' Debounce (300ms) applied; 6 tests pass.'),
    '  ' + c.dim + t('- useDebounce 훅 신규, SearchBar 연결', '- New useDebounce hook, wired into SearchBar') + c.r,
    '  ' + c.dim + t('- 타이핑 중 API 호출 약 80% 감소 예상', '- ~80% fewer API calls while typing') + c.r, '',
    c.gray + '> ' + c.r)
];

const s2Scroll = nl(
  c.gray + '~/projects/web-app' + c.r + ' ' + c.green + '$' + c.r + ' npm run build && npm test', '',
  c.dim + '> web-app@2.4.0 build' + c.r, c.dim + '> vite build' + c.r, '',
  c.cyan + 'vite v5.4.2' + c.r + ' building for production...',
  c.green + '✓' + c.r + ' 214 modules transformed.',
  c.dim + 'dist/assets/index-4f2a9c.js  ' + c.r + '182.41 kB ' + c.gray + '│ gzip: 58.7 kB' + c.r,
  c.green + '✓ built in 3.12s' + c.r, '',
  c.dim + '> vitest run' + c.r, '',
  ' ' + c.green + '✓' + c.r + ' src/utils/format.test.ts ' + c.gray + '(12)' + c.r,
  ' ' + c.green + '✓' + c.r + ' src/hooks/useDebounce.test.ts ' + c.gray + '(4)' + c.r,
  ' ' + c.green + '✓' + c.r + ' src/components/SearchBar.test.tsx ' + c.gray + '(6)' + c.r,
  ' ' + c.green + '✓' + c.r + ' src/api/client.test.ts ' + c.gray + '(9)' + c.r, '',
  c.b + ' Test Files  ' + c.r + c.green + '4 passed' + c.r + ' (4)',
  c.b + '      Tests  ' + c.r + c.green + '31 passed' + c.r + ' (31)',
  c.b + '   Duration  ' + c.r + '2.84s', '',
  c.gray + '~/projects/web-app' + c.r + ' ' + c.green + '$' + c.r + ' ');

const s3Scroll = nl(
  c.blue + '>_ OpenAI Codex' + c.r + c.gray + '  (v0.46)' + c.r, '',
  c.gray + '› ' + c.r + t('PR #128 결제 모듈 변경사항을 리뷰해줘', 'Review the payment module changes in PR #128'), '',
  c.b + '• Explored' + c.r, '  ' + c.gray + 'Read payment/charge.ts, payment/refund.ts' + c.r, '',
  c.b + t('• 리뷰 요약', '• Review summary') + c.r,
  '  1. ' + c.yellow + 'charge.ts:42' + c.r + t(' 재시도 시 멱등 키가 갱신됨', ' idempotency key is regenerated on retry'),
  '  2. ' + c.yellow + 'refund.ts:17' + c.r + t(' 부분 환불 합계 검증 누락', ' partial refund total is not validated'), '',
  c.b + '• Ran' + c.r + ' npm run test:payment', '',
  ...box(c.yellow, [
    c.b + t(' 명령 실행 허가가 필요합니다', ' Permission needed to run a command') + c.r,
    '  npm run test:payment -- --coverage',
    '  ' + c.green + '❯ 1. Yes' + c.r + '   2. Yes, always   3. No'], 44));

const s4Scroll = nl(
  c.orange + '✻' + c.r + ' Claude Code ' + c.gray + '· api-server' + c.r, '',
  c.gray + '> ' + c.r + t('users 테이블에 last_login_at 컬럼 추가하는 마이그레이션', 'Add a migration for a last_login_at column on users'), '',
  c.green + '●' + c.r + ' Write(' + c.dim + 'db/migrations/0042_last_login.sql' + c.r + ')',
  c.gray + '  ⎿  Wrote 9 lines' + c.r, '',
  c.green + '●' + c.r + ' Bash(' + c.dim + 'npm run db:migrate' + c.r + ')',
  c.gray + '  ⎿  Applying 0042_last_login ...' + c.r, '',
  c.orange + '✻ Migrating…' + c.r + c.gray + ' (12s · esc to interrupt)' + c.r);

const s5Scroll = nl(c.gray + '~/projects/api-server' + c.r + ' ' + c.green + '$' + c.r + ' ');
const s6Scroll = nl(
  c.orange + '✻' + c.r + ' Claude Code ' + c.gray + '· mobile-app' + c.r, '',
  c.gray + '> ' + c.r + t('푸시 알림 권한 요청 화면 추가', 'Add a push notification permission screen'), '',
  c.green + '●' + c.r + ' Update(' + c.dim + 'ios/Runner/Info.plist' + c.r + ')', '',
  ...box(c.yellow, [
    t(' 이 파일을 수정할까요?', ' Do you want to edit this file?'),
    '  ' + c.green + '❯ 1. Yes' + c.r + '   2. Yes, allow all   3. No'], 44));
const s7Scroll = nl(
  c.orange + '✻' + c.r + ' Claude Code ' + c.gray + '· docs-site' + c.r, '',
  c.gray + '> ' + c.r + t('설치 가이드 목차 정리해줘', 'Reorganize the install guide table of contents'), '',
  c.green + '●' + c.r + t(' 설치 가이드 3개 문서를 재구성했습니다.', ' Restructured the 3 install guide documents.'), '',
  c.gray + '> ' + c.r);
const s8Scroll = nl(
  c.orange + '✻' + c.r + ' Claude Code ' + c.gray + '· web-app · checkout' + c.r, '',
  c.gray + '> ' + c.r + t('결제 확인 화면에 쿠폰 입력 추가', 'Add coupon input to the checkout confirmation screen'), '',
  c.green + '●' + c.r + ' Read(' + c.dim + 'src/pages/Checkout.tsx' + c.r + ')',
  c.gray + '  ⎿  Read 132 lines' + c.r, '',
  c.orange + '✻ Thinking…' + c.r + c.gray + ' (6s · esc to interrupt)' + c.r);

const scroll = { s1: s1Scroll, s2: s2Scroll, s3: s3Scroll, s4: s4Scroll, s5: s5Scroll, s6: s6Scroll, s7: s7Scroll, s8: s8Scroll };

const now = Date.now();
const usage = {
  codex: { windows: [{ windowMinutes: 300, usedPercent: 28, resetsAt: now / 1000 + 9000 }, { windowMinutes: 10080, usedPercent: 41, resetsAt: now / 1000 + 300000 }], plan: 'plus', mtimeMs: now },
  claude: { windows: [{ windowMinutes: 300, usedPercent: 46, resetsAt: now / 1000 + 7200 }, { windowMinutes: 10080, usedPercent: 63, resetsAt: now / 1000 + 250000 }], plan: 'max', mtimeMs: now },
  antigravity: { windows: [{ windowMinutes: 300, usedPercent: 12, resetsAt: now / 1000 + 5000 }, { windowMinutes: 10080, usedPercent: 22, resetsAt: now / 1000 + 400000 }], plan: 'pro', mtimeMs: now, groups: [] }
};

const orphans = [
  { pgid: 41021, pids: [41021, 41030], command: 'npm run dev', cwd: projects[0].path, projectId: 'p1', startedAt: '1700000000', ports: [5173], fromApp: true, liveTab: false, sessionId: null, cpu: 3.2, rssKb: 412000 },
  { pgid: 41377, pids: [41377], command: 'node server.js', cwd: projects[1].path, projectId: 'p2', startedAt: '1700000100', ports: [3000], fromApp: true, liveTab: false, sessionId: null, cpu: 0.4, rssKb: 186000 },
  { pgid: 42010, pids: [42010], command: 'storybook dev -p 6006', cwd: projects[0].path, projectId: 'p1', startedAt: '1700000200', ports: [6006], fromApp: true, liveTab: true, sessionId: 's2', cpu: 1.1, rssKb: 530000 }
];

return { lang, repo, c, nl, box, projects, presets, sessions, branches, remote, scroll, s1Live, usage, orphans };
};
