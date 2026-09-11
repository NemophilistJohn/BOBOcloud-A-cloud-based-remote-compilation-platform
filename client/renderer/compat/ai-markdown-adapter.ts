import { createAiMarkdownRenderer } from '../../src/ai-markdown';
import type {
  AiMarkdownFacade,
  AiMarkdownI18nPort,
  AiMarkdownIconPort,
  AiMarkdownTemmlPort
} from '../../types/ai-markdown';

interface LegacyAiMarkdownNamespace {
  aiMarkdown?: AiMarkdownFacade;
  i18n?: AiMarkdownI18nPort;
  icons?: AiMarkdownIconPort;
}

type AiMarkdownWindow = Window & {
  BOBO?: LegacyAiMarkdownNamespace;
  temml?: AiMarkdownTemmlPort;
};

const legacyWindow = window as AiMarkdownWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

BOBO.aiMarkdown = createAiMarkdownRenderer({
  document,
  getI18n: () => BOBO.i18n,
  getIcons: () => BOBO.icons,
  getTemml: () => legacyWindow.temml,
  getClipboard: () => legacyWindow.navigator.clipboard,
  setTimer: (callback, delayMs) => legacyWindow.setTimeout(callback, delayMs)
});
