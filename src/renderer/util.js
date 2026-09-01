// 렌더러 공용 유틸 + 공용 상수
const CONFIRM_ARM_MS = 3000; // 2단계 확인(무장) 유지 시간
const PANEL_ANIM_MS = 230;   // 패널 슬라이딩 종료 후 리핏 지연 — CSS transition(.2s)과 동기
const IMAGE_STRIP_MAX = 12;
const SPLIT_MAX_PANES = 6;   // 분할 패널 최대 개수 (3×2 모드) — 패널 DOM·배열 길이의 기준  // 최근 첨부 이미지 보관·표시 상한

// 2단계 확인 공용 상태: 첫 클릭 = 무장(빨강 확인 표시), CONFIRM_ARM_MS 내 재클릭 = 실행.
// 단일 상태이므로 서로 다른 무장(프리셋 실행·세션 닫기·히스토리 삭제)은 자연히 배타적이다.
const ArmedConfirm = {
  _key: null,
  _timer: null,
  _rerender: null,

  isArmed(key) {
    return this._key !== null && this._key === JSON.stringify(key);
  },

  // key: 문자열 배열 등 JSON 직렬화 가능한 값. rerender: 무장 표시를 반영할 재렌더 함수
  arm(key, rerender) {
    clearTimeout(this._timer);
    const prev = this._rerender;
    this._key = JSON.stringify(key);
    this._rerender = rerender;
    if (prev && prev !== rerender) prev(); // 다른 영역에 남은 무장 UI 해제
    this._timer = setTimeout(() => this.disarm(), CONFIRM_ARM_MS);
    rerender();
  },

  disarm() {
    clearTimeout(this._timer);
    const rerender = this._rerender;
    this._key = null;
    this._rerender = null;
    if (rerender) rerender();
  }
};

// 타임스탬프+난수 기반 로컬 id (수동 계획·초안 등 렌더러 생성 항목용)
function newLocalId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 목록 전반에서 쓰는 상대 시간. 잘못된 값이나 미래 시각은 음수 단위 대신 방금으로 표시한다.
function formatRelativeTime(ms) {
  const timestamp = Number(ms);
  if (!Number.isFinite(timestamp)) return '방금';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60000) return '방금';
  if (elapsed < 3600000) return Math.floor(elapsed / 60000) + '분 전';
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + '시간 전';
  return Math.floor(elapsed / 86400000) + '일 전';
}

// 공백 포함 경로만 따옴표 (Claude Code 가 경로를 이미지 칩으로 인식)
function quotePath(p) {
  return /\s/.test(p) ? '"' + p + '"' : p;
}

// innerHTML 템플릿에 사용자 입력값을 삽입할 때의 이스케이프
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 드롭다운 검색용 느슨한 매칭.
// 검색어를 공백으로 나눈 각 토큰이 후보 문자열들 중 하나에 (a) 부분 문자열로 들어 있거나
// (b) 순서만 유지된 문자 나열(예: "trmasi" → "terminal-assistance")로 들어 있으면 일치로 본다.
// 모든 토큰이 일치해야 한다 — 토큰별로 다른 후보에 걸려도 된다(제목·경로·프로젝트명 혼합 검색).
function fuzzyMatch(candidates, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const fields = (Array.isArray(candidates) ? candidates : [candidates])
    .filter((v) => v != null)
    .map((v) => String(v).toLowerCase());
  if (!fields.length) return false;
  return q.split(/\s+/).every((token) =>
    fields.some((f) => f.includes(token) || isSubsequenceOf(f, token)));
}

// token 의 글자들이 순서를 지켜 text 안에 흩어져 있는가 (연속일 필요 없음)
function isSubsequenceOf(text, token) {
  let i = 0;
  for (let k = 0; k < text.length && i < token.length; k++) {
    if (text[k] === token[i]) i++;
  }
  return i === token.length;
}
