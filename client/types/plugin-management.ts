import type { CommandPaletteRegistrationPort } from './command-palette';
import type { Disposable } from './lifecycle';
import type { PluginPermissionDto } from './plugin-runtime';

export type PluginInstalledStatusDto =
  | 'enabled'
  | 'disabled'
  | 'invalid'
  | 'incompatible';

export interface PluginManagementEnginesDto {
  readonly bobocloud: string;
  readonly pluginApi: string;
  readonly [engine: string]: unknown;
}

export interface PluginIntegrityDto {
  readonly valid: boolean;
  readonly reason: string;
}

export interface PluginManagementManifestDto {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly engines: PluginManagementEnginesDto;
  readonly main: string;
  readonly activationEvents: readonly string[];
  readonly permissions: readonly PluginPermissionDto[];
  readonly contributes: Readonly<Record<string, unknown>>;
  readonly localization: Readonly<Record<string, string>>;
}

export interface PluginStatusDto {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly status: PluginInstalledStatusDto;
  readonly requestedPermissions: readonly PluginPermissionDto[];
  readonly grantedPermissions: readonly PluginPermissionDto[];
  readonly manifest: PluginManagementManifestDto | null;
  readonly integrity: PluginIntegrityDto;
  readonly installedAt: string;
}

export interface PluginManagementChangedDto {
  readonly reason: string;
  readonly plugins: readonly PluginStatusDto[];
}

export interface PluginPermissionRequestDto {
  readonly id: string;
  readonly permission: PluginPermissionDto;
}

export interface PluginUninstallResultDto {
  readonly id: string;
  readonly removed: true;
}

export interface PluginOpenFolderResultDto {
  readonly success: true;
}

export type PluginLocalizedTextDto = Readonly<Record<string, string>>;

export interface PluginMarketplaceSourceDto {
  readonly repository: string;
  readonly ref: string;
}

export interface PluginMarketplaceVersionDto {
  readonly version: string;
  readonly publishedAt: string;
  readonly engines: PluginManagementEnginesDto;
  readonly permissions: readonly PluginPermissionDto[];
  readonly locales: readonly string[];
  readonly size: number;
  readonly source: PluginMarketplaceSourceDto;
  readonly compatible: boolean;
  readonly installed: boolean;
}

export type PluginMarketplaceInstalledStatusDto =
  | PluginInstalledStatusDto
  | 'not-installed';

export interface PluginMarketplacePackageDto {
  readonly id: string;
  readonly displayName: PluginLocalizedTextDto;
  readonly description: PluginLocalizedTextDto;
  readonly categories: readonly string[];
  readonly latest: string;
  readonly installedVersion: string;
  readonly installedStatus: PluginMarketplaceInstalledStatusDto;
  readonly updateAvailable: boolean;
  readonly versions: readonly PluginMarketplaceVersionDto[];
}

export type PluginMarketplaceProvenanceDto =
  | 'memory'
  | 'network'
  | 'verified-cache';

export interface PluginMarketplaceSnapshotDto {
  readonly registryId: string;
  readonly updatedAt: string;
  readonly fetchedAt: string;
  readonly revision: string;
  readonly provenance: PluginMarketplaceProvenanceDto;
  readonly stale: boolean;
  readonly packages: readonly PluginMarketplacePackageDto[];
}

export interface PluginMarketplaceInstallRequestDto {
  readonly id: string;
}

export interface PluginMarketplaceHost {
  list(): Promise<PluginMarketplaceSnapshotDto>;
  refresh(): Promise<PluginMarketplaceSnapshotDto>;
  install(id: string): Promise<PluginStatusDto>;
}

export interface PluginManagementHost {
  list(): Promise<readonly PluginStatusDto[]>;
  get(id: string): Promise<PluginStatusDto | null>;
  install(): Promise<PluginStatusDto | null>;
  enable(id: string): Promise<PluginStatusDto>;
  disable(id: string): Promise<PluginStatusDto>;
  uninstall(id: string): Promise<PluginUninstallResultDto>;
  grant(id: string, permission: PluginPermissionDto): Promise<PluginStatusDto>;
  revoke(id: string, permission: PluginPermissionDto): Promise<PluginStatusDto>;
  refresh(): Promise<readonly PluginStatusDto[]>;
  openFolder(): Promise<PluginOpenFolderResultDto>;
  readonly marketplace: Readonly<PluginMarketplaceHost> | null;
  onDidChange(listener: (change: PluginManagementChangedDto) => void): Disposable;
  onOpenManager(listener: () => void): Disposable;
}

export interface PluginManagerI18n {
  t(key: string, values?: Readonly<Record<string, string | number>>): string;
  getActive?(): string;
}

export interface PluginManagerWorkbench {
  setPrimaryView(view: string): void;
}

export interface PluginDetailsOpenPort {
  open(id: string): boolean | Promise<boolean>;
}

export interface PluginManagerDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly host: Readonly<PluginManagementHost> | null;
  readonly getI18n: () => PluginManagerI18n | null | undefined;
  readonly getWorkbench: () => PluginManagerWorkbench | null | undefined;
  readonly getCommands: () => CommandPaletteRegistrationPort | null | undefined;
  readonly getPluginDetails: () => PluginDetailsOpenPort | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface PluginManagerPluginViewDto {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly error: string;
  readonly builtIn: boolean;
  readonly removable: boolean;
  readonly state: string;
}

export interface PluginMarketplaceVersionViewDto {
  readonly version: string;
  readonly publishedAt: string;
  readonly engines: Readonly<Record<string, unknown>>;
  readonly permissions: readonly string[];
  readonly locales: readonly string[];
  readonly size: number | null;
  readonly installed: boolean;
  readonly installedVersion: string;
  readonly installedStatus: string;
  readonly compatible: boolean;
  readonly source: string;
  readonly index: number;
}

export interface PluginMarketplaceEntryViewDto {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly categories: readonly string[];
  readonly source: string;
  readonly versions: readonly PluginMarketplaceVersionViewDto[];
  readonly selected: PluginMarketplaceVersionViewDto | null;
  readonly latest: string;
  readonly installed: boolean;
  readonly installedVersion: string;
  readonly installedStatus: string;
  readonly updateAvailable: boolean;
}

export interface PluginManagerRefreshOptions {
  readonly quiet?: boolean;
  readonly preserveStatus?: boolean;
}

export interface PluginMarketplaceRefreshOptions extends PluginManagerRefreshOptions {
  readonly force?: boolean;
}

export type PluginManagerViewDto = 'marketplace' | 'installed';

export interface PluginManagerUIFacade {
  init(): Promise<unknown>;
  open(view?: PluginManagerViewDto): void;
  refresh(options?: PluginManagerRefreshOptions): Promise<readonly PluginManagerPluginViewDto[]>;
  refreshMarketplace(
    options?: PluginMarketplaceRefreshOptions
  ): Promise<readonly PluginMarketplaceEntryViewDto[]>;
  getPlugins(): readonly PluginManagerPluginViewDto[];
  getMarketplace(): readonly PluginMarketplaceEntryViewDto[];
}

export interface PluginManagerUIService extends PluginManagerUIFacade, Disposable {
  readonly disposed: boolean;
}

export interface PluginDetailsStateFileTab {
  readonly path: string;
  readonly model?: unknown;
  readonly [key: string]: unknown;
}

export interface PluginDetailsState {
  tabs: PluginDetailsStateFileTab[];
  pluginDetailTabs?: PluginDetailsTab[];
  activeTabPath: string | null;
  currentViewMode: string;
  diffOriginalPath?: string;
  diffModifiedPath?: string;
}

export interface PluginDetailsViewSnapshot {
  readonly filePath: string;
  readonly mode: string;
  readonly splitActive: boolean;
  readonly diffActive: boolean;
  readonly imageActive: boolean;
  readonly diffOriginalPath: string;
  readonly diffModifiedPath: string;
}

export interface PluginDetailsDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly requestedPermissions: readonly string[];
  readonly grantedPermissions: readonly string[];
  readonly activationEvents: readonly string[];
  readonly contributionPoints: readonly string[];
  readonly engines: PluginManagementEnginesDto;
  readonly integrity: PluginIntegrityDto;
  readonly installedAt: string;
}

export interface PluginDetailsTab {
  readonly id: string;
  readonly key: string;
  detail: PluginDetailsDto;
  previousFilePath: string;
  previousView?: PluginDetailsViewSnapshot;
  message: string;
  messageTone: string;
}

export interface PluginDetailsWorkbenchTabDto {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly category: string;
  readonly closeable: true;
  readonly draggable: false;
}

export interface PluginDetailsTabProvider {
  getTabs(): readonly PluginDetailsWorkbenchTabDto[];
  activate(key: string): unknown;
  close(key: string): boolean;
  deactivate(): void;
  afterFileActivation(tab: PluginDetailsStateFileTab): void;
}

export interface PluginDetailsWorkspace {
  registerWorkbenchTabProvider(id: string, provider: PluginDetailsTabProvider): Disposable;
  activateTab(path: string): void;
  updateTabbar(): void;
  updateTitlebar(): void;
  updateEmptyState(): void;
}

export interface PluginDetailsViews {
  openSplit(): void;
  openDiff(originalPath?: string, modifiedPath?: string): void;
}

export interface PluginDetailsDocumentViews {
  hideAll(options: { readonly restoreEditor: false }): void;
}

export interface PluginConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly danger: true;
}

export type PluginConfirm = (options: PluginConfirmOptions) => Promise<boolean>;

export interface PluginDetailsDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly host: Readonly<PluginManagementHost> | null;
  readonly state: PluginDetailsState;
  readonly getI18n: () => PluginManagerI18n | null | undefined;
  readonly getWorkspace: () => PluginDetailsWorkspace | null | undefined;
  readonly getViews: () => PluginDetailsViews | null | undefined;
  readonly getDocumentViews: () => PluginDetailsDocumentViews | null | undefined;
  readonly getConfirm: () => PluginConfirm | null | undefined;
  readonly nativeConfirm: (message: string) => boolean;
}

export interface PluginDetailsFacade extends PluginDetailsOpenPort {}

export interface PluginDetailsService extends PluginDetailsFacade, Disposable {
  readonly disposed: boolean;
  init(): void;
}
