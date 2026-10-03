// HTTPS 안내·폰에서 열기·연결 진단 — 모바일 remote-core.js 와 데스크톱 modals.js 의 순수 판정.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'src');
const mob = { console };
vm.createContext(mob);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'mobile', 'remote-core.js'), 'utf8')
  + ';globalThis.__r = { sessionFromHash, stripSessionHash, bootRoute, offlineRetryDelay, pairCodeFromHash };', mob);
const r = mob.__r;

const desk = { App: {}, console, document: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(desk);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'modals.js'), 'utf8')
  + ';globalThis.__d = { remoteHttpsAdvice, remoteDeviceStatus, remoteOfflineHelp, remoteOpenOnPhoneError, remoteDevicesKey };', desk);
const d = desk.__d;

exports.name = 'HTTPS 안내 · 폰에서 열기 · 연결 진단';

exports.run = function (t) {
  // ── #session 해시 ──
  t.check('#session=id', r.sessionFromHash('#session=s_1-a') === 's_1-a');
  t.check('pair 와 공존', r.sessionFromHash('#pair=ABCD&session=x1') === 'x1' && r.pairCodeFromHash('#pair=ABCD&session=x1') === 'ABCD');
  t.check('위험 문자 거부', r.sessionFromHash('#session=a/b') === null && r.sessionFromHash('') === null);
  t.check('session 만 제거', r.stripSessionHash('#pair=ABCD&session=x1') === '#pair=ABCD' && r.stripSessionHash('#session=x1') === '');

  // ── 부팅 분기 · 오프라인 재시도 ──
  t.check('네트워크 실패 → offline', r.bootRoute(null, true, null) === 'offline' && r.bootRoute(null, true, 'ABC') === 'offline');
  t.check('인증됨 → start', r.bootRoute({ deviceId: 'd' }, false, null) === 'start');
  t.check('미인증·코드 → pair', r.bootRoute(null, false, null) === 'pair' && r.bootRoute({ deviceId: 'd' }, false, 'ABC') === 'pair');
  t.check('재시도 백오프 3s→30s', r.offlineRetryDelay(0) === 3000 && r.offlineRetryDelay(1) === 6000 && r.offlineRetryDelay(10) === 30000);

  // ── 📱 모달 분기 ──
  t.check('HTTPS 면 안내 없음', d.remoteHttpsAdvice({ mode: 'https' }) === null);
  t.check('인증서 없음 → 켜기 안내', d.remoteHttpsAdvice({ mode: 'http', httpsAvailable: false }) === 'enable');
  t.check('전환 실패 → 오류 안내', d.remoteHttpsAdvice({ mode: 'http', httpsAvailable: true, httpsError: 'x' }) === 'error');
  t.check('기기 상태 점', d.remoteDeviceStatus({ tailscaleOnline: true }) === 'online'
    && d.remoteDeviceStatus({ tailscaleOnline: false }) === 'offline'
    && d.remoteDeviceStatus({ tailscaleOnline: null }) === 'unknown' && d.remoteDeviceStatus({}) === 'unknown');
  t.check('Android 안내: 상시 VPN·배터리', /상시 VPN/.test(d.remoteOfflineHelp('android')) && /제한 없음/.test(d.remoteOfflineHelp('android')));
  t.check('iOS 안내: VPN On Demand', /On Demand/.test(d.remoteOfflineHelp('ios')));
  t.check('폰에서 열기 오류 분기', d.remoteOpenOnPhoneError('no-push') === 'setup-push'
    && d.remoteOpenOnPhoneError('원격 서버가 실행 중이 아닙니다') === 'start-server'
    && d.remoteOpenOnPhoneError('푸시 전송 실패') === 'other');
  t.check('온라인 변화도 목록 갱신', d.remoteDevicesKey([{ id: 'a', tailscaleOnline: true }]) !== d.remoteDevicesKey([{ id: 'a', tailscaleOnline: false }]));
};
