// Pull 실행과 실패 진단 팝업.
// 실패를 토스트 한 줄로만 알리면 "무엇이 막았는지"가 보이지 않아 사용자가 손을 쓸 수 없었다.
// 백엔드가 실패 유형(kind)과 막은 파일 목록을 함께 돌려주므로, 여기서 파일별 되돌리기까지
// 붙여 팝업 안에서 원인 확인 → 되돌리기 → 다시 Pull 을 끝낼 수 있게 한다.

// 실패 유형별 제목과 안내 문구 — 되돌리기의 의미(복원/삭제)가 유형마다 다르므로 명시한다
const PULL_FAILURE_TEXT = {
  local_changes: {
    title: 'Pull 실패 — 로컬 수정이 원격 변경과 겹칩니다',
    hint: '아래 파일을 로컬에서 고쳤고, 원격에서도 같은 파일이 바뀌었습니다.'
      + ' 수정을 살리려면 커밋하거나 stash 한 뒤 다시 Pull 하세요.'
      + ' 필요 없는 수정이면 오른쪽 되돌리기로 파일을 원래 상태로 돌릴 수 있습니다.'
  },
  untracked: {
    title: 'Pull 실패 — 원격에 새로 추가된 파일이 로컬 파일과 겹칩니다',
    hint: '아래 파일은 아직 커밋되지 않은 로컬 파일인데 원격에서도 같은 경로가 추가됐습니다.'
      + ' 되돌리기는 로컬 파일을 삭제합니다 — 남겨야 할 내용이면 먼저 다른 곳에 옮기세요.'
  },
  conflict: {
    title: 'Pull 실패 — 병합 충돌',
    hint: '아래 파일에서 원격 변경과 로컬 변경이 같은 위치를 건드렸습니다.'
      + ' 직접 해결하거나, 로컬 쪽을 버려도 되면 되돌리기로 원래 상태로 돌리세요.'
  },
  diverged: {
    title: 'Pull 실패 — 로컬 브랜치가 원격과 갈라졌습니다',
    hint: '원격 커밋 위로 바로 이어 붙일(fast-forward) 수 없는 상태입니다.'
      + ' 터미널에서 `git pull --rebase` 로 내 커밋을 원격 위에 다시 쌓거나,'
      + ' `git pull --no-rebase` 로 병합 커밋을 만들어야 합니다.'
  },
  other: {
    title: 'Pull 실패',
    hint: 'git 이 돌려준 원인은 아래와 같습니다.'
  }
};

// 상태 문자 → 사람이 읽을 설명 (목록의 배지 툴팁)
const PULL_STATUS_LABEL = {
  M: '수정됨', A: '추가됨(스테이지)', D: '삭제됨', R: '이름 변경', U: '미추적', '?': '상태 확인 불가'
};

Object.assign(App, {
  // Pull 버튼 클릭 — 터미널에 명령을 흘리지 않고 백그라운드로 실행한다.
  // 성공은 토스트 한 줄, 실패는 원인·파일 목록이 있는 팝업으로 알린다.
  async runGitPull(cwd) {
    if (!cwd || App._gitPulling === cwd) return;
    App._gitPulling = cwd;
    App.renderPanePresets(); // 진행 중 표시
    let result = null;
    try {
      result = await ta.gitPull(cwd);
    } catch (e) {
      // 커맨드 자체가 실패(백엔드 오류)해도 원인을 팝업으로 남긴다
      result = { ok: false, message: String(e), kind: 'other', files: [], raw: String(e) };
    } finally {
      App._gitPulling = null;
    }
    // pull 직후는 이미 최신 원격 정보를 갖고 있으므로 fetch 없이 카운트만 다시 센다
    await App.refreshGitRemote(cwd, { fetch: false });
    App.refreshBranch();
    App.renderPanePresets();
    if (result && result.ok) {
      App.showToast('⬇ Pull 완료 — ' + (result.message || ''));
      return;
    }
    App.showPullFailureModal(cwd, result || {});
  },

  // Pull 실패 팝업: 원인 요약 + 막은 파일 목록(파일별 되돌리기) + git 원본 출력 + 다시 Pull
  showPullFailureModal(cwd, result) {
    const kind = PULL_FAILURE_TEXT[result.kind] ? result.kind : 'other';
    const text = PULL_FAILURE_TEXT[kind];
    const files = Array.isArray(result.files) ? result.files : [];
    const git = App.state.gitRemote[cwd] || null;
    App.modal(`
      <h3>${escapeHtml(text.title)}</h3>
      <div class="modal-sub"></div>
      <p class="pull-hint">${escapeHtml(text.hint)}</p>
      <div class="pull-files"></div>
      <details class="pull-raw"><summary>git 원본 출력 보기</summary><pre></pre></details>
      <div class="modal-actions">
        <button id="m-close">닫기</button>
        <button id="m-retry">다시 Pull</button>
      </div>`,
      (m, close) => {
        const sub = [];
        if (git && git.branch) sub.push('⎇ ' + git.branch);
        if (git && git.behind) sub.push(`원격에 새 커밋 ${git.behind}개`);
        sub.push(cwd);
        m.querySelector('.modal-sub').textContent = sub.join(' · ');
        m.querySelector('.pull-raw pre').textContent = result.raw || result.message || '(출력 없음)';
        App._renderPullFileList(m.querySelector('.pull-files'), cwd, files);
        m.querySelector('#m-close').onclick = close;
        m.querySelector('#m-retry').onclick = () => { close(); void App.runGitPull(cwd); };
      }, { wide: true });
  },

  // 막은 파일 목록 렌더 — 한 줄에 [상태] 경로 [되돌리기]
  _renderPullFileList(host, cwd, files) {
    host.textContent = '';
    if (!files.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '특정 파일이 원인은 아닙니다 — 아래 원본 출력을 확인하세요.';
      host.appendChild(e);
      return;
    }
    const head = document.createElement('div');
    head.className = 'pull-files-head';
    head.textContent = `Pull 을 막은 파일 ${files.length}개`;
    host.appendChild(head);
    for (const f of files) host.appendChild(App._buildPullFileRow(cwd, f));
  },

  _buildPullFileRow(cwd, file) {
    const row = document.createElement('div');
    row.className = 'pull-file';

    const status = (file.status || '?').slice(0, 1);
    const badge = document.createElement('span');
    badge.className = 'pf-status s-' + (/^[A-Z]$/.test(status) ? status : 'unknown');
    badge.textContent = status;
    badge.title = PULL_STATUS_LABEL[status] || status;

    const path = document.createElement('span');
    path.className = 'pf-path';
    path.textContent = file.path;
    path.title = file.path + (file.untracked ? '\n미추적 파일 — 되돌리기는 삭제입니다' : '');

    const btn = document.createElement('button');
    btn.className = 'pf-discard';
    const idleLabel = file.untracked ? '삭제' : '되돌리기';
    btn.textContent = idleLabel;
    btn.title = file.untracked
      ? '이 로컬 파일을 삭제합니다 (복구 불가)'
      : '이 파일의 로컬 수정을 버리고 마지막 커밋 상태로 되돌립니다 (복구 불가)';

    // 팝업 위에 확인창을 겹치면 목록이 사라지므로, 버튼 자체를 2단계로 만든다.
    // 첫 클릭 = 확인 요청, 4초 안에 다시 누르면 실행.
    let armed = false;
    let disarm = null;
    const reset = () => {
      armed = false;
      clearTimeout(disarm);
      btn.classList.remove('armed');
      btn.textContent = idleLabel;
    };
    btn.onclick = async () => {
      if (!armed) {
        armed = true;
        btn.classList.add('armed');
        btn.textContent = file.untracked ? '정말 삭제?' : '정말 되돌리기?';
        disarm = setTimeout(reset, 4000);
        return;
      }
      clearTimeout(disarm);
      btn.disabled = true;
      btn.classList.remove('armed');
      btn.textContent = '처리 중…';
      let r = null;
      try {
        r = await ta.gitDiscardPaths(cwd, [file.path]);
      } catch (e) {
        r = { ok: false, failed: [{ path: file.path, message: String(e) }] };
      }
      if (r && r.ok) {
        row.classList.add('done');
        btn.textContent = file.untracked ? '삭제됨' : '되돌렸습니다';
        // 탐색기 변경 표시도 함께 정리한다
        if (App.refreshExplorer) void App.refreshExplorer(true);
      } else {
        const why = (r && r.failed && r.failed[0] && r.failed[0].message) || '알 수 없는 오류';
        row.classList.add('failed');
        btn.disabled = false;
        btn.textContent = '실패 — 재시도';
        btn.title = why;
        App.showToast('⚠ 되돌리기 실패 — ' + why);
      }
    };

    row.append(badge, path, btn);
    return row;
  }
});
