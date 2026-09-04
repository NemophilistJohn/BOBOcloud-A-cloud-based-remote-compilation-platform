'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const THEME_MODULE_GLOBAL = '__boboThemeCore';
const THEME_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/theme-manager.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: THEME_MODULE_GLOBAL,
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function loadThemeManager(savedTheme, overrides = {}) {
  const stored = new Map(savedTheme === undefined ? [] : [['bobocloud.theme', savedTheme]]);
  const cssVariables = new Map();
  const document = overrides.document || {
    documentElement: {
      style: { setProperty(name, value) { cssVariables.set(name, value); } }
    }
  };
  const storage = overrides.storage || {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); }
  };
  const sandbox = {};
  vm.runInNewContext(THEME_BUNDLE, sandbox, { filename: 'src/theme-manager.ts' });
  const manager = sandbox[THEME_MODULE_GLOBAL].createThemeService({ document, storage });
  manager.init();
  return { manager, stored, cssVariables };
}

test('theme manager exposes defensive preview colors from every real palette', () => {
  const { manager } = loadThemeManager();
  const themes = manager.listThemes();
  assert.equal(themes.map(theme => theme.id).join(','), 'cloud-forge,light,nord,monokai,dracula');
  for (const theme of themes) {
    assert.equal(theme.colors.length, 5);
    for (const color of theme.colors) assert.match(color, /^#[0-9a-f]{6}$/i);
  }

  themes[0].colors[0] = '#000000';
  assert.equal(manager.listThemes()[0].colors[0], '#101311');
});

test('theme manager applies and persists the palette selected by the settings UI', () => {
  const { manager, stored, cssVariables } = loadThemeManager();
  manager.applyTheme('monokai');
  assert.equal(manager.getCurrentTheme(), 'monokai');
  assert.equal(stored.get('bobocloud.theme'), 'monokai');
  assert.equal(cssVariables.get('--bg-deep'), '#272822');
  assert.equal(cssVariables.get('--brand'), '#A6E22E');
});

test('theme manager migrates the legacy dark alias during synchronous initialization', () => {
  const { manager, stored, cssVariables } = loadThemeManager('dark');
  assert.equal(manager.getCurrentTheme(), 'cloud-forge');
  assert.equal(stored.get('bobocloud.theme'), 'cloud-forge');
  assert.equal(cssVariables.get('--bg-deep'), '#101311');
});

test('unknown theme ids retain compatibility identity while using the default palette', () => {
  const { manager, stored, cssVariables } = loadThemeManager();
  assert.equal(manager.applyTheme('future-theme'), 'future-theme');
  assert.equal(manager.getCurrentTheme(), 'future-theme');
  assert.equal(stored.get('bobocloud.theme'), 'future-theme');
  assert.equal(cssVariables.get('--bg-deep'), '#101311');
  assert.equal(cssVariables.get('--brand'), '#d8a63f');
});

test('theme listeners preserve order, isolate errors, and release independently', () => {
  const { manager } = loadThemeManager();
  const calls = [];
  const disposeThrowing = manager.onChange((themeId) => {
    calls.push('throw:' + themeId);
    throw new Error('listener failed');
  });
  const disposeHealthy = manager.onChange((themeId) => calls.push('healthy:' + themeId));

  assert.equal(manager.applyTheme('nord'), 'nord');
  assert.equal(calls.join(','), 'throw:nord,healthy:nord');

  disposeHealthy();
  disposeHealthy();
  manager.applyTheme('light');
  assert.equal(calls.join(','), 'throw:nord,healthy:nord,throw:light');

  disposeThrowing();
  manager.dispose();
  manager.applyTheme('dracula');
  assert.equal(calls.join(','), 'throw:nord,healthy:nord,throw:light');
});

test('Monaco themes are defined once while applications and listeners remain observable', () => {
  const { manager } = loadThemeManager();
  const definitions = [];
  const applied = [];
  const changes = [];
  const monaco = {
    editor: {
      defineTheme(themeId, data) { definitions.push({ themeId, data }); },
      setTheme(themeId) { applied.push(themeId); }
    }
  };
  manager.onChange((themeId) => changes.push(themeId));

  manager.setMonaco(monaco);
  manager.setMonaco(monaco);
  manager.applyTheme('monokai');

  assert.equal(definitions.map(entry => entry.themeId).join(','),
    'cloud-forge,light,nord,monokai,dracula');
  assert.equal(new Set(definitions.map(entry => entry.themeId)).size, 5);
  assert.equal(definitions[0].data.base, 'vs-dark');
  assert.equal(definitions[1].data.base, 'vs');
  assert.equal(applied.join(','), 'cloud-forge,cloud-forge,monokai');
  assert.equal(changes.join(','), 'cloud-forge,cloud-forge,monokai');
});
