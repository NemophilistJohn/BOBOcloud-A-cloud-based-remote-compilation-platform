import type { AgentStateHandle, AgentStateStoreContract } from './agent';
import type { CommandPaletteRegistrationPort } from './command-palette';
import type { Disposable, DisposableStore, Dispose, MaybeAsyncDisposable } from './lifecycle';
import type {
  PluginManifestDto,
  PluginManifestRegistrationDto,
  PluginPermissionDto,
  PluginRuntimeCommandHandler,
  PluginRuntimeCommandMetadataDto,
  PluginRuntimeContributionOptionsDto,
  PluginRuntimeOperationResultDto,
  PluginRuntimeStatusDto
} from './plugin-runtime';
import type {
  ExtensionData,
  ExtensionLocaleDto,
  ExtensionRequestId
} from './plugin-extension-protocol';
import type { PluginExtensionSandbox, PluginExtensionSandboxFactory } from './plugin-extension-sandbox';
import type { ScmFileDecorationProvider } from './scm';
import type {
  SourceControlStateHandle,
  SourceControlStateStoreContract,
  SourceControlStateStoreErrorEvent
} from './source-control';

export type PluginExtensionLocaleDto = ExtensionLocaleDto;

export interface PluginExtensionLocalizationDto {
  readonly locale: PluginExtensionLocaleDto;
  readonly messages: Readonly<Record<string, string>>;
}

export interface PluginExtensionDescriptorRegistrationDto {
  readonly id: string;
  readonly manifest: PluginManifestRegistrationDto;
  readonly grantedPermissions?: readonly PluginPermissionDto[];
  readonly revision?: string;
}

export interface PluginExtensionDescriptorDto {
  readonly id: string;
  readonly manifest: PluginManifestDto;
  readonly grantedPermissions: readonly PluginPermissionDto[];
  readonly revision: string;
}

export type PluginExtensionStatusDto = PluginRuntimeStatusDto;
export type PluginExtensionLifecycleStatusDto = PluginExtensionStatusDto | 'stopped';

export interface PluginExtensionSnapshotDto {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly status: PluginExtensionStatusDto;
  readonly grantedPermissions: readonly PluginPermissionDto[];
}

export type PluginExtensionOperationResultDto = PluginRuntimeOperationResultDto;

export interface PluginExtensionRefreshFailureDto {
  readonly id: string;
  readonly error: unknown;
}

export interface PluginExtensionRefreshCompletedDto {
  readonly ok: boolean;
  readonly activated: readonly string[];
  readonly deactivated: readonly string[];
  readonly failures: readonly PluginExtensionRefreshFailureDto[];
  readonly error?: never;
}

export interface PluginExtensionRefreshRejectedDto {
  readonly ok: false;
  readonly error: unknown;
  readonly activated?: never;
  readonly deactivated?: never;
  readonly failures?: never;
}

export type PluginExtensionRefreshResultDto =
  | PluginExtensionRefreshCompletedDto
  | PluginExtensionRefreshRejectedDto;

export interface PluginExtensionChangeEventDto {
  readonly id: string;
  readonly status: PluginExtensionLifecycleStatusDto;
  readonly version: string;
}

export type PluginExtensionErrorSource =
  | 'agent-model-event'
  | 'extension-activate'
  | 'extension-command'
  | 'extension-command-palette'
  | 'extension-deactivate'
  | 'extension-descriptor'
  | 'extension-dispose'
  | 'extension-i18n'
  | 'extension-listener'
  | 'extension-protocol'
  | 'extension-refresh'
  | 'extension-sandbox'
  | 'extension-sandbox-dispose'
  | 'extension-validate';

export interface PluginExtensionErrorEvent {
  readonly source: PluginExtensionErrorSource;
  readonly id?: string;
  readonly error: unknown;
}

export type PluginExtensionObservedErrorEvent =
  | PluginExtensionErrorEvent
  | SourceControlStateStoreErrorEvent;

export interface PluginExtensionHostServiceRegistryPort<PluginServices extends object> {
  getForPluginDynamic<Id extends string>(
    id: Id
  ): Id extends keyof PluginServices ? PluginServices[Id] : unknown;
}

export type PluginExtensionCommandExecutionResultDto<Value = unknown> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: unknown }>;

export interface PluginExtensionHostCommandRegistryPort {
  registerDynamic(
    id: string,
    handler: PluginRuntimeCommandHandler,
    metadata?: PluginRuntimeCommandMetadataDto & { readonly owner?: string }
  ): Disposable;
  executeDynamic(id: string, ...args: unknown[]): Promise<unknown>;
  executeDynamicIsolated(
    id: string,
    ...args: unknown[]
  ): Promise<PluginExtensionCommandExecutionResultDto>;
  disposeOwner(owner: string): void;
}

export interface PluginExtensionHostContributionRegistryPort {
  registerDynamic(
    point: string,
    contribution: object,
    options?: PluginRuntimeContributionOptionsDto & { readonly owner?: string }
  ): Disposable;
  disposeOwner(owner: string): void;
}

export interface PluginExtensionCommandPalettePort extends CommandPaletteRegistrationPort {}

export type PluginExtensionHostAsyncValue<Value> = Value | PromiseLike<Value>;

export type PluginExtensionHostBroker = (
  id: string,
  method: string,
  args?: unknown
) => PluginExtensionHostAsyncValue<unknown>;

export type PluginExtensionLocaleSubscription = Dispose | Disposable | null | undefined;

export type PluginExtensionServiceSnapshotFactory = (
  id: string,
  service: unknown
) => unknown;

export interface PluginExtensionHostOptions<
  PluginServices extends object = Record<string, unknown>
> {
  readonly services: PluginExtensionHostServiceRegistryPort<PluginServices>;
  readonly commands: PluginExtensionHostCommandRegistryPort;
  readonly contributions: PluginExtensionHostContributionRegistryPort;
  readonly sourceControls?: SourceControlStateStoreContract | null;
  readonly agents?: AgentStateStoreContract | null;
  readonly listDescriptors?: () => PluginExtensionHostAsyncValue<unknown>;
  readonly loadEntry: (id: string) => PluginExtensionHostAsyncValue<unknown>;
  readonly broker?: PluginExtensionHostBroker | null;
  readonly loadLocalization?: (
    id: string,
    locale: PluginExtensionLocaleDto
  ) => PluginExtensionHostAsyncValue<unknown>;
  readonly getLocale?: () => unknown;
  readonly onLocaleChange?: (
    listener: () => void
  ) => PluginExtensionLocaleSubscription;
  readonly sandboxFactory?: PluginExtensionSandboxFactory;
  readonly getCommandPalette?: () => PluginExtensionCommandPalettePort | null | undefined;
  readonly serviceSnapshots?: Readonly<
    Partial<Record<string, PluginExtensionServiceSnapshotFactory>>
  >;
  readonly localize?: (key: string) => string;
  readonly onError?: (event: PluginExtensionObservedErrorEvent) => void;
  readonly activationTimeoutMs?: number;
  readonly invocationTimeoutMs?: number;
  readonly deactivationTimeoutMs?: number;
}

export interface PluginExtensionHostContract extends MaybeAsyncDisposable {
  onDidChange(listener: (event: PluginExtensionChangeEventDto) => void): Disposable;
  handleAgentModelEvent(payload: unknown): boolean;
  list(): readonly PluginExtensionSnapshotDto[];
  start(): Promise<PluginExtensionRefreshResultDto>;
  refresh(
    descriptors?: readonly PluginExtensionDescriptorRegistrationDto[]
  ): Promise<PluginExtensionRefreshResultDto>;
  activate(
    descriptor: PluginExtensionDescriptorRegistrationDto
  ): Promise<PluginExtensionOperationResultDto>;
  deactivate(id: string): Promise<PluginExtensionOperationResultDto>;
  dispose(): Promise<void>;
}

export interface PluginExtensionHostConstructor {
  new <PluginServices extends object = Record<string, unknown>>(
    options: PluginExtensionHostOptions<PluginServices>
  ): PluginExtensionHostContract;
}

/** @internal Renderer extension-host implementation detail. */
export interface PluginExtensionDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** @internal Renderer extension-host implementation detail. */
export interface PluginExtensionPendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** @internal Renderer extension-host implementation detail. */
export type PluginExtensionResource =
  | Readonly<{
      kind: 'command' | 'contribution' | 'document-view';
      disposable: Disposable;
    }>
  | Readonly<{
      kind: 'source-control';
      disposable: Disposable;
      stateProvider: SourceControlStateHandle;
    }>
  | Readonly<{
      kind: 'scm-decoration';
      disposable: Disposable;
      provider: ScmFileDecorationProvider;
    }>
  | Readonly<{
      kind: 'agent';
      disposable: Disposable;
      stateProvider: AgentStateHandle;
    }>;

/** @internal Renderer extension-host implementation detail. */
export interface PluginExtensionModelStreamRecord {
  lastSequence: number;
  terminal: boolean;
  settled: boolean;
  delivering: boolean;
  cancelRequested: boolean;
  queue: Array<{
    readonly args: ExtensionData;
    readonly byteLength: number;
    accounted: boolean;
  } | undefined>;
  head: number;
  queuedBytes: number;
  deliveryError: unknown;
  readonly terminalDelivery: PluginExtensionDeferred<void>;
}

/** @internal Renderer extension-host implementation detail. */
export interface PluginExtensionHostRecord {
  readonly descriptor: PluginExtensionDescriptorDto;
  status: PluginExtensionStatusDto;
  readonly subscriptions: DisposableStore;
  sandbox: PluginExtensionSandbox | null;
  readonly pending: Map<string, PluginExtensionPendingRequest>;
  readonly incomingRequests: Set<ExtensionRequestId>;
  readonly handles: Map<string, PluginExtensionResource>;
  readonly ready: PluginExtensionDeferred<void>;
  activationSettled: boolean;
  readonly cancellation: PluginExtensionDeferred<void>;
  cancelled: boolean;
  cleaned: boolean;
  activationPromise: Promise<PluginExtensionOperationResultDto> | null;
  deactivationPromise: Promise<PluginExtensionOperationResultDto> | null;
  nextRequestId: number;
  readonly modelStreams: Map<string, PluginExtensionModelStreamRecord>;
  pendingModelEventBytes: number;
  localization: PluginExtensionLocalizationDto | null;
  localizationRevision: number;
}
