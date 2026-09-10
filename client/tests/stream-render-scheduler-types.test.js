'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('stream scheduler exposes a closed typed factory and legacy facade shape', () => {
  const source = [
    "import createStreamRenderScheduler, { createStreamRenderScheduler as namedFactory } from '../src/stream-render-scheduler';",
    'import type {',
    '  StreamRenderScheduler,',
    '  StreamRenderSchedulerFacade,',
    '  StreamRenderSchedulerOptions,',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    "type SchedulerKeys = 'schedule' | 'flush' | 'cancel' | 'pending';",
    'type SchedulerIsExact = AssertTrue<Equal<keyof StreamRenderScheduler, SchedulerKeys>>;',
    'type FacadeIsExact = AssertTrue<Equal<keyof StreamRenderSchedulerFacade, \'createStreamRenderScheduler\'>>;',
    'const options: StreamRenderSchedulerOptions = { interval: 50, setTimeout: () => 1, clearTimeout: () => undefined };',
    'const scheduler: StreamRenderScheduler = createStreamRenderScheduler(() => undefined, options);',
    'const sameFactory: typeof createStreamRenderScheduler = namedFactory;',
    'scheduler.schedule(); scheduler.flush(); scheduler.cancel();',
    'const pending: boolean = scheduler.pending();',
    '// @ts-expect-error Scheduler methods are a closed compatibility surface.',
    'scheduler.dispose();',
    'void sameFactory; void pending;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__stream-render-scheduler-types-contract.ts',
    source
  });
});
