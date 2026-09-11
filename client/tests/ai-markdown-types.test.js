'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI Markdown renderer keeps a narrow typed facade and explicit presentation ports', () => {
  const source = [
    "import { createAiMarkdownRenderer } from '../src/ai-markdown';",
    "import type { AiMarkdownDependencies, AiMarkdownFacade, AiMarkdownRenderOptions, AiMarkdownRenderer } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    "type FacadeIsExact = AssertTrue<Equal<keyof AiMarkdownFacade, 'render'>>;",
    'declare const dependencies: AiMarkdownDependencies;',
    'declare const container: HTMLElement;',
    'const options: AiMarkdownRenderOptions = { streaming: true };',
    'const renderer: AiMarkdownRenderer = createAiMarkdownRenderer(dependencies);',
    'renderer.render(container, "# hello", options);',
    'const facade: AiMarkdownFacade = renderer;',
    '// @ts-expect-error Markdown renderer does not own host or disposal authority.',
    'facade.dispose();'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-markdown-types-contract.ts',
    source
  });
});
