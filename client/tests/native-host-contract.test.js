const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const CLIENT_ROOT = path.resolve(__dirname, '..');

function sourceFile(relativePath, scriptKind) {
  const absolutePath = path.join(CLIENT_ROOT, relativePath);
  return ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
}

function propertyName(node) {
  if (!node || !node.name) return '';
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return '';
}

function interfaceKeys(relativePath, interfaceName) {
  const source = sourceFile(relativePath, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement) => (
    ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  ));
  assert.ok(declaration, `missing ${interfaceName} in ${relativePath}`);
  return [...new Set(declaration.members.map(propertyName).filter(Boolean))].sort();
}

function loadPreloadApi() {
  let exposedApi = null;
  const contextBridge = {
    exposeInMainWorld(name, value) {
      assert.equal(name, 'api');
      exposedApi = value;
    }
  };
  const ipcRenderer = {
    invoke() { return Promise.resolve(undefined); },
    send() {},
    on() {},
    removeListener() {}
  };
  const source = fs.readFileSync(path.join(CLIENT_ROOT, 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    Buffer,
    Error,
    require(id) {
      if (id === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${id}`);
    }
  }, { filename: 'preload.js' });
  assert.ok(exposedApi);
  return exposedApi;
}

function preloadChannels() {
  const source = sourceFile('preload.js', ts.ScriptKind.JS);
  const channels = {
    invoke: new Set(),
    send: new Set(),
    event: new Set()
  };

  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const firstArgument = node.arguments[0];
      if (ts.isStringLiteral(firstArgument)) {
        if (ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === 'ipcRenderer') {
          if (node.expression.name.text === 'invoke') channels.invoke.add(firstArgument.text);
          if (node.expression.name.text === 'send') channels.send.add(firstArgument.text);
        } else if (ts.isIdentifier(node.expression)
            && (node.expression.text === 'subscribe' || node.expression.text === 'subscribePayload')) {
          channels.event.add(firstArgument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return channels;
}

test('NativeHost declarations cover the complete preload compatibility bridge', () => {
  const api = loadPreloadApi();
  assert.deepEqual(Object.keys(api).sort(), interfaceKeys('types/native-host.ts', 'NativeHost'));
  assert.deepEqual(Object.keys(api.plugins).sort(), interfaceKeys('types/native-host.ts', 'NativeHostPlugins'));
  assert.deepEqual(
    Object.keys(api.plugins.documents).sort(),
    interfaceKeys('types/native-host.ts', 'NativeHostPluginDocuments')
  );
  assert.deepEqual(
    Object.keys(api.plugins.marketplace).sort(),
    interfaceKeys('types/native-host.ts', 'NativeHostPluginMarketplace')
  );
});

test('IPC contract declarations cover every channel exposed by preload', () => {
  const channels = preloadChannels();
  assert.deepEqual([...channels.invoke].sort(), interfaceKeys('types/ipc-contracts.ts', 'IpcInvokeContracts'));
  assert.deepEqual([...channels.send].sort(), interfaceKeys('types/ipc-contracts.ts', 'IpcSendContracts'));
  assert.deepEqual([...channels.event].sort(), interfaceKeys('types/ipc-contracts.ts', 'IpcEventContracts'));
});
