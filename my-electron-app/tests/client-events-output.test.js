'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadScript(relativePath, windowObject, extras) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  const context = vm.createContext(Object.assign({
    window: windowObject,
    document: windowObject.document,
    console,
    crypto: { randomUUID: (() => {
      let value = 0;
      return () => 'uuid-' + (++value);
    })() },
    Date,
    Promise,
    setTimeout,
    clearTimeout
  }, extras || {}));
  vm.runInContext(source, context, { filename: relativePath });
  return context;
}

function createElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    attributes: {},
    className: '',
    innerHTML: '',
    textContent: '',
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 100,
    appendChild(child) {
      if (child && child.isFragment) {
        const children = child.childNodes.slice();
        children.forEach((entry) => this.appendChild(entry));
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
      if (index !== -1) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; }
  };
  Object.defineProperty(element, 'firstChild', { get() { return this.childNodes[0] || null; } });
  return element;
}

function createDocument(elements) {
  return {
    getElementById(id) { return elements[id] || null; },
    createElement,
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    createDocumentFragment() {
      const fragment = createElement('fragment');
      fragment.isFragment = true;
      return fragment;
    }
  };
}

test('preload subscriptions return exact disposers and scope rclone progress', () => {
  const subscriptions = new Map();
  let exposedApi = null;
  const ipcRenderer = {
    on(channel, listener) {
      if (!subscriptions.has(channel)) subscriptions.set(channel, []);
      subscriptions.get(channel).push(listener);
    },
    removeListener(channel, listener) {
      const current = subscriptions.get(channel) || [];
      subscriptions.set(channel, current.filter(item => item !== listener));
    },
    removeAllListeners() {
      throw new Error('removeAllListeners must never be used by a disposer');
    },
    invoke() { return Promise.resolve(); },
    send() {}
  };
  const contextBridge = {
    exposeInMainWorld(_name, value) { exposedApi = value; }
  };
  const source = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(id) {
      assert.equal(id, 'electron');
      return { contextBridge, ipcRenderer };
    }
  }, { filename: 'preload.js' });

  const first = [];
  const second = [];
  const disposeFirst = exposedApi.onRcloneProgress('op-first', line => first.push(line));
  const disposeSecond = exposedApi.onRcloneProgress('op-second', line => second.push(line));
  const legacy = [];
  const disposeLegacy = exposedApi.onRcloneProgress(line => legacy.push(line));
  const emit = payload => (subscriptions.get('rclone:progress') || []).slice()
    .forEach(listener => listener({}, payload));

  emit({ operationId: 'op-first', line: 'one' });
  emit({ operationId: 'op-second', line: 'two' });
  assert.deepEqual(first, ['one']);
  assert.deepEqual(second, ['two']);
  assert.deepEqual(legacy, ['one', 'two']);

  disposeFirst();
  assert.equal(subscriptions.get('rclone:progress').length, 2);
  emit({ operationId: 'op-first', line: 'ignored' });
  emit({ operationId: 'op-second', line: 'still-active' });
  assert.deepEqual(first, ['one']);
  assert.deepEqual(second, ['two', 'still-active']);
  assert.deepEqual(legacy, ['one', 'two', 'ignored', 'still-active']);
  disposeSecond();
  assert.equal(subscriptions.get('rclone:progress').length, 1);
  emit('legacy-line');
  assert.deepEqual(legacy, ['one', 'two', 'ignored', 'still-active', 'legacy-line']);
  disposeLegacy();
  assert.equal(subscriptions.get('rclone:progress').length, 0);

  let workspacePayload = null;
  const disposeWorkspace = exposedApi.onWorkspaceOpened(value => { workspacePayload = value; });
  subscriptions.get('workspace-opened')[0]({}, { rootPath: 'demo' });
  assert.equal(workspacePayload.rootPath, 'demo');
  disposeWorkspace();
  assert.equal(subscriptions.get('workspace-opened').length, 0);
});

test('rclone operations isolate progress by operation id and dispose exactly one subscription', async () => {
  const listeners = new Map();
  const invocations = [];
  const pending = [];
  const api = {
    onRcloneProgress(operationId, callback) {
      listeners.set(operationId, { callback, operationId });
      let disposed = false;
      return () => {
        assert.equal(disposed, false, 'operation disposer called more than once');
        disposed = true;
        listeners.delete(operationId);
      };
    },
    rcloneSync(payload) {
      invocations.push({ kind: 'sync', payload });
      return new Promise((resolve) => pending.push({ operationId: payload.operationId, resolve }));
    },
    rclonePull(payload) {
      invocations.push({ kind: 'pull', payload });
      return new Promise((resolve) => pending.push({ operationId: payload.operationId, resolve }));
    },
    rcloneCheckVersion() { return Promise.resolve({ available: true }); }
  };
  const syncLines = [];
  const pullLines = [];
  const windowObject = {
    api,
    BOBO: { state: { serverSettings: { rclonePath: 'rclone-bin' } } }
  };
  loadScript('src/rclone-client.js', windowObject);

  const syncPromise = windowObject.BOBO.rclone.sync({ src: 'a', remotePath: 'ra', onProgress: line => syncLines.push(line) });
  const pullPromise = windowObject.BOBO.rclone.pull({ dest: 'b', remotePath: 'rb', onProgress: line => pullLines.push(line) });
  const syncId = invocations[0].payload.operationId;
  const pullId = invocations[1].payload.operationId;
  assert.notEqual(syncId, pullId);
  assert.equal(invocations[0].payload.operationId, syncId);
  assert.equal(invocations[1].payload.operationId, pullId);

  listeners.get(syncId).callback('sync only', { operationId: syncId, line: 'sync only' });
  listeners.get(pullId).callback('pull only', { operationId: pullId, line: 'pull only' });
  assert.deepEqual(syncLines, ['sync only']);
  assert.deepEqual(pullLines, ['pull only']);

  // A legacy bare progress line cannot be attributed while two operations run.
  listeners.forEach(listener => listener.callback('ambiguous', { operationId: '', line: 'ambiguous' }));
  assert.deepEqual(syncLines, ['sync only']);
  assert.deepEqual(pullLines, ['pull only']);

  pending.find(item => item.operationId === syncId).resolve({ success: true });
  await syncPromise;
  assert.equal(listeners.has(syncId), false);
  assert.equal(listeners.has(pullId), true);
  listeners.get(pullId).callback('legacy-single', { operationId: '', line: 'legacy-single' });
  assert.deepEqual(pullLines, ['pull only', 'legacy-single']);
  pending.find(item => item.operationId === pullId).resolve({ success: true });
  await pullPromise;
  assert.equal(listeners.size, 0);
});

test('run output appends escaped batches without rewriting existing DOM', async () => {
  const runLog = createElement('pre');
  const panel = createElement('div');
  panel.clientHeight = 10;
  const document = createDocument({ 'run-log': runLog, 'panel-output': panel });
  const windowObject = {
    document,
    BOBO: { state: { runLogInitialized: true, showTimestampNextLine: false, autoScrollEnabled: true } }
  };
  loadScript('src/server-comm.js', windowObject, {
    fetch: () => { throw new Error('not used'); }
  });

  for (let i = 0; i < 50; i++) windowObject.BOBO.updateRunOutput(i === 0 ? '<script>bad()</script>' : 'line-' + i);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 50);
  const firstNode = runLog.firstChild;
  assert.match(firstNode.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(firstNode.innerHTML, /<script>/);

  for (let i = 50; i < 100; i++) windowObject.BOBO.updateRunOutput('line-' + i);
  assert.equal(runLog.childNodes.length, 100);
  assert.equal(runLog.firstChild, firstNode, 'existing lines should not be recreated on append');

  for (let i = 100; i < 5050; i++) windowObject.BOBO.updateRunOutput('line-' + i);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 5000);
  assert.notEqual(runLog.firstChild, firstNode, 'oldest output should be evicted at the hard limit');
});

test('run output keeps escaped Python traceback locations clickable', () => {
  const runLog = createElement('pre');
  const panel = createElement('div');
  const document = createDocument({ 'run-log': runLog, 'panel-output': panel });
  const windowObject = {
    document,
    BOBO: { state: { runLogInitialized: true, showTimestampNextLine: false, autoScrollEnabled: true } }
  };
  loadScript('src/server-comm.js', windowObject, {
    fetch: () => { throw new Error('not used'); }
  });

  windowObject.BOBO.updateRunOutput('Traceback: File "src/main.py", line 10');
  assert.match(runLog.firstChild.innerHTML, /class="err-link"/);
  assert.match(runLog.firstChild.innerHTML, /data-file="src\/main\.py"/);
  assert.match(runLog.firstChild.innerHTML, /data-line="10"/);
});

test('external output clear discards an older pending batch', async () => {
  const runLog = createElement('pre');
  const panel = createElement('div');
  const document = createDocument({ 'run-log': runLog, 'panel-output': panel });
  const windowObject = {
    document,
    BOBO: { state: { runLogInitialized: true, showTimestampNextLine: false, autoScrollEnabled: true } }
  };
  loadScript('src/server-comm.js', windowObject, {
    fetch: () => { throw new Error('not used'); }
  });

  for (let i = 0; i < 50; i++) windowObject.BOBO.updateRunOutput('rendered-' + i);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 50);
  windowObject.BOBO.updateRunOutput('pending-before-clear');
  runLog.childNodes.splice(0);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 0);

  windowObject.BOBO.updateRunOutput('after-clear');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 1);
  assert.equal(runLog.firstChild.innerHTML, 'after-clear');
});

test('the first output line is visible immediately and stays cleared', async () => {
  const runLog = createElement('pre');
  const panel = createElement('div');
  const document = createDocument({ 'run-log': runLog, 'panel-output': panel });
  const windowObject = {
    document,
    BOBO: { state: { runLogInitialized: true, showTimestampNextLine: false, autoScrollEnabled: true } }
  };
  loadScript('src/server-comm.js', windowObject, {
    fetch: () => { throw new Error('not used'); }
  });

  windowObject.BOBO.updateRunOutput('first');
  assert.equal(runLog.childNodes.length, 1);
  runLog.childNodes.splice(0);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(runLog.childNodes.length, 0);
});

test('terminal carries ANSI styling across lines and appends safely', () => {
  const output = createElement('pre');
  const document = createDocument({ 'terminal-output': output });
  const windowObject = {
    document,
    BOBO: { state: { setupCommands: [], selectedRuntime: '' } }
  };
  loadScript('src/terminal.js', windowObject);

  // Drive append through the public Docker status path, which flushes synchronously.
  windowObject.BOBO.sendToServer = () => Promise.resolve({
    success: true,
    message: '\u001b[1;31mred-one\nred-two\u001b[0m\n<script>bad()</script>'
  });
  windowObject.BOBO.terminal.checkDockerStatus();
  return new Promise(resolve => {
    setTimeout(() => {
      assert.equal(output.childNodes.length, 3);
      assert.match(output.childNodes[0].innerHTML, /color:var\(--red\)/);
      assert.match(output.childNodes[0].innerHTML, /font-weight:bold/);
      assert.match(output.childNodes[1].innerHTML, /color:var\(--red\)/);
      assert.match(output.childNodes[1].innerHTML, /font-weight:bold/);
      assert.doesNotMatch(output.childNodes[1].innerHTML, /<\/span>\s*<\/span>/);
      assert.match(output.childNodes[2].innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
      assert.doesNotMatch(output.childNodes[2].innerHTML, /color:var\(--red\)/);
      assert.doesNotMatch(output.childNodes[2].innerHTML, /<script>/);
      resolve();
    }, 0);
  });
});

test('terminal DOM stays bounded during repeated command output', async () => {
  const output = createElement('pre');
  const input = createElement('input');
  input.value = 'emit-lines';
  const document = createDocument({ 'terminal-output': output, 'terminal-input': input });
  const windowObject = {
    document,
    BOBO: { state: { setupCommands: [], selectedRuntime: 'python:3.11' } }
  };
  loadScript('src/terminal.js', windowObject);
  windowObject.BOBO.sendToServer = () => Promise.resolve({
    success: true,
    stdout: Array.from({ length: 3050 }, (_value, index) => 'row-' + index).join('\n'),
    exitCode: 0
  });
  await windowObject.BOBO.terminal.sendCommand();
  assert.equal(output.childNodes.length, 3000);
  assert.equal(output.childNodes[0].innerHTML, 'row-50');
  assert.equal(output.childNodes[2999].innerHTML, 'row-3049');
});
