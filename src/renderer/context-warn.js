// 세션 컨텍스트 경고 — 에이전트가 응답을 마쳤을 때 대화가 길면 터미널 하단에 배너로 알린다.
// 알리기만 한다: /clear·/new 를 PTY 로 보내지 않는다 (주제 전환 여부는 사용자가 판단).

const CTX_POLL_MS = 8000;           // 배너가 떠 있는 동안 재조회 주기 — /clear·/new 후 자동으로 걷히게
const CTX_CLAUDE_REARM_TOKENS = 100000; // 닫은 뒤 이만큼 더 늘면 다시 띄운다
const CTX_CODEX_REARM_RATIO = 0.10;     // Codex 는 창 대비 비율로 재표시

// 표시 여부 판정 (순수 함수). reset=true 면 호출부가 닫기 기록을 지운다.
// dismiss: { convId, dismissedAt } | null
function contextWarnDecision(usage, settings, dismiss) {
  if (!usage) return { show: false, reset: false };
  const st = settings || {};
  let limit = 0;
  if (usage.agent === 'claude') {
    limit = (Number(st.contextWarnClaudeK) || 0) * 1000;
  } else if (usage.agent === 'codex' && usage.window) {
    limit = usage.window * (Number(st.contextWarnCodexPct) || 0) / 100;
  }
  if (limit <= 0 || usage.tokens < limit) return { show: false, reset: true };
  if (!dismiss) return { show: true, reset: false };
  if (dismiss.convId !== usage.convId) return { show: true, reset: true };
  const step = usage.agent === 'codex' ? usage.window * CTX_CODEX_REARM_RATIO : CTX_CLAUDE_REARM_TOKENS;
  if (usage.tokens >= dismiss.dismissedAt + step) return { show: true, reset: true };
  return { show: false, reset: false };
}

Object.assign(App, {
  _ctxBanners: new Map(),  // sessionId → { bar, text, timer }
  _ctxDismiss: new Map(),  // sessionId → { convId, dismissedAt }

  async checkContextWarn(sessionId) {
    let usage = null;
    try { usage = await ta.contextUsage(sessionId); } catch (_) { usage = null; }
    // 조회 중 새 턴이 시작됐거나 세션이 닫혔으면 낡은 결과다
    const s = App.state.sessions.find((x) => x.id === sessionId);
    if (!s || (s.status !== 'done' && s.status !== 'idle')) return;
    const d = contextWarnDecision(usage, App.state.settings, App._ctxDismiss.get(sessionId) || null);
    if (d.reset) App._ctxDismiss.delete(sessionId);
    if (d.show) App.showContextBanner(sessionId, usage);
    else App.hideContextBanner(sessionId);
  },

  showContextBanner(sessionId, usage) {
    const view = TerminalView.views.get(sessionId);
    if (!view || !view.holder) return;
    const k = Math.round(usage.tokens / 1000) + 'K';
    const msg = usage.agent === 'codex'
      ? tr('컨텍스트 {k} ({pct}%) · 토큰 절약을 위해 주제가 바뀌었다면 /new 해주세요.', { k, pct: Math.round(usage.tokens / usage.window * 100) })
      : tr('컨텍스트 {k} · 토큰 절약을 위해 주제가 바뀌었다면 /clear 해주세요.', { k });
    let b = App._ctxBanners.get(sessionId);
    if (!b) {
      const bar = document.createElement('div');
      bar.className = 'resume-banner ctx-warn';
      const body = document.createElement('div');
      body.className = 'rb-body';
      const text = document.createElement('div');
      text.className = 'rb-last';
      body.append(text);
      const close = document.createElement('button');
      close.className = 'rb-close';
      close.textContent = '✕';
      close.title = tr('닫기');
      close.onclick = () => {
        const cur = App._ctxBanners.get(sessionId);
        if (cur) App._ctxDismiss.set(sessionId, { convId: cur.convId, dismissedAt: cur.tokens });
        App.hideContextBanner(sessionId);
      };
      bar.append(body, close);
      view.holder.appendChild(bar);
      b = { bar, text, timer: setInterval(() => void App.checkContextWarn(sessionId), CTX_POLL_MS) };
      App._ctxBanners.set(sessionId, b);
    }
    b.convId = usage.convId;
    b.tokens = usage.tokens;
    b.text.textContent = '⚠ ' + msg;
    b.text.title = msg;
  },

  // 닫기 기록(_ctxDismiss)은 유지한다 — 같은 대화에서 곧바로 다시 뜨지 않게
  hideContextBanner(sessionId) {
    const b = App._ctxBanners.get(sessionId);
    if (!b) return;
    clearInterval(b.timer);
    b.bar.remove();
    App._ctxBanners.delete(sessionId);
  },

  disposeContextWarn(sessionId) {
    App.hideContextBanner(sessionId);
    App._ctxDismiss.delete(sessionId);
  }
});
