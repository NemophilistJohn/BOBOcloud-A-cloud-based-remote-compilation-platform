import {
  APP_KNOWLEDGE,
  buildChatMessages,
  buildContextSections,
  buildInlineChatMessage,
  buildSystemPrompt,
  CORE_PROMPT,
  messagesLength,
  truncate
} from '../../src/ai-prompts';
import type { AiPromptsFacade } from '../../types/ai-prompts';

interface LegacyAiNamespace {
  aiPrompts?: AiPromptsFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyAiNamespace };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Keep the historical writable namespace projection at the compatibility edge.
BOBO.aiPrompts = {
  CORE_PROMPT,
  APP_KNOWLEDGE,
  truncate,
  buildContextSections,
  buildSystemPrompt,
  buildChatMessages,
  buildInlineChatMessage,
  messagesLength
};
