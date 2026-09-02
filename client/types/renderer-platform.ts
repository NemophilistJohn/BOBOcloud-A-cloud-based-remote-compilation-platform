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
import type { CommandRegistry } from '../renderer/core/command-registry';
import type {
  ContributionRegistrationMapFor,
  ContributionRegistry
} from '../renderer/core/contribution-registry';
import type { ServiceRegistry } from '../renderer/core/service-registry';
import type { AgentStateStore } from '../renderer/core/agent.js';
import type { PluginRuntime } from '../renderer/core/plugin-runtime.js';
import type { SourceControlStateStore } from '../renderer/core/source-control.js';
import type {
  AgentDescriptorDto,
  DocumentViewDescriptorDto,
  FileDecorationProviderDto,
  RendererOpaqueContributionDto,
  SourceControlDescriptorDto
} from './contributions';

export interface RendererCommandMap {
  readonly 'bobocloud.tasks.runSelected': ProjectTasksService['runSelected'];
  readonly 'bobocloud.tasks.refresh': ProjectTasksService['refresh'];
}

export interface RendererServiceMap {
  readonly 'host.diagnostics': Readonly<DiagnosticsHost>;
  readonly 'host.projectTasks': Readonly<ProjectTasksHost>;
  readonly 'host.rclone': Readonly<RcloneNativeHost>;
  readonly 'workbench.diagnosticsSettings': DiagnosticsSettingsService;
  readonly 'workbench.projectTasks': ProjectTasksService;
  readonly 'workbench.rclone': RcloneClient;
  readonly 'workbench.serverTransport': Readonly<ServerTransportService>;
  readonly 'workbench.serverCapabilities': ServerCapabilityService;
  readonly 'workbench.cloudFeaturePolicy': Readonly<CloudFeaturePolicyService>;
}

export interface RendererPluginServiceMap {
  readonly 'workbench.projectTasks': ProjectTasksPluginView;
}

export interface RendererContributionMap {
  readonly menus: RendererOpaqueContributionDto;
  readonly 'fileDecorations.sync': FileDecorationProviderDto<'sync'>;
  readonly 'fileDecorations.scm': FileDecorationProviderDto<'scm'>;
  readonly 'fileDecorations.diagnostic': FileDecorationProviderDto<'diagnostic'>;
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
  AgentAccessModeDto,
  AgentCapabilitiesDto,
  AgentCommandMapDto,
  AgentDescriptorDto,
  AgentModeDto,
  AgentReasoningEffortDto,
  DocumentViewDescriptorDto,
  DocumentViewDescriptorRegistrationDto,
  FileDecorationColorDto,
  FileDecorationDto,
  FileDecorationLaneDto,
  FileDecorationProviderDto,
  RendererOpaqueContributionDto,
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto
} from './contributions';

export interface RendererPlatform {
  readonly apiVersion: string;
  readonly lifecycle: DisposableStore;
  readonly services: ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>;
  readonly commands: CommandRegistry<RendererCommandMap>;
  readonly contributions: ContributionRegistry<RendererContributionMap>;
  readonly sourceControls: SourceControlStateStore;
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
