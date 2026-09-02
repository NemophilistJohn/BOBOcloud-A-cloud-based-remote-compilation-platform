'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
let SourceControlStateStore;
let createSourceControlCommandPayload;

function descriptor(id, order = 0) {
  return {
    id,
    title: id,
    order
  };
}

function state(title = 'Working tree') {
  return {
    phase: 'ready',
    title,
    summary: {
      title: 'Summary',
      items: [{ label: 'Branch', value: 'main' }]
    },
    sections: [{
      id: 'changes',
      title: 'Changes',
      items: [{
        id: 'readme',
        title: 'README.md',
        command: 'acme.extension.open'
      }]
    }],
    actions: [{
      id: 'refresh',
      title: 'Refresh',
      command: 'acme.extension.refresh',
      form: {
        fields: [{ id: 'message', label: 'Message' }]
      }
    }]
  };
}

test.before(async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/source-control.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const module = { exports: {} };
  const loadBundle = new Function('module', 'exports', 'require', build.outputFiles[0].text);
  loadBundle(module, module.exports, require);
  SourceControlStateStore = module.exports.SourceControlStateStore;
  createSourceControlCommandPayload = module.exports.createSourceControlCommandPayload;
});

test('command payloads accept only bounded plain form values and copy caller-owned data', () => {
  const input = { message: 'ready', amend: true };
  const payload = createSourceControlCommandPayload('acme.extension.main', 'commit', input, {
    sectionId: 'changes',
    kind: 'action'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    sourceControlId: 'acme.extension.main',
    actionId: 'commit',
    values: { message: 'ready', amend: true },
    sectionId: 'changes',
    kind: 'action'
  });
  assert.notEqual(payload.values, input);
  assert.equal(Object.isFrozen(payload.values), true);
  assert.equal(Object.isFrozen(input), false);
  input.message = 'changed';
  assert.equal(payload.values.message, 'ready');

  assert.throws(
    () => createSourceControlCommandPayload('acme.extension.main', 'commit', []),
    /plain object/
  );
  assert.throws(
    () => createSourceControlCommandPayload('acme.extension.main', 'commit', { nested: {} }),
    /only strings and booleans/
  );
  assert.throws(
    () => createSourceControlCommandPayload('acme.extension.main', 'commit', { ['x'.repeat(65)]: 'value' }),
    /maximum length/
  );
  assert.throws(
    () => createSourceControlCommandPayload(
      'acme.extension.main',
      'commit',
      Object.fromEntries(Array.from({ length: 13 }, (_, index) => ['field' + index, 'value']))
    ),
    /bounded object/
  );
  assert.throws(
    () => createSourceControlCommandPayload('acme.extension.main', 'commit', { message: 'x'.repeat(4097) }),
    /maximum length/
  );
  let accessorReads = 0;
  const accessorValues = {};
  Object.defineProperty(accessorValues, 'message', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'unsafe';
    }
  });
  assert.throws(
    () => createSourceControlCommandPayload('acme.extension.main', 'commit', accessorValues),
    /cannot contain accessors/
  );
  assert.equal(accessorReads, 0);
});

test('source-control store returns stable sorted snapshots and updates order after additions and removals', () => {
  const store = new SourceControlStateStore();
  const middle = store.register(descriptor('acme.extension.middle', 10), { owner: 'acme.extension' });
  store.register(descriptor('acme.extension.zulu', -5), { owner: 'acme.extension' });
  assert.deepEqual(store.list().map(entry => entry.id), [
    'acme.extension.zulu',
    'acme.extension.middle'
  ]);

  const alpha = store.register(descriptor('acme.extension.alpha', -5), { owner: 'acme.extension' });

  const first = store.list();
  const second = store.list();
  assert.deepEqual(first.map(entry => entry.id), [
    'acme.extension.alpha',
    'acme.extension.zulu',
    'acme.extension.middle'
  ]);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.notEqual(second[0], first[0]);

  alpha.dispose();
  assert.deepEqual(store.list().map(entry => entry.id), [
    'acme.extension.zulu',
    'acme.extension.middle'
  ]);
  middle.dispose();
  assert.deepEqual(store.list().map(entry => entry.id), ['acme.extension.zulu']);
});

test('state handles version writes and clears, then become inert or reject writes after disposal', () => {
  const changes = [];
  const store = new SourceControlStateStore();
  store.onDidChange(event => changes.push(event));
  const handle = store.register(descriptor('acme.extension.main'), { owner: 'acme.extension' });
  assert.equal(store.list()[0].state, null);

  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(handle.setState(state()), { version: 1 });
  assert.equal(Object.isFrozen(store.get(handle.id)), true);
  assert.equal(store.get(handle.id).version, 1);
  assert.equal(store.get(handle.id).state.title, 'Working tree');
  assert.equal(store.list()[0].state.title, 'Working tree');

  assert.deepEqual(handle.clearState(), { version: 2 });
  assert.deepEqual(handle.clearState(), { version: 2 });
  assert.equal(store.get(handle.id).state, null);
  assert.equal(store.list()[0].state, null);
  assert.deepEqual(changes.map(event => [event.type, event.version]), [
    ['added', 0],
    ['state', 1],
    ['cleared', 2]
  ]);
  assert.deepEqual(Object.keys(changes[0]), [
    'type', 'id', 'owner', 'descriptor', 'state', 'version'
  ]);

  handle.dispose();
  handle.dispose();
  assert.equal(store.get(handle.id), null);
  assert.deepEqual(changes.map(event => [event.type, event.version]), [
    ['added', 0],
    ['state', 1],
    ['cleared', 2],
    ['removed', 2]
  ]);
  assert.throws(() => handle.setState(state('Late write')), /handle has been disposed/);
  assert.deepEqual(handle.clearState(), { version: 2 });
});

test('disposeOwner removes exactly its records and preserves final state in removal events', () => {
  const removed = [];
  const store = new SourceControlStateStore();
  store.onDidChange(event => {
    if (event.type === 'removed') removed.push(event);
  });
  const first = store.register(descriptor('acme.extension.first'), { owner: 'acme.extension' });
  const second = store.register(descriptor('acme.extension.second'), { owner: 'acme.extension' });
  const other = store.register(descriptor('other.extension.main'), { owner: 'other.extension' });
  first.setState(state('Final state'));

  store.disposeOwner('acme.extension');
  store.disposeOwner('acme.extension');
  assert.deepEqual(removed.map(event => event.id), ['acme.extension.first', 'acme.extension.second']);
  assert.equal(removed[0].state.title, 'Final state');
  assert.equal(removed[1].state, null);
  assert.deepEqual(store.list().map(entry => entry.id), ['other.extension.main']);
  assert.throws(() => first.setState(state()), /no longer registered/);
  assert.throws(() => second.setState(state()), /no longer registered/);
  assert.deepEqual(first.clearState(), { version: 1 });
  assert.equal(store.get(other.id).id, other.id);
});

test('throwing listeners and error observers cannot interrupt state changes or later listeners', () => {
  const listenerError = new Error('listener failed');
  const reported = [];
  const observed = [];
  const store = new SourceControlStateStore({
    onError(event) {
      reported.push(event);
      throw new Error('observer failed');
    }
  });
  const throwingSubscription = store.onDidChange(() => {
    throw listenerError;
  });
  store.onDidChange(event => {
    assert.equal(Object.isFrozen(event), true);
    observed.push([event.type, event.version, event.state && event.state.title]);
  });

  const handle = store.register(descriptor('acme.extension.main'), { owner: 'acme.extension' });
  assert.doesNotThrow(() => handle.setState(state('Updated')));
  assert.equal(store.get(handle.id).state.title, 'Updated');
  assert.deepEqual(observed, [
    ['added', 0, null],
    ['state', 1, 'Updated']
  ]);
  assert.equal(reported.length, 2);
  assert.deepEqual(reported.map(event => [event.source, event.id, event.owner, event.error]), [
    ['source-control-listener', handle.id, 'acme.extension', listenerError],
    ['source-control-listener', handle.id, 'acme.extension', listenerError]
  ]);

  throwingSubscription.dispose();
  handle.clearState();
  assert.deepEqual(observed.at(-1), ['cleared', 2, null]);
  assert.equal(reported.length, 2);
});

test('store copies and deeply freezes accepted DTOs without freezing caller-owned inputs', () => {
  const store = new SourceControlStateStore();
  const inputDescriptor = descriptor('acme.extension.main', 4);
  const inputState = state();
  const handle = store.register(inputDescriptor, { owner: 'acme.extension' });
  handle.setState(inputState);

  assert.equal(Object.isFrozen(inputDescriptor), false);
  assert.equal(Object.isFrozen(inputState), false);
  assert.equal(Object.isFrozen(inputState.sections), false);

  inputDescriptor.title = 'Mutated descriptor';
  inputDescriptor.order = -100;
  inputState.title = 'Mutated state';
  inputState.summary.items[0].value = 'dev';
  inputState.sections[0].items[0].title = 'MUTATED.md';
  inputState.actions.push({
    id: 'late',
    title: 'Late',
    command: 'acme.extension.late'
  });

  const snapshot = store.get(handle.id);
  assert.equal(snapshot.descriptor.title, 'acme.extension.main');
  assert.equal(snapshot.descriptor.order, 4);
  assert.equal(snapshot.state.title, 'Working tree');
  assert.equal(snapshot.state.summary.items[0].value, 'main');
  assert.equal(snapshot.state.sections[0].items[0].title, 'README.md');
  assert.equal(snapshot.state.actions.length, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.descriptor), true);
  assert.equal(Object.isFrozen(snapshot.state), true);
  assert.equal(Object.isFrozen(snapshot.state.summary.items), true);
  assert.equal(Object.isFrozen(snapshot.state.sections[0].items[0]), true);
  assert.deepEqual(Object.keys(snapshot.state.sections[0].items[0]), [
    'id', 'title', 'description', 'meta', 'badge', 'command', 'disabled'
  ]);
  assert.deepEqual(Object.keys(snapshot.state.actions[0]), [
    'id', 'title', 'description', 'command', 'kind', 'placement', 'icon', 'disabled', 'form'
  ]);
  assert.deepEqual(Object.keys(snapshot.state.actions[0].form.fields[0]), [
    'id', 'label', 'type', 'description', 'placeholder', 'required', 'value', 'maxLength', 'options'
  ]);
});

test('disposed stores remove records once and reject new registrations and subscriptions', () => {
  const removed = [];
  const store = new SourceControlStateStore();
  store.onDidChange(event => {
    if (event.type === 'removed') removed.push(event.id);
  });
  const first = store.register(descriptor('acme.extension.first'), { owner: 'acme.extension' });
  const second = store.register(descriptor('acme.extension.second'), { owner: 'acme.extension' });

  store.dispose();
  store.dispose();
  assert.deepEqual(removed, ['acme.extension.second', 'acme.extension.first']);
  assert.deepEqual(store.list(), []);
  assert.throws(() => first.setState(state()), /no longer registered/);
  assert.deepEqual(second.clearState(), { version: 0 });
  assert.throws(
    () => store.register(descriptor('acme.extension.late'), { owner: 'acme.extension' }),
    /store has been disposed/
  );
  assert.throws(() => store.onDidChange(() => {}), /store has been disposed/);
});
