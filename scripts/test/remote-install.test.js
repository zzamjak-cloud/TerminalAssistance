// 모바일 홈 화면 앱화 — remote-core.js 의 standalone 판정·설치 안내 조건·기기 이름 기본값.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'mobile', 'remote-core.js');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8')
  + ';globalThis.__r = { isStandaloneMode, installPlatform, shouldShowInstallSheet, deviceNameFromUA, INSTALL_DISMISS_KEY };',
sandbox);
const r = sandbox.__r;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID_REDUCED = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const ANDROID_MODEL = 'Mozilla/5.0 (Linux; Android 13; SM-S918N Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

exports.name = '모바일 홈 화면 앱화 (standalone · 설치 안내 · 기기 이름)';

exports.run = function (t) {
  t.check('iOS navigator.standalone', r.isStandaloneMode(true, false));
  t.check('display-mode standalone', r.isStandaloneMode(undefined, true));
  t.check('브라우저 탭은 standalone 아님', !r.isStandaloneMode(undefined, false) && !r.isStandaloneMode(false, false));

  t.check('iPhone → ios', r.installPlatform(IPHONE, 5) === 'ios');
  t.check('iPadOS(맥 UA + 터치) → ios', r.installPlatform(IPAD_DESKTOP, 5) === 'ios');
  t.check('진짜 맥 사파리 → other', r.installPlatform(IPAD_DESKTOP, 0) === 'other');
  t.check('Android → android', r.installPlatform(ANDROID_REDUCED, 5) === 'android');

  t.check('브라우저 + 미거절 → 안내', r.shouldShowInstallSheet(false, false));
  t.check('standalone 이면 안내 안 함', !r.shouldShowInstallSheet(true, false));
  t.check('다시 보지 않기 → 안내 안 함', !r.shouldShowInstallSheet(false, true));
  t.check('저장 키 고정', r.INSTALL_DISMISS_KEY === 'ta-remote-install-dismissed');

  t.check('iPhone 기본 이름', r.deviceNameFromUA(IPHONE, 5) === 'iPhone');
  t.check('iPad 기본 이름', r.deviceNameFromUA(IPAD_DESKTOP, 5) === 'iPad');
  t.check('축소 UA(K) → Android', r.deviceNameFromUA(ANDROID_REDUCED, 5) === 'Android', r.deviceNameFromUA(ANDROID_REDUCED, 5));
  t.check('모델명 UA → 모델명', r.deviceNameFromUA(ANDROID_MODEL, 5) === 'SM-S918N', r.deviceNameFromUA(ANDROID_MODEL, 5));
  t.check('그 외 → 모바일 브라우저', r.deviceNameFromUA('', 0) === '모바일 브라우저');
};
