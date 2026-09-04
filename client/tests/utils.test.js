'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const CORE_GLOBAL = '__boboUtilitiesCore';
const UTILITY_KEYS = Object.freeze([
  'detectLanguage',
  'isImageFile',
  'projectKey',
  'isWindowsLocalPath',
  'localPathSeparator',
  'langDisplayName'
]);

const CORE_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/utils.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: CORE_GLOBAL,
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

const ADAPTER_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['renderer/compat/utils-adapter.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function loadCore() {
  const sandbox = {};
  vm.runInNewContext(CORE_BUNDLE, sandbox, { filename: 'src/utils.ts' });
  return sandbox[CORE_GLOBAL];
}

function loadAdapter(existingBobo = {}) {
  const window = { BOBO: existingBobo };
  vm.runInNewContext(ADAPTER_BUNDLE, { window }, {
    filename: 'renderer/compat/utils-adapter.ts'
  });
  return { window, utilities: window.BOBO };
}

test('utility core exports exactly the six historical functions', () => {
  const utilities = loadCore();
  assert.deepEqual(Object.keys(utilities).sort(), [...UTILITY_KEYS].sort());
  for (const key of UTILITY_KEYS) assert.equal(typeof utilities[key], 'function');
});

test('detectLanguage preserves extension precedence and the complete language table', () => {
  const utilities = loadCore();
  const cases = [
    ['SOURCE.TS', 'typescript'],
    ['source.js', 'javascript'],
    ['component.JSX', 'javascript'],
    ['component.tsx', 'typescript'],
    ['settings.JSONC', 'json'],
    ['main.py', 'python'],
    ['main.cpp', 'cpp'],
    ['main.cc', 'cpp'],
    ['main.cxx', 'cpp'],
    ['main.c', 'c'],
    ['Main.java', 'java'],
    ['data.json', 'json'],
    ['README.md', 'markdown'],
    ['index.html', 'html'],
    ['theme.css', 'css'],
    ['theme.scss', 'scss'],
    ['theme.sass', 'scss'],
    ['theme.less', 'less'],
    ['script.sh', 'shell'],
    ['script.bash', 'shell'],
    ['script.zsh', 'shell'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['query.sql', 'sql'],
    ['layout.xml', 'xml'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['unknown.bobo', 'plaintext']
  ];

  for (const [filename, expected] of cases) {
    assert.equal(utilities.detectLanguage(filename), expected, filename);
  }
  assert.equal(
    utilities.detectLanguage('typed.ts', '#!/usr/bin/env python'),
    'typescript',
    'a known extension wins over a conflicting shebang'
  );
});

test('detectLanguage preserves exact shebang position, whole-content search, case, and priority quirks', () => {
  const utilities = loadCore();
  assert.equal(
    utilities.detectLanguage('script', '#!/usr/bin/env node\npython'),
    'python',
    'python wins because the historical search scans all content in fixed priority order'
  );
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env node'), 'javascript');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env bash'), 'shell');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env fish'), 'shell');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env pwsh'), 'shell');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env go'), 'go');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env rust-script'), 'rust');
  assert.equal(utilities.detectLanguage('script', '#!/usr/bin/env PYTHON'), 'plaintext');
  assert.equal(utilities.detectLanguage('script', '\uFEFF#!/usr/bin/env python'), 'plaintext');
  assert.equal(utilities.detectLanguage('script', ' #!/usr/bin/env python'), 'plaintext');
  assert.equal(utilities.detectLanguage('script', null), 'plaintext');
  assert.equal(utilities.detectLanguage('script', 0), 'plaintext');
  assert.throws(() => utilities.detectLanguage(null), { name: 'TypeError' });
  assert.throws(() => utilities.detectLanguage('script', 1), { name: 'TypeError' });
});

test('isImageFile preserves the exact extension set and historical index calculation', () => {
  const utilities = loadCore();
  for (const filename of [
    'image.png', 'image.JPG', 'image.jpeg', 'image.gif', 'image.bmp',
    'image.svg', 'image.WEBP', '.png'
  ]) {
    assert.equal(utilities.isImageFile(filename), true, filename);
  }
  for (const filename of ['image.avif', 'image.png.exe', 'png', 'image.', '']) {
    assert.equal(utilities.isImageFile(filename), false, filename);
  }
  assert.equal(
    utilities.isImageFile('\u0130.PNG'),
    false,
    'lastIndexOf still runs on the original string before lowercase expansion'
  );
  assert.throws(() => utilities.isImageFile(null), { name: 'TypeError' });
});

test('projectKey keeps its normalized signed-int32 hash stable across releases', () => {
  const utilities = loadCore();
  assert.equal(utilities.projectKey('C:\\Users\\Alice\\Project\\'), 'pwv31ez');
  assert.equal(utilities.projectKey('c:/users/alice/project'), 'pwv31ez');
  assert.equal(utilities.projectKey('C:/USERS/ALICE/PROJECT///'), 'pwv31ez');
  assert.equal(utilities.projectKey('/srv/BOBO/project///'), 'ppoltwr');
  assert.equal(utilities.projectKey(''), 'p0');
  assert.equal(utilities.projectKey('////'), 'p0');
  assert.throws(() => utilities.projectKey(null), { name: 'TypeError' });
});

test('local path flavor preserves drive, UNC, coercion, and separator behavior', () => {
  const utilities = loadCore();
  for (const value of [
    'C:\\workspace\\main.py',
    'c:/workspace/main.py',
    '\\\\server\\share\\main.py',
    '\\\\server/share/main.py',
    '//server/share/main.py',
    '//server/\\share'
  ]) {
    assert.equal(utilities.isWindowsLocalPath(value), true, String(value));
  }
  for (const value of [
    '/workspace/main.py',
    'C:relative\\main.py',
    '\\server\\share\\main.py',
    'file:///C:/workspace/main.py',
    undefined,
    null,
    false,
    0,
    42
  ]) {
    assert.equal(utilities.isWindowsLocalPath(value), false, String(value));
  }

  const windowsLike = { toString: () => 'Z:\\workspace' };
  assert.equal(utilities.isWindowsLocalPath(windowsLike), true);
  assert.equal(utilities.isWindowsLocalPath(Symbol('C:\\workspace')), false);
  assert.equal(utilities.localPathSeparator('D:\\workspace'), '\\');
  assert.equal(utilities.localPathSeparator('/workspace'), '/');
  assert.equal(utilities.localPathSeparator(windowsLike), '\\');
});

test('langDisplayName keeps known labels and treats prototype property names as unknown ids', () => {
  const utilities = loadCore();
  const expected = {
    python: 'Python',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    go: 'Go',
    rust: 'Rust',
    json: 'JSON',
    markdown: 'Markdown',
    html: 'HTML',
    css: 'CSS',
    shell: 'Shell',
    plaintext: 'Plain Text',
    sql: 'SQL',
    xml: 'XML',
    yaml: 'YAML',
    php: 'PHP',
    ruby: 'Ruby'
  };
  for (const [id, label] of Object.entries(expected)) {
    assert.equal(utilities.langDisplayName(id), label, id);
  }
  assert.equal(utilities.langDisplayName('unknown-language'), 'unknown-language');
  assert.equal(utilities.langDisplayName(''), '');
  assert.equal(utilities.langDisplayName('__proto__'), '__proto__');
  assert.equal(utilities.langDisplayName('constructor'), 'constructor');
  assert.equal(utilities.langDisplayName('toString'), 'toString');

  let coercions = 0;
  const changingId = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return coercions === 1 ? 'python' : 'javascript';
    }
  };
  assert.equal(utilities.langDisplayName(changingId), 'Python');
  assert.equal(coercions, 1, 'language ids are converted to property keys exactly once');
});

test('compatibility adapter preserves BOBO identity and projects only writable utility functions', () => {
  const sentinel = Object.freeze({ retained: true });
  const existingBobo = { sentinel, detectLanguage: () => 'legacy' };
  const { window, utilities } = loadAdapter(existingBobo);

  assert.equal(window.BOBO, existingBobo);
  assert.equal(utilities.sentinel, sentinel);
  assert.equal('utils' in utilities, false);
  assert.deepEqual(
    Object.keys(utilities).filter((key) => key !== 'sentinel').sort(),
    [...UTILITY_KEYS].sort()
  );
  for (const key of UTILITY_KEYS) {
    assert.equal(typeof utilities[key], 'function', key);
    assert.equal(Object.getOwnPropertyDescriptor(utilities, key).writable, true, key);
  }

  const dynamicSeparator = utilities.localPathSeparator;
  utilities.isWindowsLocalPath = () => true;
  assert.equal(dynamicSeparator('/workspace'), '\\');
  utilities.isWindowsLocalPath = () => false;
  assert.equal(dynamicSeparator('C:\\workspace'), '/');

  for (const key of UTILITY_KEYS) {
    const replacement = () => key;
    utilities[key] = replacement;
    assert.equal(utilities[key], replacement, key);
  }
});
