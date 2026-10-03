// 📱 원클릭 폰 연결 — modals.js 의 auto 바인드 등급·'연결됨' 판정을 vm 에서 검증한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'modals.js');
const sandbox = { App: {}, console, document: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__s = { remoteBindLevel, needsRemoteBindConfirm, remotePhoneBaseline, remotePhoneConnected, remoteDevicesKey };', sandbox);
const { remoteBindLevel, needsRemoteBindConfirm, remotePhoneBaseline, remotePhoneConnected, remoteDevicesKey } = sandbox.__s;

exports.name = '원클릭 폰 연결 (auto 바인드 · 연결됨 판정)';

exports.run = function (t) {
  t.check('auto → tailscale 등급', remoteBindLevel('auto') === 'tailscale' && remoteBindLevel(' AUTO ') === 'tailscale');
  const off = { enabled: false, bind: '127.0.0.1', port: 7788 };
  t.check('auto 로 켜도 2차 확인 없음', !needsRemoteBindConfirm(off, { enabled: true, bind: 'auto', port: 7788 }));

  const v0 = { devices: [{ id: 'a' }], connectedDevices: 0 };
  const base = remotePhoneBaseline(v0);
  t.check('변화 없으면 미연결', !remotePhoneConnected(base, v0));
  t.check('새 기기 페어링 → 연결됨', remotePhoneConnected(base, { devices: [{ id: 'a' }, { id: 'b' }], connectedDevices: 0 }));
  t.check('기존 기기 재접속은 연결됨 아님', !remotePhoneConnected(base, { devices: [{ id: 'a' }], connectedDevices: 1 }));
  t.check('기기 폐기만으로는 연결됨 아님', !remotePhoneConnected(base, { devices: [], connectedDevices: 0 }));
  t.check('baseline 없으면 false', !remotePhoneConnected(null, v0));

  const k1 = remoteDevicesKey([{ id: 'a', lastSeenMs: 1 }]);
  t.check('목록 키: 연결 수만 바뀌면 동일', k1 === remoteDevicesKey([{ id: 'a', lastSeenMs: 1 }]));
  t.check('목록 키: lastSeen 변화 감지', k1 !== remoteDevicesKey([{ id: 'a', lastSeenMs: 2 }]));
  t.check('목록 키: 기기 추가 감지', k1 !== remoteDevicesKey([{ id: 'a', lastSeenMs: 1 }, { id: 'b' }]));
};
