import {
  createProjectTasks,
  type ProjectTasksCloudFeaturePolicy,
  type ProjectTasksI18n,
  type ProjectTasksRendererState
} from '../../src/project-tasks';
import type {
  ProjectTasksPluginView,
  ProjectTasksRunnerPort,
  ProjectTasksService
} from '../../types/project-tasks';
import { rendererPlatform as runtimeRendererPlatform } from '../core/bootstrap.js';
import { PROJECT_TASKS_HOST_SERVICE_ID } from '../core/native-host-adapter';
import { rendererPlatform } from '../core/typed-platform';

export const PROJECT_TASKS_SERVICE_ID = 'workbench.projectTasks';

interface LegacyBobo {
  state?: ProjectTasksRendererState;
  i18n?: ProjectTasksI18n;
  cloudFeaturePolicy?: ProjectTasksCloudFeaturePolicy;
  runner?: ProjectTasksRunnerPort;
  projectTasks?: ProjectTasksService;
  updateRunOutput?(message: string): void;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Project Tasks requires renderer state.');

const projectTasks = createProjectTasks({
  host: rendererPlatform.services.require(PROJECT_TASKS_HOST_SERVICE_ID),
  document,
  window: legacyWindow,
  storage: legacyWindow.localStorage,
  getState: () => BOBO.state as ProjectTasksRendererState,
  getI18n: () => BOBO.i18n,
  getCloudFeaturePolicy: () => BOBO.cloudFeaturePolicy,
  getRunner: () => BOBO.runner,
  updateRunOutput: (message) => BOBO.updateRunOutput?.(message)
});

const pluginView: ProjectTasksPluginView = Object.freeze({
  list() {
    const configuration = projectTasks.getConfiguration();
    return Object.freeze(configuration.tasks.map((task) => Object.freeze({
      label: task.label,
      kind: task.kind,
      type: task.type,
      source: task.source,
      executable: task.executable === true,
      warnings: Object.freeze(task.warnings.map((warning) => warning.code))
    })));
  },
  getSelected() {
    return Object.freeze({ ...projectTasks.getSelected() });
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  PROJECT_TASKS_SERVICE_ID,
  projectTasks,
  { owner: 'core.tasks', exposeToPlugins: true, pluginView }
));

rendererPlatform.lifecycle.add(runtimeRendererPlatform.commands.register(
  'bobocloud.tasks.runSelected',
  () => projectTasks.runSelected(),
  { owner: 'core.tasks', title: 'Run Selected Task', category: 'Tasks' }
));

rendererPlatform.lifecycle.add(runtimeRendererPlatform.commands.register(
  'bobocloud.tasks.refresh',
  () => projectTasks.refresh(),
  { owner: 'core.tasks', title: 'Refresh Project Tasks', category: 'Tasks' }
));

// Compatibility projection only: the registry owns and disposes this instance.
BOBO.projectTasks = projectTasks;
