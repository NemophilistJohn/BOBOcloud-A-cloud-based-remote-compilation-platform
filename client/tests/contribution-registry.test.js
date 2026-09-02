'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');
let ContributionPoint;
let ContributionRegistry;

test.before(async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/contribution-registry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const module = { exports: {} };
  const loadBundle = new Function('module', 'exports', 'require', build.outputFiles[0].text);
  loadBundle(module, module.exports, require);
  ContributionPoint = module.exports.ContributionPoint;
  ContributionRegistry = module.exports.ContributionRegistry;
});

test('contribution registry preserves dynamic validation, normalization, and point-scoped identity', () => {
  const contributions = new ContributionRegistry();
  const first = { id: 'first', value: 1 };

  assert.equal(Object.isFrozen(ContributionPoint), true);
  assert.throws(() => contributions.register('', first), /Contribution point must be a non-empty string/);
  assert.throws(() => contributions.register(42, first), /Contribution point must be a non-empty string/);
  assert.throws(() => contributions.register('missing', null), /must be an object/);
  assert.throws(() => contributions.register('missing', {}), /Contribution id must be a non-empty string/);
  assert.throws(
    () => contributions.register('bad-owner', first, { owner: 42 }),
    /Contribution owner must be a non-empty string/
  );

  contributions.register(' custom.point ', first, { owner: ' owner.one ' });
  contributions.register('other.point', first, { id: 'first', owner: 'owner.two' });
  contributions.register('array.point', [], { id: 'array', owner: 'owner.array' });
  assert.equal(contributions.list('custom.point')[0], first);
  assert.deepEqual(contributions.list(' custom.point '), []);
  assert.throws(
    () => contributions.register('custom.point', { id: 'first' }, { owner: 'another.owner' }),
    /already registered/
  );

  // The old NUL-delimited composite key made these distinct identities collide.
  contributions.register('alpha\0beta', { id: 'gamma' });
  contributions.register('alpha', { id: 'beta\0gamma' });
  assert.equal(contributions.list('alpha\0beta').length, 1);
  assert.equal(contributions.list('alpha').length, 1);

  const entries = contributions.listEntries();
  assert.deepEqual(entries.map(entry => entry.point), [
    'custom.point', 'other.point', 'array.point', 'alpha\0beta', 'alpha'
  ]);
  assert.equal(Object.isFrozen(entries[0]), true);
  assert.equal(entries[0].contribution, first);
  assert.deepEqual(contributions.listEntries('').map(entry => entry.point), entries.map(entry => entry.point));
  assert.deepEqual(contributions.describe('custom.point'), [
    { point: 'custom.point', id: 'first', owner: 'owner.one' }
  ]);
  assert.equal(Object.isFrozen(contributions.describe('custom.point')[0]), true);
});

test('point-specific validators retain their normalization and ownership contracts', () => {
  const contributions = new ContributionRegistry();
  const decoration = {
    id: 'acme.sync',
    namespace: 'acme.sync',
    lane: 'sync',
    getDecoration() { return null; }
  };
  contributions.register(ContributionPoint.FILE_DECORATIONS_SYNC, decoration, { owner: 'acme' });
  assert.equal(contributions.list(ContributionPoint.FILE_DECORATIONS_SYNC)[0], decoration);
  assert.throws(
    () => contributions.register(ContributionPoint.FILE_DECORATIONS_SCM, {
      ...decoration,
      id: 'acme.wrong-lane'
    }, { owner: 'acme' }),
    /does not match contribution point/
  );

  contributions.register(ContributionPoint.SOURCE_CONTROL, {
    id: 'acme.scm',
    title: 'Source Control'
  }, { owner: 'acme' });
  const sourceControl = contributions.list(ContributionPoint.SOURCE_CONTROL)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(sourceControl)), {
    id: 'acme.scm',
    title: 'Source Control',
    icon: 'git-branch',
    order: 0,
    openCommand: null
  });
  assert.equal(Object.isFrozen(sourceControl), true);
  assert.throws(
    () => contributions.register(ContributionPoint.SOURCE_CONTROL, {
      id: 'acme.other',
      title: 'Other'
    }, { id: 'acme.mismatch', owner: 'acme' }),
    /id must match/
  );

  contributions.register(ContributionPoint.DOCUMENT_VIEWS, {
    id: 'acme.preview',
    title: 'Preview',
    extensions: ['.MD'],
    entry: 'views/preview.js'
  }, { owner: 'acme' });
  const documentView = contributions.list(ContributionPoint.DOCUMENT_VIEWS)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(documentView)), {
    id: 'acme.preview',
    title: 'Preview',
    extensions: ['.md'],
    entry: 'views/preview.js',
    resources: [],
    priority: 0
  });
  assert.equal(Object.isFrozen(documentView), true);
});

test('collect snapshots providers, awaits sequentially, binds this, and isolates every failure', async () => {
  const handlerError = new Error('handler failed');
  const getterError = new Error('getter failed');
  const reported = [];
  const order = [];
  let lateRegistered = false;
  const contributions = new ContributionRegistry({
    onError(event) {
      reported.push(event);
      throw new Error('observer failed');
    }
  });

  const first = {
    id: 'first',
    async run(value) {
      assert.equal(this, first);
      order.push('first:start');
      await Promise.resolve();
      order.push('first:end');
      if (!lateRegistered) {
        lateRegistered = true;
        contributions.register('providers', {
          id: 'late',
          run(lateValue) {
            order.push('late');
            return lateValue + 100;
          }
        });
      }
      return value + 1;
    }
  };
  const getter = { id: 'getter' };
  Object.defineProperty(getter, 'run', {
    get() {
      order.push('getter');
      throw getterError;
    }
  });
  const failure = {
    id: 'failure',
    run() {
      order.push('failure');
      throw handlerError;
    }
  };
  const last = {
    id: 'last',
    run(value) {
      order.push('last');
      return value + 2;
    }
  };
  contributions.register('providers', first);
  contributions.register('providers', { id: 'missing', run: 'not-a-function' });
  contributions.register('providers', getter);
  contributions.register('providers', failure);
  contributions.register('providers', last);

  const result = await contributions.collect('providers', 'run', 5);
  assert.deepEqual(result.values, [6, 7]);
  assert.deepEqual(order, ['first:start', 'first:end', 'getter', 'failure', 'last']);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].id, 'getter');
  assert.equal(result.errors[0].error, getterError);
  assert.equal(result.errors[1].id, 'failure');
  assert.equal(result.errors[1].error, handlerError);
  assert.deepEqual(reported, [
    {
      source: 'contribution',
      point: 'providers',
      id: 'getter',
      owner: 'core',
      error: getterError
    },
    {
      source: 'contribution',
      point: 'providers',
      id: 'failure',
      owner: 'core',
      error: handlerError
    }
  ]);

  order.length = 0;
  const second = await contributions.collect('providers', 'run', 1);
  assert.deepEqual(second.values, [2, 3, 101]);
  assert.equal(order.at(-1), 'late');
});

test('change listeners remain synchronous, snapshot-based, frozen, and observer-safe', () => {
  const changes = [];
  const errors = [];
  const listenerError = new Error('listener failed');
  const contributions = new ContributionRegistry({
    onError(event) {
      errors.push(event);
      throw new Error('observer failed');
    }
  });
  let lateSubscription;
  const lateListener = event => changes.push('late:' + event.type);
  const firstListener = event => {
    assert.equal(Object.isFrozen(event), true);
    changes.push('first:' + event.type);
    if (!lateSubscription) lateSubscription = contributions.onDidChange(lateListener);
  };
  const firstSubscription = contributions.onDidChange(firstListener);
  const duplicateSubscription = contributions.onDidChange(firstListener);
  contributions.onDidChange(() => { throw listenerError; });
  contributions.onDidChange(event => changes.push('last:' + event.type));

  const registration = contributions.register('events', { id: 'event.one' });
  assert.deepEqual(changes, ['first:added', 'last:added']);
  registration.dispose();
  assert.deepEqual(changes, [
    'first:added', 'last:added',
    'first:removed', 'last:removed', 'late:removed'
  ]);
  assert.deepEqual(errors, [
    {
      source: 'contribution-listener',
      point: 'events',
      id: 'event.one',
      owner: 'core',
      error: listenerError
    },
    {
      source: 'contribution-listener',
      point: 'events',
      id: 'event.one',
      owner: 'core',
      error: listenerError
    }
  ]);

  firstSubscription.dispose();
  duplicateSubscription.dispose();
  lateSubscription.dispose();
  contributions.register('events', { id: 'event.two' });
  assert.equal(changes.at(-1), 'last:added');
});

test('change listeners preserve removal snapshots and Set-style duplicate subscriptions', () => {
  const snapshotRegistry = new ContributionRegistry();
  const snapshotCalls = [];
  let laterSubscription;
  snapshotRegistry.onDidChange(() => {
    snapshotCalls.push('remover');
    laterSubscription.dispose();
  });
  laterSubscription = snapshotRegistry.onDidChange(() => snapshotCalls.push('later'));
  snapshotRegistry.register('events', { id: 'event.snapshot' });
  assert.deepEqual(snapshotCalls, ['remover', 'later']);

  const duplicateRegistry = new ContributionRegistry();
  let duplicateCalls = 0;
  const duplicateListener = () => { duplicateCalls += 1; };
  const firstSubscription = duplicateRegistry.onDidChange(duplicateListener);
  const duplicateSubscription = duplicateRegistry.onDidChange(duplicateListener);
  firstSubscription.dispose();
  duplicateRegistry.register('events', { id: 'event.deduplicated' });
  assert.equal(duplicateCalls, 0);
  duplicateSubscription.dispose();
});

test('registration handles and owner/global disposal preserve identity and ordering', () => {
  const removals = [];
  const contributions = new ContributionRegistry({ onError() { throw new Error('observer failed'); } });
  contributions.onDidChange(event => {
    if (event.type === 'removed') removals.push(event.id);
    throw new Error('listener failed');
  });

  const active = contributions.register('lifecycle', { id: 'active' }, { owner: 'owner.active' });
  active.dispose();
  active.dispose();
  assert.deepEqual(removals, ['active']);

  const stale = contributions.register('lifecycle', { id: 'replaceable', value: 'old' }, { owner: 'owner.old' });
  contributions.disposeOwner('owner.old');
  const replacement = { id: 'replaceable', value: 'new' };
  contributions.register('lifecycle', replacement, { owner: 'owner.new' });
  stale.dispose();
  assert.equal(contributions.list('lifecycle')[0], replacement);

  contributions.register('lifecycle', { id: 'owner.first' }, { owner: 'owner.group' });
  contributions.register('lifecycle', { id: 'owner.second' }, { owner: 'owner.group' });
  contributions.disposeOwner(' owner.group ');
  assert.equal(contributions.list('lifecycle').length, 3);
  contributions.disposeOwner('owner.group');
  assert.deepEqual(removals.slice(-2), ['owner.first', 'owner.second']);

  contributions.register('other', { id: 'global.last' }, { owner: 'owner.global' });
  contributions.dispose();
  contributions.dispose();
  assert.deepEqual(removals.slice(-2), ['global.last', 'replaceable']);
  assert.deepEqual(contributions.listEntries(), []);
  assert.throws(() => contributions.register('late', { id: 'late' }), /has been disposed/);
  assert.throws(() => contributions.onDidChange(() => {}), /has been disposed/);
});

test('typed contribution maps preserve point, callback, event, and dynamic boundaries', () => {
  const source = [
    "import { ContributionPoint, ContributionRegistry } from '../renderer/core/contribution-registry';",
    "import type { ContributionPointId } from '../renderer/core/contribution-registry';",
    "import type { DocumentViewDescriptorDto } from '../types/contributions';",
    "import type { RendererContributionMap, RendererContributionRegistrationMap } from '../types/renderer-platform';",
    'type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'const pointCoverage: Equal<keyof RendererContributionMap, ContributionPointId> = true;',
    'const registrationPointCoverage: Equal<keyof RendererContributionRegistrationMap, ContributionPointId> = true;',
    'interface Provider {',
    '  readonly id?: string;',
    '  readonly run: (input: { readonly value: string }) => Promise<number>;',
    '  readonly optional?: (enabled: boolean) => string;',
    '}',
    'interface DataContribution { readonly id?: string; readonly value: number; }',
    'interface KnownMap { readonly provider: Provider; readonly data: DataContribution; }',
    'type HybridMap = Record<string, object> & { readonly provider: Provider };',
    'declare const known: ContributionRegistry<KnownMap>;',
    "known.register('provider', { id: 'provider', run: async input => input.value.length });",
    "known.register('data', { id: 'data', value: 1 });",
    "known.list('provider')[0]!.run({ value: 'ok' });",
    "const collected: Promise<{ readonly values: number[]; readonly errors: readonly unknown[] }> =",
    "  known.collect('provider', 'run', { value: 'ok' });",
    '// @ts-expect-error Unknown points are rejected by a precise contribution map.',
    "known.register('unknown', { id: 'unknown' });",
    '// @ts-expect-error Contributions must match the selected point.',
    "known.register('data', { id: 'data', value: 'wrong' });",
    '// @ts-expect-error Callback properties cannot narrow their accepted DTO.',
    "known.register('provider', { id: 'narrow', run: async (input: { value: string; extra: number }) => input.extra });",
    '// @ts-expect-error collect only accepts callable members.',
    "known.collect('data', 'value');",
    '// @ts-expect-error collect arguments follow the selected callback.',
    "known.collect('provider', 'run', { value: 1 });",
    'declare const knownPoint: keyof KnownMap;',
    '// @ts-expect-error Finite point unions must be narrowed before registration.',
    "known.register(knownPoint, { id: 'unsafe', value: 1 });",
    "declare const knownMethod: 'run' | 'optional';",
    '// @ts-expect-error Finite method unions must be narrowed before collection.',
    "known.collect('provider', knownMethod, { value: 'unsafe' });",
    'known.onDidChange(event => {',
    "  if (event.point === 'data') event.contribution.value.toFixed();",
    "  if (event.point === 'provider') event.contribution.run({ value: 'event' });",
    '});',
    'declare const hybrid: ContributionRegistry<HybridMap>;',
    "hybrid.register('provider', { id: 'hybrid', run: async input => input.value.length });",
    '// @ts-expect-error A known point in a hybrid map keeps its precise contribution type.',
    "hybrid.register('provider', { id: 'hybrid.wrong', value: 1 });",
    'const hybridCollected: Promise<{ readonly values: number[]; readonly errors: readonly unknown[] }> =',
    "  hybrid.collect('provider', 'run', { value: 'known' });",
    'declare const hybridPoint: string;',
    "hybrid.register(hybridPoint, { id: 'hybrid.dynamic', value: 1 });",
    'const hybridDynamicResult: Promise<{ readonly values: unknown[]; readonly errors: readonly unknown[] }> =',
    '  hybrid.collect(hybridPoint, dynamicMethod, 1, 2, 3);',
    'const hybridLiteralDynamicResult: Promise<{ readonly values: unknown[]; readonly errors: readonly unknown[] }> =',
    "  hybrid.collect('other', 'invoke', 1);",
    '// @ts-expect-error A precise mutable registry cannot be widened to a dynamic registry.',
    'const widened: ContributionRegistry<Record<string, object>> = known;',
    '// @ts-expect-error Contribution maps cannot contain scalar values.',
    'type ScalarRegistry = ContributionRegistry<{ bad: string }>;',
    '// @ts-expect-error Contribution maps cannot contain optional points.',
    'type OptionalRegistry = ContributionRegistry<{ optional?: Provider }>;',
    '// @ts-expect-error A contribution is an object descriptor, not a bare callback.',
    'type FunctionRegistry = ContributionRegistry<{ callback: () => void }>;',
    '// @ts-expect-error Source-control output must match the built-in validator result.',
    'type InvalidSourceRegistry = ContributionRegistry<{ sourceControl: { readonly id: string; readonly title: string; readonly marker: number } }>;',
    '// @ts-expect-error Document-view output cannot claim fields stripped by its validator.',
    'type InvalidDocumentRegistry = ContributionRegistry<{ documentViews: DocumentViewDescriptorDto & { readonly marker: number } }>;',
    'declare const renderer: ContributionRegistry<RendererContributionMap>;',
    'interface MenuContribution { readonly id: string; readonly title: string; }',
    'declare const menuContribution: MenuContribution;',
    'renderer.register(ContributionPoint.MENUS, menuContribution);',
    'renderer.register(ContributionPoint.FILE_DECORATIONS_SYNC, {',
    "  namespace: 'core.sync', lane: 'sync', getDecoration: () => null",
    "}, { id: 'core.sync' });",
    'renderer.register(ContributionPoint.FILE_DECORATIONS_SYNC, {',
    "  id: 'core.inline', namespace: 'core.inline', lane: 'sync', getDecoration: () => null",
    '});',
    '// @ts-expect-error A contribution id or registration option id is required.',
    "renderer.register(ContributionPoint.FILE_DECORATIONS_SYNC, { namespace: 'core.missing', lane: 'sync', getDecoration: () => null });",
    '// @ts-expect-error File-decoration providers must return synchronously.',
    "renderer.register(ContributionPoint.FILE_DECORATIONS_SYNC, { id: 'core.async', namespace: 'core.async', lane: 'sync', getDecoration: async () => null });",
    '// @ts-expect-error The file-decoration lane must match its contribution point.',
    "renderer.register(ContributionPoint.FILE_DECORATIONS_SYNC, { id: 'core.scm', namespace: 'core.scm', lane: 'scm', getDecoration: () => null });",
    "renderer.register(ContributionPoint.SOURCE_CONTROL, { id: 'core.scm', title: 'Source Control' });",
    "renderer.list(ContributionPoint.SOURCE_CONTROL)[0]!.openCommand?.toUpperCase();",
    'renderer.register(ContributionPoint.DOCUMENT_VIEWS, {',
    "  id: 'core.preview', title: 'Preview', extensions: ['.md'], entry: 'views/preview.js'",
    '});',
    'renderer.list(ContributionPoint.DOCUMENT_VIEWS)[0]!.resources.map(resource => resource.toUpperCase());',
    '// @ts-expect-error Finite opaque points do not invent callable contribution members.',
    "renderer.collect(ContributionPoint.MENUS, 'run');",
    'const dynamic = new ContributionRegistry();',
    'declare const dynamicPoint: string;',
    'declare const dynamicMethod: string;',
    "dynamic.register(dynamicPoint, { id: 'dynamic', run: (value: number) => value + 1 });",
    'const dynamicLiteralResult: Promise<{ readonly values: unknown[]; readonly errors: readonly unknown[] }> =',
    "  dynamic.collect('literal.point', 'run', 1);",
    '// @ts-expect-error Dynamic contributions cannot be callable, even with an inline id.',
    "dynamic.register(dynamicPoint, Object.assign(() => 1, { id: 'callable.inline' }));",
    '// @ts-expect-error Dynamic contributions cannot be callable when options supply the id.',
    "dynamic.register(dynamicPoint, () => 1, { id: 'callable.option' });",
    'const dynamicResult: Promise<{ readonly values: unknown[]; readonly errors: readonly unknown[] }> =',
    '  dynamic.collect(dynamicPoint, dynamicMethod, 1, 2, 3);',
    'dynamicResult.then(result => {',
    '  // @ts-expect-error Dynamic contribution results require validation before property access.',
    '  result.values[0].value;',
    '});',
    'void pointCoverage;',
    'void registrationPointCoverage;',
    'void collected;',
    'void hybridCollected;',
    'void hybridDynamicResult;',
    'void hybridLiteralDynamicResult;',
    'void dynamicLiteralResult;',
    'void widened;',
    'void (null as unknown as ScalarRegistry);',
    'void (null as unknown as OptionalRegistry);',
    'void (null as unknown as FunctionRegistry);',
    'void (null as unknown as InvalidSourceRegistry);',
    'void (null as unknown as InvalidDocumentRegistry);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__contribution-registry-contract.ts',
    source
  });
});
