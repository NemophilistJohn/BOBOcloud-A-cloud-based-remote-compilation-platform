'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const rclone = require('../rclone');
const { getCachePaths } = require('../scripts/prepare-rclone');

function managedRclonePath() {
  return getCachePaths(process.platform, process.arch).binaryPath;
}

test('checks exactly the managed rclone executable supplied by main', async () => {
  const executable = managedRclonePath();
  assert.equal(fs.existsSync(executable), true, 'Run npm run prepare:rclone before the client test suite');
  const result = await rclone.checkVersion(executable, 'bundled');
  assert.equal(result.available, true);
  assert.equal(result.path, executable);
  assert.equal(result.source, 'bundled');
  assert.match(result.version, /^rclone v/);
});

test('does not search PATH or accept relative executable names', async () => {
  const result = await rclone.checkVersion(rclone.EXE_NAME, 'system');
  assert.equal(result.available, false);
  assert.match(result.error, /managed absolute rclone executable path is required/);
});

test('rejects an arbitrary executable that does not identify itself as rclone', async () => {
  const result = await rclone.checkVersion(process.execPath, 'system');
  assert.equal(result.available, false);
  assert.equal(result.code, 'INVALID_RCLONE');
  assert.match(result.error, /identify itself as rclone/);
});

test('sync fails closed when main does not provide a managed executable', async () => {
  const result = await rclone.sync({ src: 'source', remotePath: 'remote', retries: 0 });
  assert.equal(result.success, false);
  assert.equal(result.error.type, 'EXECUTABLE_UNAVAILABLE');
});

test('rclone config must use an explicit app-managed absolute file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'private', 'rclone.conf');
  assert.equal(rclone.requireManagedConfig(configPath, true), configPath);
  assert.equal(fs.statSync(path.dirname(configPath)).isDirectory(), true);
  assert.throws(() => rclone.requireManagedConfig('rclone.conf', true), /app-managed absolute/);
  assert.throws(() => rclone.requireManagedConfig(configPath, false), /config is missing/);
  fs.writeFileSync(configPath, '[remote]\n');
  assert.equal(rclone.requireManagedConfig(configPath, false), configPath);
});

test('SFTP passwords travel through stdin and never enter process arguments, config logs, or errors', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-secret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'private', 'rclone.conf');
  const invocations = [];
  let stdin = '';
  const result = await rclone.ensureConfig({
    ip: 'compiler.example', user: 'builder', pass: ' ssh-secret-value '
  }, process.execPath, configPath, {
    checkVersion: async (executablePath) => ({ available: true, path: executablePath }),
    execFile(executablePath, args, options, callback) {
      invocations.push({ executablePath, args, options });
      return {
        stdin: {
          on() {},
          end(value) {
            stdin = value;
            setImmediate(() => callback(null, 'protected-rclone-value\n', ''));
          }
        }
      };
    }
  });
  assert.equal(result.success, true);
  assert.equal(stdin, ' ssh-secret-value \n');
  assert.deepEqual(invocations[0].args, ['obscure', '-']);
  assert.doesNotMatch(JSON.stringify(invocations), /ssh-secret-value/);
  const stored = fs.readFileSync(configPath, 'utf8');
  assert.match(stored, /pass = protected-rclone-value/);
  assert.doesNotMatch(stored, /ssh-secret-value/);

  const failed = await rclone.ensureConfig({
    ip: 'compiler.example', user: 'builder', pass: 'another-secret'
  }, process.execPath, path.join(root, 'private', 'failed.conf'), {
    checkVersion: async (executablePath) => ({ available: true, path: executablePath }),
    execFile(_executablePath, _args, _options, callback) {
      return {
        stdin: {
          on() {},
          end() {
            const error = Object.assign(new Error('command failed with another-secret'), { code: 9 });
            setImmediate(() => callback(error, '', 'another-secret'));
          }
        }
      };
    }
  });
  assert.equal(failed.success, false);
  assert.doesNotMatch(JSON.stringify(failed), /another-secret|command failed/);
});

test('SFTP connection validation is bounded and returns only classified errors', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone.conf');
  fs.writeFileSync(configPath, '[cloud-compiler-sftp]\n');
  let suppliedArgs;
  const result = await rclone.checkConnection({
    executablePath: process.execPath,
    configPath,
    execFile(_executablePath, args, options, callback) {
      suppliedArgs = args;
      assert.ok(options.timeout <= 15000);
      assert.ok(options.maxBuffer <= 64 * 1024);
      const error = Object.assign(new Error('command exposed C:\\private\\rclone.conf'), { code: 1 });
      setImmediate(() => callback(error, '', 'permission denied for hidden-secret'));
    }
  });
  assert.deepEqual(suppliedArgs.slice(2), [
    'lsjson', 'cloud-compiler-sftp:', '--stat', '--no-modtime', '--no-mimetype'
  ]);
  assert.equal(result.success, false);
  assert.equal(result.error.type, 'AUTH_FAILED');
  assert.equal(result.error.message, 'Authentication failed');
  assert.doesNotMatch(JSON.stringify(result), /hidden-secret|private/);
});

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = onKill || (() => true);
  return child;
}

test('core default exclusions cannot be disabled with an empty array', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-excludes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone.conf');
  fs.writeFileSync(configPath, '[remote]\n');
  let args = [];
  const result = await rclone.syncOnce({
    executablePath: process.execPath,
    configPath,
    src: root,
    remotePath: '/remote/workspace',
    excludes: [],
    spawn(_exe, suppliedArgs) {
      args = suppliedArgs;
      const child = fakeChild();
      setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
  });
  assert.equal(result.success, true);
  const exclusions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--exclude') exclusions.push(args[index + 1]);
  }
  assert.deepEqual(exclusions, rclone.DEFAULT_EXCLUDES);
});

test('abort waits for graceful termination and escalates to a confirmed force kill', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-rclone-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'rclone.conf');
  fs.writeFileSync(configPath, '[remote]\n');
  const controller = new AbortController();
  const signals = [];
  let child;
  let taskkillExecutable = '';
  const running = rclone.syncOnce({
    executablePath: process.execPath,
    configPath,
    src: root,
    remotePath: '/remote/workspace',
    signal: controller.signal,
    killGraceMs: 5,
    killConfirmationMs: 100,
    spawn() {
      child = fakeChild((signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          child.signalCode = signal;
          setImmediate(() => child.emit('close', null));
        }
        return true;
      });
      return child;
    },
    execFile(executable, _args, _options, callback) {
      taskkillExecutable = executable;
      child.signalCode = 'SIGKILL';
      setImmediate(() => {
        callback(null, '', '');
        child.emit('close', null);
      });
    }
  });
  controller.abort();
  const result = await running;
  assert.equal(result.success, false);
  assert.equal(result.error.type, 'CANCELLED');
  assert.equal(signals[0], 'SIGTERM');
  if (process.platform === 'win32') {
    assert.equal(path.isAbsolute(taskkillExecutable), true);
    assert.match(taskkillExecutable, /[\\/]System32[\\/]taskkill\.exe$/i);
  } else {
    assert.equal(signals.includes('SIGKILL'), true);
  }
});
