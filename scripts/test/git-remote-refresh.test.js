const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');

function loadApp() {
  const storage = new Map();
  const context = {
    console,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(source + '\n;globalThis.__testApp = App;', context);
  return { app: context.__testApp, context };
}

const remoteState = (branch) => ({
  branch,
  hasUpstream: true,
  behind: 0,
  ahead: 0,
  fetchFailed: false,
});

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  name: 'Pull 상태 자동 갱신',
  async run(t) {
    t.check(
      '앱 포커스와 가시성 복귀가 공통 Pull 상태 갱신 경로를 호출한다',
      /window\.addEventListener\('focus',\s*refreshAfterAppResume\)/.test(source)
        && /document\.addEventListener\('visibilitychange',[\s\S]*?visibilityState === 'visible'[\s\S]*?refreshAfterAppResume\(\)/.test(source)
    );
    t.check(
      '네트워크 연결 복구 시 TTL과 무관하게 Pull 상태를 다시 확인한다',
      /window\.addEventListener\('online',[\s\S]*?refreshVisibleGitRemote\(\{ fetch: true, forceFetch: true \}\)/.test(source)
    );
    t.check(
      '보이는 저장소만 60초 저빈도로 원격 상태를 갱신한다',
      /GIT_REMOTE_POLL_MS\s*=\s*60_000/.test(source)
        && /setInterval\(\(\) => \{[\s\S]*?visibilityState === 'visible'[\s\S]*?refreshVisibleGitRemote\(\{ fetch: true \}\)[\s\S]*?GIT_REMOTE_POLL_MS\)/.test(source)
    );
    t.check(
      '외부 브랜치 변경은 TTL을 무시하고 원격 상태를 다시 fetch한다',
      /if \(branchChanged\) \{[\s\S]*?delete App\.state\.gitRemote\[cwd\][\s\S]*?refreshGitRemote\(cwd, \{ fetch: true, forceFetch: true \}\)/.test(source)
    );
    t.check(
      '세션 활성화 즉시 보이는 Pull 상태를 갱신한다',
      /activateSession\(id, opts\)[\s\S]*?refreshBranch\(\);[\s\S]*?refreshVisibleGitRemote\(\{ fetch: true \}\)/.test(source)
    );
    t.check(
      'Pull 완료 뒤에는 추가 fetch 없이 로컬 격차를 다시 센다',
      /runGitPull\(cwd\)[\s\S]*?refreshGitRemote\(cwd, \{ fetch: false \}\)/.test(source)
    );

    {
      const { app, context } = loadApp();
      app.state.sessions = [{ id: 'visible', cwd: '/repo' }];
      app.state.activeId = 'visible';
      app.state.branches.visible = 'main';
      app.isSplit = () => false;
      app.splitVisiblePanes = () => [];
      app.renderPanePresets = () => {};
      const calls = [];
      let finishLocal;
      context.ta = {
        gitRemoteState: (_cwd, fetch) => {
          calls.push(fetch);
          if (calls.length === 1) return new Promise((resolve) => { finishLocal = resolve; });
          return Promise.resolve(remoteState('main'));
        },
      };

      const localJob = app.refreshGitRemote('/repo', { fetch: false });
      await Promise.resolve();
      const forcedJob = app.refreshGitRemote('/repo', { fetch: true, forceFetch: true });
      finishLocal(remoteState('main'));
      await Promise.all([localJob, forcedJob]);
      await flushPromises();
      t.check(
        '로컬 조회 중 강제 fetch가 들어오면 완료 뒤 실제로 후속 실행한다',
        JSON.stringify(calls) === JSON.stringify([false, true]),
        JSON.stringify(calls)
      );
    }

    {
      const { app, context } = loadApp();
      app.state.sessions = [{ id: 'visible', cwd: '/repo' }];
      app.state.activeId = 'visible';
      app.state.branches.visible = 'main';
      app.isSplit = () => false;
      app.splitVisiblePanes = () => [];
      const renderedBranches = [];
      app.renderPanePresets = () => renderedBranches.push(app.state.gitRemote['/repo']?.branch);
      let finishOldFetch;
      let callCount = 0;
      context.ta = {
        gitRemoteState: () => {
          callCount++;
          if (callCount === 1) return new Promise((resolve) => { finishOldFetch = resolve; });
          return Promise.resolve(remoteState('feature'));
        },
      };

      const oldJob = app.refreshGitRemote('/repo', { fetch: true, forceFetch: true });
      await Promise.resolve();
      app.state.branches.visible = 'feature';
      finishOldFetch(remoteState('main'));
      await oldJob;
      await flushPromises();
      t.check(
        'checkout 도중 도착한 낡은 응답은 적용하지 않고 새 브랜치 응답만 표시한다',
        callCount === 2
          && app.state.gitRemote['/repo']?.branch === 'feature'
          && JSON.stringify(renderedBranches) === JSON.stringify(['feature']),
        JSON.stringify({ callCount, state: app.state.gitRemote['/repo'], renderedBranches })
      );
    }

    {
      const { app } = loadApp();
      app.state.sessions = [
        { id: 'active', cwd: '/same' },
        { id: 'split', cwd: '/same' },
        { id: 'hidden', cwd: '/hidden' },
      ];
      app.state.activeId = 'active';
      app.split = { mode: '2col', panes: ['active', 'split'] };
      app.isSplit = () => app.split.mode !== '1x1';
      app.splitVisiblePanes = () => app.split.panes;
      const calls = [];
      app.refreshGitRemote = (cwd) => { calls.push(cwd); };

      const visibleIds = app.visibleGitSessions().map((session) => session.id);
      app.refreshVisibleGitRemote({ fetch: true });
      t.check(
        '보이는 세션만 고르고 같은 cwd는 한 번만 조회한다',
        JSON.stringify(visibleIds) === JSON.stringify(['active', 'split'])
          && JSON.stringify(calls) === JSON.stringify(['/same']),
        JSON.stringify({ visibleIds, calls })
      );

      app.split.mode = '1x1';
      app.split.panes = ['hidden']; // 이전 분할 배정이 남아 있어도 단일 화면에서는 보이지 않는다
      calls.length = 0;
      const singleVisibleIds = app.visibleGitSessions().map((session) => session.id);
      app.refreshVisibleGitRemote({ fetch: true });
      t.check(
        '1x1 모드에서는 남아 있는 분할 패널 세션을 조회하지 않는다',
        JSON.stringify(singleVisibleIds) === JSON.stringify(['active'])
          && JSON.stringify(calls) === JSON.stringify(['/same']),
        JSON.stringify({ singleVisibleIds, calls })
      );
    }

    {
      const { app, context } = loadApp();
      app.state.sessions = [{ id: 'active', cwd: '/repo' }];
      app.state.activeId = 'active';
      app.state.branches.active = 'main';
      app.state.gitRemote['/repo'] = remoteState('main');
      app.isSplit = () => false;
      app.splitVisiblePanes = () => [];
      app.renderTopbar = () => {};
      app.renderPanePresets = () => {};
      const refreshCalls = [];
      app.refreshGitRemote = (cwd, opts) => { refreshCalls.push({ cwd, opts }); };
      context.ta = { gitBranch: () => Promise.resolve('feature') };

      await app.refreshBranch();
      t.check(
        '브랜치 변경은 이전 Pull 캐시를 지우고 TTL을 무시한 fetch를 실행한다',
        app.state.branches.active === 'feature'
          && !Object.prototype.hasOwnProperty.call(app.state.gitRemote, '/repo')
          && JSON.stringify(refreshCalls) === JSON.stringify([{
            cwd: '/repo',
            opts: { fetch: true, forceFetch: true },
          }]),
        JSON.stringify({ branch: app.state.branches.active, refreshCalls })
      );
    }

    {
      const { app, context } = loadApp();
      app.state.sessions = [{ id: 'newly-visible', cwd: '/repo' }];
      app.state.activeId = 'newly-visible';
      app.state.gitRemote['/repo'] = remoteState('main');
      app.isSplit = () => false;
      app.splitVisiblePanes = () => [];
      app.renderTopbar = () => {};
      app.renderPanePresets = () => {};
      const refreshCalls = [];
      app.refreshGitRemote = (cwd, opts) => { refreshCalls.push({ cwd, opts }); };
      context.ta = { gitBranch: () => Promise.resolve('feature') };

      await app.refreshBranch();
      t.check(
        '새로 보인 세션도 cwd 캐시 브랜치가 다르면 stale 캐시를 지우고 강제 fetch한다',
        app.state.branches['newly-visible'] === 'feature'
          && !Object.prototype.hasOwnProperty.call(app.state.gitRemote, '/repo')
          && refreshCalls.length === 1
          && refreshCalls[0].opts.forceFetch === true,
        JSON.stringify({ branch: app.state.branches['newly-visible'], refreshCalls })
      );
    }
  },
};
