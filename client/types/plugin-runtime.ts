import type {
  AgentDescriptorRegistrationDto,
  AgentStateStoreContract,
  AgentStateRegistrationDto,
  AgentVersionDto
} from './agent';
import type { DocumentViewDescriptorRegistrationDto } from './document-view';
import type { Disposable, MaybeAsyncDisposable } from './lifecycle';
import type {
  SourceControlDescriptorRegistrationDto,
  SourceControlStateStoreContract,
  SourceControlStateStoreErrorEvent,
  SourceControlStateRegistrationDto,
  SourceControlVersionDto
} from './source-control';

export type PluginApiVersionDto = '1.6.0';

export type PluginPermissionDto =
  | 'commands.register'
  | 'commands.execute'
  | 'contributions.register'
  | 'services.read'
  | 'sourceControl.register'
  | 'scm.git.read'
  | 'scm.git.write'
  | 'fileDecorations.scm'
  | 'documentViews.register'
  | 'documents.read'
  | 'agents.register'
  | 'models.generate'
  | 'workspace.read'
  | 'workspace.write'
  | 'process.execute'
  | 'skills.read'
  | 'storage.local';

export type PluginRuntimeContributionPointDto =
  | 'menus'
  | 'fileDecorations.sync'
  | 'fileDecorations.scm'
  | 'fileDecorations.diagnostic'
  | 'tasks'
  | 'debug.configurationProviders'
  | 'settings'
  | 'languages'
  | 'ai.tools'
  | 'mcp.providers'
  | 'skills.providers';

export interface PluginManifestEnginesRegistrationDto {
  readonly pluginApi: string;
  readonly [engine: string]: unknown;
}

export interface PluginManifestEnginesDto {
  readonly pluginApi: string;
  readonly [engine: string]: unknown;
}

export interface PluginManifestRegistrationDto {
  readonly id: string;
  readonly version: string;
  readonly displayName?: string;
  readonly engines: PluginManifestEnginesRegistrationDto;
  readonly permissions?: readonly PluginPermissionDto[];
  readonly contributes?: Readonly<Record<string, unknown>> | null;
}

export interface PluginManifestDto {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly engines: PluginManifestEnginesDto;
  readonly permissions: readonly PluginPermissionDto[];
  readonly contributes: Readonly<Record<string, unknown>>;
}

export type PluginRuntimeStatusDto = 'activating' | 'active' | 'deactivating';

export interface PluginRuntimeSnapshotDto {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly status: PluginRuntimeStatusDto;
}

export interface PluginRuntimeOperationSuccessDto {
  readonly ok: true;
  readonly id: string;
}

export interface PluginRuntimeOperationFailureDto {
  readonly ok: false;
  readonly error: unknown;
}

export type PluginRuntimeOperationResultDto =
  | PluginRuntimeOperationSuccessDto
  | PluginRuntimeOperationFailureDto;

export type PluginRuntimeErrorSourceDto =
  | 'plugin-lifecycle'
  | 'plugin-validate'
  | 'plugin-dispose'
  | 'plugin-activate'
  | 'plugin-deactivate';

export interface PluginRuntimeErrorEvent {
  readonly source: PluginRuntimeErrorSourceDto;
  readonly id?: string;
  readonly error: unknown;
}

export type PluginRuntimeObservedErrorEvent =
  | PluginRuntimeErrorEvent
  | SourceControlStateStoreErrorEvent;

export interface PluginRuntimeIdentityDto {
  readonly id: string;
  readonly version: string;
}

export interface PluginRuntimeSubscriptions {
  add<Value extends MaybeAsyncDisposable>(disposable: Value): Value;
}

/** Erased command boundary for an already validated plugin namespace. */
export type PluginRuntimeCommandHandler = (...args: any[]) => unknown;
type PluginRuntimeExecutable =
  | PluginRuntimeCommandHandler
  | (abstract new (...args: any[]) => object);

export interface PluginRuntimeCommandMetadataDto {
  readonly title?: string;
  readonly category?: string;
  readonly permissions?: readonly string[];
}

export interface PluginRuntimeCommands {
  register(
    id: string,
    handler: PluginRuntimeCommandHandler,
    metadata?: PluginRuntimeCommandMetadataDto
  ): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
}

export type PluginRuntimeContributionRegistrationDto<Contribution extends object = object> =
  Contribution &
  { readonly id?: unknown } &
  ([Extract<Contribution, PluginRuntimeExecutable>] extends [never] ? unknown : never);

export interface PluginRuntimeContributionOptionsDto {
  readonly id?: string;
}

export interface PluginRuntimeContributions {
  register<Contribution extends object>(
    point: PluginRuntimeContributionPointDto,
    contribution: PluginRuntimeContributionRegistrationDto<Contribution> & { readonly id: string },
    options?: PluginRuntimeContributionOptionsDto
  ): Disposable;
  register<Contribution extends object>(
    point: PluginRuntimeContributionPointDto,
    contribution: PluginRuntimeContributionRegistrationDto<Contribution>,
    options: PluginRuntimeContributionOptionsDto & { readonly id: string }
  ): Disposable;
}

export interface PluginRuntimeServices<PluginServices extends object> {
  get<Id extends string>(
    id: Id
  ): Id extends keyof PluginServices ? PluginServices[Id] : unknown;
}

export interface PluginRuntimeSourceControlProvider extends Disposable {
  readonly id: string;
  setState(state: SourceControlStateRegistrationDto): Promise<SourceControlVersionDto>;
  clearState(): Promise<SourceControlVersionDto>;
}

export interface PluginRuntimeSourceControl {
  register(
    descriptor: SourceControlDescriptorRegistrationDto
  ): Promise<PluginRuntimeSourceControlProvider>;
}

export interface PluginRuntimeDocumentViews {
  register(descriptor: DocumentViewDescriptorRegistrationDto): Disposable;
}

export interface PluginRuntimeAgentProvider extends Disposable {
  readonly id: string;
  setState(state: AgentStateRegistrationDto): AgentVersionDto;
  clearState(): AgentVersionDto;
}

export interface PluginRuntimeAgents {
  register(descriptor: AgentDescriptorRegistrationDto): PluginRuntimeAgentProvider;
}

export type PluginRuntimeI18nValuesDto = Readonly<Record<string, unknown>>;
export type PluginRuntimeI18nChangeListener = () => void;

export interface PluginRuntimeI18n {
  readonly locale: string;
  t(key: unknown, values?: PluginRuntimeI18nValuesDto | null): string;
  onDidChange(listener: PluginRuntimeI18nChangeListener): Disposable;
}

export interface PluginRuntimeLocalizationRegistrationDto {
  readonly locale?: string;
  readonly messages?: Readonly<Record<string, unknown>>;
}

export interface PluginRuntimeContext<PluginServices extends object = Record<string, unknown>> {
  readonly apiVersion: PluginApiVersionDto;
  readonly plugin: Readonly<PluginRuntimeIdentityDto>;
  readonly subscriptions: Readonly<PluginRuntimeSubscriptions>;
  readonly services: Readonly<PluginRuntimeServices<PluginServices>>;
  readonly commands: Readonly<PluginRuntimeCommands>;
  readonly contributions: Readonly<PluginRuntimeContributions>;
  readonly sourceControl: Readonly<PluginRuntimeSourceControl>;
  readonly documentViews: Readonly<PluginRuntimeDocumentViews>;
  readonly agents: Readonly<PluginRuntimeAgents>;
  readonly i18n: Readonly<PluginRuntimeI18n>;
}

export type PluginRuntimeActivationValue =
  | void
  | (() => void | PromiseLike<void>)
  | MaybeAsyncDisposable;

export interface PluginRuntimeModule<PluginServices extends object = Record<string, unknown>> {
  activate(
    context: PluginRuntimeContext<PluginServices>
  ): PluginRuntimeActivationValue | PromiseLike<PluginRuntimeActivationValue>;
  deactivate?(): void | PromiseLike<void>;
}

export interface PluginRuntimeServiceRegistryPort<PluginServices extends object> {
  getForPluginDynamic<Id extends string>(
    id: Id
  ): Id extends keyof PluginServices ? PluginServices[Id] : unknown;
  disposeOwner(owner: string): void;
}

export interface PluginRuntimeCommandRegistryPort {
  registerDynamic(
    id: string,
    handler: PluginRuntimeCommandHandler,
    metadata?: PluginRuntimeCommandMetadataDto & { readonly owner?: string }
  ): Disposable;
  executeDynamic(id: string, ...args: unknown[]): Promise<unknown>;
  disposeOwner(owner: string): void;
}

export interface PluginRuntimeContributionRegistryPort {
  registerDynamic(
    point: string,
    contribution: object,
    options?: PluginRuntimeContributionOptionsDto & { readonly owner?: string }
  ): Disposable;
  disposeOwner(owner: string): void;
}

export interface PluginRuntimeOptions<PluginServices extends object = Record<string, unknown>> {
  readonly services: PluginRuntimeServiceRegistryPort<PluginServices>;
  readonly commands: PluginRuntimeCommandRegistryPort;
  readonly contributions: PluginRuntimeContributionRegistryPort;
  readonly sourceControls?: SourceControlStateStoreContract;
  readonly agents?: AgentStateStoreContract;
  readonly getPluginI18n?: (
    manifest: PluginManifestDto
  ) => PluginRuntimeLocalizationRegistrationDto | null | undefined;
  readonly onError?: (event: PluginRuntimeObservedErrorEvent) => void;
}

export interface PluginRuntimeContract<PluginServices extends object = Record<string, unknown>>
extends MaybeAsyncDisposable {
  activate(
    manifest: PluginManifestRegistrationDto,
    pluginModule: PluginRuntimeModule<PluginServices>
  ): Promise<PluginRuntimeOperationResultDto>;
  deactivate(id: string): Promise<PluginRuntimeOperationResultDto>;
  list(): readonly PluginRuntimeSnapshotDto[];
  dispose(): Promise<void>;
}
