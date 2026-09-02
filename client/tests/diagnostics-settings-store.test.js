'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createSettingsStore,
  defaultDiagnosticsSettings,
  normalizeDiagnosticsSettings
} = require('../main/settings-store');

const CHECK_IDS = [
  'missingSemicolon',
  'strayTokens',
  'unmatchedBrackets',
  'unclosedStrings',
  'assignmentInCondition',
  'unsafeFunctions',
  'trailingWhitespace',
  'mixedIndent',
  'longLines',
  'todoComments',
  'cppModernize',
  'styleHints'
];

function createUserData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bobocloud-diagnostics-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createStore(userData) {
  return createSettingsStore({
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'userData');
        return userData;
      }
    }
  });
}

test('diagnostics normalization returns an independent complete default value', () => {
  const first = normalizeDiagnosticsSettings();
  const second = normalizeDiagnosticsSettings(null);

  assert.deepEqual(first, defaultDiagnosticsSettings());
  assert.deepEqual(second, defaultDiagnosticsSettings());
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.checks, second.checks);
  assert.deepEqual(Object.keys(first.checks), CHECK_IDS);
});

test('legacy partial diagnostics files merge with defaults on read', (t) => {
  const userData = createUserData(t);
  fs.writeFileSync(path.join(userData, 'diagnostics-settings.json'), JSON.stringify({
    enabled: false,
    checkOn: 'save',
    checks: {
      missingSemicolon: { enabled: false },
      longLines: { severity: 'hint', maxLineLength: 240 }
    }
  }), 'utf8');

  const settings = createStore(userData).readDiagnosticsSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.checkOn, 'save');
  assert.equal(settings.debounceMs, 300);
  assert.deepEqual(settings.checks.missingSemicolon, { enabled: false, severity: 'error' });
  assert.deepEqual(settings.checks.longLines, { enabled: true, severity: 'hint', maxLineLength: 240 });
  assert.deepEqual(settings.checks.styleHints, { enabled: true, severity: 'warning' });
});

test('diagnostics normalization ignores unknown, inherited, accessor, and prototype fields', () => {
  const inheritedChecks = Object.create({
    missingSemicolon: { enabled: false, severity: 'hint' }
  });
  inheritedChecks.longLines = Object.create({
    enabled: false,
    severity: 'error',
    maxLineLength: 999
  });
  inheritedChecks.unknownCheck = { enabled: false, severity: 'error' };
  Object.defineProperty(inheritedChecks, 'todoComments', {
    enumerable: true,
    get() {
      throw new Error('accessors must not run');
    }
  });

  const source = Object.create({ enabled: false, checkOn: 'save', debounceMs: 0 });
  source.checks = inheritedChecks;
  source.unknownTopLevel = true;
  Object.defineProperty(source, 'enabled', {
    enumerable: true,
    get() {
      throw new Error('accessors must not run');
    }
  });

  const normalized = normalizeDiagnosticsSettings(source);
  assert.deepEqual(normalized, defaultDiagnosticsSettings());
  assert.deepEqual(Object.keys(normalized), ['enabled', 'checkOn', 'debounceMs', 'checks']);
  assert.deepEqual(Object.keys(normalized.checks), CHECK_IDS);
  assert.equal(Object.hasOwn(normalized, 'unknownTopLevel'), false);
  assert.equal(Object.hasOwn(normalized.checks, 'unknownCheck'), false);
  assert.equal(Object.hasOwn(normalized.checks, '__proto__'), false);
});

test('diagnostics enums and numeric boundaries fail closed', () => {
  const low = normalizeDiagnosticsSettings({
    checkOn: 'invalid',
    debounceMs: -1,
    checks: {
      missingSemicolon: { severity: 'fatal', maxLineLength: 999 },
      longLines: { severity: 'hint', maxLineLength: 19 }
    }
  });
  assert.equal(low.checkOn, 'type');
  assert.equal(low.debounceMs, 0);
  assert.deepEqual(low.checks.missingSemicolon, {
    enabled: true,
    severity: 'error',
    maxLineLength: 999
  });
  assert.deepEqual(low.checks.longLines, { enabled: true, severity: 'hint', maxLineLength: 20 });

  const high = normalizeDiagnosticsSettings({
    checkOn: 'save',
    debounceMs: 5001,
    checks: { longLines: { maxLineLength: 1001 } }
  });
  assert.equal(high.checkOn, 'save');
  assert.equal(high.debounceMs, 5000);
  assert.equal(high.checks.longLines.maxLineLength, 1000);

  const nonFinite = normalizeDiagnosticsSettings({
    debounceMs: Infinity,
    checks: { longLines: { maxLineLength: NaN } }
  });
  assert.equal(nonFinite.debounceMs, 300);
  assert.equal(nonFinite.checks.longLines.maxLineLength, 120);
});

test('partial diagnostics writes persist and round-trip only normalized fields', (t) => {
  const userData = createUserData(t);
  const store = createStore(userData);
  const malicious = JSON.parse(`{
    "enabled": false,
    "debounceMs": 42,
    "unknownTopLevel": "drop-me",
    "checks": {
      "longLines": { "enabled": false, "severity": "info", "maxLineLength": 80, "extra": "drop-me" },
      "todoComments": { "severity": "warning" },
      "unknownCheck": { "enabled": true, "severity": "error" },
      "__proto__": { "polluted": true }
    }
  }`);

  assert.equal(store.writeDiagnosticsSettings(malicious), true);
  const persisted = JSON.parse(fs.readFileSync(store.paths.diagnostics, 'utf8'));
  const expected = normalizeDiagnosticsSettings(malicious);
  assert.deepEqual(persisted, expected);
  assert.deepEqual(store.readDiagnosticsSettings(), expected);
  assert.deepEqual(createStore(userData).readDiagnosticsSettings(), expected);
  assert.equal(Object.hasOwn(persisted, 'unknownTopLevel'), false);
  assert.equal(Object.hasOwn(persisted.checks.longLines, 'extra'), false);
  assert.equal(Object.hasOwn(persisted.checks, 'unknownCheck'), false);
  assert.equal(Object.hasOwn(persisted.checks, '__proto__'), false);
});

test('diagnostics atomic write failures still return false without replacing the blocking file', (t) => {
  const root = createUserData(t);
  const blockedUserData = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockedUserData, 'preserve-me', 'utf8');

  const store = createStore(blockedUserData);
  assert.equal(store.writeDiagnosticsSettings({ enabled: false }), false);
  assert.equal(fs.readFileSync(blockedUserData, 'utf8'), 'preserve-me');
});
