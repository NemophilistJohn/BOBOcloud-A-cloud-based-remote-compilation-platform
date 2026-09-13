import type { AiChatPanelFacade } from './ai-chat-panel';
import type { AiSettingsCenterFacade } from './ai-settings-center';

/** The two public projections supplied by the lazy AI presentation bundle. */
export interface AiUiBundle {
  readonly chatPanel: AiChatPanelFacade | undefined;
  readonly settingsCenter: AiSettingsCenterFacade | undefined;
}

/** Narrow compatibility surface exposed by the core-bundle lazy loader. */
export interface AiUiLoaderFacade {
  ensureLoaded(): Promise<AiUiBundle>;
  isLoaded(): boolean;
}

/** Minimal i18n and toast ports needed to report a failed lazy load. */
export interface AiUiLoaderI18nPort {
  t(source: unknown): string;
}

export interface AiUiLoaderToastPort {
  error?(message: string): void;
}

/**
 * The compatibility namespace consumed by the loader.  Other BOBO members
 * deliberately remain outside this contract so the lazy edge cannot become
 * an untyped service locator.
 */
export interface AiUiLoaderBobo {
  i18n?: AiUiLoaderI18nPort;
  toast?: AiUiLoaderToastPort;
  aiChatPanel?: AiChatPanelFacade;
  aiSettingsCenter?: AiSettingsCenterFacade;
  aiUiLoader?: AiUiLoaderFacade;
}
