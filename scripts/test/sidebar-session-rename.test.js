const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'sidebar.js');

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.title = '';
    this.spellcheck = true;
    this.onclick = null;
    this.ondblclick = null;
    this.onkeydown = null;
    this.onblur = null;
    this.onmousedown = null;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceWith(next) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      next.parentNode = parent;
      parent.children[index] = next;
      this.parentNode = null;
    }
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      if (node.matches(selector)) out.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }

  matches(selector) {
    const data = selector.match(/^\.([A-Za-z0-9_-]+)\[data-sid="([^"]+)"\]$/);
    if (data) return this.classList.contains(data[1]) && this.dataset.sid === data[2];
    const klass = selector.match(/^\.([A-Za-z0-9_-]+)$/);
    if (klass) return this.classList.contains(klass[1]);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
}

class FakeDocument {
  constructor() {
    this.listeners = {};
    this.activeElement = null;
    this.body = new FakeElement('body', this);
    this.byId = { 'project-list': new FakeElement('div', this) };
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId[id] || null;
  }

  querySelector(selector) {
    if (selector.startsWith('#project-list ')) {
      return this.byId['project-list'].querySelector(selector.slice('#project-list '.length));
    }
    return this.byId['project-list'].querySelector(selector);
  }

  addEventListener(type, handler) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners[type] || []) handler(event);
  }
}

function event(target, key, detail) {
  return {
    target,
    key,
    detail: detail || 0,
    stopped: false,
    prevented: false,
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.prevented = true; },
  };
}

function loadSidebar() {
  const document = new FakeDocument();
  const calls = [];
  const sandbox = {
    document,
    localStorage: { getItem: () => null, setItem() {} },
    makeSortable() {},
    Theme: { adjustText: (color) => color },
    ArmedConfirm: { isArmed: () => false, disarm() {}, arm() {} },
    ta: { renameSession: async (id, title) => calls.push([id, title]) },
    App: {
      state: {
        projects: [{ id: 'p1', name: 'Project', path: 'D:/Project', color: '' }],
        sessions: [{ id: 's1', projectId: 'p1', title: 'Old title', status: 'idle', cwd: 'D:/Project' }],
        activeId: 's1',
        projectEmptyId: null,
      },
      lastSessionByProject: {},
      activateSession(id) { this.state.activeId = id; },
      createSession() {},
      closeSession() {},
      renderTopbar() { this.topbarRendered = true; },
    },
    console: { warn() {}, error() {}, log() {} },
  };
  const api = vm.runInNewContext(fs.readFileSync(SRC, 'utf8') + ';({ renderSidebar });', sandbox);
  return { api, document, calls, App: sandbox.App };
}

exports.name = '사이드바 세션 제목 인라인 변경';

exports.run = function run(t) {
  {
    const { api, document, calls, App } = loadSidebar();
    api.renderSidebar();
    const row = document.querySelector('.session-row[data-sid="s1"]');
    t.check('더블 클릭하면 세션 제목 입력 필드로 전환된다', row && typeof row.ondblclick === 'function');
    row.ondblclick(event(row));
    const input = row.querySelector('.session-rename');
    t.check('입력 필드가 기존 제목으로 시작한다', input && input.value === 'Old title');
    input.value = 'New title';
    input.onkeydown(event(input, 'Enter'));
    t.check('Enter 로 제목을 즉시 저장한다', calls.length === 1 && calls[0][0] === 's1' && calls[0][1] === 'New title');
    t.check('저장 성공 후 로컬 세션 제목을 갱신한다', App.state.sessions[0].title === 'New title');
  }

  {
    const { api, document, calls } = loadSidebar();
    api.renderSidebar();
    document.dispatch('keydown', event(document.body, 'F2'));
    const input = document.querySelector('.session-rename');
    t.check('선택된 세션에서 F2 를 누르면 제목 편집을 시작한다', input && input.value === 'Old title');
    input.value = 'Blur save';
    input.onblur();
    t.check('입력 필드 바깥 클릭으로 blur 되면 제목을 저장한다', calls.length === 1 && calls[0][1] === 'Blur save');
  }

  {
    const { api, document, calls } = loadSidebar();
    api.renderSidebar();
    const row = document.querySelector('.session-row[data-sid="s1"]');
    row.ondblclick(event(row));
    const input = row.querySelector('.session-rename');
    const click = event(input);
    input.onclick(click);
    t.check('입력 필드 내부 클릭은 행 선택으로 전파되지 않는다', click.stopped && document.querySelector('.session-rename') === input);
    t.check('입력 필드 내부 클릭만으로 저장하지 않는다', calls.length === 0);
  }

  {
    const { api, document } = loadSidebar();
    api.renderSidebar();
    const row = document.querySelector('.session-row[data-sid="s1"]');
    row.onclick(event(row, undefined, 2));
    t.check('두 번째 click 이벤트만으로도 세션 제목 편집을 시작한다', !!row.querySelector('.session-rename'));
  }

  {
    const { api, document } = loadSidebar();
    api.renderSidebar();
    const row = document.querySelector('.session-row[data-sid="s1"]');
    const close = row.querySelector('.session-close');
    row.ondblclick(event(close));
    t.check('닫기 버튼 더블 클릭은 세션 제목 편집을 시작하지 않는다', !row.querySelector('.session-rename'));
  }
};
