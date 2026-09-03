// 도움말 팝업 — 단축키·사용법 / 터미널 명령어 / Git 명령어 3탭 + 통합 검색
// 데이터는 순수 배열로 두고 렌더러가 탭·검색을 함께 처리한다 (검색은 3탭 전체를 한 번에 훑는다).
// 키 표기의 'Mod' 는 실행 플랫폼에 맞춰 ⌘ / Ctrl 로 치환된다.
Object.assign(App, {
  // 단축키·사용법
  HELP_SHORTCUTS: [
    {
      title: '세션 · 프로젝트',
      items: [
        ['Mod+1 ~ Mod+9', '1~9번 세션으로 즉시 전환 (터미널에 포커스가 있어도 동작)'],
        ['Mod+T', '현재 프로젝트에 새 세션 추가'],
        ['프로젝트 클릭', '세션이 있으면 전환, 없으면 그 경로에서 새 터미널을 연다'],
        ['세션 이름 더블클릭', '세션 이름 바꾸기 (Enter 저장 · Esc 취소)'],
        ['상단바 🟡 배지 클릭', '허가 대기 중인 세션으로 점프 (여러 개면 클릭할 때마다 순환)']
      ]
    },
    {
      title: '패널 접기 · 펼치기',
      items: [
        ['Mod+I', '좌측 프로젝트 사이드바 토글'],
        ['Mod+O', '탐색기(파일 트리) 토글'],
        ['Mod+P', '우측 세션 기록·문서·메모 패널 토글'],
        ['패널 경계 드래그', '패널 너비 조절']
      ]
    },
    {
      title: '프롬프트 입력 · 전송',
      items: [
        ['Mod+J', '터미널 ↔ 프롬프트 입력창 커서 전환. 터미널에 프롬프트를 잘못 치고 있었다면 치던 내용을 잘라내 입력창으로 옮긴다'],
        ['Mod+Enter', '입력창의 프롬프트를 현재 세션으로 전송'],
        ['Shift+Enter', '예약 발송 — 작업이 진행 중이면 완료된 뒤 자동 전송'],
        ['Tab / Shift+Tab', '분할 모드에서 패널 순회 + 해당 패널 입력창 포커스'],
        ['Mod+V', '클립보드에 이미지가 있으면 PNG로 저장해 경로 첨부, 텍스트면 일반 붙여넣기'],
        ['파일 드래그앤드롭', '창에 이미지·파일을 떨어뜨리면 경로가 입력창에 삽입된다']
      ]
    },
    {
      title: '터미널 검색',
      items: [
        ['Mod+F', '터미널 검색창 열기'],
        ['Enter / Shift+Enter', '다음 / 이전 검색 결과로 이동'],
        ['Esc', '검색창 닫기']
      ]
    },
    {
      title: '탐색기 (파일 트리)',
      items: [
        ['↑ / ↓', '선택 항목 위·아래 이동'],
        ['← / →', '폴더 접기·펼치기 (파일이면 부모 폴더로 이동)'],
        ['Space', '선택한 파일 미리보기 열기 / 닫기 (토글)'],
        ['Enter', '파일 경로를 활성 입력창에 삽입 · 폴더는 접기·펼치기'],
        ['F2', '파일·폴더 이름 바꾸기'],
        ['더블클릭', '파일 미리보기 열기'],
        ['우클릭', '컨텍스트 메뉴 (탐색기에서 보기 · 편집 · 삭제 등)'],
        ['↻ / ＋', '파일 트리 새로고침 · 선택한 폴더 안에 새 파일·폴더 만들기']
      ]
    },
    {
      title: '터미널 텍스트 편집 (macOS)',
      items: [
        ['Cmd+← / Cmd+→', '입력 줄의 처음 / 끝으로 이동'],
        ['Option+← / Option+→', '단어 단위로 이동'],
        ['Cmd+⌫', '커서 앞의 줄 전체 삭제 (^U)'],
        ['Option+⌫', '커서 앞 단어 삭제 (^W)'],
        ['Shift+클릭', '선택 영역 확장'],
        ['Ctrl+C', '실행 중인 작업 중단 (Windows·Linux 는 선택 영역이 있으면 복사)']
      ]
    },
    {
      title: '팝업 · 편집기',
      items: [
        ['Esc', '팝업 닫기 (편집기에서 저장 안 된 변경이 있으면 확인 후)'],
        ['Mod+S', '파일 편집기 저장'],
        ['Space', '파일 미리보기 팝업 닫기']
      ]
    },
    {
      title: '세션 상태 아이콘',
      items: [
        ['🟢 점멸', '실행 중 — AI 도구나 명령이 작업하고 있다'],
        ['⚪', '대기 — 입력을 기다리는 상태'],
        ['🟡', '허가 대기 — AI 도구가 사용자 승인을 요청했다'],
        ['🔵', '완료 — 작업이 끝났다 (배지 + 데스크톱 알림)'],
        ['🔴', '종료됨 — 셸이 끝났다']
      ]
    },
    {
      title: '사용법 — 프리셋 · 분할 · 설정',
      items: [
        ['프리셋 칩 클릭', '등록한 작업 지시를 즉시 실행'],
        ['프리셋 Shift+클릭', '실행하지 않고 입력창에 내용만 넣기'],
        ['프리셋 우클릭', '해당 프리셋 수정'],
        ['상단바 분할 버튼', '화면 분할 8종 선택 (세로 최대 4열 · 가로 최대 3행)'],
        ['상단바 ⚙ 설정', '테마 12종·글꼴·줄 간격·최소 대비·셸·알림·AI 도구 훅 연동'],
        ['우측 패널 문서', '세션 기록·계획 문서·Markdown 메모 열람 및 추가'],
        ['터미널 선택 후 저장', '터미널에서 텍스트를 선택하면 계획 문서로 저장할 수 있다']
      ]
    }
  ],

  // 터미널 주요 명령어 (macOS·Linux 기준, Windows 차이는 설명에 병기)
  HELP_TERMINAL: [
    {
      title: '경로 이동 · 확인',
      items: [
        ['pwd', '현재 작업 디렉터리 경로 출력'],
        ['cd <경로>', '디렉터리 이동 (`cd ..` 상위 · `cd ~` 홈 · `cd -` 직전 위치)'],
        ['ls', '디렉터리 내용 목록 (Windows: `dir`)'],
        ['ls -al', '숨김 파일까지 상세 목록 (권한·소유자·크기·수정 시각)'],
        ['ls -lhS', '크기순 정렬 + 사람이 읽는 단위'],
        ['tree -L 2', '트리 형태로 2단계까지 표시']
      ]
    },
    {
      title: '파일 · 디렉터리 조작',
      items: [
        ['mkdir -p a/b/c', '중간 디렉터리까지 한 번에 생성'],
        ['touch <파일>', '빈 파일 생성 (있으면 수정 시각만 갱신)'],
        ['cp <원본> <대상>', '파일 복사 (`-r` 디렉터리 전체)'],
        ['mv <원본> <대상>', '이동 또는 이름 바꾸기'],
        ['rm <파일>', '파일 삭제 (`-r` 디렉터리 · `-f` 강제 — 복구 불가, 주의)'],
        ['ln -s <원본> <링크>', '심볼릭 링크 생성'],
        ['open .', '현재 폴더를 Finder 로 열기 (Windows: `start .`)']
      ]
    },
    {
      title: '파일 내용 보기',
      items: [
        ['cat <파일>', '파일 전체 출력'],
        ['less <파일>', '페이지 단위로 보기 (`q` 종료 · `/` 검색)'],
        ['head -n 50 <파일>', '앞 50줄만'],
        ['tail -n 50 <파일>', '뒤 50줄만'],
        ['tail -f <로그>', '새로 추가되는 내용을 실시간으로 따라가기'],
        ['wc -l <파일>', '줄 수 세기'],
        ['diff a.txt b.txt', '두 파일 차이 비교']
      ]
    },
    {
      title: '검색',
      items: [
        ['grep -rn "패턴" .', '현재 폴더 이하에서 문자열 검색 (줄 번호 표시)'],
        ['grep -rni "패턴" src', '대소문자 무시 검색'],
        ['grep -rn --include="*.js" "패턴" .', '특정 확장자만 검색'],
        ['rg "패턴"', 'ripgrep — grep 보다 빠르고 .gitignore 를 존중'],
        ['find . -name "*.log"', '이름 패턴으로 파일 찾기'],
        ['find . -type d -name node_modules', '이름이 일치하는 디렉터리 찾기'],
        ['which <명령>', '명령의 실행 파일 경로 확인']
      ]
    },
    {
      title: '파이프 · 리다이렉션',
      items: [
        ['<명령> | grep <패턴>', '앞 명령의 출력을 다음 명령의 입력으로 넘긴다'],
        ['<명령> > out.txt', '출력을 파일로 저장 (덮어쓰기)'],
        ['<명령> >> out.txt', '출력을 파일 끝에 이어 붙이기'],
        ['<명령> 2>&1 | tee log.txt', '오류까지 합쳐 화면에 보이면서 파일로도 저장'],
        ['<명령1> && <명령2>', '앞 명령이 성공했을 때만 다음 실행'],
        ['<명령> &', '백그라운드로 실행']
      ]
    },
    {
      title: '프로세스 · 포트',
      items: [
        ['ps aux | grep <이름>', '실행 중인 프로세스 찾기'],
        ['top', '실시간 CPU·메모리 사용 현황 (`htop` 이 더 보기 좋다)'],
        ['kill <PID>', '프로세스 종료 요청 (`kill -9 <PID>` 강제 종료)'],
        ['lsof -i :3000', '3000번 포트를 점유한 프로세스 확인'],
        ['pkill -f <문자열>', '명령줄에 해당 문자열이 있는 프로세스 종료'],
        ['jobs / fg / bg', '백그라운드 작업 목록·전환']
      ]
    },
    {
      title: '권한 · 소유',
      items: [
        ['chmod +x <파일>', '실행 권한 부여'],
        ['chmod 644 <파일>', '소유자 읽기·쓰기, 그 외 읽기'],
        ['chown user:group <파일>', '소유자·그룹 변경'],
        ['sudo <명령>', '관리자 권한으로 실행']
      ]
    },
    {
      title: '압축 · 전송',
      items: [
        ['tar -czf out.tar.gz <폴더>', 'tar.gz 로 압축'],
        ['tar -xzf in.tar.gz', 'tar.gz 압축 풀기'],
        ['zip -r out.zip <폴더>', 'zip 압축 (`unzip in.zip` 풀기)'],
        ['curl -O <URL>', '파일 다운로드'],
        ['curl -s <URL> | head', 'API 응답 확인'],
        ['scp <파일> user@host:<경로>', 'SSH 로 파일 전송'],
        ['rsync -av <원본>/ <대상>/', '변경분만 동기화 복사']
      ]
    },
    {
      title: '디스크 · 시스템',
      items: [
        ['df -h', '디스크 여유 공간'],
        ['du -sh *', '현재 폴더 항목별 용량'],
        ['du -sh . | sort -h', '용량 순 정렬'],
        ['uname -a', 'OS·커널 정보'],
        ['env / echo $PATH', '환경 변수 확인'],
        ['export KEY=value', '현재 셸에 환경 변수 설정'],
        ['history | grep <명령>', '과거에 실행한 명령 찾기']
      ]
    },
    {
      title: 'Node · 패키지',
      items: [
        ['npm install', 'package.json 의 의존성 설치'],
        ['npm run <스크립트>', 'package.json scripts 실행'],
        ['npm outdated', '오래된 의존성 확인'],
        ['npx <패키지>', '설치 없이 패키지 실행'],
        ['node -v / npm -v', '버전 확인']
      ]
    }
  ],

  // Git 주요 명령어
  HELP_GIT: [
    {
      title: '시작 · 설정',
      items: [
        ['git init', '현재 폴더를 Git 저장소로 초기화'],
        ['git clone <URL>', '원격 저장소 복제'],
        ['git clone --depth 1 <URL>', '최근 커밋만 얕게 복제 (빠름)'],
        ['git config --global user.name "이름"', '커밋 작성자 이름 설정'],
        ['git config --global user.email "메일"', '커밋 작성자 메일 설정'],
        ['git config --list', '적용 중인 설정 전체 확인']
      ]
    },
    {
      title: '상태 · 변경 확인',
      items: [
        ['git status', '변경·스테이징 상태 확인'],
        ['git status -sb', '한 줄 요약 + 브랜치·원격 차이 표시'],
        ['git diff', '스테이징하지 않은 변경 내용'],
        ['git diff --staged', '스테이징된 변경 내용'],
        ['git diff <브랜치A>..<브랜치B>', '두 브랜치 차이'],
        ['git show <커밋>', '특정 커밋의 변경 내용'],
        ['git blame <파일>', '각 줄을 마지막으로 바꾼 커밋·작성자']
      ]
    },
    {
      title: '스테이징 · 커밋',
      items: [
        ['git add <파일>', '파일을 스테이징'],
        ['git add -A', '변경 전체(삭제 포함)를 스테이징'],
        ['git add -p', '변경 조각을 골라가며 스테이징'],
        ['git restore --staged <파일>', '스테이징만 취소 (작업 내용은 유지)'],
        ['git commit -m "메시지"', '스테이징된 변경을 커밋'],
        ['git commit --amend', '직전 커밋 수정 (메시지·내용) — 푸시 전에만 안전'],
        ['git commit --no-verify', '훅을 건너뛰고 커밋']
      ]
    },
    {
      title: '브랜치',
      items: [
        ['git branch', '로컬 브랜치 목록 (`-a` 원격 포함)'],
        ['git switch <브랜치>', '브랜치 전환 (구버전: `git checkout`)'],
        ['git switch -c <브랜치>', '새 브랜치를 만들고 전환'],
        ['git branch -d <브랜치>', '병합된 브랜치 삭제 (`-D` 강제)'],
        ['git branch -m <새이름>', '현재 브랜치 이름 바꾸기'],
        ['git merge <브랜치>', '지정 브랜치를 현재 브랜치로 병합'],
        ['git merge --abort', '충돌 난 병합을 취소하고 이전 상태로']
      ]
    },
    {
      title: '원격 저장소',
      items: [
        ['git remote -v', '연결된 원격 목록·URL 확인'],
        ['git remote add origin <URL>', '원격 저장소 추가'],
        ['git fetch --all --prune', '원격 정보 갱신 + 삭제된 원격 브랜치 정리'],
        ['git pull --ff-only', '로컬 변경을 덮지 않는 안전한 최신화'],
        ['git pull --rebase', '원격 커밋 위로 내 커밋을 다시 쌓아 최신화'],
        ['git push', '현재 브랜치를 원격으로 전송'],
        ['git push -u origin <브랜치>', '새 브랜치를 원격에 올리고 추적 연결'],
        ['git push --force-with-lease', '되감은 이력 강제 푸시 (남의 커밋은 보호)']
      ]
    },
    {
      title: '임시 저장 (stash)',
      items: [
        ['git stash', '작업 중 변경을 잠시 치워 두고 깨끗한 상태로'],
        ['git stash -u', '추적되지 않는 새 파일까지 함께 치우기'],
        ['git stash list', '치워 둔 목록 확인'],
        ['git stash pop', '가장 최근 것을 되돌리고 목록에서 제거'],
        ['git stash apply stash@{1}', '특정 항목을 되돌리되 목록에는 남기기'],
        ['git stash drop', '가장 최근 항목 버리기 (복구 어려움)']
      ]
    },
    {
      title: '되돌리기',
      items: [
        ['git restore <파일>', '파일의 변경을 버리고 마지막 커밋 상태로'],
        ['git revert <커밋>', '해당 커밋을 취소하는 새 커밋 생성 (이력 보존, 공유 브랜치에 안전)'],
        ['git reset --soft HEAD~1', '커밋만 취소 — 변경은 스테이징에 남긴다'],
        ['git reset --mixed HEAD~1', '커밋·스테이징 취소 — 변경은 작업트리에 남긴다'],
        ['git reset --hard HEAD~1', '커밋과 변경을 모두 버린다 (복구 불가, 주의)'],
        ['git reflog', 'HEAD 이동 기록 — 잃어버린 커밋을 찾는 마지막 수단'],
        ['git clean -nd', '추적되지 않는 파일 삭제 미리보기 (`-fd` 실제 삭제)']
      ]
    },
    {
      title: '이력 조사',
      items: [
        ['git log --oneline -20', '최근 20개 커밋 한 줄 요약'],
        ['git log --graph --oneline --all', '브랜치 흐름을 그래프로'],
        ['git log -p <파일>', '파일의 변경 이력을 diff 와 함께'],
        ['git log --author="이름"', '작성자로 필터'],
        ['git log --since="2 weeks ago"', '기간으로 필터'],
        ['git shortlog -sn', '작성자별 커밋 수'],
        ['git bisect start', '이분 탐색으로 문제를 만든 커밋 찾기']
      ]
    },
    {
      title: '리베이스 · 정리',
      items: [
        ['git rebase <브랜치>', '현재 브랜치의 커밋을 지정 브랜치 위로 옮긴다'],
        ['git rebase -i HEAD~3', '최근 3개 커밋을 합치기·수정·순서 변경 (푸시 전에만)'],
        ['git rebase --continue', '충돌 해결 후 리베이스 계속'],
        ['git rebase --abort', '리베이스를 취소하고 이전 상태로'],
        ['git cherry-pick <커밋>', '다른 브랜치의 특정 커밋만 가져오기']
      ]
    },
    {
      title: '태그 · 릴리스',
      items: [
        ['git tag', '태그 목록'],
        ['git tag -a v1.0.0 -m "메시지"', '주석 태그 생성'],
        ['git push origin v1.0.0', '태그를 원격으로 전송 (`--tags` 전체)'],
        ['git tag -d v1.0.0', '로컬 태그 삭제'],
        ['git describe --tags', '현재 커밋에 가장 가까운 태그']
      ]
    },
    {
      title: '워크트리 · 서브모듈',
      items: [
        ['git worktree add ../dir <브랜치>', '같은 저장소를 다른 폴더에서 동시에 작업'],
        ['git worktree list', '워크트리 목록'],
        ['git worktree remove ../dir', '워크트리 제거'],
        ['git submodule update --init --recursive', '서브모듈 내려받기']
      ]
    }
  ],

  HELP_TAB_DEFS: [
    { id: 'shortcuts', label: '단축키 · 사용법', data: 'HELP_SHORTCUTS' },
    { id: 'terminal', label: '터미널 명령어', data: 'HELP_TERMINAL' },
    { id: 'git', label: 'Git 명령어', data: 'HELP_GIT' }
  ],

  _helpTab: 'shortcuts',

  // 'Mod' → 플랫폼 표기. 단축키 탭에서만 의미가 있지만 치환은 전 탭 공통으로 둔다.
  _helpModKey() {
    return App.state.platform === 'macos' ? 'Cmd' : 'Ctrl';
  },

  showHelpModal() {
    const tabs = App.HELP_TAB_DEFS;
    const mod = App._helpModKey();
    const tabBar = tabs.map((t) =>
      `<button type="button" class="help-tab${t.id === App._helpTab ? ' on' : ''}" data-help-tab="${t.id}">${escapeHtml(t.label)}</button>`).join('');
    App.modal(`
      <h3>도움말</h3>
      <div class="help-search">
        <input type="text" id="help-q" placeholder="명령어·단축키 검색 (예: 브랜치, grep, Mod+J)" spellcheck="false" autocomplete="off">
        <button type="button" id="help-q-clear" title="검색 지우기">✕</button>
      </div>
      <div class="help-tabs" id="help-tabs">${tabBar}</div>
      <div class="help-body" id="help-body"></div>
      <div class="modal-actions"><button id="m-close">닫기</button></div>`,
      (m, close) => {
        const body = m.querySelector('#help-body');
        const input = m.querySelector('#help-q');
        const clear = m.querySelector('#help-q-clear');
        const tabBtns = [...m.querySelectorAll('.help-tab')];

        const render = () => {
          const q = input.value.trim();
          m.querySelector('#help-tabs').classList.toggle('dimmed', !!q);
          clear.classList.toggle('hidden', !q);
          body.innerHTML = q ? App._helpSearchHtml(q, mod) : App._helpTabHtml(App._helpTab, mod);
          body.scrollTop = 0;
        };

        tabBtns.forEach((b) => {
          b.onclick = () => {
            App._helpTab = b.dataset.helpTab;
            tabBtns.forEach((x) => x.classList.toggle('on', x === b));
            input.value = '';
            render();
            input.focus();
          };
        });
        input.oninput = render;
        // 검색창 안에서는 Esc 로 먼저 검색어만 지운다 (한 번 더 누르면 모달이 닫힌다)
        input.onkeydown = (e) => {
          if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; render(); }
        };
        clear.onclick = () => { input.value = ''; render(); input.focus(); };
        m.querySelector('#m-close').onclick = close;

        render();
        input.focus();
      }, { wide: true });
  },

  // 한 탭 전체 렌더 — 그룹 제목 + 항목 표
  _helpTabHtml(tabId, mod) {
    const def = App.HELP_TAB_DEFS.find((t) => t.id === tabId) || App.HELP_TAB_DEFS[0];
    return App[def.data].map((g) => App._helpGroupHtml(g.title, g.items, mod, '')).join('');
  },

  // 검색 결과 — 3탭 전체를 훑어 탭 이름을 머리말로 붙인다
  _helpSearchHtml(q, mod) {
    const needle = App._helpNorm(q, mod);
    const out = [];
    let total = 0;
    for (const def of App.HELP_TAB_DEFS) {
      for (const g of App[def.data]) {
        const hits = g.items.filter(([k, d]) =>
          App._helpNorm(k, mod).includes(needle) || App._helpNorm(d, mod).includes(needle)
          || App._helpNorm(g.title, mod).includes(needle));
        if (!hits.length) continue;
        total += hits.length;
        out.push(App._helpGroupHtml(`${g.title}`, hits, mod, def.label, q));
      }
    }
    if (!total) {
      return `<div class="help-empty">'${escapeHtml(q)}' 에 해당하는 항목이 없습니다.</div>`;
    }
    return `<div class="help-count">검색 결과 ${total}건</div>` + out.join('');
  },

  _helpGroupHtml(title, items, mod, tabLabel, q) {
    const rows = items.map(([k, d]) => `
      <div class="help-row">
        <div class="help-key">${App._helpMark(App._helpSub(k, mod), q)}</div>
        <div class="help-desc">${App._helpMark(App._helpSub(d, mod), q)}</div>
      </div>`).join('');
    const badge = tabLabel ? `<span class="help-badge">${escapeHtml(tabLabel)}</span>` : '';
    return `<section class="help-group"><h4>${escapeHtml(title)}${badge}</h4>${rows}</section>`;
  },

  _helpSub(s, mod) {
    return String(s).replace(/Mod/g, mod);
  },

  // 검색 대조용 정규화 — 대소문자·공백 무시, 'Mod' 표기와 실제 키 표기를 모두 매칭
  _helpNorm(s, mod) {
    return String(s).replace(/Mod/g, mod).toLowerCase().replace(/\s+/g, '');
  },

  // 검색어 강조 — escapeHtml 이후에 <mark> 만 삽입한다
  _helpMark(text, q) {
    const safe = escapeHtml(text);
    if (!q) return safe;
    const needle = escapeHtml(q).toLowerCase();
    if (!needle) return safe;
    const lower = safe.toLowerCase();
    let out = '';
    let i = 0;
    while (i < safe.length) {
      const at = lower.indexOf(needle, i);
      if (at < 0) { out += safe.slice(i); break; }
      // HTML 엔티티(&amp; 등) 내부를 자르면 마크업이 깨진다 → 그 구간은 강조하지 않는다
      if (safe.lastIndexOf('&', at) > safe.lastIndexOf(';', at)) { out += safe.slice(i, at + 1); i = at + 1; continue; }
      out += safe.slice(i, at) + '<mark>' + safe.slice(at, at + needle.length) + '</mark>';
      i = at + needle.length;
    }
    return out;
  }
});
