'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI prompt DTOs keep the pure facade closed and structurally typed', () => {
  const source = [
    "import { buildChatMessages, buildInlineChatMessage, truncate } from '../src/ai-prompts';",
    "import type { AiPromptBuildOptionsDto, AiPromptBuildResultDto, AiPromptMessageDto, AiPromptsFacade } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    "type FacadeKeys = 'CORE_PROMPT' | 'APP_KNOWLEDGE' | 'truncate' | 'buildContextSections' | 'buildSystemPrompt' | 'buildChatMessages' | 'buildInlineChatMessage' | 'messagesLength';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AiPromptsFacade, FacadeKeys>>;',
    'declare const options: AiPromptBuildOptionsDto;',
    'const result: AiPromptBuildResultDto = buildChatMessages(options);',
    'const messages: readonly AiPromptMessageDto[] = result.messages;',
    'const inline: string = buildInlineChatMessage({}, { codeBefore: "const ", codeAfter: ";" });',
    'const bounded: string = truncate("abcdef", 3, "head");',
    '// @ts-expect-error Prompt facade has no host or disposal authority.',
    'const invalid = ({} as AiPromptsFacade).dispose;',
    'void messages; void inline; void bounded; void invalid;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-prompts-types-contract.ts',
    source
  });
});
