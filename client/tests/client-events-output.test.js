'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const pluginRpcTransport = require('../main/plugin-rpc-transport');

function loadPreloadApi(ipcRenderer) {
  let exposedApi = null;
  const contextBridge = {
    exposeInMainWorld(_name, value) { exposedApi = value; }
  };
  const source = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(id) {
      if (id === 'electron') return { contextBridge, ipcRenderer };
      throw new Error('Unexpected preload dependency: ' + id);
    }
  }, { filename: 'preload.js' });
  assert.ok(exposedApi);
  return exposedApi;
}

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
  const exposedApi = loadPreloadApi(ipcRenderer);

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

test('preload plugin RPC forwards structured main-process results unchanged', async () => {
  const invocations = [];
  let response = pluginRpcTransport.pluginRpcSuccess({ repositories: [] });
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke(channel, payload) {
      invocations.push({ channel, payload });
      return Promise.resolve(response);
    },
    send() {}
  };
  const exposedApi = loadPreloadApi(ipcRenderer);

  assert.equal(
    await exposedApi.plugins.rpc('bobocloud.local-scm', 'scm.git.detect', { includeNested: false }),
    response
  );
  assert.deepEqual(JSON.parse(JSON.stringify(invocations[0])), {
    channel: 'plugins:rpc',
    payload: {
      pluginId: 'bobocloud.local-scm',
      method: 'scm.git.detect',
      args: { includeNested: false }
    }
  });

  const source = new Error('Open a local workspace before using source control.');
  source.code = 'SCM_GIT_NO_WORKSPACE';
  response = pluginRpcTransport.pluginRpcFailure(source);
  assert.equal(await exposedApi.plugins.rpc('bobocloud.local-scm', 'scm.git.detect', {}), response);
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
    BOBO: { state: { serverSettings: {}, workspaceRoot: 'a', workspaceIdentity: 7 } }
  };
  loadScript('src/rclone-client.js', windowObject);

  const syncPromise = windowObject.BOBO.rclone.sync({ src: 'a', remotePath: 'ra', onProgress: line => syncLines.push(line) });
  const pullPromise = windowObject.BOBO.rclone.pull({ dest: 'a', remotePath: 'rb', onProgress: line => pullLines.push(line) });
  const syncId = invocations[0].payload.operationId;
  const pullId = invocations[1].payload.operationId;
  assert.notEqual(syncId, pullId);
  assert.equal(invocations[0].payload.operationId, syncId);
  assert.equal(invocations[1].payload.operationId, pullId);
  assert.equal(Object.hasOwn(invocations[0].payload, 'rclonePath'), false);
  assert.equal(Object.hasOwn(invocations[1].payload, 'rclonePath'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(invocations[0].payload.localScope)), {
    type: 'workspace', rootPath: 'a', workspaceIdentity: 7
  });
  assert.equal(Object.hasOwn(invocations[0].payload, 'src'), false);
  assert.equal(Object.hasOwn(invocations[1].payload, 'dest'), false);

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
  assert.equal(runLog.childNodes.filter(node => node.getAttribute('data-output-kind') === 'program').length, 5000);
  const omission = runLog.childNodes.find(node => node.getAttribute('data-output-omission') === 'true');
  assert.ok(omission);
  assert.match(omission.textContent, /Earlier output omitted: 50 lines/);
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

test('terminal rendering stays behind the sender-bound main-process bridge', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'terminal.js'), 'utf8');
  assert.match(source, /global\.api\.terminalStart\(request\)/);
  assert.match(source, /global\.api\.terminalWrite\(entry\.data\)/);
  assert.match(source, /global\.api\.onTerminalOutput\(handleTerminalOutput\)/);
  assert.match(source, /global\.api\.onTerminalStatus\(handleTerminalStatus\)/);
  assert.match(source, /global\.api\.onTerminalPackageIntent\(handleTerminalPackageIntent\)/);
  assert.match(source, /applyManagedPackageChanges\(terminalIntentChanges\(event\)/);
  assert.match(source, /manager:\s*String\(event\.manager \|\| ''\)/);
  assert.match(source, /\['runtime', 'dev', 'optional'\]\.indexOf\(requestedScope\) >= 0/);
  assert.match(source, /scope: validScope \? requestedScope : 'runtime'/);
  assert.match(source, /case 'unsupported_option':[\s\S]*?This terminal library command cannot be managed automatically\. Use Package Center instead\./);
  assert.match(source, /case 'unsupported_command':[\s\S]*?This terminal library command cannot be managed automatically\. Use Package Center instead\./);
  assert.doesNotMatch(source, /This pip (?:option|command)/);
  assert.doesNotMatch(source, /sendToServer\(['"]terminal['"]/);
  assert.doesNotMatch(source, /getElementById\(['"]terminal-input['"]\)/);
  assert.doesNotMatch(source, /getElementById\(['"]terminal-output['"]\)/);
  assert.match(source, /setupCommands:\s*Array\.isArray\(S\.setupCommands\)/);
});
