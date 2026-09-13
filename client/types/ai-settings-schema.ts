import type {
  AiAuthType,
  AiCapabilitiesDto,
  AiMode,
  AiParametersDto,
  AiProfileDto,
  AiProtocol,
  AiPurpose,
  AiSettingsDto
} from './ai-service';

/** Provider ids understood by the canonical schema, with forward compatibility. */
export type AiKnownProviderId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'openai-compatible';

export type AiProviderId = AiKnownProviderId | (string & {});

export type AiCapabilitySource =
  | 'unknown'
  | 'provider-api'
  | 'official-catalog'
  | 'user-override'
  | (string & {});

export type AiReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type AiQwenRegion =
  | 'cn-beijing'
  | 'ap-southeast-1'
  | 'ap-northeast-1'
  | 'eu-central-1'
  | 'us-east-1';

export type AiQwenBillingPlan =
  | 'standard'
  | 'workspace'
  | 'trial'
  | 'token-plan'
  | 'coding-plan';

/** Provider metadata consumed by the AI settings editor. */
export interface AiSettingsProviderDefinitionDto {
  readonly labelKey: string;
  readonly protocols: readonly AiProtocol[];
  readonly defaultProtocol: AiProtocol;
  readonly authTypes: readonly AiAuthType[];
  readonly defaultAuthType: AiAuthType;
  readonly apiVersion?: string;
  readonly organization?: boolean;
  readonly project?: boolean;
  readonly region?: boolean;
  readonly workspace?: boolean;
  readonly billingPlan?: boolean;
  readonly [key: string]: unknown;
}

/** Values accepted by the schema's endpoint resolver. */
export interface AiSettingsSchemaEndpointValues {
  readonly protocol?: unknown;
  readonly region?: unknown;
  readonly billingPlan?: unknown;
  readonly workspaceId?: unknown;
  readonly [key: string]: unknown;
}

/** Defaults accepted by normalizeParameters; stop is normalized independently. */
export interface AiSettingsParameterDefaults {
  readonly maxTokens: number;
  readonly temperature: number;
  readonly topP: number;
}

/**
 * Minimal schema surface retained for the AI transport dependency.
 * Compatibility callers may provide only the two canonical normalizers.
 */
export interface AiSettingsSchemaPort {
  normalizeSettings(value: unknown): AiSettingsDto;
  normalizeProfile(value: unknown, index: number, purpose: AiPurpose): AiProfileDto;
}

/**
 * Complete v4 runtime surface exported by src/ai-settings-schema.js.
 * The runtime remains a shared CJS/UMD module because main/settings-store.js
 * loads it directly; this contract lets typed renderer code consume it without
 * copying or weakening the normalization implementation.
 */
export interface AiSettingsSchemaRuntime extends AiSettingsSchemaPort {
  readonly SCHEMA_VERSION: 4;
  readonly MAX_MODEL_REQUEST_OUTPUT_TOKENS: 262_144;
  readonly PROVIDER_ORDER: readonly AiKnownProviderId[];
  readonly PROVIDER_CATALOG: Readonly<Record<string, AiSettingsProviderDefinitionDto>>;
  readonly CAPABILITY_SOURCES: readonly AiCapabilitySource[];
  readonly REASONING_EFFORTS: readonly AiReasoningEffort[];
  readonly QWEN_REGIONS: readonly AiQwenRegion[];
  readonly QWEN_BILLING_PLANS: readonly AiQwenBillingPlan[];
  normalizeProviderId(value: unknown): AiProviderId;
  normalizeProtocol(
    value: unknown,
    provider?: unknown,
    endpoint?: unknown,
    purpose?: AiPurpose,
    mode?: AiMode
  ): AiProtocol;
  normalizeCapabilities(value: unknown): AiCapabilitiesDto;
  qwenRegionsForBillingPlan(value: unknown): readonly AiQwenRegion[];
  validQwenWorkspaceId(value: unknown): boolean;
  defaultEndpointFor(
    provider: unknown,
    values?: Readonly<AiSettingsSchemaEndpointValues>
  ): string;
  normalizeModelId(value: unknown): string;
  normalizeParameters(
    value: unknown,
    defaults: AiSettingsParameterDefaults,
    maxTokensMax: number
  ): AiParametersDto;
  normalizeStop(value: unknown): string[];
  settingsEqual(left: unknown, right: unknown): boolean;
}

export type AiSettingsSchemaRuntimePort = AiSettingsSchemaRuntime;
