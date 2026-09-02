'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
let ServiceRegistry;

test.before(async () => {
  const build = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['renderer/core/service-registry.ts'],
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
  ServiceRegistry = module.exports.ServiceRegistry;
});

test('service registry validates and normalizes registrations without leaking services', () => {
  const services = new ServiceRegistry();
  const privateService = Object.freeze({ value: 1 });
  const publicService = Object.freeze({ value: 2 });
  const publicView = Object.freeze({ value: 2 });

  assert.throws(() => services.register('', {}), /Service id must be a non-empty string/);
  assert.throws(() => services.register(42, {}), /Service id must be a non-empty string/);
  assert.throws(() => services.register('missing', null), /requires a value/);
  assert.throws(() => services.register('missing', undefined), /requires a value/);
  assert.throws(
    () => services.register('bad-owner', {}, { owner: 42 }),
    /Service owner must be a non-empty string/
  );

  services.register(' private.service ', privateService, { owner: ' core.private ' });
  services.register('public.service', publicService, {
    owner: 'public.owner',
    exposeToPlugins: true,
    pluginView: publicView
  });
  services.register('fallback.service', publicService, {
    owner: 'public.owner',
    exposeToPlugins: true
  });

  assert.equal(services.get('private.service'), privateService);
  assert.equal(services.require('private.service'), privateService);
  assert.equal(services.get('unknown.service'), undefined);
  assert.throws(() => services.require('unknown.service'), /Unknown service/);
  assert.throws(() => services.getForPlugin('private.service'), /not exposed to plugins/);
  assert.throws(() => services.getForPlugin('unknown.service'), /Unknown service/);
  assert.equal(services.getForPlugin('public.service'), publicView);
  assert.notEqual(services.getForPlugin('public.service'), publicService);
  assert.equal(services.getForPlugin('fallback.service'), publicService);
  assert.throws(() => services.register('private.service', {}), /already registered/);

  const descriptions = services.describe();
  assert.deepEqual(JSON.parse(JSON.stringify(descriptions)), [
    { id: 'private.service', owner: 'core.private', exposeToPlugins: false },
    { id: 'public.service', owner: 'public.owner', exposeToPlugins: true },
    { id: 'fallback.service', owner: 'public.owner', exposeToPlugins: true }
  ]);
  assert.equal(Object.isFrozen(descriptions[0]), true);
  assert.equal(Object.hasOwn(descriptions[0], 'service'), false);
  assert.equal(Object.hasOwn(descriptions[0], 'pluginView'), false);
});

test('typed service maps require an explicit plugin DTO and keep host services private', () => {
  const contractPath = path.join(ROOT, 'tests', '__service-registry-contract.ts');
  const source = [
    "import { ServiceRegistry } from '../renderer/core/service-registry';",
    "import type { RendererPluginServiceMap, RendererServiceMap } from '../types/renderer-platform';",
    "declare const services: ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>;",
    "declare const tasks: RendererServiceMap['workbench.projectTasks'];",
    "declare const taskView: RendererPluginServiceMap['workbench.projectTasks'];",
    "declare const diagnosticsHost: RendererServiceMap['host.diagnostics'];",
    "services.register('workbench.projectTasks', tasks, { exposeToPlugins: true, pluginView: taskView });",
    "services.getForPlugin('workbench.projectTasks').list();",
    '// @ts-expect-error Plugin-visible typed services require an explicit DTO projection.',
    "services.register('workbench.projectTasks', tasks, { exposeToPlugins: true });",
    '// @ts-expect-error Host services are not members of the plugin service map.',
    "services.register('host.diagnostics', diagnosticsHost, { exposeToPlugins: true, pluginView: diagnosticsHost });",
    '// @ts-expect-error Host services cannot be requested through the plugin boundary.',
    "services.getForPlugin('host.diagnostics');",
    'const dynamicServices = new ServiceRegistry();',
    "dynamicServices.register('plugin.dynamic', { value: 1 }, {",
    '  exposeToPlugins: true,',
    '  pluginView: { value: 1 }',
    '});'
  ].join('\n');
  const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.renderer.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = fileName => path.resolve(fileName) === contractPath || fileExists(fileName);
  host.readFile = fileName => path.resolve(fileName) === contractPath ? source : readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.resolve(fileName) === contractPath
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([contractPath], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n'
  });
  assert.equal(diagnostics.length, 0, formatted);
});

test('an active registration handle removes and disposes its service exactly once', () => {
  const calls = [];
  const services = new ServiceRegistry();
  const registration = services.register('active.service', {
    dispose: () => calls.push('active')
  });

  registration.dispose();
  registration.dispose();
  assert.equal(services.has('active.service'), false);
  assert.deepEqual(calls, ['active']);
});

test('service registry disposes in reverse order, isolates errors, and ignores stale handles', () => {
  const calls = [];
  const errors = [];
  const services = new ServiceRegistry({ onError: event => errors.push(event) });

  const stale = services.register('replaceable', {
    dispose: () => calls.push('replaceable-old')
  }, { owner: 'owner.replaceable' });
  services.register('owner.first', {
    dispose: () => calls.push('owner-first-service')
  }, {
    owner: 'owner.group',
    dispose: () => calls.push('owner-first-explicit')
  });
  services.register('owner.second', {
    dispose: () => calls.push('owner-second')
  }, { owner: 'owner.group' });
  services.register('global.first', {
    dispose: () => calls.push('global-first')
  }, { owner: 'owner.global' });
  services.register('global.second', {}, {
    owner: 'owner.global',
    dispose: () => {
      calls.push('global-second');
      throw new Error('dispose failed');
    }
  });

  services.disposeOwner('owner.group');
  services.disposeOwner('owner.group');
  assert.deepEqual(calls, ['owner-second', 'owner-first-explicit']);

  services.disposeOwner('owner.replaceable');
  const replacement = Object.freeze({ value: 'replacement' });
  services.register('replaceable', replacement, { owner: 'owner.new' });
  stale.dispose();
  assert.equal(services.require('replaceable'), replacement);

  services.dispose();
  services.dispose();
  assert.deepEqual(calls, [
    'owner-second',
    'owner-first-explicit',
    'replaceable-old',
    'global-second',
    'global-first'
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, 'service-dispose');
  assert.equal(errors[0].id, 'global.second');
  assert.equal(errors[0].owner, 'owner.global');
  assert.match(errors[0].error.message, /dispose failed/);
  assert.throws(() => services.register('late.service', {}), /has been disposed/);
});
