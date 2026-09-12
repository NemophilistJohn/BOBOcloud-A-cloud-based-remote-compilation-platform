import type { RcloneClient, RcloneSettingsService } from './rclone';
import type { CommandPaletteService } from './command-palette';
import type { ConfirmService } from './confirm-dialog';
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
import type { PluginApiVersionDto, PluginRuntimeContract } from './plugin-runtime';
import type { PluginExtensionNativeHost } from './plugin-extension-bootstrap';
import type { AgentDescriptorDto, AgentStateStoreContract } from './agent';
import type { SourceControlStateStoreContract } from './source-control';
import type { SourceControlViewService } from './source-control-view';
import type { FileSearchService } from './file-search';
import type {
  DocumentViewDescriptorDto,
  DocumentViewHost,
  DocumentViewService
} from './document-view';
import type { I18nService, LanguagePacksHost } from './i18n';
import type { LanguagePacksPanelService } from './language-packs-panel';
import type {
  PluginDetailsService,
  PluginManagementHost,
  PluginManagerUIService
} from './plugin-management';
import type {
  RendererOpaqueContributionDto,
  SourceControlDescriptorDto
} from './contributions';
import type { ThemeService } from './theme';
import type { EnvironmentActivityService } from './environment-activity';
import type { CacheStoreService } from './cache-store';
import type { CacheCenterService } from './cache-center';
import type {
  EnvironmentCenterNativeHostPort,
  EnvironmentCenterService
} from './environment-center';
import type { ViewsHost, ViewsService } from './views';
import type {
  ProjectsService,
  ProjectsHost
} from './projects';
import type { RuntimeService } from './runtime';
import type { RunConfigService } from './run-config';
import type { RunOutputService } from './run-output';
import type { TabOrderService } from './tab-order';
import type { ToastService } from './toast';
import type { OutputPanelService } from './output-panel';
import type { TaskProblemMatcherService } from './task-problem-matcher';
import type { WorkspaceSyncStatusService } from './workspace-sync-status';
import type { WorkspaceLaunchHost, WorkspaceLaunchService } from './workspace-launch';
import type { WorkspaceSettingsHost, WorkspaceSettingsService } from './workspace-settings';
import type { WorkbenchLayoutService } from './workbench-layout';
import type { SettingsService } from './settings';
import type { AccountProfileService } from './account-profile';
import type { EditorCoreService } from './editor-core';
import type { AiContextService } from './ai-context';
import type { AiService, AiServiceHostPort } from './ai-service';
import type { AiInlineService } from './ai-inline';
import type { AiAgentButtonService, AiAgentButtonHostPort } from './ai-agent-button';
import type { AiSettingsCenterService } from './ai-settings-center';
import type { ServerCommService } from './server-comm';

export interface RendererCommandMap {
  readonly 'bobocloud.tasks.runSelected': ProjectTasksService['runSelected'];
  readonly 'bobocloud.tasks.refresh': ProjectTasksService['refresh'];
}

export interface RendererServiceMap {
  readonly 'host.diagnostics': Readonly<DiagnosticsHost>;
  readonly 'host.documentViews': Readonly<DocumentViewHost>;
  readonly 'host.environmentCenter': Readonly<EnvironmentCenterNativeHostPort>;
  readonly 'host.languagePacks': Readonly<LanguagePacksHost>;
  readonly 'host.pluginManagement': Readonly<PluginManagementHost>;
  readonly 'host.pluginExtensions': Readonly<PluginExtensionNativeHost>;
  readonly 'host.projectTasks': Readonly<ProjectTasksHost>;
  readonly 'host.projects': Readonly<ProjectsHost>;
  readonly 'host.rclone': Readonly<RcloneNativeHost>;
  readonly 'host.views': Readonly<ViewsHost>;
  readonly 'host.workspaceLaunch': Readonly<WorkspaceLaunchHost>;
  readonly 'host.workspaceSettings': Readonly<WorkspaceSettingsHost>;
  readonly 'host.ai': Readonly<AiServiceHostPort>;
  readonly 'host.aiUi': Readonly<AiAgentButtonHostPort>;
  readonly 'workbench.confirm': ConfirmService;
  readonly 'workbench.diagnosticsSettings': DiagnosticsSettingsService;
  readonly 'workbench.documentViews': DocumentViewService;
  readonly 'workbench.environmentActivity': EnvironmentActivityService;
  readonly 'workbench.environmentCenter': EnvironmentCenterService;
  readonly 'workbench.cacheStore': CacheStoreService;
  readonly 'workbench.cacheCenter': CacheCenterService;
  readonly 'workbench.fileDecorations': FileDecorationService;
  readonly 'workbench.fileIcons': FileIconService;
  readonly 'workbench.i18n': I18nService;
  readonly 'workbench.languagePacksPanel': LanguagePacksPanelService;
  readonly 'workbench.pluginDetails': PluginDetailsService;
  readonly 'workbench.pluginManagerUI': PluginManagerUIService;
  readonly 'workbench.projectTasks': ProjectTasksService;
  readonly 'workbench.projects': ProjectsService;
  readonly 'workbench.runConfig': RunConfigService;
  readonly 'workbench.runtime': RuntimeService;
  readonly 'workbench.runOutput': RunOutputService;
  readonly 'workbench.tabOrder': TabOrderService;
  readonly 'workbench.toast': ToastService;
  readonly 'workbench.rclone': RcloneClient;
  readonly 'workbench.rcloneSettings': RcloneSettingsService;
  readonly 'workbench.serverTransport': Readonly<ServerTransportService>;
  readonly 'workbench.serverComm': ServerCommService;
  readonly 'workbench.serverCapabilities': ServerCapabilityService;
  readonly 'workbench.cloudFeaturePolicy': Readonly<CloudFeaturePolicyService>;
  readonly 'workbench.commandPalette': CommandPaletteService;
  readonly 'workbench.outputPanel': OutputPanelService;
  readonly 'workbench.taskProblemMatcher': TaskProblemMatcherService;
  readonly 'workbench.workspaceSyncStatus': WorkspaceSyncStatusService;
  readonly 'workbench.workspaceLaunch': WorkspaceLaunchService;
  readonly 'workbench.workspaceSettings': WorkspaceSettingsService;
  readonly 'workbench.layout': WorkbenchLayoutService;
  readonly 'workbench.fileSearch': FileSearchService;
  readonly 'workbench.settings': SettingsService;
  readonly 'workbench.accountProfile': AccountProfileService;
  readonly 'workbench.editorCore': EditorCoreService;
  readonly 'workbench.aiContext': AiContextService;
  readonly 'workbench.aiService': AiService;
  readonly 'workbench.aiInline': AiInlineService;
  readonly 'workbench.aiAgentButton': AiAgentButtonService;
  readonly 'workbench.aiSettingsCenter': AiSettingsCenterService;
  readonly 'workbench.sourceControlView': SourceControlViewService;
  readonly 'workbench.theme': ThemeService;
  readonly 'workbench.views': ViewsService;
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
  CommandPaletteCommandDto,
  CommandPaletteCommandHandler,
  CommandPaletteDependencies,
  CommandPaletteFacade,
  CommandPaletteI18n,
  CommandPaletteRegistrationPort,
  CommandPaletteService
} from './command-palette';
export type {
  ConfirmDependencies,
  ConfirmDetailsOptions,
  ConfirmDetailsResultDto,
  ConfirmFacade,
  ConfirmOptions,
  ConfirmService
} from './confirm-dialog';
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
  I18nChangeEvent,
  I18nChangeListener,
  I18nInterpolationParams,
  I18nLocaleSelectionResult,
  I18nService,
  I18nServiceDependencies,
  I18nSnapshot,
  I18nTextBindingOptions,
  I18nTranslatedAttribute,
  LanguagePackDirectionDto,
  LanguagePackDto,
  LanguagePackErrorDto,
  LanguagePackInstallCanceledDto,
  LanguagePackInstallResultDto,
  LanguagePackManifestDto,
  LanguagePackMessagesDto,
  LanguagePackOpenFolderResultDto,
  LanguagePacksChangedDto,
  LanguagePacksChangedListener,
  LanguagePacksHost,
  LanguagePacksInvalidationHint,
  LanguagePacksInvalidationListener,
  LanguagePacksListDto,
  LanguagePacksStartupDto,
  LanguagePackSourceDto,
  LanguagePackSummaryDto
} from './i18n';
export type {
  LanguagePackPanelViewDto,
  LanguagePacksPanelDependencies,
  LanguagePacksPanelFacade,
  LanguagePacksPanelI18n,
  LanguagePacksPanelRenderOptions,
  LanguagePacksPanelService
} from './language-packs-panel';
export type {
  PluginConfirm,
  PluginConfirmOptions,
  PluginDetailsDependencies,
  PluginDetailsDocumentViews,
  PluginDetailsDto,
  PluginDetailsFacade,
  PluginDetailsOpenPort,
  PluginDetailsService,
  PluginDetailsState,
  PluginDetailsStateFileTab,
  PluginDetailsTab,
  PluginDetailsTabProvider,
  PluginDetailsViews,
  PluginDetailsViewSnapshot,
  PluginDetailsWorkbenchTabDto,
  PluginDetailsWorkspace,
  PluginInstalledStatusDto,
  PluginIntegrityDto,
  PluginLocalizedTextDto,
  PluginManagementChangedDto,
  PluginManagementEnginesDto,
  PluginManagementHost,
  PluginManagementManifestDto,
  PluginManagerDependencies,
  PluginManagerI18n,
  PluginManagerPluginViewDto,
  PluginManagerRefreshOptions,
  PluginManagerUIFacade,
  PluginManagerUIService,
  PluginManagerViewDto,
  PluginManagerWorkbench,
  PluginMarketplaceEntryViewDto,
  PluginMarketplaceHost,
  PluginMarketplaceInstallRequestDto,
  PluginMarketplaceInstalledStatusDto,
  PluginMarketplacePackageDto,
  PluginMarketplaceProvenanceDto,
  PluginMarketplaceRefreshOptions,
  PluginMarketplaceSnapshotDto,
  PluginMarketplaceSourceDto,
  PluginMarketplaceVersionDto,
  PluginMarketplaceVersionViewDto,
  PluginOpenFolderResultDto,
  PluginPermissionRequestDto,
  PluginStatusDto,
  PluginUninstallResultDto
} from './plugin-management';
export type {
  PluginApiVersionDto,
  PluginManifestDto,
  PluginManifestEnginesDto,
  PluginManifestEnginesRegistrationDto,
  PluginManifestRegistrationDto,
  PluginPermissionDto,
  PluginRuntimeActivationValue,
  PluginRuntimeAgentProvider,
  PluginRuntimeAgents,
  PluginRuntimeCommandHandler,
  PluginRuntimeCommandMetadataDto,
  PluginRuntimeCommandRegistryPort,
  PluginRuntimeCommands,
  PluginRuntimeContext,
  PluginRuntimeContract,
  PluginRuntimeContributionOptionsDto,
  PluginRuntimeContributionPointDto,
  PluginRuntimeContributionRegistrationDto,
  PluginRuntimeContributionRegistryPort,
  PluginRuntimeContributions,
  PluginRuntimeDocumentViews,
  PluginRuntimeErrorEvent,
  PluginRuntimeErrorSourceDto,
  PluginRuntimeI18n,
  PluginRuntimeI18nChangeListener,
  PluginRuntimeI18nValuesDto,
  PluginRuntimeIdentityDto,
  PluginRuntimeLocalizationRegistrationDto,
  PluginRuntimeModule,
  PluginRuntimeObservedErrorEvent,
  PluginRuntimeOperationFailureDto,
  PluginRuntimeOperationResultDto,
  PluginRuntimeOperationSuccessDto,
  PluginRuntimeOptions,
  PluginRuntimeServices,
  PluginRuntimeServiceRegistryPort,
  PluginRuntimeSnapshotDto,
  PluginRuntimeSourceControl,
  PluginRuntimeSourceControlProvider,
  PluginRuntimeStatusDto,
  PluginRuntimeSubscriptions
} from './plugin-runtime';
export type {
  PluginExtensionSandbox,
  PluginExtensionSandboxDocument,
  PluginExtensionSandboxFactory,
  PluginExtensionSandboxMountTarget,
  PluginExtensionSandboxOptions
} from './plugin-extension-sandbox';
export type {
  PluginExtensionBootstrapErrorEvent,
  PluginExtensionBootstrapErrorSource,
  PluginExtensionBootstrapObservedErrorEvent,
  PluginExtensionNativeHost,
  PluginExtensionNativeHostAsyncValue,
  PluginExtensionNativeHostSubscription
} from './plugin-extension-bootstrap';
export type {
  PluginExtensionChangeEventDto,
  PluginExtensionCommandExecutionResultDto,
  PluginExtensionCommandPalettePort,
  PluginExtensionDescriptorDto,
  PluginExtensionDescriptorRegistrationDto,
  PluginExtensionErrorEvent,
  PluginExtensionErrorSource,
  PluginExtensionHostAsyncValue,
  PluginExtensionHostBroker,
  PluginExtensionHostCommandRegistryPort,
  PluginExtensionHostConstructor,
  PluginExtensionHostContract,
  PluginExtensionHostContributionRegistryPort,
  PluginExtensionHostOptions,
  PluginExtensionHostServiceRegistryPort,
  PluginExtensionLifecycleStatusDto,
  PluginExtensionLocaleDto,
  PluginExtensionLocaleSubscription,
  PluginExtensionLocalizationDto,
  PluginExtensionObservedErrorEvent,
  PluginExtensionOperationResultDto,
  PluginExtensionRefreshCompletedDto,
  PluginExtensionRefreshFailureDto,
  PluginExtensionRefreshRejectedDto,
  PluginExtensionRefreshResultDto,
  PluginExtensionServiceSnapshotFactory,
  PluginExtensionSnapshotDto,
  PluginExtensionStatusDto
} from './plugin-extension-host';
export type {
  AgentAccessModeDto,
  AgentActiveSessionDto,
  AgentActiveSessionRegistrationDto,
  AgentApprovalDto,
  AgentApprovalOutcomeDto,
  AgentApprovalRegistrationDto,
  AgentApprovalResultDto,
  AgentApprovalResultRegistrationDto,
  AgentApprovalToolDto,
  AgentCapabilitiesDto,
  AgentCapabilitiesRegistrationDto,
  AgentCommandMapRegistrationDto,
  AgentCommandMapDto,
  AgentCommandPayloadDto,
  AgentCommandValuesRegistrationDto,
  AgentCompactionDto,
  AgentCompactionRegistrationDto,
  AgentDescriptorDto,
  AgentDescriptorRegistrationDto,
  AgentEffectiveReasoningEffortDto,
  AgentGoalDto,
  AgentGoalRegistrationDto,
  AgentGoalStepDto,
  AgentGoalStepRegistrationDto,
  AgentGoalStepStatusDto,
  AgentMessageDto,
  AgentMessageRegistrationDto,
  AgentMessageRoleDto,
  AgentModeDto,
  AgentModelCapabilitiesDto,
  AgentModelCapabilitiesRegistrationDto,
  AgentModelCapabilitySourceDto,
  AgentModelChoiceDto,
  AgentModelChoiceRegistrationDto,
  AgentModelPurposeDto,
  AgentObservedStatePatchDto,
  AgentObservedStatePatchOperationDto,
  AgentPhaseDto,
  AgentReasoningEffortDto,
  AgentSessionStatusDto,
  AgentSessionSummaryDto,
  AgentSessionSummaryRegistrationDto,
  AgentSkillChoiceDto,
  AgentSkillChoiceRegistrationDto,
  AgentStateAddedEvent,
  AgentStateChangeEvent,
  AgentStateChangeListener,
  AgentStateChangeType,
  AgentStateChangedEvent,
  AgentStateClearedEvent,
  AgentStateDto,
  AgentStateHandle,
  AgentStatePatchedEvent,
  AgentStatePatchAppliedDto,
  AgentStatePatchDto,
  AgentStatePatchOperationDto,
  AgentStatePatchRejectedDto,
  AgentStateRegistrationDto,
  AgentStateRegistrationOptions,
  AgentStateRemovedEvent,
  AgentStateSetEvent,
  AgentStateSnapshot,
  AgentStateStoreContract,
  AgentStateStoreErrorEvent,
  AgentStateStoreOptions,
  AgentStateUpdateResultDto,
  AgentTimelineItemDto,
  AgentTimelineItemRegistrationDto,
  AgentTimelineKindDto,
  AgentTimelineStatusDto,
  AgentVersionDto
} from './agent';
export type {
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
export type {
  RcloneAvailableVersionDto,
  RcloneBinaryCandidateDto,
  RcloneBinaryScanDto,
  RcloneBinarySourceDto,
  RcloneBundledCandidateDto,
  RcloneBundledSelectionDto,
  RcloneClient,
  RcloneConnectionErrorDto,
  RcloneConnectionFailureDto,
  RcloneConnectionResultDto,
  RcloneConnectionSuccessDto,
  RcloneOperationOptions,
  RcloneRendererState,
  RcloneSelectionDto,
  RcloneSelectBinaryCancelledDto,
  RcloneSelectBinaryRequestDto,
  RcloneSelectBinaryResultDto,
  RcloneSelectBinarySuccessDto,
  RcloneSettingsClientPort,
  RcloneSettingsDependencies,
  RcloneSettingsFacade,
  RcloneSettingsI18n,
  RcloneSettingsService,
  RcloneSettingsWindow,
  RcloneSystemCandidateDto,
  RcloneSystemSelectionDto,
  RcloneUnavailableVersionDto,
  RcloneVersionResultDto
} from './rclone';
export type {
  BuiltinThemeId,
  ThemeChangeListener,
  ThemeDependencies,
  ThemeDescriptorDto,
  ThemeManagerFacade,
  ThemeMonaco,
  ThemeMonacoDataDto,
  ThemeMonacoEditorPort,
  ThemeMonacoTokenRuleDto,
  ThemeService
} from './theme';
export type {
  EnvironmentActivityActionDto,
  EnvironmentActivityDependencies,
  EnvironmentActivityEditor,
  EnvironmentActivityEditorModel,
  EnvironmentActivityEventDetailDto,
  EnvironmentActivityEventDto,
  EnvironmentActivityEventKindDto,
  EnvironmentActivityFacade,
  EnvironmentActivityListener,
  EnvironmentActivityOperations,
  EnvironmentActivityOutcomeDto,
  EnvironmentActivityPersonalWorkspaceDto,
  EnvironmentActivityRecordDetailDto,
  EnvironmentActivityRecordDto,
  EnvironmentActivityRendererState,
  EnvironmentActivityScopeDto,
  EnvironmentActivityScopeKeyDto,
  EnvironmentActivityScopeOverridesDto,
  EnvironmentActivityService,
  EnvironmentActivityStorage,
  EnvironmentActivityTabDto,
  EnvironmentActivityTeamWorkspaceDto,
  EnvironmentActivityUserDto,
  EnvironmentActivityWorkspaceDto
} from './environment-activity';
export type {
  EnvironmentCenterActionDto,
  EnvironmentCenterActivityPort,
  EnvironmentCenterConfirmPort,
  EnvironmentCenterDependencies,
  EnvironmentCenterEditorModelPort,
  EnvironmentCenterEditorPort,
  EnvironmentCenterFacade,
  EnvironmentCenterI18nPort,
  EnvironmentCenterLocalizationPort,
  EnvironmentCenterLspPort,
  EnvironmentCenterLspStatusDto,
  EnvironmentCenterMarkerPort,
  EnvironmentCenterMergePorts,
  EnvironmentCenterNativeHostPort,
  EnvironmentCenterPackageCenterPort,
  EnvironmentCenterProblemDto,
  EnvironmentCenterProblemMatcherPort,
  EnvironmentCenterRefreshOptionsDto,
  EnvironmentCenterRendererState,
  EnvironmentCenterRuntimeDefinitionDto,
  EnvironmentCenterServerActionDto,
  EnvironmentCenterServerRequestMap,
  EnvironmentCenterServerResponseMap,
  EnvironmentCenterService,
  EnvironmentCenterTabDto,
  EnvironmentCenterToastPort,
  EnvironmentCenterWorkbenchPort,
  EnvironmentCenterWorkspacePort,
  EnvironmentHealthDto,
  EnvironmentIssueStatusDto,
  EnvironmentServerEnvelopeDto,
  EnvironmentTreeNodeDto,
  EnvironmentViewStateDto,
  ProjectEnvironmentActionDto,
  ProjectEnvironmentActionRequestDto,
  ProjectEnvironmentActionResultDto,
  ProjectEnvironmentActionsDto,
  ProjectEnvironmentActivityDto,
  ProjectEnvironmentCapabilityDto,
  ProjectEnvironmentCheckDto,
  ProjectEnvironmentConsistencyDto,
  ProjectEnvironmentDependencyCacheDto,
  ProjectEnvironmentIssueDto,
  ProjectEnvironmentLanguageDto,
  ProjectEnvironmentManifestDto,
  ProjectEnvironmentPackageDto,
  ProjectEnvironmentPackagesDto,
  ProjectEnvironmentRepairPlanDto,
  ProjectEnvironmentRepairStepDto,
  ProjectEnvironmentRequestContextDto,
  ProjectEnvironmentRuntimeDto,
  ProjectEnvironmentSnapshotDto,
  ProjectEnvironmentWireDto,
  ProjectEnvironmentWireManifestDto,
  ProjectEnvironmentWorkspaceDto
} from './environment-center';
export type {
  ViewsCodeEditorPort,
  ViewsCollaborationPort,
  ViewsDependencies,
  ViewsDiffEditorPort,
  ViewsDiffModelDto,
  ViewsDiffPathsDto,
  ViewsEditorCorePort,
  ViewsFacade,
  ViewsHost,
  ViewsMonacoEditorPort,
  ViewsMonacoPort,
  ViewsRendererState,
  ViewsService,
  ViewsSettingsPort,
  ViewsSplitEditorPort,
  ViewsTabDto,
  ViewsTextModelPort,
  ViewsThemePort,
  ViewsUriPort,
  ViewsWorkspaceSettingsPort,
  WorkbenchEditorViewModeDto
} from './views';
export type {
  ProjectsCacheCenterPort,
  ProjectsConfirmPort,
  ProjectsDependencies,
  ProjectsDeleteResponseDto,
  ProjectsDeleteResponseWireDto,
  ProjectsFacade,
  ProjectsHost,
  ProjectsI18nPort,
  ProjectsListResponseDto,
  ProjectsListResponseWireDto,
  ProjectsOpenOptionsDto,
  ProjectsProjectDto,
  ProjectsProjectNamesDto,
  ProjectsProjectWireDto,
  ProjectsRendererState,
  ProjectsSaveProjectNameRequestDto,
  ProjectsSendToServer,
  ProjectsServerActionDto,
  ProjectsServerRequestMap,
  ProjectsServerResponseMap,
  ProjectsService,
  ProjectsStorageInfoDto,
  ProjectsStorageInfoWireDto
} from './projects';
export type {
  RuntimeActionDto,
  RuntimeDefinitionDto,
  RuntimeDependencies,
  RuntimeEnvironmentActivityPort,
  RuntimeFacade,
  RuntimeHelpersFacade,
  RuntimeI18nPort,
  RuntimeListResponseWireDto,
  RuntimeLspPort,
  RuntimeRendererState,
  RuntimeRequestMap,
  RuntimeResponseMap,
  RuntimeRunConfigPort,
  RuntimeSelectionResultDto,
  RuntimeSendToServer,
  RuntimeService,
  RuntimeStoragePort,
  RuntimeTabDto,
  RuntimeToastPort
} from './runtime';
export type {
  RunConfigActionDto,
  RunConfigArgsDto,
  RunConfigDependencies,
  RunConfigFacade,
  RunConfigI18nPort,
  RunConfigRawDto,
  RunConfigRendererState,
  RunConfigRequestMap,
  RunConfigResponseMap,
  RunConfigSendToServer,
  RunConfigService,
  RunConfigStoragePort,
  RunConfigTabDto,
  RunConfigTargetDto,
  RunConfigTargetListResponseDto,
  RunConfigTargetMetaDto,
  RunConfigWindowPort
} from './run-config';
export type {
  RunOutputBeginOptionsDto,
  RunOutputDependencies,
  RunOutputDetailOptionsDto,
  RunOutputFacade,
  RunOutputFinishOptionsDto,
  RunOutputI18nPort,
  RunOutputKnownPhase,
  RunOutputOutputPort,
  RunOutputPhase,
  RunOutputService,
  RunOutputState,
  RunOutputStatusDto,
  RunOutputUpdateOptionsDto
} from './run-output';
export type {
  TabOrderFacade,
  TabOrderPosition,
  TabOrderService,
  TabOrderTab
} from './tab-order';
export type {
  IconName,
  RendererIconsFacade,
  RendererIconsSnapshot
} from './icons';
export type {
  ToastDependencies,
  ToastFacade,
  ToastIconPort,
  ToastKind,
  ToastService
} from './toast';
export type {
  OutputPanelDapPort,
  OutputPanelDependencies,
  OutputPanelFacade,
  OutputPanelProblemMatcherPort,
  OutputPanelRunOutputPort,
  OutputPanelService,
  OutputPanelState,
  OutputPanelTerminalPort,
  OutputPanelWorkbenchPort
} from './output-panel';
export type {
  TaskProblemDto,
  TaskProblemExecutionDto,
  TaskProblemMatcherDependencies,
  TaskProblemMatcherEditorCorePort,
  TaskProblemMatcherEditorPort,
  TaskProblemMatcherFacade,
  TaskProblemMatcherI18nPort,
  TaskProblemMatcherListener,
  TaskProblemMatcherMarkerDto,
  TaskProblemMatcherModelPort,
  TaskProblemMatcherMonacoEditorPort,
  TaskProblemMatcherMonacoPort,
  TaskProblemMatcherService,
  TaskProblemMatcherState,
  TaskProblemMatcherWorkspacePort,
  TaskProblemPatternDto,
  TaskProblemSession,
  TaskProblemSeverity
} from './task-problem-matcher';
export type {
  WorkspaceLaunchConsumer,
  WorkspaceLaunchDependencies,
  WorkspaceLaunchFacade,
  WorkspaceLaunchHost,
  WorkspaceLaunchI18nPort,
  WorkspaceLaunchOpenedListener,
  WorkspaceLaunchOpenedWorkspaceDto,
  WorkspaceLaunchService,
  WorkspaceLaunchStoragePort,
  WorkspaceLaunchTeamMappingDto,
  WorkspaceLaunchTreeNodeDto
} from './workspace-launch';
export type {
  WorkspaceSyncBeginOptionsDto,
  WorkspaceSyncChangeListener,
  WorkspaceSyncContextDto,
  WorkspaceSyncDecorationDto,
  WorkspaceSyncEntryOptionsDto,
  WorkspaceSyncEventPort,
  WorkspaceSyncEventKindDto,
  WorkspaceSyncFileEventDto,
  WorkspaceSyncFinishErrorDto,
  WorkspaceSyncFinishResultDto,
  WorkspaceSyncI18nPort,
  WorkspaceSyncPathDto,
  WorkspaceSyncProvider,
  WorkspaceSyncStateDto,
  WorkspaceSyncStatusDependencies,
  WorkspaceSyncStatusFacade,
  WorkspaceSyncStatusService,
  WorkspaceSyncTreeNodeDto,
  WorkspaceSyncWorkspacePort
} from './workspace-sync-status';
export type {
  WorkspaceEditorSettingsDto,
  WorkspaceSettingsAssociationDto,
  WorkspaceSettingsChangedListener,
  WorkspaceSettingsConfigKeyDto,
  WorkspaceSettingsConfigValueDto,
  WorkspaceSettingsDependencies,
  WorkspaceSettingsDetectLanguage,
  WorkspaceSettingsEditorCorePort,
  WorkspaceSettingsEditorModelChangeDto,
  WorkspaceSettingsEditorPort,
  WorkspaceSettingsEditorRawOptionsDto,
  WorkspaceSettingsEditorUpdateDto,
  WorkspaceSettingsEmptySnapshotDto,
  WorkspaceSettingsEnvironmentActivityPort,
  WorkspaceSettingsExcludeRuleDto,
  WorkspaceSettingsFacade,
  WorkspaceSettingsFileSearchPort,
  WorkspaceSettingsFilesDto,
  WorkspaceSettingsHost,
  WorkspaceSettingsLanguageIdDto,
  WorkspaceSettingsLoadedSnapshotDto,
  WorkspaceSettingsLspPort,
  WorkspaceSettingsModelOptionsDto,
  WorkspaceSettingsModelPort,
  WorkspaceSettingsModelUpdateDto,
  WorkspaceSettingsMonacoPort,
  WorkspaceSettingsRenderWhitespaceDto,
  WorkspaceSettingsRendererState,
  WorkspaceSettingsRequestDto,
  WorkspaceSettingsRuntimePort,
  WorkspaceSettingsService,
  WorkspaceSettingsSnapshotDto,
  WorkspaceSettingsSplitEditorPort,
  WorkspaceSettingsTabDto,
  WorkspaceSettingsTreeNodeDto,
  WorkspaceSettingsValuesDto,
  WorkspaceSettingsWarningDto,
  WorkspaceSettingsWordWrapDto,
  WorkspaceSettingsWorkspacePort
} from './workspace-settings';
export type {
  FileSearchDependencies,
  FileSearchEventTarget,
  FileSearchFacade,
  FileSearchFileDto,
  FileSearchFileIconsPort,
  FileSearchI18nPort,
  FileSearchIconsPort,
  FileSearchService,
  FileSearchStatePort,
  FileSearchStoragePort,
  FileSearchTabDto,
  FileSearchTreeNodeDto,
  FileSearchWorkbenchPort,
  FileSearchWorkspaceLaunchPort,
  FileSearchWorkspacePort,
  FileSearchWorkspaceSettingsPort
} from './file-search';
export type {
  WorkbenchAiAgentButtonPort,
  WorkbenchAiChatPanelPort,
  WorkbenchApplyOptionsDto,
  WorkbenchAuxiliaryOptionsDto,
  WorkbenchCollaborationCurrentDto,
  WorkbenchCollaborationPort,
  WorkbenchCommandsPort,
  WorkbenchDensityDto,
  WorkbenchFileSearchPort,
  WorkbenchLayoutDependencies,
  WorkbenchLayoutEditorPort,
  WorkbenchLayoutFacade,
  WorkbenchLayoutService,
  WorkbenchPersistentStateDto,
  WorkbenchLayoutSnapshotDto,
  WorkbenchLayoutStateDto,
  WorkbenchPanelPositionDto,
  WorkbenchProjectsPort,
  WorkbenchSettingsPort,
  WorkbenchStoragePort,
  WorkbenchSwitchPanelPort,
  WorkbenchTerminalPort,
  WorkbenchResizeKindDto
} from './workbench-layout';
export type {
  AccountProfileActivityDataWireDto,
  AccountProfileActivityDayWireDto,
  AccountProfileAuthPort,
  AccountProfileAuthState,
  AccountProfileCollaborationPort,
  AccountProfileConfirmPort,
  AccountProfileDependencies,
  AccountProfileFacade,
  AccountProfileI18nPort,
  AccountProfileImagePort,
  AccountProfileRendererState,
  AccountProfileSendToServer,
  AccountProfileServerActionDto,
  AccountProfileServerRequestMap,
  AccountProfileServerResponseMap,
  AccountProfileService,
  AccountProfileTabDto,
  AccountProfileToastPort,
  AccountProfileUserDto
} from './account-profile';
export type {
  EditorCoreAiInlinePort,
  EditorCoreCommandsPort,
  EditorCoreCursorPositionEvent,
  EditorCoreDapPort,
  EditorCoreDependencies,
  EditorCoreDiagnosticsSettingsDto,
  EditorCoreDiagnosticsSettingsPort,
  EditorCoreDiagnosticsStateDto,
  EditorCoreEditorPort,
  EditorCoreFacade,
  EditorCoreGlobalEventPort,
  EditorCoreI18nPort,
  EditorCoreKeyCodeDto,
  EditorCoreKeyModDto,
  EditorCoreMarkerDto,
  EditorCoreMarkerSeverityDto,
  EditorCoreModelChangeEvent,
  EditorCoreModelOptionsDto,
  EditorCoreModelPort,
  EditorCoreMonacoEditorPort,
  EditorCoreMonacoPort,
  EditorCoreProjectTasksPort,
  EditorCoreRendererState,
  EditorCoreRuleRegistryPort,
  EditorCoreRunnerPort,
  EditorCoreService,
  EditorCoreSettingsPort,
  EditorCoreTabDto,
  EditorCoreTaskProblemMatcherPort,
  EditorCoreThemePort,
  EditorCoreUriPort,
  EditorCoreWorkspacePort,
  EditorCoreWorkspaceSettingsPort
} from './editor-core';
export type {
  ServerCommAbortController,
  ServerCommAbortSignal,
  ServerCommActionDto,
  ServerCommAuthPort,
  ServerCommAuthStatePort,
  ServerCommDependencies,
  ServerCommFacade,
  ServerCommFetch,
  ServerCommFetchInit,
  ServerCommFetchResponse,
  ServerCommI18nPort,
  ServerCommOutputKind,
  ServerCommOutputUpdateOptionsDto,
  ServerCommRendererState,
  ServerCommRequestOptionsDto,
  ServerCommResponseEnvelopeDto,
  ServerCommResponseHeaders,
  ServerCommRunOutputPort,
  ServerCommServerSettingsDto,
  ServerCommService,
  ServerCommTimer,
  ServerCommWorkspacePort
} from './server-comm';
export type {
  AiContextActiveTabDto,
  AiContextAiStateDto,
  AiContextCurrentFileDto,
  AiContextDependencies,
  AiContextEditorPort,
  AiContextFacade,
  AiContextFullContextDto,
  AiContextInlineContextDto,
  AiContextModelPort,
  AiContextPolicyDto,
  AiContextPositionDto,
  AiContextPromptsPort,
  AiContextReferencedFileDto,
  AiContextRendererState,
  AiContextSelectionDto,
  AiContextSelectionPort,
  AiContextService,
  AiContextSplitEditorPort,
  AiContextTabDto
} from './ai-context';
export type {
  AiActiveConnectionsResultDto,
  AiApplySettingsOptions,
  AiAuthType,
  AiCapabilitiesDto,
  AiChatContextPolicyDto,
  AiChatMessageDto,
  AiChatPayloadDto,
  AiChatSettingsDto,
  AiConnectionDto,
  AiHealthDto,
  AiHealthState,
  AiInlineCompletionResultDto,
  AiInlineContextDto,
  AiInlineContextPolicyDto,
  AiInlineRequestDto,
  AiInlineSettingsDto,
  AiLegacyModelDto,
  AiMode,
  AiOperationResultDto,
  AiOperationSuccessDto,
  AiParametersDto,
  AiProfileDto,
  AiProtocol,
  AiPurpose,
  AiResultErrorDto,
  AiService,
  AiServiceDependencies,
  AiServiceFacade,
  AiServiceHostPort,
  AiServiceMutableState,
  AiServiceRendererState,
  AiSettingsDto,
  AiSettingsSchemaPort,
  AiStatusDto,
  AiStreamChunkDto,
  AiStreamChunkListener,
  AiStreamEndDto,
  AiStreamEndListener,
  AiStreamErrorDto,
  AiStreamErrorListener,
  AiTransportResponseDto
} from './ai-service';
export type {
  AiInlineAiContextPort,
  AiInlineAiServicePort,
  AiInlineCancellationTokenPort,
  AiInlineCompletionItemDto,
  AiInlineCompletionListDto,
  AiInlineDependencies,
  AiInlineFacade,
  AiInlineEditorPort,
  AiInlineLanguagesPort,
  AiInlineLogger,
  AiInlineModelPort,
  AiInlineMonacoEditorPort,
  AiInlineMonacoPort,
  AiInlineProvider,
  AiInlinePositionDto,
  AiInlineRangeDto,
  AiInlineRendererState,
  AiInlineService,
  AiInlineSplitEditorPort,
  AiInlineStatePort,
  AiInlineTriggerContextDto
} from './ai-inline';
export type {
  AiAgentButtonAiServicePort,
  AiAgentButtonAiState,
  AiAgentButtonChatPanelPort,
  AiAgentButtonDependencies,
  AiAgentButtonFacade,
  AiAgentButtonHostPort,
  AiAgentButtonI18nPort,
  AiAgentButtonInlinePort,
  AiAgentButtonInlineState,
  AiAgentButtonProfileDto,
  AiAgentButtonRendererState,
  AiAgentButtonService,
  AiAgentButtonSettingsCenterPort,
  AiAgentButtonToastPort,
  AiAgentButtonWorkbenchPort
} from './ai-agent-button';
export type {
  AiSettingsCenterAgentButtonPort,
  AiSettingsCenterAgentWorkbenchPort,
  AiSettingsCenterAiServicePort,
  AiSettingsCenterConfirmPort,
  AiSettingsCenterConnectionState,
  AiSettingsCenterDependencies,
  AiSettingsCenterDraft,
  AiSettingsCenterFacade,
  AiSettingsCenterI18nPort,
  AiSettingsCenterProfileShape,
  AiSettingsCenterRendererState,
  AiSettingsCenterSchemaPort,
  AiSettingsCenterService,
  AiSettingsProviderDefinitionDto
} from './ai-settings-center';
export type {
  SettingsAiFieldOptionDto,
  SettingsAiFieldOptions,
  SettingsAiFieldResult,
  SettingsAiInlineModeDto,
  SettingsAiModelDto,
  SettingsAiModelInputDto,
  SettingsAiModelUpdateDto,
  SettingsAiPurposeDto,
  SettingsAiResultDto,
  SettingsAiServicePort,
  SettingsAiSettingsCenterPort,
  SettingsAiStateDto,
  SettingsAiStatusDto,
  SettingsAiStatusStateDto,
  SettingsDependencies,
  SettingsDiagnosticsPort,
  SettingsDiagnosticsStateDto,
  SettingsFacade,
  SettingsI18nPort,
  SettingsLanguagePacksPort,
  SettingsLogger,
  SettingsLspPort,
  SettingsRendererState,
  SettingsRclonePort,
  SettingsServerSettingsDto,
  SettingsService,
  SettingsTabDto,
  SettingsThemeDescriptorDto,
  SettingsThemePort,
  SettingsToastPort,
  SettingsWindowPort
} from './settings';
export type {
  DetectedLanguageIdDto,
  LocalPathSeparatorDto,
  ProjectKeyDto,
  RendererUtilitiesFacade
} from './utils';
export type {
  StreamRenderScheduler,
  StreamRenderSchedulerFactory,
  StreamRenderSchedulerFacade,
  StreamRenderSchedulerOptions
} from './stream-render-scheduler';
export type {
  AiPromptBuildMetadataDto,
  AiPromptBuildOptionsDto,
  AiPromptBuildResultDto,
  AiPromptChatSettingsDto,
  AiPromptContextDto,
  AiPromptCurrentFileDto,
  AiPromptHistoryMessageDto,
  AiPromptInlineContextDto,
  AiPromptKeep,
  AiPromptMessageDto,
  AiPromptPolicyDto,
  AiPromptSelectionDto,
  AiPromptSettingsDto,
  AiPromptsFacade
} from './ai-prompts';
export type {
  AiMarkdownClipboardPort,
  AiMarkdownDependencies,
  AiMarkdownFacade,
  AiMarkdownI18nPort,
  AiMarkdownIconPort,
  AiMarkdownRenderOptions,
  AiMarkdownRenderer,
  AiMarkdownTemmlPort
} from './ai-markdown';
export type {
  RendererAiChatContextState,
  RendererAiChatState,
  RendererAiInlineContextState,
  RendererAiInlineState,
  RendererAiParametersState,
  RendererAiState,
  RendererAuthState,
  RendererCollaborationState,
  RendererDapState,
  RendererDiagnosticsState,
  RendererLspState,
  RendererRuntimeState,
  RendererState,
  RendererTabState
} from './state';
export type {
  CacheCapabilitiesDto,
  CacheCategoryDto,
  CacheCategoryGroupDto,
  CacheEntryDto,
  CacheEntryWireDto,
  CacheGroupInventoryOptionsDto,
  CacheHistoryStateDto,
  CacheHistoryStatesDto,
  CacheInventoryDto,
  CacheInventoryFilterScopeDto,
  CacheInventoryFiltersDto,
  CacheInventoryGroupsDto,
  CacheInventoryProtocolError,
  CacheInventoryTotalsDto,
  CacheInventoryWireDto,
  CacheModelFacade,
  CacheProjectGroupDto,
  CacheProjectNamesDto,
  CacheRawObjectDto,
  CacheStateDto,
  CacheWorkspaceContextDto
} from './cache-model';
export type {
  CacheStoreAbortController,
  CacheStoreActionDto,
  CacheStoreClearRequestDto,
  CacheStoreClearScopeDto,
  CacheStoreClearScopeRequestDto,
  CacheStoreDeleteRequestDto,
  CacheStoreDependencies,
  CacheStoreEntryRequestDto,
  CacheStoreFacade,
  CacheStoreFactoryFacade,
  CacheStoreIdentityUserDto,
  CacheStoreInvalidationDto,
  CacheStoreInventoryRequestDto,
  CacheStoreInventoryTransportOptions,
  CacheStoreListener,
  CacheStoreLoadOptionsDto,
  CacheStoreModel,
  CacheStoreMutationMapDto,
  CacheStoreMutationTransportOptions,
  CacheStoreOperations,
  CacheStoreRendererState,
  CacheStoreRequestMap,
  CacheStoreResponseEnvelopeDto,
  CacheStoreSendToServer,
  CacheStoreService,
  CacheStoreSnapshotDto,
  CacheStoreStatusDto,
  CacheStoreTransportOptions,
  CacheStoreTransportOptionsMap,
  CacheStoreEntryTransportOptions,
  LegacyCacheStoreFactoryOptions
} from './cache-store';
export type {
  CacheCenterConfirmPort,
  CacheCenterDependencies,
  CacheCenterFacade,
  CacheCenterFilterScopeDto,
  CacheCenterFiltersDto,
  CacheCenterI18nPort,
  CacheCenterIconPort,
  CacheCenterModel,
  CacheCenterPackageCenterPort,
  CacheCenterPackageOpenOptionsDto,
  CacheCenterProjectsPort,
  CacheCenterRendererState,
  CacheCenterService,
  CacheCenterStore,
  CacheCenterToastPort,
  CacheCenterWorkbenchPort
} from './cache-center';

export interface RendererPlatform {
  readonly apiVersion: PluginApiVersionDto;
  readonly lifecycle: DisposableStore;
  readonly services: ServiceRegistry<RendererServiceMap, RendererPluginServiceMap>;
  readonly commands: CommandRegistry<RendererCommandMap>;
  readonly contributions: ContributionRegistry<RendererContributionMap>;
  readonly sourceControls: SourceControlStateStoreContract;
  readonly agents: AgentStateStoreContract;
  readonly plugins: PluginRuntimeContract<RendererPluginServiceMap>;
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

export type {
  RendererPlatformAgentsFacade,
  RendererPlatformCommandsFacade,
  RendererPlatformCompatibilityFacade,
  RendererPlatformContributionsFacade,
  RendererPlatformFileDecorationsFacade,
  RendererPlatformPluginsFacade,
  RendererPlatformServicesFacade,
  RendererPlatformSourceControlFacade
} from './platform-adapter';
