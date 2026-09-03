import type {
  AgentCommandPayloadDto,
  AgentCommandValuesRegistrationDto,
  AgentStateStoreContract
} from './agent';
import type { FileDecorationService } from './file-decoration';
import type { Disposable } from './lifecycle';
import type {
  PluginApiVersionDto,
  PluginRuntimeContract
} from './plugin-runtime';
import type {
  SourceControlCommandDetailsDto,
  SourceControlCommandPayloadDto,
  SourceControlFormDto,
  SourceControlFormValues,
  SourceControlRawFormValues,
  SourceControlStateStoreContract
} from './source-control';
import type {
  CommandDescription,
  CommandExecutionResult,
  CommandRegistrationMetadata,
  DynamicCommandHandler
} from '../renderer/core/command-registry';
import type {
  ContributionCollectionResult,
  ContributionDescription,
  ContributionRegistrationOptions
} from '../renderer/core/contribution-registry';
import type { ServiceDescription } from '../renderer/core/service-registry';

/** Trusted dynamic service lookup retained for legacy workbench modules. */
export interface RendererPlatformServicesFacade {
  has(id: string): boolean;
  get(id: string): unknown;
  describe(): readonly ServiceDescription[];
}

export interface RendererPlatformCommandsFacade {
  register(
    id: string,
    handler: DynamicCommandHandler,
    metadata?: CommandRegistrationMetadata
  ): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  executeIsolated(
    id: string,
    ...args: unknown[]
  ): Promise<CommandExecutionResult<unknown>>;
  describe(): readonly CommandDescription[];
}

export interface RendererPlatformContributionsFacade {
  register(
    point: string,
    contribution: object,
    options?: ContributionRegistrationOptions
  ): Disposable;
  list(point: string): readonly object[];
  collect(
    point: string,
    method: string,
    ...args: unknown[]
  ): Promise<ContributionCollectionResult<unknown>>;
  describe(point?: string): readonly ContributionDescription[];
}

export interface RendererPlatformSourceControlFacade
  extends Pick<SourceControlStateStoreContract, 'list' | 'get' | 'onDidChange'> {
  normalizeFormValues(
    form: SourceControlFormDto | null,
    values: SourceControlRawFormValues
  ): SourceControlFormValues;
  createCommandPayload(
    descriptorId: string,
    actionId: string,
    values: SourceControlFormValues | null | undefined,
    details?: SourceControlCommandDetailsDto
  ): SourceControlCommandPayloadDto;
}

export interface RendererPlatformAgentsFacade
  extends Pick<AgentStateStoreContract, 'list' | 'get' | 'onDidChange'> {
  createCommandPayload(
    providerId: string,
    action: string,
    values?: AgentCommandValuesRegistrationDto
  ): AgentCommandPayloadDto;
}

export type RendererPlatformFileDecorationsFacade = Readonly<
  Pick<FileDecorationService, 'get' | 'onDidChange'>
>;

export type RendererPlatformPluginsFacade<PluginServices extends object> = Readonly<
  Pick<PluginRuntimeContract<PluginServices>, 'activate' | 'deactivate' | 'list'>
>;

/**
 * Frozen compatibility projection for trusted legacy renderer modules.
 * Installed extensions never receive this object.
 */
export interface RendererPlatformCompatibilityFacade<
  PluginServices extends object = Record<string, unknown>
> {
  readonly apiVersion: PluginApiVersionDto;
  readonly contributionPoints: typeof import('../renderer/core/contribution-registry').ContributionPoint;
  readonly permissions: typeof import('../renderer/core/plugin-runtime').PluginPermission;
  readonly fileDecorations: RendererPlatformFileDecorationsFacade;
  readonly sourceControl: Readonly<RendererPlatformSourceControlFacade>;
  readonly agents: Readonly<RendererPlatformAgentsFacade>;
  readonly services: Readonly<RendererPlatformServicesFacade>;
  readonly commands: Readonly<RendererPlatformCommandsFacade>;
  readonly contributions: Readonly<RendererPlatformContributionsFacade>;
  readonly plugins: RendererPlatformPluginsFacade<PluginServices>;
}
