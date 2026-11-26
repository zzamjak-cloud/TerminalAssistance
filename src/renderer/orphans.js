// 남은 백그라운드 프로세스 — 탭이 닫히거나 앱이 재시작된 뒤에도 살아 있는 서버·감시 루프를
// 사이드바 배지로 알리고 목록에서 종료할 수 있게 한다. 판별은 백엔드(orphans.rs), Windows 는 늘 빈 목록.
const ORPHAN_FIRST_SCAN_MS = 5000;
const ORPHAN_RESCAN_MS = 5 * 60 * 1000;

function orphanMemKb(list) {
  return (list || []).reduce((sum, o) => sum + (o.rssKb || 0), 0);
}

// KB → 사람이 읽는 크기 (340MB, 1.2GB)
function formatMemKb(kb) {
  const mb = (kb || 0) / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.max(0, Math.round(mb))}MB`;
}

Object.assign(App, {
  _orphans: [],

  initOrphans() {
    const badge = document.getElementById('orphan-badge');
    if (badge) badge.onclick = () => App.showOrphansModal();
    // 비정상 종료 뒤에는 지난 실행의 서버가 그대로 남아 있을 가능성이 커 바로 확인한다
    setTimeout(async () => {
      await App.scanOrphans();
      const left = App._leftoverOrphans();
      if (left.length) {
        App.showToastWhenFree(tr("이전 작업에서 남은 백그라운드 프로세스 {n}개 · 약 {mem} 사용 중 — 사이드바 아래 '백그라운드'에서 확인할 수 있습니다", { n: left.length, mem: formatMemKb(orphanMemKb(left)) }), 9000);
      }
    }, App._crashed ? 0 : ORPHAN_FIRST_SCAN_MS);
    setInterval(() => { void App.scanOrphans(); }, ORPHAN_RESCAN_MS);
  },

  _orphanScanSeq: 0,

  async scanOrphans() {
    // 겹친 조회가 늦게 돌아와 최신 목록을 옛 목록으로 덮지 않도록 마지막 요청만 반영한다
    const seq = ++App._orphanScanSeq;
    let list;
    try { list = (await ta.listOrphans()) || []; }
    catch (_) { list = []; }
    if (seq !== App._orphanScanSeq) return App._orphans;
    App._orphans = list;
    App.renderOrphanBadge();
    if (App._dashOpen) App.renderDashboardOrphans();
    return App._orphans;
  },

  // 닫힌 탭·이전 실행이 남긴 것만 '남은 프로세스' — 열린 탭이 띄운 백그라운드 작업은 따로 보여 준다
  _leftoverOrphans() {
    return App._orphans.filter((o) => !o.liveTab);
  },

  renderOrphanBadge() {
    const el = document.getElementById('orphan-badge');
    if (!el) return;
    const n = App._leftoverOrphans().length;
    el.classList.toggle('hidden', n === 0);
    el.textContent = tr('백그라운드 {n}', { n });
    el.title = tr('닫힌 탭·이전 실행에서 남은 백그라운드 프로세스 {n}개 · 약 {mem} 사용 중 — 클릭해 확인·종료', { n, mem: formatMemKb(orphanMemKb(App._leftoverOrphans())) });
  },

  // 실행 경과(초)로 시작 시각을 계산한다 — ps 의 lstart 문자열은 웹뷰마다 해석이 다르다
  _orphanStarted(o) {
    if (Number.isFinite(o.elapsedSec)) return formatRelativeTime(Date.now() - o.elapsedSec * 1000);
    return String(o.startedAt || '');
  },

  _orphanRowHtml(o) {
    const p = App.state.projects.find((x) => x.id === o.projectId);
    const where = o.projectId ? (p ? p.name : tr('프로젝트 밖')) : (o.cwd || tr('경로 모름'));
    const tab = o.liveTab ? App.state.sessions.find((x) => x.id === o.sessionId) : null;
    return `
      <div class="orphan-row" data-pgid="${o.pgid}">
        <div class="orphan-main">
          <div class="orphan-cmd" title="${escapeHtml(o.command)}">${escapeHtml(o.command)}</div>
          <div class="orphan-meta">
            ${escapeHtml(where)}
            · CPU ${escapeHtml(String(Math.round(o.cpu || 0)))}% · ${escapeHtml(formatMemKb(o.rssKb || 0))}
            · ${tr('{time} 시작', { time: escapeHtml(App._orphanStarted(o)) })}
            ${o.ports.length ? ` · ${tr('포트 {ports}', { ports: o.ports.map((x) => escapeHtml(String(x))).join(', ') })}` : ''}
            ${o.pids.length > 1 ? ` · ${tr('프로세스 {n}개', { n: o.pids.length })}` : ''}
            ${tab ? ` · ${tr('탭 {title}', { title: escapeHtml(tab.title) })}` : (o.fromApp ? ' · ' + tr('앱 세션에서 실행') : '')}
          </div>
        </div>
        <button class="orphan-kill danger">${tr('종료', null, 'kill')}</button>
      </div>`;
  },

  async showOrphansModal() {
    await App.scanOrphans();
    const leftovers = App._leftoverOrphans();
    const liveOnes = App._orphans.filter((o) => o.liveTab);
    const liveSection = liveOnes.length
      ? `<div class="orphan-group">${tr('열린 탭 소속 ({n}) — 탭에서 띄운 백그라운드 작업입니다', { n: liveOnes.length })}</div>${liveOnes.map((o) => App._orphanRowHtml(o)).join('')}`
      : '';
    App.modal(`
      <h3>${tr('남은 백그라운드 프로세스')}</h3>
      <p style="color:var(--fg-dim);line-height:1.6">${tr('닫힌 탭이나 이전 실행에서 에이전트가 띄운 뒤 남은 프로세스입니다.')}</p>
      <div class="orphan-list">
        ${leftovers.map((o) => App._orphanRowHtml(o)).join('') || '<div class="prompt-empty">' + tr('남은 백그라운드 프로세스가 없습니다.') + '</div>'}
        ${liveSection}
      </div>
      <div class="modal-actions">
        <button id="m-cancel">${tr('닫기')}</button>
        ${leftovers.length > 1 ? '<button id="m-kill-all" class="danger">' + tr('남은 프로세스 모두 종료') + '</button>' : ''}
      </div>`,
      (m, close) => {
        m.querySelector('#m-cancel').onclick = close;
        for (const row of m.querySelectorAll('.orphan-row')) {
          const btn = row.querySelector('.orphan-kill');
          btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = tr('종료 중…', null, 'kill');
            try {
              await ta.killOrphan(Number(row.dataset.pgid));
              row.remove();
            } catch (e) {
              btn.disabled = false;
              btn.textContent = tr('종료', null, 'kill');
              App.showToast(tr('종료하지 못했습니다: {e}', { e }));
            }
            await App.scanOrphans();
          };
        }
        const all = m.querySelector('#m-kill-all');
        if (all) all.onclick = async () => {
          all.disabled = true;
          all.textContent = tr('종료 중…', null, 'kill');
          let results = [];
          try { results = await ta.killOrphans(leftovers.map((o) => o.pgid)); }
          catch (e) { App.showToast(tr('종료하지 못했습니다: {e}', { e })); }
          // 실제로 종료된 항목만 목록에서 걷는다
          const failed = [];
          for (const r of results) {
            const row = m.querySelector(`.orphan-row[data-pgid="${Number(r.pgid)}"]`);
            if (r.ok) { if (row) row.remove(); } else failed.push(r.error || String(r.pgid));
          }
          await App.scanOrphans();
          if (failed.length) {
            all.disabled = false;
            all.textContent = tr('남은 프로세스 모두 종료');
            App.showToast(tr('{n}개를 종료하지 못했습니다 — {first}', { n: failed.length, first: failed[0] }), 9000);
          } else {
            close();
          }
        };
      }, { wide: true });
  }
});
