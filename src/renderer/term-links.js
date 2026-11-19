// 터미널 링크·복사의 순수 규칙 (DOM·xterm 비의존 — Node 테스트에서 그대로 불러 쓴다).
//
// TUI 줄바꿈 실측 (70열):
//  - Claude Code: 폭 끝에서 토큰 중간을 자르고 다음 줄을 2칸 들여쓴다. 단어 경계에서
//    끊을 땐 줄 끝에 공백 셀을 남긴다 ("--verbose " / "  --log-file").
//  - Codex: '-'·'/' 뒤나 공백에서 끊고 줄 끝 공백을 남기지 않는다 ("5a15-" / "  4d1e").
// 그래서 줄을 이을 때의 구분자는 ①줄 끝 공백 셀 → 공백 ②폭 끝까지 찬 줄 → 없음
// ③'-'·'/'·'\' 로 끝남 → 없음 ④그 외 → 공백.
const TermLinks = {
  joinSep(prevText, trailingSpace, lastCol, cols) {
    if (trailingSpace) return ' ';
    if (lastCol >= cols - 1) return '';
    if (/[-/\\]$/.test(prevText)) return '';
    return ' ';
  },

  // rows: 선택 영역의 물리 행 [{ body, raw, wrapped, trailingSpace, lastCol }]
  //  body = 오른쪽 공백을 뺀 텍스트, raw = 공백 포함 원문, wrapped = xterm 자체 줄바꿈의 연속 행
  // TUI 가 끊어 놓은 긴 명령을 한 줄로 되돌린다. 셸 줄 잇기('\')는 공백 하나로 바꾼다.
  joinCommandRows(rows, cols) {
    let out = '';
    let prev = null;
    rows.forEach((r, i) => {
      const next = rows[i + 1];
      let piece = next && next.wrapped ? r.raw : r.body;
      piece = piece.replace(/\s*[│┃]\s*$/, '');
      if (i === 0) {
        piece = piece.replace(/^\s*(?:[│┃]\s*)?(?:[⏺●•]\s+)?/, '');
        out = piece;
      } else if (r.wrapped) {
        out += piece;
      } else {
        piece = piece.replace(/^\s*(?:[│┃]\s*)?/, '');
        if (piece) {
          out = out.replace(/\s+$/, '');
          let sep;
          if (/(^|\s)\\$/.test(out)) {
            out = out.replace(/\s*\\$/, '');
            sep = ' ';
          } else {
            sep = out ? this.joinSep(out, prev.trailingSpace, prev.lastCol, cols) : '';
          }
          out += sep + piece;
        }
      }
      prev = r;
    });
    return out.trim();
  },

  // 경로 꼬리의 :줄(:열) 분리
  splitLineSuffix(s) {
    const m = String(s).match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
    return { path: m[1], line: m[2] ? Number(m[2]) : 0 };
  },

  // 스킴 없이 쓴 웹 주소 (github.com/owner/repo, www.example.com) — 파일로 해석되지 않을 때만 쓴다
  WEB_HOST_RE: /^(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|kr|me|gg|so|sh|xyz|edu|gov|info|tv)(?:\/[^\s]*)?$/i,
  // GitHub owner/repo 축약형 — 화면에 GitHub 언급이 있을 때만 링크로 본다 ("SSN/ITIN" 류 오탐 방지)
  GITHUB_REPO_RE: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,

  webUrlFor(path, githubContext) {
    if (this.WEB_HOST_RE.test(path) && (/\//.test(path) || /^www\./i.test(path))) {
      return 'https://' + path.replace(/[)\]]+$/, '');
    }
    if (githubContext && this.GITHUB_REPO_RE.test(path) && !/^[A-Z]{1,6}\/[A-Z]{1,6}$/.test(path) && !/\.(?:md|js|ts|json|py|rs|go|cs|txt|ya?ml|toml|lock|sh)$/i.test(path)) {
      return 'https://github.com/' + path.replace(/\.git$/, '');
    }
    return null;
  },

  // text 에서 링크 후보를 뽑는다. fileRe·tailRe 는 terminal-view.js 의 FILE_LINK_RE·FILE_LINK_TAIL_RE.
  // 절대경로·~ 경로는 뒤따르는 공백 단어를 붙인 후보도 낸다 ("~/Library/Application Support/…").
  candidates(text, fileRe, tailRe) {
    const out = [];
    const clean = (s) => s.replace(/[.,;'"”’)\]]+$/, '').replace(tailRe, '$1');
    fileRe.lastIndex = 0;
    let m;
    while ((m = fileRe.exec(text))) {
      const matched = clean(m[0]);
      if (matched.length < 3 || !/\p{L}/u.test(matched)) continue;
      // 직전에 공백 없이 URL 스킴(://)이 이어지면 URL 의 일부 — URL 처리에 맡긴다
      const before = text.slice(Math.max(0, m.index - 64), m.index) + (/^[\\/]/.test(matched) ? matched[0] : '');
      if (/[A-Za-z][\w+.-]*:\/\/\S*$/.test(before)) continue;
      const start = m.index;
      out.push(Object.assign({ start, end: start + matched.length - 1 }, this.splitLineSuffix(matched)));
      if (!/^(?:~|[A-Za-z]:[\\/]|[\\/])/.test(matched) || /:\d+$/.test(matched)) continue;
      let pos = start + m[0].length;
      let ext = m[0];
      for (let k = 0; k < 4; k++) {
        const w = text.slice(pos).match(/^ ([^\s`'"()<>[\]{}|,;]+)/);
        if (!w) break;
        ext += w[0];
        pos += w[0].length;
        const s = clean(ext);
        out.push(Object.assign({ start, end: start + s.length - 1 }, this.splitLineSuffix(s)));
      }
    }
    return out;
  },

  // TUI 가 끊은 긴 URL — 한 행 안의 URL 은 WebLinksAddon 이 처리하므로 여러 행에 걸친 것만
  urls(text, rowOf) {
    const out = [];
    const re = /https?:\/\/[^\s<>"'`]+/g;
    let m;
    while ((m = re.exec(text))) {
      const url = m[0].replace(/[.,;:!?)\]'"”’]+$/, '');
      const end = m.index + url.length - 1;
      if (rowOf(m.index) !== rowOf(end)) out.push({ start: m.index, end, url });
    }
    return out;
  },

  // 겹치는 후보 중 긴 것 우선으로 고른다
  pickNonOverlapping(items) {
    const chosen = [];
    for (const it of items.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
      if (chosen.some((c) => !(it.end < c.start || it.start > c.end))) continue;
      chosen.push(it);
    }
    return chosen.sort((a, b) => a.start - b.start);
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = TermLinks;
