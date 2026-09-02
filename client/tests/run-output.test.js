'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function classListFor(element) {
  return {
    add(name) {
      const values = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
      values.add(name);
      element.className = Array.from(values).join(' ');
    },
    remove(name) {
      element.className = String(element.className || '').split(/\s+/).filter(value => value && value !== name).join(' ');
    },
    toggle(name, force) {
      const present = String(element.className || '').split(/\s+/).includes(name);
      const enabled = force === undefined ? !present : Boolean(force);
      if (enabled) this.add(name);
      else this.remove(name);
      return enabled;
    },
    contains(name) { return String(element.className || '').split(/\s+/).includes(name); }
  };
}

function createElement(tagName) {
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    attributes: {},
    dataset: {},
    className: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    isConnected: true,
    title: '',
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 100,
    appendChild(child) {
      if (child && child.isFragment) {
        child.childNodes.slice().forEach(entry => this.appendChild(entry));
        child.childNodes.length = 0;
        return child;
      }
      child.parentNode = this;
      this.childNodes.push(child);
      this.scrollHeight = this.childNodes.length;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    click() { const callback = listeners.get('click'); if (callback) callback({ currentTarget: this }); },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = String(value);
    },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  };
  element.classList = classListFor(element);
  Object.defineProperty(element, 'firstChild', { get() { return this.childNodes[0] || null; } });
  return element;
}

function createFixture(options = {}) {
  let elementLookupCount = 0;
  const createdElements = {
    'run-summary': createElement('div'),
    'run-summary-title': createElement('span'),
    'run-summary-phase': createElement('span'),
    'run-summary-meta': createElement('span'),
    'run-details-toggle': createElement('button'),
    'run-details-count': createElement('span'),
    'run-log': createElement('div'),
    'panel-output': createElement('div')
  };
  createdElements['run-summary'].hidden = true;
  createdElements['run-details-toggle'].hidden = true;
  const elements = options.initiallyMissing === true ? {} : createdElements;
  const document = {
    getElementById(id) {
      elementLookupCount += 1;
      return elements[id] || null;
    },
    querySelector() { return { textContent: 'Python 3.10' }; },
    createElement,
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    createDocumentFragment() {
      const fragment = createElement('fragment');
      fragment.isFragment = true;
      return fragment;
    }
  };
  const subscribers = [];
  let locale = 'en';
  const translations = {
    zh: {
      Preparing: '正在准备',
      'Show run details': '显示运行详情',
      'Hide run details': '隐藏运行详情'
    }
  };
  const windowObject = {
    document,
    BOBO: {
      state: { runLogInitialized: true, showTimestampNextLine: false, autoScrollEnabled: true },
      i18n: {
        t(source, params) {
          let value = translations[locale] && translations[locale][source] || source;
          return String(value).replace(/\{([^}]+)\}/g, (match, key) => params && params[key] !== undefined ? params[key] : match);
        },
        onChange(callback) { subscribers.push(callback); }
      }
    }
  };
  const context = vm.createContext({
    window: windowObject,
    document,
    console,
    Date,
    Promise,
    Set,
    Number,
    setTimeout,
    clearTimeout
  });
  for (const relative of ['src/server-comm.js', 'src/run-output.js']) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, relative), 'utf8'), context, { filename: relative });
  }
  windowObject.BOBO.runOutput.init();
  return {
    windowObject,
    elements: createdElements,
    getElementLookupCount() { return elementLookupCount; },
    mountElements() { Object.assign(elements, createdElements); },
    replaceElement(id) {
      if (elements[id]) elements[id].isConnected = false;
      const replacement = createElement(createdElements[id] && createdElements[id].tagName || 'div');
      createdElements[id] = replacement;
      elements[id] = replacement;
      return replacement;
    },
    setLocale(nextLocale) {
      locale = nextLocale;
      subscribers.slice().forEach(callback => callback({ id: nextLocale }));
    }
  };
}

function outputByKind(log, kind) {
  return log.childNodes.filter(node => node.getAttribute && node.getAttribute('data-output-kind') === kind);
}

test('run output keeps infrastructure details collapsed and preserves the raw command', async () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  const longCommand = '[run:python] [docker] sh -c project_root=$PWD; export PYTHONPATH=/project-deps/python; exec python3 "$@" python-runtime main.py';

  BOBO.runOutput.begin({ target: 'main.py' });
  BOBO.runOutput.handleStatus({ type: 'status', stage: 'docker', message: '[docker] Container reused (idle pool): abc123' });
  BOBO.runOutput.handleStatus({ type: 'status', stage: 'run:python', message: longCommand });
  BOBO.updateRunOutput('hello from user code');
  await new Promise(resolve => setTimeout(resolve, 230));

  assert.equal(fixture.elements['run-summary'].hidden, false);
  assert.equal(fixture.elements['run-summary-title'].textContent, 'main.py');
  assert.equal(fixture.elements['run-summary-phase'].textContent, 'Running');
  assert.equal(fixture.elements['run-summary-meta'].textContent, 'Python 3.10');
  assert.equal(fixture.elements['run-log'].classList.contains('show-run-details'), false);

  const details = outputByKind(fixture.elements['run-log'], 'detail');
  const program = outputByKind(fixture.elements['run-log'], 'program');
  assert.equal(details.length, 3);
  assert.equal(program.length, 1);
  assert.equal(program[0].innerHTML, 'hello from user code');
  assert.match(details[2].innerHTML, /Program process started/);
  assert.doesNotMatch(details[2].innerHTML, /PYTHONPATH/);
  assert.equal(details[2].getAttribute('title'), longCommand);

  fixture.elements['run-details-toggle'].click();
  assert.equal(fixture.elements['run-details-toggle'].getAttribute('aria-expanded'), 'true');
  assert.equal(fixture.elements['run-log'].classList.contains('show-run-details'), true);
});

test('exit code 137 is explained without claiming a specific server cause', () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'animation.py' });
  BOBO.runOutput.finish({ success: false, returnCode: 137 });

  assert.equal(fixture.elements['run-summary'].dataset.state, 'failed');
  assert.match(fixture.elements['run-summary-phase'].textContent, /forcibly terminated/);
  assert.match(fixture.elements['run-summary-meta'].textContent, /Exit code 137/);
  assert.doesNotMatch(fixture.elements['run-summary-phase'].textContent, /out of memory|OOM/i);

  BOBO.runOutput.finish({ success: true, returnCode: 0 });
  assert.equal(fixture.elements['run-summary'].dataset.state, 'failed', 'late terminal events must not overwrite the first result');
});

test('program and technical-detail retention limits are independent', async () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'main.py' });
  for (let i = 0; i < 350; i++) BOBO.runOutput.detail('detail-' + i);
  for (let i = 0; i < 5050; i++) BOBO.updateRunOutput('program-' + i);
  await new Promise(resolve => setTimeout(resolve, 230));

  const log = fixture.elements['run-log'];
  assert.equal(outputByKind(log, 'detail').length, 300);
  assert.equal(fixture.elements['run-details-count'].textContent, '300+');
  assert.equal(fixture.elements['run-details-count'].hidden, false);
  assert.equal(outputByKind(log, 'program').length, 5000);
  assert.match(outputByKind(log, 'program')[0].innerHTML, /program-50/);
  const omission = outputByKind(log, 'notice');
  assert.equal(omission.length, 1);
  assert.match(omission[0].textContent, /Earlier output omitted: 50 lines/);
});

test('setup fragment continuations do not inflate the detail count', () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'main.py' });
  BOBO.runOutput.detail('install 1%', {
    stage: 'setup', streamFragment: true, streamKey: 'stdout:setup'
  });
  BOBO.runOutput.detail('install 50%', {
    stage: 'setup', streamFragment: true, streamKey: 'stdout:setup', replace: true
  });
  BOBO.runOutput.detail('', {
    stage: 'setup', streamFragment: true, streamKey: 'stdout:setup', append: true, newline: true
  });
  assert.equal(fixture.elements['run-details-count'].textContent, '2');
});

test('stream continuations reuse output DOM references without summary lookups', () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'main.py' });
  BOBO.runOutput.detail('install 1%', {
    stage: 'setup', streamFragment: true, streamKey: 'stdout:setup'
  });
  const lookupsBeforeContinuations = fixture.getElementLookupCount();

  for (let index = 2; index <= 101; index += 1) {
    BOBO.runOutput.detail('install ' + index + '%', {
      stage: 'setup', streamFragment: true, streamKey: 'stdout:setup', replace: true
    });
  }

  assert.equal(fixture.getElementLookupCount(), lookupsBeforeContinuations);
  assert.equal(fixture.elements['run-details-count'].textContent, '2');
});

test('output DOM caches recover from initial absence and node replacement', () => {
  const fixture = createFixture({ initiallyMissing: true });
  const BOBO = fixture.windowObject.BOBO;

  BOBO.updateRunOutput('before mount');
  BOBO.runOutput.begin({ target: 'before-mount.py' });
  fixture.mountElements();
  BOBO.clearRunOutput();
  BOBO.runOutput.begin({ target: 'mounted.py' });
  assert.equal(fixture.elements['run-summary'].hidden, false);
  assert.equal(fixture.elements['run-summary-title'].textContent, 'mounted.py');

  fixture.replaceElement('run-summary');
  fixture.replaceElement('run-summary-title');
  const replacementLog = fixture.replaceElement('run-log');
  BOBO.runOutput.phase('running');
  BOBO.updateRunOutput('after replacement');

  assert.equal(fixture.elements['run-summary'].hidden, false);
  assert.equal(fixture.elements['run-summary-title'].textContent, 'mounted.py');
  assert.match(replacementLog.childNodes[0].innerHTML, /after replacement/);
});

test('locale refresh changes the summary controls without rewriting program output', async () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'main.py', runtime: 'Python 3.10' });
  BOBO.updateRunOutput('literal user output');
  await new Promise(resolve => setTimeout(resolve, 230));

  const program = outputByKind(fixture.elements['run-log'], 'program')[0];
  fixture.setLocale('zh');
  assert.equal(fixture.elements['run-summary-phase'].textContent, '正在准备');
  assert.equal(fixture.elements['run-details-toggle'].getAttribute('title'), '显示运行详情');
  assert.equal(program.innerHTML, 'literal user output');
});

test('starting another run removes stale technical details while preserving program output', async () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'first.py' });
  BOBO.runOutput.detail('old container detail');
  BOBO.updateRunOutput('first run program output');
  await new Promise(resolve => setTimeout(resolve, 230));
  BOBO.runOutput.finish({ success: true, returnCode: 0 });

  BOBO.runOutput.begin({ target: 'second.py' });
  BOBO.runOutput.detail('new container detail');
  await new Promise(resolve => setTimeout(resolve, 230));

  const log = fixture.elements['run-log'];
  const details = outputByKind(log, 'detail').map(node => node.innerHTML);
  const program = outputByKind(log, 'program').map(node => node.innerHTML);
  assert.equal(details.some(line => /old container detail/.test(line)), false);
  assert.equal(details.some(line => /new container detail/.test(line)), true);
  assert.equal(program.some(line => /first run program output/.test(line)), true);
});

test('clearing an active transcript preserves lifecycle state but completed runs clear fully', () => {
  const fixture = createFixture();
  const BOBO = fixture.windowObject.BOBO;
  BOBO.runOutput.begin({ target: 'main.py' });
  BOBO.clearRunOutput();
  BOBO.runOutput.clearTranscript();

  assert.equal(fixture.elements['run-summary'].hidden, false);
  assert.equal(fixture.elements['run-summary'].dataset.state, 'running');
  assert.equal(fixture.elements['run-details-count'].hidden, true);

  BOBO.runOutput.finish({ success: true, returnCode: 0 });
  BOBO.clearRunOutput();
  BOBO.runOutput.clearTranscript();
  assert.equal(fixture.elements['run-summary'].hidden, true);
  assert.equal(fixture.elements['run-details-toggle'].hidden, true);
});
