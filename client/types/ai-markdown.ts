export interface AiMarkdownRenderOptions {
  readonly streaming?: boolean;
}

export interface AiMarkdownI18nPort {
  t(key: string): string;
}

export interface AiMarkdownIconPort {
  readonly copy?: string;
}

export interface AiMarkdownTemmlPort {
  renderToString(tex: string, options: Readonly<Record<string, unknown>>): string;
}

export interface AiMarkdownClipboardPort {
  writeText(value: string): Promise<void>;
}

export interface AiMarkdownDependencies {
  readonly document: Document;
  readonly getI18n: () => AiMarkdownI18nPort | null | undefined;
  readonly getIcons: () => AiMarkdownIconPort | null | undefined;
  readonly getTemml: () => AiMarkdownTemmlPort | null | undefined;
  readonly getClipboard: () => AiMarkdownClipboardPort | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
}

export interface AiMarkdownFacade {
  render(
    container: HTMLElement,
    markdown: unknown,
    options?: AiMarkdownRenderOptions
  ): void;
}

export type AiMarkdownRenderer = AiMarkdownFacade;
