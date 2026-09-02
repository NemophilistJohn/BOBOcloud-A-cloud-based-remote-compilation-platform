'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = [path.join(ROOT, 'renderer'), path.join(ROOT, 'src')];
const NATIVE_HOST_ADAPTER = 'renderer/core/native-host-adapter.ts';
const LEGACY_DIRECT_ACCESS_LIMITS = new Map([
  ['renderer/core/plugin-extension-bootstrap.js', 2],
  ['src/agent-workbench.js', 7],
  ['src/ai-agent-button.js', 3],
  ['src/ai-chat-panel.js', 7],
  ['src/ai-service.js', 16],
  ['src/app.js', 23],
  ['src/auth.js', 16],
  ['src/collaboration.js', 6],
  ['src/dap-client.js', 27],
  ['src/diagnostics-settings.js', 4],
  ['src/document-views.js', 2],
  ['src/editor-core.js', 3],
  ['src/environment-center.js', 6],
  ['src/i18n.js', 22],
  ['src/lsp-client.js', 56],
  ['src/package-center.js', 1],
  ['src/plugin-details.js', 6],
  ['src/plugin-manager-ui.js', 5],
  ['src/project-tasks.js', 3],
  ['src/projects.js', 5],
  ['src/runner.js', 15],
  ['src/settings.js', 3],
  ['src/terminal.js', 30],
  ['src/views.js', 2],
  ['src/workspace-launch.js', 9],
  ['src/workspace-settings.js', 6],
  ['src/workspace.js', 28]
]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|ts)$/.test(entry.name) ? [target] : [];
  });
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function directBridgeAccessCount(file, source) {
  const scriptKind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  let count = 0;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'api' &&
        ts.isIdentifier(node.expression) && (node.expression.text === 'window' || node.expression.text === 'global')) {
      count += 1;
    } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
        (node.expression.text === 'window' || node.expression.text === 'global') &&
        ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'api') {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

test('renderer bridge access is confined to the adapter and bounded legacy callers', () => {
  const actual = new Map();
  for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    const count = directBridgeAccessCount(file, source);
    if (count) actual.set(relative(file), count);
  }

  assert.equal(actual.get(NATIVE_HOST_ADAPTER), 1,
    'the native host adapter must be the only new renderer bridge entrypoint');
  actual.delete(NATIVE_HOST_ADAPTER);

  for (const [file, count] of actual) {
    assert.equal(file.endsWith('.ts'), false, `TypeScript module bypasses the native host adapter: ${file}`);
    assert.equal(LEGACY_DIRECT_ACCESS_LIMITS.has(file), true, `new direct native host access: ${file}`);
    assert.ok(count <= LEGACY_DIRECT_ACCESS_LIMITS.get(file),
      `direct native host access increased in ${file}: ${count}`);
  }

  for (const [file, limit] of LEGACY_DIRECT_ACCESS_LIMITS) {
    const count = actual.get(file) || 0;
    assert.ok(count <= limit, `direct native host access increased in ${file}: ${count}`);
  }

  assert.equal(actual.has('src/rclone-client.js'), false,
    'the migrated rclone slice must not regain a direct preload dependency');
});

test('native host services remain private to the workbench', () => {
  const adapter = fs.readFileSync(path.join(ROOT, NATIVE_HOST_ADAPTER), 'utf8');
  assert.match(adapter, /RCLONE_HOST_SERVICE_ID\s*=\s*['"]host\.rclone['"]/);
  assert.match(adapter, /exposeToPlugins:\s*false/);
  assert.doesNotMatch(adapter, /pluginView\s*:/);
});
