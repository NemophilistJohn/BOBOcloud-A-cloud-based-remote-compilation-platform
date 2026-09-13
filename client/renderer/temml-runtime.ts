// Bridge Temml's ESM export to the existing browser-global contract.
import temml from 'temml';
import type { AiMarkdownTemmlPort } from '../types/ai-markdown';

type TemmlWindow = Window & {
  temml?: AiMarkdownTemmlPort;
};

const legacyWindow = window as TemmlWindow;

// Keep the historical first-writer-wins behavior. Embedders that provide a
// compatible Temml global remain authoritative, while the lazy bundle fills
// the global only when it is absent.
legacyWindow.temml = legacyWindow.temml || (temml as unknown as AiMarkdownTemmlPort);

