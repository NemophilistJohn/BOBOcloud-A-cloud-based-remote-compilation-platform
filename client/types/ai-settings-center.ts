import type {
  AiOperationResultDto,
  AiProfileDto,
  AiPurpose,
  AiService,
  AiServiceRendererState,
  AiSettingsDto,
  AiStatusDto
} from './ai-service';
import type {
  AiCapabilitySource,
  AiKnownProviderId,
  AiProviderId,
  AiReasoningEffort,
  AiSettingsProviderDefinitionDto,
  AiSettingsSchemaPort
} from './ai-settings-schema';
import type { ConfirmFacade } from './confirm-dialog';
import type { Disposable, Dispose } from './lifecycle';
import type { RendererIconsFacade } from './icons';

export type {
  AiSettingsProviderDefinitionDto,
  AiSettingsSchemaPort
} from './ai-settings-schema';

/** Complete schema surface used by the settings editor. */
export interface AiSettingsCenterSchemaPort extends AiSettingsSchemaPort {
  readonly SCHEMA_VERSION?: number;
  readonly MAX_MODEL_REQUEST_OUTPUT_TOKENS?: number;
  readonly PROVIDER_ORDER?: readonly AiKnownProviderId[];
  readonly PROVIDER_CATALOG?: Readonly<Record<string, AiSettingsProviderDefinitionDto>>;
  readonly CAPABILITY_SOURCES?: readonly AiCapabilitySource[];
  readonly REASONING_EFFORTS?: readonly AiReasoningEffort[];
  readonly normalizeProviderId?: (value: unknown) => AiProviderId;
  readonly normalizeCapabilities?: (value: unknown) => AiProfileDto['capabilities'];
  readonly defaultEndpointFor?: (provider: unknown, values?: Readonly<Record<string, unknown>>) => string;
  readonly qwenRegionsForBillingPlan?: (billingPlan: unknown) => readonly string[];
  readonly validQwenWorkspaceId?: (value: unknown) => boolean;
}

export type AiSettingsCenterRendererState = AiServiceRendererState;

export type AiSettingsCenterAiServicePort = Pick<
  AiService,
  | 'getSettings'
  | 'getModelStatus'
  | 'testProfileConnection'
  | 'testModelConnection'
  | 'updateSettings'
  | 'saveSettings'
  | 'clearInlineCache'
>;

export interface AiSettingsCenterI18nPort {
  t(source: unknown, params?: Readonly<Record<string, unknown>> | null): string;
  onChange?(listener: () => void): Dispose;
}

export type AiSettingsCenterConfirmPort = ConfirmFacade;

export interface AiSettingsCenterAgentButtonPort {
  updateLEDs?(status: string): void;
}

export interface AiSettingsCenterAgentWorkbenchPort {
  refreshModels?(): unknown;
}

export interface AiSettingsCenterDependencies {
  readonly document: Document;
  readonly state: AiSettingsCenterRendererState;
  readonly getI18n: () => AiSettingsCenterI18nPort | null | undefined;
  readonly getSchema: () => AiSettingsCenterSchemaPort | null | undefined;
  readonly getAiService: () => AiSettingsCenterAiServicePort | null | undefined;
  readonly getConfirm: () => AiSettingsCenterConfirmPort | null | undefined;
  readonly getIcons: () => RendererIconsFacade | null | undefined;
  readonly getAgentButton: () => AiSettingsCenterAgentButtonPort | null | undefined;
  readonly getAgentWorkbench: () => AiSettingsCenterAgentWorkbenchPort | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly logger?: Pick<Console, 'error'>;
}

export interface AiSettingsCenterDraft {
  schemaVersion: number;
  chatProfiles: AiProfileDto[];
  inlineProfiles: AiProfileDto[];
  chatProfileId: string;
  inlineProfileId: string;
  globalInstructions: string;
  chat: {
    instructions: string;
    parameters: { maxTokens: number; temperature: number; topP: number; stop: string[]; [key: string]: unknown };
    context: { [key: string]: unknown; maxInputChars: number; currentFileChars: number; selectionChars: number; projectChars: number; referencedFileChars: number; maxReferencedFiles: number; historyMessages: number; historyMessageChars: number };
    [key: string]: unknown;
  };
  inline: {
    enabled: boolean;
    instructions: string;
    debounceMs: number;
    parameters: { maxTokens: number; temperature: number; topP: number; stop: string[]; [key: string]: unknown };
    context: { prefixChars: number; suffixChars: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  chatOpen: boolean;
  [key: string]: unknown;
}

export interface AiSettingsCenterService extends Disposable {
  readonly disposed: boolean;
  init(): void;
  open(tab?: string): void;
  close(): Promise<void>;
  save(): Promise<AiOperationResultDto | undefined>;
  switchTab(tab: string): void;
  isDirty(): boolean;
  getDraft(): AiSettingsDto | null;
}

/** Historical seven-key BOBO.aiSettingsCenter projection. */
export type AiSettingsCenterFacade = Pick<
  AiSettingsCenterService,
  'init' | 'open' | 'close' | 'save' | 'switchTab' | 'isDirty' | 'getDraft'
>;

export type AiSettingsCenterConnectionState =
  | { readonly state: 'disabled'; readonly key?: string }
  | { readonly state: string; readonly key: string };

export interface AiSettingsCenterProfileShape {
  readonly provider: {
    readonly id: string;
    readonly definition: AiSettingsProviderDefinitionDto;
  };
  readonly protocol: string;
  readonly authType: string;
  readonly region: string;
  readonly billingPlan: string;
  readonly workspaceId: string;
}
