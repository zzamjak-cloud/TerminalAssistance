// 설치본과 분리된 dev 실행 — identifier 를 바꿔 설정 파일·데이터 디렉토리를 따로 쓴다.
// 같은 identifier 로 띄우면 두 앱이 ta-config.json 전체를 서로 덮어써,
// 설치본(구버전)이 모르는 필드(remote 등)가 지워지고 세션 레이아웃이 뒤섞인다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE_ID = require('../src-tauri/tauri.conf.json').identifier;
const DEV_ID = `${BASE_ID}.dev`;

// Tauri app_config_dir 과 같은 규칙
function configDir(id) {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', id);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), id);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), id);
}

// 최초 1회만 설치본 설정을 복사해 프로젝트·프리셋을 이어 쓴다 (원본은 읽기만 한다).
// sessionLayout 은 비운다 — 설치본에서 열린 세션들이 dev 에서 중복으로 열리지 않게.
function seedConfig() {
  const src = path.join(configDir(BASE_ID), 'ta-config.json');
  const dstDir = configDir(DEV_ID);
  const dst = path.join(dstDir, 'ta-config.json');
  if (fs.existsSync(dst)) return;
  if (!fs.existsSync(src)) {
    console.log('dev:isolated: 설치본 설정이 없어 빈 설정으로 시작합니다.');
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    data.sessionLayout = [];
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(dst, JSON.stringify(data, null, 2));
    console.log(`dev:isolated: 설치본 설정을 복사했습니다 → ${dst}`);
  } catch (e) {
    console.warn(`dev:isolated: 설정 복사 실패 (빈 설정으로 시작): ${e.message}`);
  }
}

seedConfig();
console.log(`dev:isolated: identifier=${DEV_ID}`);

const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
// 인라인 JSON 대신 파일 경로를 넘긴다 — Windows cmd 셸이 따옴표를 깨뜨리기 때문
const overridePath = path.join(os.tmpdir(), 'ta-dev-isolated.conf.json');
fs.writeFileSync(overridePath, JSON.stringify({ identifier: DEV_ID }));
const args = ['dev', '--config', overridePath, ...process.argv.slice(2)];
const child = spawn(bin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
