'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function classListFor(element) {
  return {
    toggle(name, force) {
      const values = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      element.className = Array.from(values).join(' ');
      return enabled;
    }
  };
}

function createElement(tagName) {
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    attributes: Object.create(null),
    childNodes: [],
    value: '',
    disabled: false,
    textContent: '',
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    dispatch(type, event) {
      (listeners.get(type) || []).forEach(callback => callback(Object.assign({ target: this }, event)));
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelectorAll(selector) {
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const matches = [];
      const visit = node => {
        if (className && String(node.className || '').split(/\s+/).includes(className)) matches.push(node);
        (node.childNodes || []).forEach(visit);
      };
      this.childNodes.forEach(visit);
      return matches;
    },
    scrollIntoView() {},
    focus() { this.focused = true; }
  };
  element.classList = classListFor(element);
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { this.childNodes = []; }
  });
  return element;
}

function normalizedPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function relativePath(filePath, rootPath) {
  const file = String(filePath || '').replace(/\\/g, '/');
  const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedPath(file).indexOf(normalizedPath(root) + '/') === 0) return file.slice(root.length + 1);
  return file.split('/').pop() || file;
}

function fuzzyMatch(query, text) {
  query = query.toLowerCase();
  text = String(text || '').toLowerCase();
  let score = 0;
  let queryIndex = 0;
  let previousMatch = false;
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] === query[queryIndex]) {
      score += previousMatch ? 3 : 1;
      if (textIndex === 0 || '/_-.'.includes(text[textIndex - 1])) score += 5;
      queryIndex += 1;
      previousMatch = true;
    } else {
      previousMatch = false;
    }
  }
  return queryIndex === query.length ? score : -1;
}

function legacyResults(files, root, query) {
  return files.map(file => {
    const relative = relativePath(file.path, root);
    const nameScore = fuzzyMatch(query, file.name);
    const pathScore = fuzzyMatch(query, relative);
    return { file, relative, score: Math.max(nameScore >= 0 ? nameScore + 4 : -1, pathScore) };
  }).filter(match => match.score >= 0).sort((left, right) => {
    return right.score - left.score || left.relative.localeCompare(right.relative);
  }).slice(0, 50).map(match => match.file.path);
}

function legacySuggestions(files, root, tabs) {
  const important = [
    'readme.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'makefile'
  ];
  return files.map(file => {
    const relative = relativePath(file.path, root);
    const name = String(file.name || '').toLowerCase();
    const importantIndex = important.indexOf(name);
    let score = importantIndex >= 0 ? 400 - importantIndex : 0;
    if (/^(?:main|index|app|application|program)\.[a-z0-9]+$/.test(name)) score += 260;
    score += Math.max(0, 80 - (relative.split('/').length - 1) * 20);
    const tabIndex = tabs.findIndex(tab => normalizedPath(tab.path) === normalizedPath(file.path));
    if (tabIndex >= 0) score += 600 - tabIndex;
    return { file, relative, score };
  }).sort((left, right) => {
    return right.score - left.score || left.relative.localeCompare(right.relative);
  }).slice(0, 8).map(match => match.file.path);
}

function createRuntime(fileCount) {
  const root = 'C:\\workspace';
  const files = Array.from({ length: fileCount }, (_value, index) => {
    const suffix = String(fileCount - index - 1).padStart(5, '0');
    return { type: 'file', name: 'file-' + suffix + '.js', path: root + '\\src\\file-' + suffix + '.js' };
  });
  files.push(
    { type: 'file', name: 'README.md', path: root + '\\README.md' },
    { type: 'file', name: 'package.json', path: root + '\\package.json' },
    { type: 'file', name: 'main.js', path: root + '\\src\\main.js' }
  );
  const tabs = [{ path: files[130].path }, { path: files[4000].path }];
  const elements = {
    'quick-file-search-input': createElement('input'),
    'quick-file-search-results': createElement('div'),
    'quick-file-search-status': createElement('div')
  };
  const storage = new Map();
  const document = {
    createElement,
    getElementById(id) { return elements[id] || null; }
  };
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    addEventListener() {},
    BOBO: {
      state: {
        workspaceRoot: root,
        workspaceTree: { type: 'directory', path: root, children: files },
        tabs
      },
      workspaceSettings: { isPathExcluded() { return false; } },
      workbench: { setPrimaryView() {} },
      workspace: { openFile() {} },
      i18n: { t(source, params) {
        return String(source).replace(/\{([^}]+)\}/g, (match, key) => params && params[key] !== undefined ? params[key] : match);
      } }
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(
    'globalThis.__sortCalls = 0; const nativeSort = Array.prototype.sort; ' +
    'Array.prototype.sort = function() { globalThis.__sortCalls += 1; return nativeSort.apply(this, arguments); };',
    context
  );
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'file-search.js'), 'utf8'), context, {
    filename: 'src/file-search.js'
  });
  return { sandbox, elements, files, root, tabs };
}

test('Quick Open keeps legacy ranking while avoiding whole-result sorting', () => {
  const runtime = createRuntime(5000);
  runtime.sandbox.BOBO.fileSearch.show();
  const suggested = runtime.elements['quick-file-search-results']
    .querySelectorAll('.file-search-result')
    .map(element => element.getAttribute('data-path'));
  assert.deepEqual(suggested, legacySuggestions(runtime.files, runtime.root, runtime.tabs));

  const input = runtime.elements['quick-file-search-input'];
  input.value = 'file';
  input.dispatch('input', {});

  const actual = runtime.elements['quick-file-search-results']
    .querySelectorAll('.file-search-result')
    .map(element => element.getAttribute('data-path'));
  const expected = legacyResults(runtime.files, runtime.root, 'file');

  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 50);
  assert.equal(runtime.sandbox.__sortCalls, 0);
});
