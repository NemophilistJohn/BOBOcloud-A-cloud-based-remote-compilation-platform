import type { AiInlineService } from './ai-inline';
import type { AiProfileDto, AiService } from './ai-service';
import type { Disposable } from './lifecycle';
import type { WorkbenchLayoutFacade } from './workbench-layout';

/** The profile fields rendered by the compact status menu. */
export type AiAgentButtonProfileDto = Pick<AiProfileDto, 'id' | 'name'>;

export interface AiAgentButtonInlineState {
  readonly enabled?: unknown;
  readonly [key: string]: unknown;
}

/** Mutable renderer state needed by the status button. */
export interface AiAgentButtonAiState {
  chatOpen: boolean;
  status: string;
  chatProfiles?: readonly AiAgentButtonProfileDto[] | null;
  chatProfileId?: string | null;
  inline?: AiAgentButtonInlineState | null;
  readonly [key: string]: unknown;
}

export interface AiAgentButtonRendererState {
  ai: AiAgentButtonAiState;
  readonly [key: string]: unknown;
}

export type AiAgentButtonAiServicePort = Pick<
  AiService,
  'getProfileFor' | 'getModelStatus' | 'saveSettings' | 'setProfileFor'
>;

export type AiAgentButtonInlinePort = Pick<AiInlineService, 'setEnabled'>;

export type AiAgentButtonWorkbenchPort = Pick<
  WorkbenchLayoutFacade,
  'setAuxiliaryVisible'
>;

export interface AiAgentButtonChatPanelPort {
  setVisible?(visible: boolean): unknown;
}

export interface AiAgentButtonSettingsCenterPort {
  open?(tab?: string): unknown;
}

export interface AiAgentButtonI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
}

export interface AiAgentButtonToastPort {
  error?(message: string): void;
}

/** Host-owned menu event, kept private to the trusted renderer. */
export interface AiAgentButtonHostPort {
  onOpenAiSettings(listener: () => void): Disposable;
}

export interface AiAgentButtonDependencies {
  readonly document: Document;
  readonly state: AiAgentButtonRendererState;
  readonly getI18n: () => AiAgentButtonI18nPort | null | undefined;
  readonly getAiService: () => AiAgentButtonAiServicePort | null | undefined;
  readonly getAiInline: () => AiAgentButtonInlinePort | null | undefined;
  readonly getWorkbench: () => AiAgentButtonWorkbenchPort | null | undefined;
  readonly getChatPanel: () => AiAgentButtonChatPanelPort | null | undefined;
  readonly getSettingsCenter: () => AiAgentButtonSettingsCenterPort | null | undefined;
  readonly getToast: () => AiAgentButtonToastPort | null | undefined;
  readonly host?: AiAgentButtonHostPort | null;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

/** Historical five-key BOBO.aiAgentButton projection. */
export interface AiAgentButtonFacade {
  init(): void;
  updateLEDs(status: string): void;
  toggleChat(open?: boolean): void;
  openMenu(): void;
  closeMenu(): void;
}

export interface AiAgentButtonService extends AiAgentButtonFacade, Disposable {
  readonly disposed: boolean;
}
