# Terminal Assistance

AI(Claude Code 등) 시대의 **멀티 프로젝트 터미널 워크스페이스**.
프로젝트를 미리 등록해 두고 클릭 한 번으로 터미널을 전환하며, 각 터미널이 **무슨 작업을 하고 있는지 / 끝났는지**를 한눈에 봅니다.

macOS · Windows 지원 (Tauri 2 — 시스템 WebView 기반이라 Electron 대비 메모리 점유가 낮습니다).

## 주요 기능

- **프로젝트 레지스트리** — 프로젝트(이름·경로·색상)를 등록해 두고 클릭 한 번으로 해당 경로의 터미널 열기/전환. `cd` 반복 끝.
- **멀티 세션 + 상태 시각화** — 세션마다 실시간 상태 표시:
  - 🟢 실행 중 (점멸) / ⚪ 대기 / 🔵 **완료** (3초 이상 돌던 작업이 끝나면 배지 + 데스크톱 알림) / 🔴 종료됨
  - 다른 세션을 보고 있어도 백그라운드 작업 완료를 놓치지 않습니다.
- **명령 프리셋** — 자주 쓰는 작업 지시를 전역/프로젝트별로 등록. 클릭=실행, Shift+클릭=입력만, 우클릭=수정.
- **이미지 첨부** — 클립보드 이미지 `Cmd/Ctrl+V` 또는 파일 드래그앤드롭 → PNG 저장 후 경로 자동 입력(Claude Code 가 이미지로 인식). 하단 스트립에서 **어떤 이미지를 전달했는지 썸네일로 확인**, 클릭하면 원본 열기.
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
  presets.js        명령 프리셋 바
  app.js            상태·모달·업데이트 확인
```

설계 배경과 로드맵은 [docs/PLAN.md](docs/PLAN.md) 참고.

## 라이선스

MIT
