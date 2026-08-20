// 프롬프트 히스토리: PTY 로 가는 사용자 입력을 라인 단위로 추적해,
// Enter 로 제출된 텍스트를 세션별 히스토리에 쌓고 클릭 시 해당 위치로 점프한다.
const PROMPT_HISTORY_MAX = 300; // 세션당 보관 상한
const PROMPT_PREVIEW_LEN = 90;  // 목록 표시용 절단 길이

Object.assign(App, {
  _promptSyncTimers: {}, // sessionId → 디바운스 타이머 (백엔드 동기화용)

  // 프롬프트 히스토리를 백엔드에 동기화 — 앱 종료 시 세션 스냅샷에 포함돼
  // 재시작 후에도 히스토리가 유지된다. 커밋은 즉시(0), 삭제는 디바운스(연타 대비).
  // 즉시 보내지 않으면 명령 직후 앱을 닫았을 때 마지막 프롬프트가 유실된다.
  syncPrompts(id, delayMs = 500) {
    if (!id) return;
    clearTimeout(App._promptSyncTimers[id]);
    App._promptSyncTimers[id] = setTimeout(() => {
      delete App._promptSyncTimers[id];
      const list = (App.state.prompts[id] || []).map((it) => ({
        n: it.n, text: it.text, ts: it.ts.getTime(), line: it.line
      }));
      ta.setSessionPrompts(id, list).catch(() => {}); // 동기화 실패는 치명적이지 않음
    }, delayMs);
  },

  trackInput(id, data) {
    let buf = App._inputBufs[id] || '';
    // 브래킷 붙여넣기 래퍼는 제거하고 내용은 유지
    data = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r') { App.commitPrompt(id, buf); buf = ''; }
      else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') buf = '';              // Ctrl+C / Ctrl+U
      else if (ch === '\x1b') {                                        // ESC 시퀀스(방향키 등)는 통째로 스킵
        i++;
        if (data[i] === '[' || data[i] === 'O') {
          i++;
          while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) i++;
        }
      }
      else if (ch >= ' ' || ch === '\n' || ch === '\t') buf += ch;
    }
    App._inputBufs[id] = buf;
  },

  commitPrompt(id, text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < 2) return; // 단타 엔터/한 글자 명령은 노이즈로 간주
    const marker = TerminalView.addPromptMarker(id);
    const list = App.state.prompts[id] || (App.state.prompts[id] = []);
    // n: 마지막 항목 +1 (단조 증가) — length+1 은 삭제·트리밍 후 재사용돼
    // deletePrompt/ArmedConfirm 키가 엉뚱한 항목과 충돌한다
    const n = (list.length ? list[list.length - 1].n : 0) + 1;
    // line: 커밋 시점의 절대 버퍼 라인 — 마커가 폐기됐을 때 텍스트 검색 폴백의 기준점
    list.push({ n, text, ts: new Date(), marker, line: marker ? marker.line : -1 });
    if (list.length > PROMPT_HISTORY_MAX) {
      const old = list.shift();
      if (old.marker) { try { old.marker.dispose(); } catch (_) {} }
    }
    App.syncPrompts(id, 0); // 커밋은 즉시 동기화 — 직후 앱 종료 시 유실 방지
    if (id === App.state.activeId) App.renderPromptList();
  },

  deletePrompt(sid, n) {
    const list = App.state.prompts[sid] || [];
    const idx = list.findIndex((x) => x.n === n);
    if (idx >= 0) {
      const [old] = list.splice(idx, 1);
      if (old.marker) { try { old.marker.dispose(); } catch (_) {} }
      App.syncPrompts(sid);
    }
    if (sid === App.state.activeId) App.renderPromptList(true);
  },

  renderPromptList(keepScroll) {
    // 패널이 닫혀 있으면 렌더 생략 — 열 때 togglePromptPanel 이 다시 채운다
    if (document.getElementById('prompt-panel').classList.contains('hidden')) return;
    const el = document.getElementById('prompt-list');
    const prevScroll = el.scrollTop; // 삭제/확인 재렌더 시 스크롤 위치 유지용
    el.textContent = '';
    const items = App.state.prompts[App.state.activeId] || [];
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'prompt-empty';
      e.textContent = '이 세션에서 입력한 프롬프트가 여기에 쌓입니다. 클릭하면 해당 위치로 이동합니다.';
      el.appendChild(e);
      return;
    }
    const rerender = () => App.renderPromptList(true);
    for (const it of items) {
      const row = document.createElement('div');
      // 마커가 죽어도 텍스트 검색 폴백으로 이동 가능한 경우가 많으므로
      // 취소선(gone)은 미리 긋지 않고 실제 클릭이 실패했을 때만 표시한다
      row.className = 'prompt-item';
      const n = document.createElement('span');
      n.className = 'pn';
      n.textContent = it.n;
      const t = document.createElement('span');
      t.className = 'pt';
      t.textContent = it.text.length > PROMPT_PREVIEW_LEN ? it.text.slice(0, PROMPT_PREVIEW_LEN) + '…' : it.text;
      row.title = it.text + '\n' + it.ts.toLocaleTimeString();
      // 삭제 버튼: 첫 클릭 = "삭제 확인" 표시(시간 내 재클릭), 재클릭 = 삭제
      const key = ['prompt-del', App.state.activeId, it.n];
      const armed = ArmedConfirm.isArmed(key);
      const x = document.createElement('button');
      x.className = 'px' + (armed ? ' confirm' : '');
      x.textContent = armed ? '삭제 확인' : '✕';
      x.title = armed ? '한 번 더 클릭하면 삭제' : '히스토리에서 삭제';
      x.onclick = (e) => {
        e.stopPropagation();
        if (armed) {
          ArmedConfirm.disarm();
          App.deletePrompt(App.state.activeId, it.n);
        } else {
          ArmedConfirm.arm(key, rerender);
        }
      };
      row.append(n, t, x);
      row.onclick = () => {
        // 마커가 죽어도 텍스트 검색 폴백으로 찾을 수 있으므로 성공 시 gone 해제
        if (TerminalView.scrollToPrompt(App.state.activeId, it)) row.classList.remove('gone');
        else row.classList.add('gone');
      };
      el.appendChild(row);
    }
    el.scrollTop = keepScroll ? prevScroll : el.scrollHeight; // 새 항목 추가 시엔 최신이 보이도록
  }
});
