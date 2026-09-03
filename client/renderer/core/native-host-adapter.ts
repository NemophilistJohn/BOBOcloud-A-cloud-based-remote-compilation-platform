import type {
  DiagnosticsHost,
  DiagnosticsOpenListener,
  DiagnosticsSettingsWriteDto
} from '../../types/diagnostics';
import type {
  ProjectTaskResolveRequestDto,
  ProjectTasksFileEvent,
  ProjectTasksHost,
  ProjectTasksWorkspaceOpenedListener
} from '../../types/project-tasks';
import type { DocumentViewHost } from '../../types/document-view';
import type {
  LanguagePacksHost,
  LanguagePacksInvalidationHint,
  LanguagePacksInvalidationListener
} from '../../types/i18n';
import type { NativeHost, RcloneNativeHost, RcloneProgressListener } from '../../types/native-host';
import { toDisposable } from './disposable.js';
import { rendererPlatform } from './bootstrap';

export const DIAGNOSTICS_HOST_SERVICE_ID = 'host.diagnostics';
export const DOCUMENT_VIEWS_HOST_SERVICE_ID = 'host.documentViews';
export const LANGUAGE_PACKS_HOST_SERVICE_ID = 'host.languagePacks';
export const PROJECT_TASKS_HOST_SERVICE_ID = 'host.projectTasks';
export const RCLONE_HOST_SERVICE_ID = 'host.rclone';

function createDiagnosticsHost(host: NativeHost): Readonly<DiagnosticsHost> {
  return Object.freeze({
    readSettings: () => host.readDiagnosticsSettings(),
    writeSettings: (settings: DiagnosticsSettingsWriteDto) => host.writeDiagnosticsSettings(settings),
    onOpen: (listener: DiagnosticsOpenListener) => toDisposable(
      host.onOpenDiagnosticsSettings(() => listener())
    )
  });
}

function createDocumentViewsHost(host: NativeHost): Readonly<DocumentViewHost> {
  return Object.freeze({
    loadDocumentView: (pluginId: string, viewerId: string) => (
      host.plugins.loadDocumentView(pluginId, viewerId)
    ),
    loadLocalization: (pluginId: string, locale: string) => (
      host.plugins.loadLocalization(pluginId, locale)
    ),
    openDocument: (pluginId: string, viewerId: string, filePath: string) => (
      host.plugins.documents.open(pluginId, viewerId, filePath)
    ),
    readDocument: (documentId: string, offset: number, length: number) => (
      host.plugins.documents.read(documentId, offset, length)
    ),
    closeDocument: (documentId: string) => host.plugins.documents.close(documentId)
  });
}

function createLanguagePacksHost(host: NativeHost): Readonly<LanguagePacksHost> {
  const invalidationHint = (payload: unknown): LanguagePacksInvalidationHint => {
    if (!payload || typeof payload !== 'object') return Object.freeze({});
    try {
      const reason = Object.getOwnPropertyDescriptor(payload, 'reason');
      const value = reason && 'value' in reason ? reason.value : null;
      return typeof value === 'string' && value.length <= 32 && value === 'filesystem'
        ? Object.freeze({ reason: 'filesystem' as const })
        : Object.freeze({});
    } catch (_) {
      return Object.freeze({});
    }
  };
  return Object.freeze({
    startup: () => host.languagePacksStartup(),
    list: () => host.languagePacksList(),
    load: (id: string) => host.languagePackLoad(id),
    setActive: (id: string) => host.languagePackSetActive(id),
    install: () => host.languagePackInstall(),
    remove: (id: string) => host.languagePackRemove(id),
    openFolder: () => host.languagePacksOpenFolder(),
    refresh: () => host.languagePacksRefresh(),
    onDidChange: (listener: LanguagePacksInvalidationListener) => toDisposable(
      host.onLanguagePacksChanged((payload) => listener(invalidationHint(payload)))
    )
  });
}

function createRcloneNativeHost(host: NativeHost): Readonly<RcloneNativeHost> {
  return Object.freeze({
    rclonePrepareRemote: (payload: unknown) => host.rclonePrepareRemote(payload),
    rcloneSync: (payload: unknown) => host.rcloneSync(payload),
    rclonePull: (payload: unknown) => host.rclonePull(payload),
    rcloneCancel: (operationId: string) => host.rcloneCancel(operationId),
    rcloneCancelAll: (reason: unknown) => host.rcloneCancelAll(reason),
    rcloneListBinaries: () => host.rcloneListBinaries(),
    rcloneGetSelection: () => host.rcloneGetSelection(),
    rcloneSelectBinary: (payload: unknown) => host.rcloneSelectBinary(payload),
    rcloneCheckVersion: () => host.rcloneCheckVersion(),
    rcloneValidateConnection: () => host.rcloneValidateConnection(),
    onRcloneProgress: (operationId: string, listener: RcloneProgressListener) => (
      host.onRcloneProgress(operationId, listener)
    )
  });
}

function isProjectTasksConfigurationEvent(event: ProjectTasksFileEvent): boolean {
  const filePath = String(event?.path || '').replace(/\\/g, '/').toLowerCase();
  return filePath.endsWith('/.vscode/tasks.json') || filePath.endsWith('/.bobocloud/tasks.json');
}

function createProjectTasksHost(host: NativeHost): Readonly<ProjectTasksHost> {
  return Object.freeze({
    list: () => host.tasksList(),
    resolve: (request: ProjectTaskResolveRequestDto) => (
      host.tasksResolve(request.label, request.context, request.inputs)
    ),
    onWorkspaceOpened: (listener: ProjectTasksWorkspaceOpenedListener) => toDisposable(
      host.onWorkspaceOpened((event) => listener(event))
    ),
    onConfigurationChanged: (listener: () => void) => toDisposable(
      host.onFileEvent((event) => {
        if (isProjectTasksConfigurationEvent(event)) listener();
      })
    )
  });
}

// This is the only new renderer module allowed to read the preload global.
// Domain services below it expose narrower capabilities and remain host-only.
const nativeHost = window.api;
if (!nativeHost || typeof nativeHost !== 'object') {
  throw new Error('The BOBOCLOUD native host bridge is unavailable.');
}

const diagnosticsRegistration = rendererPlatform.services.register(
  DIAGNOSTICS_HOST_SERVICE_ID,
  createDiagnosticsHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(diagnosticsRegistration);

const documentViewsRegistration = rendererPlatform.services.register(
  DOCUMENT_VIEWS_HOST_SERVICE_ID,
  createDocumentViewsHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(documentViewsRegistration);

const languagePacksRegistration = rendererPlatform.services.register(
  LANGUAGE_PACKS_HOST_SERVICE_ID,
  createLanguagePacksHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(languagePacksRegistration);

const projectTasksRegistration = rendererPlatform.services.register(
  PROJECT_TASKS_HOST_SERVICE_ID,
  createProjectTasksHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(projectTasksRegistration);

const rcloneRegistration = rendererPlatform.services.register(
  RCLONE_HOST_SERVICE_ID,
  createRcloneNativeHost(nativeHost),
  { owner: 'core', exposeToPlugins: false }
);
rendererPlatform.lifecycle.add(rcloneRegistration);
