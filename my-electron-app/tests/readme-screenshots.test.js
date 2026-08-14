'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CAPTURE_SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'capture-readme-screenshots.js'), 'utf8');
const DAP_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'dap_adapters.json'), 'utf8'));
const DAP_BUILD = fs.readFileSync(path.join(ROOT, 'server', 'deploy', 'dap-toolkit', 'build.sh'), 'utf8');
const DAP_VERIFY = fs.readFileSync(path.join(ROOT, 'server', 'deploy', 'dap-toolkit', 'verify.sh'), 'utf8');
const DAP_SMOKE = fs.readFileSync(path.join(ROOT, 'server', 'deploy', 'dap-toolkit', 'dap-smoke.py'), 'utf8');
const DAP_NODE_DOCKERFILE = fs.readFileSync(path.join(ROOT, 'server', 'deploy', 'dap-toolkit', 'Dockerfile.node'), 'utf8');
const DAP_DOCS = fs.readFileSync(path.join(ROOT, 'docs', 'dap-server.md'), 'utf8');
const IMAGE_NAMES = ['workbench.png', 'environment-center.png', 'ai-control-center.png'];

function pngMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path.basename(filePath) + ' must be PNG');
  return { bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('README documents current client/server contracts and single-binary deployment', () => {
  assert.match(README, /客户端 \*\*2\.6\.0\*\*，服务端 \*\*2\.4\.0\*\*/);
  assert.match(README, /WebSocket `:3101\/ws`/);
  assert.match(README, /WebSocket `:3101\/term`/);
  assert.match(README, /HTTP `:3100`/);
  assert.match(README, /WebSocket `:3101\/dap`/);
  assert.match(README, /debugpy 1\.8\.16/);
  assert.match(README, /Delve 1\.24\.2/);
  assert.match(README, /Node\.js[\s\S]*child-session routing/);
  assert.doesNotMatch(README, /\| Node\.js 20、22 \|/);
  assert.match(README, /\[DAP 服务端文档\]\(docs\/dap-server\.md\)/);
  assert.match(README, /Python[\s\S]*`python:3\.13`/);
  assert.match(README, /Go[\s\S]*`go:1\.23`/);
  assert.match(README, /只保留当前 `bobocloud-server`/);
  assert.match(README, /不创建或保留 `\.bak`\/版本号快照/);
  assert.doesNotMatch(README, /renderer\.js/);
  assert.doesNotMatch(README, /Expect: \{"success":true,"authMode":"multi","version":"2\.1\.0"\}/);
});

test('DAP release artifacts advertise only verified Python and Go adapters', () => {
  assert.deepEqual(
    DAP_MANIFEST.adapters.map((adapter) => adapter.runtimeId),
    ['python:3.9', 'python:3.10', 'python:3.11', 'python:3.12', 'python:3.13', 'go:1.21', 'go:1.23']
  );
  assert.ok(DAP_MANIFEST.adapters.every((adapter) => adapter.languageId === 'python' || adapter.languageId === 'go'));
  for (const [name, source] of [['build.sh', DAP_BUILD], ['verify.sh', DAP_VERIFY]]) {
    assert.doesNotMatch(source, /dap-node|Dockerfile\.node|verify_candidate\s+node/, `${name} must not publish Node DAP`);
  }
  assert.doesNotMatch(DAP_SMOKE, /^\s*"node"\s*:/m);
  assert.match(DAP_NODE_DOCKERFILE, /Experimental groundwork only/);
  assert.match(DAP_DOCS, /Node\.js 调试延后[\s\S]*child-session routing/);
  assert.doesNotMatch(DAP_DOCS, /\| Node\.js 20、22 \|/);
});

test('README screenshot references exist and are presentation-sized PNG files', () => {
  for (const name of IMAGE_NAMES) {
    const relative = 'docs/screenshots/' + name;
    assert.match(README, new RegExp('!\\[[^\\]]+\\]\\(' + relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)'));
    const metadata = pngMetadata(path.join(ROOT, relative));
    assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 1440, height: 900 });
    assert.ok(metadata.bytes >= 10000, name + ' must contain non-trivial rendered content');
  }
});

test('docs screenshot command uses isolated local fixtures and all-or-nothing promotion', () => {
  assert.equal(PACKAGE.scripts['docs:screenshots'], 'node scripts/capture-readme-screenshots.js');
  for (const name of ['workbench.png', 'environment-center.png', 'ai-control-center.png']) {
    assert.match(CAPTURE_SCRIPT, new RegExp(name.replace('.', '\\.')));
  }
  assert.match(CAPTURE_SCRIPT, /mkdtempSync/);
  assert.match(CAPTURE_SCRIPT, /api\.example\.invalid/);
  assert.match(CAPTURE_SCRIPT, /validatePng\(stagedPath\)/);
  assert.match(CAPTURE_SCRIPT, /renameSync\(nextDirectory, SCREENSHOT_DIR\)/);
  assert.match(CAPTURE_SCRIPT, /renameSync\(previousDirectory, SCREENSHOT_DIR\)/);
  assert.match(CAPTURE_SCRIPT, /API_\?KEY\|TOKEN\|SECRET\|PASSWORD\|CREDENTIAL/);
  assert.doesNotMatch(CAPTURE_SCRIPT, /process\.env\[["'][^"']*KEY/);
  assert.doesNotMatch(CAPTURE_SCRIPT, /fetch\s*\(|https?\.request\s*\(/);
});

test('AI screenshot is publishable only after README references it', () => {
  const reference = 'docs/screenshots/ai-control-center.png';
  if (!README.includes(reference)) return;
  const metadata = pngMetadata(path.join(ROOT, reference));
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 1440, height: 900 });
  assert.ok(metadata.bytes >= 10000, 'AI control center must contain non-trivial rendered content');
});
