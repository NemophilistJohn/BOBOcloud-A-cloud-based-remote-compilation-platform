'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('extension sandbox contracts keep transport data untrusted and lifecycle disposable', () => {
  const source = [
    "import { EXTENSION_SANDBOX_CSP, buildExtensionSandboxDocument, createSandboxedExtensionSandbox } from '../renderer/core/plugin-extension-sandbox';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  PluginExtensionSandbox,',
    '  PluginExtensionSandboxDocument,',
    '  PluginExtensionSandboxFactory,',
    '  PluginExtensionSandboxOptions',
    "} from '../types/renderer-platform';",
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    'type IsUnknown<Value> = IsAny<Value> extends true',
    '  ? false',
    '  : unknown extends Value ? ([keyof Value] extends [never] ? true : false) : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type InboundMessage = Parameters<NonNullable<PluginExtensionSandboxOptions['onMessage']>>[0];",
    'type InboundMessageIsUnknown = AssertTrue<IsUnknown<InboundMessage>>;',
    'declare const sandboxDocument: PluginExtensionSandboxDocument;',
    'const options: PluginExtensionSandboxOptions = {',
    '  document: sandboxDocument,',
    '  MessageChannel,',
    '  connectTimeoutMs: 5_000,',
    '  onMessage(message) { void message; },',
    '  onFatal(error) { void error; }',
    '};',
    'const factory: PluginExtensionSandboxFactory = createSandboxedExtensionSandbox;',
    'const sandbox: PluginExtensionSandbox = factory(options);',
    'const disposable: Disposable = sandbox;',
    'const ready: Promise<void> = sandbox.ready;',
    "sandbox.postMessage({ protocolVersion: 1, type: 'initialize' });",
    'const policy: string = EXTENSION_SANDBOX_CSP;',
    'const documentSource: string = buildExtensionSandboxDocument();',
    'type FactoryIsNotAny = AssertFalse<IsAny<typeof createSandboxedExtensionSandbox>>;',
    'type FactoryResultIsNotAny = AssertFalse<IsAny<ReturnType<typeof createSandboxedExtensionSandbox>>>;',
    'type SandboxIsNotAny = AssertFalse<IsAny<typeof sandbox>>;',
    'disposable.dispose();',
    'void ready; void policy; void documentSource;',
    'void (null as unknown as InboundMessageIsUnknown);',
    'void (null as unknown as FactoryIsNotAny);',
    'void (null as unknown as FactoryResultIsNotAny);',
    'void (null as unknown as SandboxIsNotAny);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__plugin-extension-sandbox-types-contract.ts',
    source
  });
});
