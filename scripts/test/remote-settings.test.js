// 데스크톱 설정의 원격 바인드 확인 — modals.js 를 vm 에 올려 분류·확인 조건을 검증한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'modals.js');
const sandbox = { App: {}, console, document: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__s = { remoteBindLevel, needsRemoteBindConfirm, remoteBindConfirmText };', sandbox);
const { remoteBindLevel, needsRemoteBindConfirm, remoteBindConfirmText } = sandbox.__s;

exports.name = '원격 설정 바인드 확인 (bindLevel · 2차 확인)';

exports.run = function (t) {
  const cases = {
    '127.0.0.1': 'loopback', localhost: 'loopback', '::1': 'loopback', '127.5.0.1': 'loopback',
    '100.64.0.1': 'tailscale', '100.127.255.254': 'tailscale', '100.128.0.1': 'public', '100.63.0.1': 'public',
    '10.1.2.3': 'lan', '172.16.0.1': 'lan', '172.31.9.9': 'lan', '172.32.0.1': 'public', '192.168.0.5': 'lan',
    '169.254.1.1': 'lan', 'fd12::1': 'lan', 'fe80::1': 'lan',
    '0.0.0.0': 'public', '::': 'public', '8.8.8.8': 'public', '2001:db8::1': 'public',
    '999.1.1.1': null, 'abc': null
  };
  for (const [bind, level] of Object.entries(cases)) {
    t.check(`${bind} → ${level}`, remoteBindLevel(bind) === level, remoteBindLevel(bind));
  }

  const off = { enabled: false, bind: '127.0.0.1', port: 7788 };
  t.check('LAN 으로 새로 켜면 확인', needsRemoteBindConfirm(off, { enabled: true, bind: '192.168.0.5', port: 7788 }));
  t.check('0.0.0.0 으로 켜면 확인', needsRemoteBindConfirm(off, { enabled: true, bind: '0.0.0.0', port: 7788 }));
  t.check('루프백·Tailscale 은 묻지 않는다',
    !needsRemoteBindConfirm(off, { enabled: true, bind: '127.0.0.1', port: 7788 })
    && !needsRemoteBindConfirm(off, { enabled: true, bind: '100.100.1.2', port: 7788 }));
  t.check('끄는 적용은 묻지 않는다', !needsRemoteBindConfirm(off, { enabled: false, bind: '0.0.0.0', port: 7788 }));
  const lanOn = { enabled: true, bind: '192.168.0.5', port: 7788 };
  t.check('이미 그 주소로 켜져 있으면(푸시만 변경) 묻지 않는다',
    !needsRemoteBindConfirm(lanOn, { enabled: true, bind: '192.168.0.5', port: 7788 }));
  t.check('포트가 바뀌면 다시 묻는다', needsRemoteBindConfirm(lanOn, { enabled: true, bind: '192.168.0.5', port: 7789 }));

  const text = remoteBindConfirmText('lan');
  t.check('확인 문구: 평문 HTTP 토큰 노출 + Tailscale 권장', /HTTP/.test(text) && /토큰/.test(text) && /Tailscale/.test(text));
};
