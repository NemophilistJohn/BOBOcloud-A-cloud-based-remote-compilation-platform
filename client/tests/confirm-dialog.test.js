'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const CONFIRM_MODULE_GLOBAL = '__boboConfirmCore';
const CONFIRM_BUNDLE = esbuild.buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/confirm-dialog.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: CONFIRM_MODULE_GLOBAL,
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

function createHarness(options = {}) {
  const elements = [];
  const timers = new Map();
  const clearedDelays = [];
  let nextTimer = 1;

  class FakeElement {
    constructor(tagName, document) {
      this.tagName = String(tagName).toUpperCase();
      this.ownerDocument = document;
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.hidden = false;
      this.checked = false;
      this.textContent = '';
      this.id = '';
      this.onclick = null;
      this.removed = false;
      this.focusCalls = 0;
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
      child.parentElement = this;
      child.removed = false;
      this.children.push(child);
      return child;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type);
      if (listeners) listeners.delete(listener);
    }

    dispatch(type, init = {}) {
      const event = Object.assign({
        type,
        target: this,
        key: '',
        shiftKey: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      }, init);
      const listeners = this.listeners.get(type);
      if (listeners) Array.from(listeners).forEach((listener) => listener(event));
      return event;
    }

    listenerCount(type) {
      return this.listeners.get(type)?.size || 0;
    }

    focus() {
      this.focusCalls += 1;
      this.ownerDocument.activeElement = this;
    }

    remove() {
      this.removed = true;
      if (this.parentElement) {
        const index = this.parentElement.children.indexOf(this);
        if (index !== -1) this.parentElement.children.splice(index, 1);
      }
      this.parentElement = null;
    }
  }

  const document = {
    activeElement: null,
    body: null,
    createElement(tagName) {
      const element = new FakeElement(tagName, document);
      elements.push(element);
      return element;
    }
  };
  if (options.body !== false) document.body = document.createElement('body');

  const originalFocus = {
    calls: 0,
    focus() {
      this.calls += 1;
      if (options.focusThrows) throw new Error('focus unavailable');
      document.activeElement = this;
    }
  };
  document.activeElement = originalFocus;

  const sandbox = {};
  vm.runInNewContext(CONFIRM_BUNDLE, sandbox, { filename: 'src/confirm-dialog.ts' });
  const service = sandbox[CONFIRM_MODULE_GLOBAL].createConfirmService({
    document,
    setTimer(callback, delay) {
      const timer = nextTimer++;
      timers.set(timer, { callback, delay });
      return timer;
    },
    clearTimer(timer) {
      const record = timers.get(timer);
      if (record) clearedDelays.push(record.delay);
      timers.delete(timer);
    }
  });

  return {
    service,
    document,
    originalFocus,
    clearedDelays,
    runTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'expected a ' + delay + 'ms timer');
      const [timer, record] = entry;
      timers.delete(timer);
      record.callback();
    },
    timerDelays() {
      return Array.from(timers.values(), (timer) => timer.delay);
    },
    byClass(name) {
      return elements.find((element) => !element.removed && element.classList.contains(name));
    },
    byId(id) {
      return elements.find((element) => !element.removed && element.id === id);
    }
  };
}

test('confirm service settles concurrent requests in FIFO order without crossing option snapshots', async () => {
  const harness = createHarness();
  assert.equal(harness.byId('confirm-dialog'), undefined, 'dialog DOM stays lazy until first use');

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
  const first = harness.service.confirm({
    title: 'First request',
    message: 'First message',
    confirmLabel: 'Approve first',
    cancelLabel: 'Reject first',
    danger: true
  }).then((value) => {
    firstSettled = true;
    return value;
  });
  const second = harness.service.confirm(secondOptions).then((value) => {
    secondSettled = true;
    return value;
  });
  secondOptions.title = 'Mutated after enqueue';
  secondOptions.confirmLabel = 'Mutated label';

  const overlay = harness.byId('confirm-dialog');
  const title = harness.byId('confirm-dialog-title');
  const option = harness.byClass('confirm-option');
  assert.equal(title.textContent, 'First request');
  assert.equal(option.hidden, true);
  assert.equal(overlay.classList.contains('open'), true);
  assert.equal(overlay.getAttribute('aria-hidden'), 'false');
  assert.equal(harness.byClass('confirm-btn-danger').textContent, 'Approve first');
  assert.equal(harness.byClass('confirm-btn-ghost').textContent, 'Reject first');

  harness.runTimer(50);
  harness.byClass('confirm-btn-danger').onclick();
  await Promise.resolve();
  assert.equal(firstSettled, false, 'the active request resolves after the close delay');
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

test('details cancellation preserves the checkbox result and advances the FIFO queue', async () => {
  const harness = createHarness();
  const first = harness.service.confirm({
    title: 'Cancel me',
    checkboxLabel: 'Remember this choice',
    checkboxChecked: true,
    returnDetails: true
  });
  const second = harness.service.confirm({ title: 'Then confirm me' });

  harness.runTimer(50);
  harness.byClass('confirm-btn-ghost').onclick();
  harness.runTimer(150);
  const cancelled = await first;
  assert.equal(cancelled.confirmed, false);
  assert.equal(cancelled.checkboxChecked, true);
  assert.equal(harness.byId('confirm-dialog-title').textContent, 'Then confirm me');

  harness.runTimer(50);
  harness.byClass('confirm-btn-primary').onclick();
  harness.runTimer(150);
  assert.equal(await second, true);
});

test('keyboard handling traps Tab, cancels with Escape, confirms with Enter, and restores focus after closing', async () => {
  const harness = createHarness();
  const cancelledPromise = harness.service.confirm({
    title: 'Keyboard request',
    checkboxLabel: 'Optional choice'
  });
  const overlay = harness.byId('confirm-dialog');
  const card = harness.byClass('confirm-card');
  const checkbox = harness.byClass('confirm-option').children[0];
  const cancelButton = harness.byClass('confirm-btn-ghost');
  const confirmButton = harness.byClass('confirm-btn-primary');

  assert.equal(card.getAttribute('role'), 'alertdialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  assert.equal(harness.document.activeElement, harness.originalFocus);
  harness.runTimer(50);
  assert.equal(harness.document.activeElement, confirmButton);

  const tab = overlay.dispatch('keydown', { key: 'Tab', target: confirmButton });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, checkbox);
  const reverseTab = overlay.dispatch('keydown', {
    key: 'Tab',
    shiftKey: true,
    target: checkbox
  });
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, confirmButton);

  const escape = overlay.dispatch('keydown', { key: 'Escape', target: confirmButton });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(overlay.classList.contains('open'), false);
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  assert.equal(harness.originalFocus.calls, 0, 'focus remains until the close delay finishes');
  harness.runTimer(150);
  assert.equal(await cancelledPromise, false);
  assert.equal(harness.originalFocus.calls, 1);
  assert.equal(harness.document.activeElement, harness.originalFocus);

  const confirmedPromise = harness.service.confirm({ title: 'Confirm from keyboard' });
  harness.runTimer(50);
  assert.equal(harness.document.activeElement, confirmButton);
  const hiddenOptionTab = overlay.dispatch('keydown', { key: 'Tab', target: confirmButton });
  assert.equal(hiddenOptionTab.defaultPrevented, true);
  assert.equal(harness.document.activeElement, cancelButton);
  const enter = overlay.dispatch('keydown', { key: 'Enter', target: cancelButton });
  assert.equal(enter.defaultPrevented, true);
  harness.runTimer(150);
  assert.equal(await confirmedPromise, true);
});

test('only an exact backdrop click cancels the active request', async () => {
  const harness = createHarness();
  let settled = false;
  const result = harness.service.confirm({ title: 'Backdrop request' }).then((value) => {
    settled = true;
    return value;
  });
  const overlay = harness.byId('confirm-dialog');
  const card = harness.byClass('confirm-card');

  harness.runTimer(50);
  overlay.dispatch('click', { target: card });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(overlay.classList.contains('open'), true);
  assert.deepEqual(harness.timerDelays(), []);

  overlay.dispatch('click', { target: overlay });
  assert.equal(overlay.classList.contains('open'), false);
  harness.runTimer(150);
  assert.equal(await result, false);
});

test('dispose during closing preserves the captured selection and clears both timers and DOM listeners', async () => {
  const harness = createHarness();
  const result = harness.service.confirm({
    title: 'Dispose while closing',
    checkboxLabel: 'Keep selection',
    checkboxChecked: true,
    returnDetails: true
  });
  const overlay = harness.byId('confirm-dialog');
  const confirmButton = harness.byClass('confirm-btn-primary');
  const cancelButton = harness.byClass('confirm-btn-ghost');

  confirmButton.onclick();
  assert.deepEqual(harness.clearedDelays, [50]);
  assert.deepEqual(harness.timerDelays(), [150]);
  harness.service.dispose();

  const response = await result;
  assert.equal(response.confirmed, true);
  assert.equal(response.checkboxChecked, true);
  assert.equal(harness.service.disposed, true);
  assert.deepEqual(harness.clearedDelays, [50, 150]);
  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.originalFocus.calls, 1);
  assert.equal(overlay.listenerCount('click'), 0);
  assert.equal(overlay.listenerCount('keydown'), 0);
  assert.equal(confirmButton.onclick, null);
  assert.equal(cancelButton.onclick, null);
  assert.equal(harness.byId('confirm-dialog'), undefined);
});

test('dispose fail-closes active and queued requests without leaving timers pending', async () => {
  const harness = createHarness();
  const active = harness.service.confirm({
    title: 'Active request',
    checkboxLabel: 'Selected before disposal',
    checkboxChecked: true,
    returnDetails: true
  });
  const queuedBoolean = harness.service.confirm({ title: 'Queued boolean request' });
  const queuedDetails = harness.service.confirm({
    title: 'Queued details request',
    checkboxLabel: 'Queued choice',
    checkboxChecked: true,
    returnDetails: true
  });

  assert.deepEqual(harness.timerDelays(), [50]);
  harness.service.dispose();
  const activeResult = await active;
  const queuedResult = await queuedBoolean;
  const queuedDetailsResult = await queuedDetails;

  assert.equal(activeResult.confirmed, false);
  assert.equal(activeResult.checkboxChecked, false);
  assert.equal(queuedResult, false);
  assert.equal(queuedDetailsResult.confirmed, false);
  assert.equal(queuedDetailsResult.checkboxChecked, false);
  assert.deepEqual(harness.clearedDelays, [50]);
  assert.deepEqual(harness.timerDelays(), []);
  assert.equal(harness.originalFocus.calls, 1);
  assert.equal(harness.byId('confirm-dialog'), undefined);
});

test('disposed services and documents without a body fail closed without creating DOM or timers', async () => {
  const missingBody = createHarness({ body: false });
  assert.equal(await missingBody.service.confirm({ title: 'No body' }), false);
  const missingBodyDetails = await missingBody.service.confirm({
    title: 'No body details',
    returnDetails: true
  });
  assert.equal(missingBodyDetails.confirmed, false);
  assert.equal(missingBodyDetails.checkboxChecked, false);
  assert.equal(missingBody.byId('confirm-dialog'), undefined);
  assert.deepEqual(missingBody.timerDelays(), []);

  const disposed = createHarness();
  disposed.service.dispose();
  assert.equal(disposed.service.disposed, true);
  assert.equal(await disposed.service.confirm({ title: 'After dispose' }), false);
  const disposedDetails = await disposed.service.confirm({
    title: 'After dispose details',
    returnDetails: true
  });
  assert.equal(disposedDetails.confirmed, false);
  assert.equal(disposedDetails.checkboxChecked, false);
  assert.equal(disposed.byId('confirm-dialog'), undefined);
  assert.deepEqual(disposed.timerDelays(), []);
});

test('focus restoration failures cannot block settlement or the next queued request', async () => {
  const harness = createHarness({ focusThrows: true });
  const first = harness.service.confirm({ title: 'First request' });
  const second = harness.service.confirm({ title: 'Second request' });

  harness.runTimer(50);
  harness.byClass('confirm-btn-primary').onclick();
  harness.runTimer(150);
  assert.equal(await first, true);
  assert.equal(harness.byId('confirm-dialog-title').textContent, 'Second request');

  harness.runTimer(50);
  harness.byClass('confirm-btn-ghost').onclick();
  harness.runTimer(150);
  assert.equal(await second, false);
  assert.equal(harness.originalFocus.calls, 1);
});
