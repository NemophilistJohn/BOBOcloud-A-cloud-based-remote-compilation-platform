'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');
let CommandRegistry;

test.before(async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/command-registry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const module = { exports: {} };
  vm.runInNewContext(build.outputFiles[0].text, {
    module,
    exports: module.exports,
    require
  });
  CommandRegistry = module.exports.CommandRegistry;
});

test('command registry validates, normalizes, and describes registrations', () => {
  const commands = new CommandRegistry();
  const permissions = ['workspace.read'];

  assert.throws(() => commands.register('', () => {}), /Command id must be a non-empty string/);
  assert.throws(() => commands.register(42, () => {}), /Command id must be a non-empty string/);
  assert.throws(() => commands.register('missing', null), /requires a handler/);
  assert.throws(
    () => commands.register('bad-owner', () => {}, { owner: 42 }),
    /Command owner must be a non-empty string/
  );

  commands.register(' command.one ', () => 1, {
    owner: ' owner.one ',
    title: '',
    category: 'Tests',
    permissions
  });
  permissions.push('workspace.write');
  commands.register('command.two', () => 2, { title: 42, category: null });

  assert.equal(commands.has('command.one'), true);
  assert.equal(commands.has(' command.one '), false);
  assert.throws(() => commands.register('command.one', () => 3), /already registered/);

  const descriptions = commands.describe();
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), [
    {
      id: 'command.one',
      owner: 'owner.one',
      title: '',
      category: 'Tests',
      permissions: ['workspace.read']
    },
    {
      id: 'command.two',
      owner: 'core',
      title: 'command.two',
      category: '',
      permissions: []
    }
  ]);
  assert.equal(Object.isFrozen(descriptions[0]), true);
  assert.equal(Object.isFrozen(descriptions[0].permissions), true);
  assert.equal(Object.hasOwn(descriptions[0], 'handler'), false);
});

test('execute always returns a promise and preserves sync and async results', async () => {
  const events = [];
  const commands = new CommandRegistry({ onError: event => events.push(event) });
  commands.register('sync', (left, right) => left + right);
  commands.register('async', async value => value * 2);
  commands.register('bound', function () {
    return { id: this.id, owner: this.owner, title: this.title };
  }, { owner: 'owner.bound', title: 'Bound handler' });

  const syncResult = commands.execute('sync', 2, 3);
  const asyncResult = commands.execute('async', 4);
  const unknownResult = commands.execute('unknown');

  assert.equal(typeof syncResult.then, 'function');
  assert.equal(typeof asyncResult.then, 'function');
  assert.equal(typeof unknownResult.then, 'function');
  assert.equal(await syncResult, 5);
  assert.equal(await asyncResult, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(await commands.execute('bound'))), {
    id: 'bound',
    owner: 'owner.bound',
    title: 'Bound handler'
  });
  await assert.rejects(unknownResult, /Unknown command: unknown/);
  assert.deepEqual(events, []);
});

test('execute reports command failures and rethrows the original error object', async () => {
  const events = [];
  const commands = new CommandRegistry({ onError: event => events.push(event) });
  const syncError = new Error('sync failed');
  const asyncError = new Error('async failed');
  commands.register('sync.fail', () => { throw syncError; }, { owner: 'owner.sync' });
  commands.register('async.fail', async () => { throw asyncError; }, { owner: 'owner.async' });

  await assert.rejects(commands.execute('sync.fail'), error => error === syncError);
  await assert.rejects(commands.execute('async.fail'), error => error === asyncError);
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'command');
  assert.equal(events[0].id, 'sync.fail');
  assert.equal(events[0].owner, 'owner.sync');
  assert.equal(events[0].error, syncError);
  assert.equal(events[1].source, 'command');
  assert.equal(events[1].id, 'async.fail');
  assert.equal(events[1].owner, 'owner.async');
  assert.equal(events[1].error, asyncError);
});

test('an error observer cannot replace the command failure', async () => {
  const commandError = new Error('command failed');
  const commands = new CommandRegistry({
    onError() {
      throw new Error('observer failed');
    }
  });
  commands.register('fails', () => { throw commandError; });

  await assert.rejects(commands.execute('fails'), error => error === commandError);
});

test('executeIsolated returns a precise success or failure without rejecting', async () => {
  const commands = new CommandRegistry();
  const failure = new Error('isolated failure');
  commands.register('succeeds', value => ({ value }));
  commands.register('fails', () => Promise.reject(failure));

  assert.deepEqual(
    JSON.parse(JSON.stringify(await commands.executeIsolated('succeeds', 7))),
    { ok: true, value: { value: 7 } }
  );
  const failed = await commands.executeIsolated('fails');
  const unknown = await commands.executeIsolated('unknown');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, failure);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /Unknown command: unknown/);
});

test('registration handles, owner disposal, and global disposal preserve identity', async () => {
  const commands = new CommandRegistry();
  const active = commands.register('active', () => 'active', { owner: 'owner.active' });
  active.dispose();
  active.dispose();
  assert.equal(commands.has('active'), false);

  const stale = commands.register('replaceable', () => 'old', { owner: 'owner.old' });
  commands.register('kept', () => 'kept', { owner: 'owner.kept' });
  commands.disposeOwner('owner.old');
  commands.register('replaceable', () => 'new', { owner: 'owner.new' });
  stale.dispose();
  assert.equal(await commands.execute('replaceable'), 'new');
  assert.equal(await commands.execute('kept'), 'kept');

  commands.disposeOwner(' owner.new ');
  assert.equal(commands.has('replaceable'), true);
  commands.dispose();
  commands.dispose();
  assert.equal(commands.has('replaceable'), false);
  await assert.rejects(commands.execute('replaceable'), /Unknown command/);
  assert.throws(() => commands.register('late', () => {}), /has been disposed/);
});

test('typed command maps enforce host IDs, arguments, handlers, and isolated narrowing', () => {
  const source = [
    "import { CommandRegistry } from '../renderer/core/command-registry';",
    "import type { RendererCommandMap } from '../types/renderer-platform';",
    'declare const commands: CommandRegistry<RendererCommandMap>;',
    '// @ts-expect-error A precise host registry cannot be widened into a dynamic registry.',
    'const widenedCommands: CommandRegistry<Record<string, (...args: any[]) => unknown>> = commands;',
    "declare const configuration: Awaited<ReturnType<RendererCommandMap['bobocloud.tasks.refresh']>>;",
    "commands.register('bobocloud.tasks.runSelected', async () => true);",
    "commands.register('bobocloud.tasks.refresh', async () => configuration);",
    "const runResult: Promise<boolean | void> = commands.execute('bobocloud.tasks.runSelected');",
    "const refreshResult = commands.execute('bobocloud.tasks.refresh');",
    "refreshResult.then(configuration => configuration.tasks);",
    '// @ts-expect-error Known command results cannot degrade to any.',
    "const invalidRefreshResult: Promise<boolean> = commands.execute('bobocloud.tasks.refresh');",
    "commands.executeIsolated('bobocloud.tasks.refresh').then(result => {",
    '  if (result.ok) result.value.tasks;',
    '  else result.error;',
    '});',
    '// @ts-expect-error Unknown host command IDs are rejected by the typed facade.',
    "commands.execute('plugin.dynamic');",
    '// @ts-expect-error Unknown host command IDs cannot be registered through the typed facade.',
    "commands.register('plugin.dynamic', () => undefined);",
    '// @ts-expect-error Project Tasks commands accept no arguments.',
    "commands.execute('bobocloud.tasks.refresh', 1);",
    '// @ts-expect-error Known command handlers must preserve their result contract.',
    "commands.register('bobocloud.tasks.refresh', async () => true);",
    'declare const commandId: keyof RendererCommandMap;',
    '// @ts-expect-error Finite union IDs must be narrowed before registration.',
    'commands.register(commandId, async () => true);',
    '// @ts-expect-error Finite union IDs must be narrowed before execution.',
    'commands.execute(commandId);',
    '// @ts-expect-error Finite union IDs must be narrowed before isolated execution.',
    'commands.executeIsolated(commandId);',
    'interface MethodCommands {',
    '  inspect(payload: { readonly value: string }): Promise<number>;',
    '}',
    'declare const methodCommands: CommandRegistry<MethodCommands>;',
    "methodCommands.register('inspect', async payload => payload.value.length);",
    '// @ts-expect-error Method-derived handlers cannot narrow their accepted DTO.',
    "methodCommands.register('inspect', async (payload: { value: string; extra: number }) => payload.extra);",
    '// @ts-expect-error Every typed command map value must be callable.',
    'type InvalidRegistry = CommandRegistry<{ bad: string }>;',
    '// @ts-expect-error Typed command maps cannot contain optional handlers.',
    'type OptionalRegistry = CommandRegistry<{ optional?: () => void }>;',
    'const dynamicCommands = new CommandRegistry();',
    "dynamicCommands.register('plugin.dynamic', (value: number) => ({ value }));",
    "const dynamicResult: Promise<unknown> = dynamicCommands.execute('plugin.dynamic', 1);",
    'declare const dynamicId: string;',
    'dynamicCommands.register(dynamicId, (...args: unknown[]) => args.length);',
    'dynamicCommands.execute(dynamicId, 1, 2, 3);',
    'dynamicResult.then(value => {',
    '  // @ts-expect-error Dynamic command results remain unknown until validated.',
    '  value.value;',
    '});',
    'void runResult;',
    'void widenedCommands;',
    'void (null as unknown as InvalidRegistry);',
    'void (null as unknown as OptionalRegistry);',
    'void invalidRefreshResult;',
    'void dynamicResult;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__command-registry-contract.ts',
    source
  });
});
