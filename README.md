# Terminal Assistance

AI(Claude Code 등) 시대의 **멀티 프로젝트 터미널 워크스페이스**.
프로젝트를 미리 등록해 두고 클릭 한 번으로 터미널을 전환하며, 각 터미널이 **무슨 작업을 하고 있는지 / 끝났는지**를 한눈에 봅니다.

macOS · Windows 지원 (Tauri 2 — 시스템 WebView 기반이라 Electron 대비 메모리 점유가 낮습니다).

## 주요 기능

- **프로젝트 레지스트리** — 프로젝트(이름·경로·색상)를 등록해 두고 클릭 한 번으로 해당 경로의 터미널 열기/전환. `cd` 반복 끝.
- **멀티 세션 + 상태 시각화** — 세션마다 실시간 상태 표시:
  - 🟢 실행 중 (점멸) / ⚪ 대기 / 🔵 **완료** (배지 + 데스크톱 알림) / 🔴 종료됨
  - 완료 판정: Claude Code 훅이 설치된 세션은 `Stop` 훅 신호만을 완료로 본다 (도구 실행 중 출력 공백을 완료로 오판하지 않는다). 훅이 없는 세션은 3초 이상 돌던 작업이 5초 이상 조용해질 때 완료.
  - 다른 세션을 보고 있어도 백그라운드 작업 완료를 놓치지 않습니다.
- **명령 프리셋** — 자주 쓰는 작업 지시를 전역/프로젝트별로 등록. 클릭=실행, Shift+클릭=입력만, 우클릭=수정.
- **이미지 첨부** — 클립보드 이미지 `Cmd/Ctrl+V` 또는 파일 드래그앤드롭 → PNG 저장 후 경로 자동 입력(Claude Code 가 이미지로 인식). 하단 스트립에서 **어떤 이미지를 전달했는지 썸네일로 확인**, 클릭하면 원본 열기.
- **테마** — 다크/라이트 프리셋 12종 또는 배경색·강조색 직접 지정. 배경 밝기에 따라 글자·상태·프로젝트 색과 코드 하이라이트가 자동 보정됩니다.
- **자동 업데이트** — 새 버전이 릴리즈되면 앱이 알려주고 클릭 한 번으로 업데이트.

## 설치

[Releases](https://github.com/zzamjak-cloud/TerminalAssistance/releases/latest) 에서 다운로드:

| OS | 파일 |
|---|---|
| macOS (Intel/Apple Silicon 공용) | `Terminal.Assistance_x.y.z_universal.dmg` |
| Windows | `Terminal.Assistance_x.y.z_x64-setup.exe` |

> macOS 에서 "확인되지 않은 개발자" 경고가 뜨면: 우클릭 → 열기.
> Windows SmartScreen 경고가 뜨면: 추가 정보 → 실행.

## 사용법

1. **프로젝트 등록**: 좌측 하단 `+ 프로젝트 등록` → 폴더 선택. 
2. **터미널 열기/전환**: 사이드바에서 프로젝트 클릭. 이미 세션이 있으면 전환, 없으면 새로 엽니다.
   - `Cmd/Ctrl+1~9` 세션 전환 · `Cmd/Ctrl+T` 현재 프로젝트에 새 세션
3. **작업 지시 프리셋**: 상단 `+ 프리셋` 으로 등록 → 칩 클릭으로 실행.
4. **이미지 전달**: 화면 캡처 후 터미널에서 `Cmd/Ctrl+V`, 또는 이미지 파일을 창에 드롭.
5. **상태 확인**: 사이드바의 세션 점 색으로 진행/완료 확인. 비활성 세션이 끝나면 알림이 옵니다.

## 소스에서 빌드

요구사항: [Rust](https://rustup.rs), Node.js 20+, (Windows: WebView2 — Win11 기본 내장)

```bash
git clone https://github.com/zzamjak-cloud/TerminalAssistance.git
cd TerminalAssistance
npm install
npm run dev      # 개발 실행
npm run build    # 배포 빌드 (dmg / exe)
```

### macOS: 권한 팝업이 반복되는 경우

서명 인증서 없이 빌드하면 앱이 ad-hoc(linker) 서명 상태로 남습니다. ad-hoc 서명은 인증서 체인이
없어서 macOS 가 권한 기록(TCC csreq)을 실행 파일의 cdhash 에만 고정하는데, cdhash 는 빌드마다
바뀝니다. 그래서 "전체 디스크 접근"을 허용해도 다음 빌드에서 무효화되고, 터미널에서 `claude` 가
홈 디렉터리를 훑을 때 문서·데스크탑·다운로드·음악·사진 폴더 권한 팝업이 매번 다시 뜹니다.

자체서명 인증서로 서명하면 csreq 가 `identifier + certificate leaf` 기준이 되어 재빌드해도
권한이 유지됩니다.

```bash
npm run sign:mac    # 최초 1회: 인증서 생성 + 현재 빌드 서명 (관리자 권한 불필요)
npm run build:mac   # 이후 빌드는 이 명령으로 — 빌드 중 자동 서명됨

bash scripts/macos-selfsign.sh reset    # 낡은 cdhash 에 묶인 기존 허용 기록 초기화
bash scripts/macos-selfsign.sh verify   # designated requirement 확인 (cdhash 가 없으면 정상)
```

`reset` 후에는 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근에서 기존
`Terminal Assistance` 항목을 지우고 서명된 앱을 다시 등록하면 됩니다.

릴리즈도 같은 인증서로 서명되므로(아래 참고), 자동 업데이트 후에도 권한이 유지됩니다.
서명되지 않은 예전 버전을 쓰고 있다면 설치된 앱을 직접 재서명할 수도 있습니다.

```bash
bash scripts/macos-selfsign.sh installed   # /Applications 의 앱을 재서명
```

### 알림·Dock 에 옛 아이콘이 보일 때 (macOS)

알림 센터는 번들 ID 로 아이콘을 찾습니다. 빌드 산출물(`src-tauri/target/*/bundle`)과
언마운트된 dmg 사본이 같은 번들 ID 로 LaunchServices 에 남아 있으면 그중 오래된 번들의
아이콘이 알림에 쓰입니다. 아래 스크립트가 낡은 등록을 정리하고 아이콘 캐시를 갱신합니다.

```bash
bash scripts/macos-refresh-icon.sh
```

### macOS 릴리즈 서명 설정 (메인테이너용, 최초 1회)

릴리즈 빌드를 서명하지 않으면 **모든 사용자**가 업데이트마다 같은 권한 팝업을 다시 겪습니다.
CI 가 로컬과 동일한 자체서명 인증서를 쓰도록 secret 을 등록하세요.

```bash
bash scripts/macos-selfsign.sh export   # secret 값을 파일로 저장
```

`~/.tauri/terminalassistance-codesign-secrets.txt` 의 값들을 리포 Settings → Secrets and
variables → Actions 에 등록하고, **등록 후 파일을 삭제하세요**
(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD`).

- 인증서와 비밀번호는 `~/.tauri/terminalassistance-codesign.p12` / `.pass` 에 있습니다.
  **분실하면 재발급이 불가능하고**, 새로 만들면 designated requirement 의 leaf 해시가 바뀌어
  전체 사용자의 권한 허용이 한 번 초기화됩니다. 백업해 두세요.
- 개인키이므로 터미널·로그·리포에 노출되지 않게 다루세요. 유출되면 그 인증서로 서명된
  다른 앱이 사용자가 이 앱에 부여한 권한을 물려받을 수 있습니다.
- 릴리즈 워크플로에 검증 단계가 있어, 서명이 빠지면 릴리즈가 실패합니다.
- 공증(notarization)은 하지 않으므로 첫 실행 시 Gatekeeper 경고는 그대로 남습니다
  (현재 ad-hoc 상태와 동일). 이를 없애려면 Apple Developer ID 가 필요합니다.

> `npm run dev` 는 `.app` 번들이 아닌 실행 파일을 직접 띄우므로 이 방식으로 서명할 수 없습니다.
> 권한 동작을 확인할 때는 `npm run build:mac` 으로 만든 번들을 사용하세요.

## 릴리즈 (메인테이너용)

버전 태그를 푸시하면 GitHub Actions 가 macOS/Windows 를 빌드해 릴리즈를 게시하고,
설치된 앱들은 다음 실행 시 업데이트 팝업(변경 사항 링크: [CHANGELOG.md](CHANGELOG.md))을 띄웁니다.

```bash
# 1) src-tauri/tauri.conf.json 과 package.json 의 version 을 올리고
# 2) CHANGELOG.md 에 변경 사항 기록 후
git tag v0.2.0 && git push origin v0.2.0
```

필요 시크릿: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (업데이트 서명 키).

서명 키는 GitHub 시크릿에만 있으면 되고, 로컬에는 필요 없다.
`.env` 파일은 동작하지 않는다 — Tauri v2 는 서명 키를 프로세스 환경변수에서만 읽는다.
개인키를 잃으면 기존 사용자에게 자동 업데이트를 내려보낼 수 없으니 저장소 밖에 백업해 둔다.

로컬에서 서명 포함 릴리즈 빌드를 확인해야 할 때 (Windows):

```powershell
# 키를 ~\.tauri\terminalassistance.key 에 두고
.\scripts\build-signed.ps1
```

서명 없이 `npm run build` 를 돌리면 msi/nsis 설치본까지는 만들어지고
업데이터 서명 단계에서만 실패한다 — 개발/동작 확인 목적이면 그대로 써도 된다.

## 아키텍처

```
src-tauri/          Rust 백엔드
  src/pty.rs        PTY 세션 관리 + 상태 머신 (portable-pty, 500ms 폴링 스레드 1개)
  src/store.rs      프로젝트·프리셋·설정 JSON 영속화
  src/main.rs       IPC 커맨드 + 플러그인 배선 (clipboard/dialog/notification/opener/updater)
src/renderer/       프론트엔드 (순수 웹, 번들러 없음)
  terminal-view.js  xterm.js 세션 뷰 (비활성 세션도 버퍼 유지 → 전환 비용 0)
  sidebar.js        프로젝트/세션 목록 + 상태 시각화
  presets.js        명령 프리셋 바 (전역)
  split-view.js     분할 패널 배치·패널 헤더·프로젝트 프리셋 드롭다운
  drafts.js         패널별 프롬프트 작성기 (즉시 전송·예약 FIFO·일괄 전송)
  theme.js          배경·강조색 2값에서 전체 팔레트 파생 (라이트/다크 자동 판별)
  app.js            상태·모달·업데이트 확인
```

설계 배경과 로드맵은 [docs/PLAN.md](docs/PLAN.md) 참고.

## 라이선스

GNU General Public License v3.0 only (`GPL-3.0-only`).

이 프로젝트는 오픈소스 상태를 강제하기 위해 GPLv3로 배포됩니다. 복사, 수정, 배포, 파생물 배포는 GPLv3 조건을 따라야 하며, 파생물 역시 동일한 라이선스와 소스 공개 의무를 유지해야 합니다.

저작권 및 저작자 처리는 [AUTHORS.md](AUTHORS.md)를 참고하세요.
