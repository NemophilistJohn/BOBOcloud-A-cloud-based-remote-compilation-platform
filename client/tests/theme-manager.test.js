const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadThemeManager(savedTheme) {
  const stored = new Map(savedTheme ? [['bobocloud.theme', savedTheme]] : []);
  const cssVariables = new Map();
  const sandbox = {
    document: {
      documentElement: {
        style: { setProperty(name, value) { cssVariables.set(name, value); } }
      }
    },
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, String(value)); }
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'theme-manager.js'), 'utf8'),
    sandbox,
    { filename: 'theme-manager.js' }
  );
  return { manager: sandbox.themeManager, stored, cssVariables };
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
