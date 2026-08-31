'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'confirm-dialog.js'), 'utf8');

function createHarness() {
  const elements = [];
  const timers = [];

  class FakeElement {
    constructor(tagName, document) {
      this.tagName = String(tagName).toUpperCase();
      this.ownerDocument = document;
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.hidden = false;
      this.checked = false;
      this.textContent = '';
      this.id = '';
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name)
      };
      Object.defineProperty(this, 'className', {
        get: () => Array.from(classes).join(' '),
        set: (value) => {
          classes.clear();
          String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
        }
      });
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) || null;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }
  }

  const document = {
    activeElement: null,
    createElement(tagName) {
      const element = new FakeElement(tagName, document);
      elements.push(element);
      return element;
    }
  };
  document.body = document.createElement('body');
  const originalFocus = {
    calls: 0,
    focus() {
      this.calls += 1;
      document.activeElement = this;
    }
  };
  document.activeElement = originalFocus;

  const window = { BOBO: {} };
  const context = vm.createContext({
    document,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    window
  });
  vm.runInContext(SOURCE, context, { filename: 'confirm-dialog.js' });

  return {
    api: window.BOBO,
    originalFocus,
    runTimer(delay) {
      const index = timers.findIndex((timer) => timer.delay === delay);
      assert.notEqual(index, -1, 'expected a ' + delay + 'ms timer');
      const [timer] = timers.splice(index, 1);
      timer.callback();
    },
    byClass(name) {
      return elements.find((element) => element.classList.contains(name));
    },
    byId(id) {
      return elements.find((element) => element.id === id);
    }
  };
}

test('BOBO.confirm settles concurrent requests in FIFO order without crossing options', async () => {
  const harness = createHarness();
  const secondOptions = {
    title: 'Second request',
    message: 'Second message',
    confirmLabel: 'Approve second',
    checkboxLabel: 'Remember this choice',
    checkboxChecked: true,
    returnDetails: true
  };
  let firstSettled = false;
  let secondSettled = false;
  const first = harness.api.confirm({
    title: 'First request',
    message: 'First message',
    confirmLabel: 'Approve first'
  }).then((value) => {
    firstSettled = true;
    return value;
  });
  const second = harness.api.confirm(secondOptions).then((value) => {
    secondSettled = true;
    return value;
  });
  secondOptions.title = 'Mutated after enqueue';

  const overlay = harness.byId('confirm-dialog');
  const title = harness.byId('confirm-dialog-title');
  const option = harness.byClass('confirm-option');
  assert.equal(title.textContent, 'First request');
  assert.equal(option.hidden, true);
  assert.equal(overlay.classList.contains('open'), true);

  harness.runTimer(50);
  harness.byClass('confirm-btn-primary').onclick();
  await Promise.resolve();
  assert.equal(firstSettled, false, 'the active request resolves after the close animation');
  assert.equal(secondSettled, false);

  harness.runTimer(150);
  assert.equal(await first, true);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, false);
  assert.equal(title.textContent, 'Second request');
  assert.equal(option.hidden, false);
  assert.equal(harness.byClass('confirm-btn-primary').textContent, 'Approve second');

  harness.runTimer(50);
  harness.byClass('confirm-btn-primary').onclick();
  harness.runTimer(150);
  const secondResult = await second;
  assert.equal(secondResult.confirmed, true);
  assert.equal(secondResult.checkboxChecked, true);
  assert.equal(harness.originalFocus.calls, 2);
  assert.equal(overlay.classList.contains('open'), false);
});

test('BOBO.confirm continues to the next queued request after cancellation', async () => {
  const harness = createHarness();
  const first = harness.api.confirm({ title: 'Cancel me' });
  const second = harness.api.confirm({ title: 'Then confirm me' });

  harness.runTimer(50);
  harness.byClass('confirm-btn-ghost').onclick();
  harness.runTimer(150);
  assert.equal(await first, false);
  assert.equal(harness.byId('confirm-dialog-title').textContent, 'Then confirm me');

  harness.runTimer(50);
  harness.byClass('confirm-btn-primary').onclick();
  harness.runTimer(150);
  assert.equal(await second, true);
});
