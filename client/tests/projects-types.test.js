'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('projects contracts keep the host private and the historical facade exact', () => {
  const source = [
    "import { createProjectsService, PROJECTS_SERVICE_ID, resolveProjectDisplayName } from '../src/projects';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  ProjectsDependencies,',
    '  ProjectsFacade,',
    '  ProjectsHost,',
    '  ProjectsListResponseWireDto,',
    '  ProjectsProjectDto,',
    '  ProjectsProjectNamesDto,',
    '  ProjectsService,',
    '  ProjectsServerRequestMap,',
    '  ProjectsStorageInfoDto',
    "} from '../types/projects';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'init' | 'open' | 'openWithQuotaError' | 'close' | 'loadProjects' | 'switchTab';",
    'type FacadeIsExact = AssertTrue<Equal<keyof ProjectsFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof ProjectsService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<ProjectsService extends Disposable ? true : false>;',
    "type WorkbenchServiceIsExact = AssertTrue<Equal<RendererServiceMap['workbench.projects'], ProjectsService>>;",
    "type HostServiceIsExact = AssertTrue<Equal<RendererServiceMap['host.projects'], Readonly<ProjectsHost>>>;",
    "type WorkbenchPluginAbsent = AssertFalse<'workbench.projects' extends keyof RendererPluginServiceMap ? true : false>;",
    "type HostPluginAbsent = AssertFalse<'host.projects' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.projects' = PROJECTS_SERVICE_ID;",
    'declare const dependencies: ProjectsDependencies;',
    'declare const host: ProjectsHost;',
    'declare const service: ProjectsService;',
    'const created: ProjectsService = createProjectsService(dependencies);',
    'const disposable: Disposable = created;',
    'const names: ProjectsProjectNamesDto = { folder: "Project" };',
    'const project: ProjectsProjectDto = { key: "folder", name: "Project", sizeBytes: 10, files: 1, modTime: 0 };',
    'const response: ProjectsListResponseWireDto = { success: true, storageInfo: null };',
    'const storage: ProjectsStorageInfoDto = { totalUsedBytes: 1, quotaBytes: 2, persistBytes: 0, projectsTotalBytes: 1, projects: [project] };',
    'const listPayload: ProjectsServerRequestMap["listProjects"] = {};',
    'const displayName: string = resolveProjectDisplayName(project, names);',
    'service.init(); service.open(); service.openWithQuotaError("quota"); service.close(); service.loadProjects(); service.switchTab("cache"); service.dispose();',
    'host.readProjectNames(); host.saveProjectName("folder", "Project"); host.onOpenServerProjects(() => {});',
    '// @ts-expect-error Project service methods are a closed compatibility surface.',
    'service.switchTab(7);',
    '// @ts-expect-error Native project authority is private to the trusted workbench.',
    "(null as unknown as RendererPlatform).services.getForPlugin('host.projects');",
    '// @ts-expect-error Projects are not exposed to downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.projects');",
    'void serviceId; void disposable; void names; void response; void storage; void listPayload; void displayName;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__projects-types-contract.ts',
    source
  });
});
