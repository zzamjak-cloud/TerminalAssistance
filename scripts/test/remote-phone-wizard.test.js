// 📱 단계별 마법사 — modals.js 의 단계 판정·폴링 정지, remote-core.js 의 상시 VPN 안내.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src');
const desk = { App: {}, console, document: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(desk);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'modals.js'), 'utf8')
  + ';globalThis.__d = { phoneWizardPlan, phoneWizardShouldPoll, phoneWizardBodyKey, tailscaleDownloadUrl, phoneSummaryLine };', desk);
const d = desk.__d;

const mob = { console };
vm.createContext(mob);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'mobile', 'remote-core.js'), 'utf8')
  + ';globalThis.__r = { shouldShowVpnTips, vpnTipSteps };', mob);
const r = mob.__r;

const base = { macTailscale: 'running', httpsAvailable: true, phones: [{ os: 'android', online: true }], pairedDevices: 1, pushConfigured: true };

exports.name = '📱 연결 마법사 (단계 판정 · 폴링 · 상시 VPN 안내)';

exports.run = function (t) {
  const plan = (st, f) => d.phoneWizardPlan(Object.assign({}, base, st), f || {});
  t.check('PC Tailscale 꺼짐 → 1단계', plan({ macTailscale: 'stopped' }).current === 'mac');
  t.check('미설치도 1단계', plan({ macTailscale: 'missing' }).current === 'mac');
  t.check('폰 피어 없음 → 2단계', plan({ phones: [] }).current === 'phone');
  const off = plan({ phones: [{ os: 'android', online: false }] });
  t.check('폰 오프라인 → 2단계 완료 + 상시 VPN 안내', off.steps[1].done && /상시 VPN/.test(off.steps[1].note || ''));
  t.check('iOS 오프라인 → On Demand 안내', /On Demand/.test(plan({ phones: [{ os: 'iOS', online: false }] }).steps[1].note));
  t.check('HTTPS 미가용 → 3단계', plan({ httpsAvailable: false }).current === 'https');
  t.check('HTTPS 건너뛰기 → 다음 단계', plan({ httpsAvailable: false, pairedDevices: 0 }, { httpsSkipped: true }).current === 'pair');
  t.check('페어링 없음 → 4단계', plan({ pairedDevices: 0 }).current === 'pair');
  t.check('알림 미설정 → 마무리', plan({ pushConfigured: false }).current === 'finish');
  t.check('마무리 완료 표시로 끝', plan({ pushConfigured: false }, { finished: true }).allDone);
  t.check('모두 완료 → 요약', plan({}).allDone && plan({}).current === null);
  t.check('앞 단계가 우선', plan({ macTailscale: 'needs-login', phones: [], pairedDevices: 0 }).current === 'mac');

  t.check('폴링: 현재 마법사·연결됨·열림', d.phoneWizardShouldPoll(true, true, false));
  t.check('폴링 정지: 모달 닫힘', !d.phoneWizardShouldPoll(true, true, true));
  t.check('폴링 정지: 다른 마법사로 교체', !d.phoneWizardShouldPoll(false, true, false));
  t.check('폴링 정지: DOM 분리', !d.phoneWizardShouldPoll(true, false, false));

  const key = (st, f) => d.phoneWizardBodyKey(plan(st, f), Object.assign({}, base, st));
  const k1 = key({ pairedDevices: 0 });
  t.check('같은 상태면 같은 키(QR 유지)', k1 === key({ pairedDevices: 0 }));
  t.check('페어링 중 폰 오프라인 안내가 생겨도 본문 유지', k1 === key({ pairedDevices: 0, phones: [{ os: 'android', online: false }] }));
  t.check('페어링 중 HTTPS 상태가 바뀌어도 본문 유지', k1 === key({ pairedDevices: 0, httpsAvailable: false }, { httpsSkipped: true }));
  t.check('단계 변하면 키 변경', k1 !== key({}));
  t.check('PC 단계: missing→stopped 는 본문 변경', key({ macTailscale: 'missing' }) !== key({ macTailscale: 'stopped' }));
  t.check('재페어링 필요 안내', /다시 페어링/.test(plan({ pairedDevices: 0, staleDevices: 2 }).steps[3].note || ''));
  t.check('OS 별 다운로드', d.tailscaleDownloadUrl('macos').endsWith('/mac') && d.tailscaleDownloadUrl('windows').endsWith('/windows'));
  t.check('요약 줄', /폰 1대/.test(d.phoneSummaryLine(base, { mode: 'https', running: true })));

  t.check('VPN 안내: 폰만', r.shouldShowVpnTips('android', false) && r.shouldShowVpnTips('ios', false) && !r.shouldShowVpnTips('other', false));
  t.check('VPN 안내: 다시 보지 않기', !r.shouldShowVpnTips('android', true));
  const a = JSON.stringify(r.vpnTipSteps('android'));
  t.check('Android: 상시 VPN·배터리 제한 없음', /상시 VPN/.test(a) && /제한 없음/.test(a));
  t.check('iOS: VPN On Demand', /On Demand/.test(JSON.stringify(r.vpnTipSteps('ios'))));
  t.check('Android: 삼성 월렛 분할 터널링 안내', /split tunneling/.test(a) && /삼성 월렛/.test(a) && !/split tunneling/.test(JSON.stringify(r.vpnTipSteps('ios'))));
};
