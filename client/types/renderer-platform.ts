import type { RcloneClient } from '../src/rclone-client';
import type { DiagnosticsHost, DiagnosticsSettingsService } from './diagnostics';
import type {
  ProjectTasksHost,
  ProjectTasksPluginView,
  ProjectTasksService
} from './project-tasks';
import type {
  CloudFeaturePolicyService,
  ServerCapabilityService,
  ServerTransportService
} from './server-runtime';
import type { DisposableStore } from './lifecycle';
import type { RcloneNativeHost } from './native-host';
import type { FileIconPluginView, FileIconService } from './file-icons';
import type {
  FileDecorationProvider,
  FileDecorationService
} from './file-decoration';
import type { CommandRegistry } from '../renderer/core/command-registry';
import type {
  ContributionRegistrationMapFor,
  ContributionRegistry
} from '../renderer/core/contribution-registry';
import type { ServiceRegistry } from '../renderer/core/service-registry';
import type { AgentStateStore } from '../renderer/core/agent.js';
import type { PluginRuntime } from '../renderer/core/plugin-runtime.js';
import type { SourceControlStateStoreContract } from './source-control';
import type { SourceControlViewService } from './source-control-view';
import type {
  DocumentViewDescriptorDto,
  DocumentViewHost,
  DocumentViewService
} from './document-view';
import type {
  AgentDescriptorDto,
  RendererOpaqueContributionDto,
  SourceControlDescriptorDto
} from './contributions';

export interface RendererCommandMap {
  readonly 'bobocloud.tasks.runSelected': ProjectTasksService['runSelected'];
  readonly 'bobocloud.tasks.refresh': ProjectTasksService['refresh'];
}

export interface RendererServiceMap {
  readonly 'host.diagnostics': Readonly<DiagnosticsHost>;
  readonly 'host.documentViews': Readonly<DocumentViewHost>;
  readonly 'host.projectTasks': Readonly<ProjectTasksHost>;
  readonly 'host.rclone': Readonly<RcloneNativeHost>;
  readonly 'workbench.diagnosticsSettings': DiagnosticsSettingsService;
  readonly 'workbench.documentViews': DocumentViewService;
  readonly 'workbench.fileDecorations': FileDecorationService;
  readonly 'workbench.fileIcons': FileIconService;
  readonly 'workbench.projectTasks': ProjectTasksService;
  readonly 'workbench.rclone': RcloneClient;
  readonly 'workbench.serverTransport': Readonly<ServerTransportService>;
  readonly 'workbench.serverCapabilities': ServerCapabilityService;
  readonly 'workbench.cloudFeaturePolicy': Readonly<CloudFeaturePolicyService>;
  readonly 'workbench.sourceControlView': SourceControlViewService;
}

export interface RendererPluginServiceMap {
  readonly 'workbench.fileIcons': FileIconPluginView;
  readonly 'workbench.projectTasks': ProjectTasksPluginView;
}

export interface RendererContributionMap {
  readonly menus: RendererOpaqueContributionDto;
  readonly 'fileDecorations.sync': FileDecorationProvider<'sync'>;
  readonly 'fileDecorations.scm': FileDecorationProvider<'scm'>;
  readonly 'fileDecorations.diagnostic': FileDecorationProvider<'diagnostic'>;
  readonly tasks: RendererOpaqueContributionDto;
  readonly 'debug.configurationProviders': RendererOpaqueContributionDto;
  readonly settings: RendererOpaqueContributionDto;
  readonly languages: RendererOpaqueContributionDto;
  readonly 'ai.tools': RendererOpaqueContributionDto;
  readonly 'mcp.providers': RendererOpaqueContributionDto;
  readonly 'skills.providers': RendererOpaqueContributionDto;
  readonly agents: AgentDescriptorDto;
  readonly sourceControl: SourceControlDescriptorDto;
  readonly documentViews: DocumentViewDescriptorDto;
}

export type RendererContributionRegistrationMap =
  ContributionRegistrationMapFor<RendererContributionMap>;

export type { Disposable, DisposableStore, MaybeAsyncDisposable } from './lifecycle';
export type {
  FileIconLookupService,
  FileIconNameMap,
  FileIconPluginView,
  FileIconService,
  FileIconServiceOptions
} from './file-icons';
export type {
  CommandDescription,
  CommandExecutionFailure,
  CommandExecutionResult,
  CommandExecutionSuccess,
  CommandRegistrationMetadata,
  CommandRegistry,
  CommandRegistryErrorEvent,
  CommandRegistryOptions,
  DynamicCommandHandler
} from '../renderer/core/command-registry';
export type {
  ContributionChangeEvent,
  ContributionChangeEventFor,
  ContributionChangeType,
  ContributionCollectionError,
  ContributionCollectionResult,
  ContributionDescription,
  ContributionDescriptionFor,
  ContributionEntry,
  ContributionEntryFor,
  ContributionPointId,
  ContributionRegistrationMapFor,
  ContributionRegistrationOptions,
  ContributionRegistry,
  ContributionRegistryErrorEvent,
  ContributionRegistryOptions,
  DynamicContributionMethod
} from '../renderer/core/contribution-registry';
export type {
  ServiceDescription,
  ServiceRegistrationOptions,
  ServiceRegistry,
  ServiceRegistryErrorEvent,
  ServiceRegistryOptions
} from '../renderer/core/service-registry';
export type {
  FileDecorationChangeEvent,
  FileDecorationChangeListener,
  FileDecorationColorDto,
  FileDecorationDto,
  FileDecorationLaneForPoint,
  FileDecorationLaneDto,
  FileDecorationPointId,
  FileDecorationProvider,
  FileDecorationProviderChangeListener,
  FileDecorationProviderDto,
  FileDecorationProviderResult,
  FileDecorationRegistrationDto,
  FileDecorationService
} from './file-decoration';
export type {
  DocumentCloseResultDto,
  DocumentInfoDto,
  DocumentReadDataDto,
  DocumentReadRangeDto,
  DocumentReadResultDto,
  DocumentViewContributionChangeEventDto,
  DocumentViewContributionEntryDto,
  DocumentViewContributionPort,
  DocumentViewDependencies,
  DocumentViewDescriptorDto,
  DocumentViewDescriptorRegistrationDto,
  DocumentViewHideOptions,
  DocumentViewHost,
  DocumentViewI18n,
  DocumentViewInstance,
  DocumentViewLocalizationDto,
  DocumentViewManifestDescriptorDto,
  DocumentViewPublicDescriptorDto,
  DocumentViewRegistrationDto,
  DocumentViewService,
  DocumentViewState,
  DocumentViewSubscription,
  DocumentViewTabLike,
  DocumentViewThemeDto,
  DocumentViewThemeKindDto,
  DocumentViewThemePort,
  DocumentViewViewsPort,
  DocumentViewWorkspacePort,
  LoadedDocumentViewDto,
  SandboxedDocumentView,
  SandboxedDocumentViewOptions,
  VerifiedDocumentViewFileDto
} from './document-view';
export type {
  AgentAccessModeDto,
  AgentCapabilitiesDto,
  AgentCommandMapDto,
  AgentDescriptorDto,
  AgentModeDto,
  AgentReasoningEffortDto,
  RendererOpaqueContributionDto,
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto
} from './contributions';
export type {
  SourceControlAddedEvent,
  SourceControlActionDto,
  SourceControlActionIconDto,
  SourceControlActionKindDto,
  SourceControlActionPlacementDto,
  SourceControlActionRegistrationDto,
  SourceControlButtonActionDto,
  SourceControlButtonActionRegistrationDto,
  SourceControlCheckboxFormFieldDto,
  SourceControlCheckboxFormFieldRegistrationDto,
  SourceControlChangeEvent,
  SourceControlChangeListener,
  SourceControlChangeType,
  SourceControlClearedEvent,
  SourceControlCommandDetailsDto,
  SourceControlCommandPayloadDto,
  SourceControlFormDto,
  SourceControlFormFieldDto,
  SourceControlFormFieldRegistrationDto,
  SourceControlFormFieldTypeDto,
  SourceControlFormRegistrationDto,
  SourceControlFormValues,
  SourceControlIconDto,
  SourceControlLoadMoreDto,
  SourceControlLoadMoreRegistrationDto,
  SourceControlMenuActionDto,
  SourceControlMenuActionRegistrationDto,
  SourceControlPhaseDto,
  SourceControlRawFormValues,
  SourceControlRegistrationOptions,
  SourceControlRemovedEvent,
  SourceControlSectionDto,
  SourceControlSectionItemDto,
  SourceControlSectionItemRegistrationDto,
  SourceControlSectionRegistrationDto,
  SourceControlSelectOptionDto,
  SourceControlSelectOptionRegistrationDto,
  SourceControlSelectFormFieldDto,
  SourceControlSelectFormFieldRegistrationDto,
  SourceControlSnapshot,
  SourceControlStateDto,
  SourceControlStateChangedEvent,
  SourceControlStateHandle,
  SourceControlStateRegistrationDto,
  SourceControlStateStoreContract,
  SourceControlStateStoreErrorEvent,
  SourceControlStateStoreOptions,
  SourceControlSummaryDto,
  SourceControlSummaryItemDto,
  SourceControlSummaryItemRegistrationDto,
  SourceControlSummaryRegistrationDto,
  SourceControlTextFormFieldDto,
  SourceControlTextFormFieldRegistrationDto,
  SourceControlTextareaFormFieldDto,
  SourceControlTextareaFormFieldRegistrationDto,
  SourceControlToolbarActionDto,
  SourceControlToolbarActionRegistrationDto,
  SourceControlVersionDto
} from './source-control';
export type {
  SourceControlViewCommandPort,
  SourceControlViewCommandResult,
  SourceControlViewDependencies,
  SourceControlViewI18n,
  SourceControlViewService,
  SourceControlViewWorkbench
} from './source-control-view';
export type {
  ScmDecorationClearResultDto,
  ScmDecorationEntryDto,
  ScmDecorationEntryRegistrationDto,
  ScmDecorationSetResultDto,
  ScmFileDecorationProvider,
  ScmFileDecorationProviderOptions,
  ScmFileStatusDto,
  ScmGitArgumentsMap,
  ScmGitArgumentsRegistrationMap,
  ScmGitOperationDto,
  ScmGitPermissionDto,
  ScmGitPermissionFor,
  ScmGitReadOperationDto,
  ScmGitRequestDto,
  ScmGitRequestRegistrationDto,
  ScmGitWriteOperationDto
} from './scm';

export interface RendererPlatform {
  readonly apiVersion: string;
  readonly lifecycle: DisposableStore;
  readonly services: ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>;
  readonly commands: CommandRegistry<RendererCommandMap>;
  readonly contributions: ContributionRegistry<RendererContributionMap>;
  readonly sourceControls: SourceControlStateStoreContract;
  readonly agents: AgentStateStore;
  readonly plugins: PluginRuntime;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

export interface RendererPlatformErrorEvent {
  readonly source: string;
  readonly id?: string;
  readonly owner?: string;
  readonly error: unknown;
}

export interface RendererPlatformLogger {
  error(message?: unknown, ...values: unknown[]): void;
}

export interface RendererPlatformOptions {
  readonly logger?: RendererPlatformLogger;
  readonly onError?: (event: RendererPlatformErrorEvent) => void;
}
