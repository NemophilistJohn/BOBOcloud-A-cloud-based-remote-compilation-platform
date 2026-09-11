'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('renderer state exposes a mutable typed DTO without disposal or plugin authority', () => {
  const source = [
    "import { ALWAYS_COLLAPSED, createRendererState } from '../src/state';",
    "import type { RendererAiState, RendererState } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type StateHasCoreFields = AssertTrue<',
    "  Equal<Pick<RendererState, 'tabs' | 'activeTabPath' | 'workspaceRoot' | 'ai'>, { tabs: RendererState['tabs']; activeTabPath: string | null; workspaceRoot: string | null; ai: RendererAiState }>" ,
    '>;',
    'const state: RendererState = createRendererState();',
    'state.tabs.push({ path: \'/workspace/main.ts\', dirty: true });',
    "state.activePanel = 'problems';",
    "state.ai.inlineStatus = 'idle';",
    'const collapsed: boolean = ALWAYS_COLLAPSED.has(\'node_modules\');',
    '// @ts-expect-error Renderer state is not a disposable service.',
    'state.dispose();',
    'void collapsed; void state;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__state-types-contract.ts',
    source
  });
});

