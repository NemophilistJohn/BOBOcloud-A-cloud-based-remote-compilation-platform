import { rendererPlatform } from '../core/bootstrap.js';

const BOBO = window.BOBO = window.BOBO || {};
const projectTasks = BOBO.projectTasks;

if (!projectTasks) {
  throw new Error('BOBO.projectTasks must load before the project tasks platform adapter.');
}

const pluginView = Object.freeze({
  list() {
    const configuration = projectTasks.getConfiguration();
    return Object.freeze((configuration.tasks || []).map((task) => Object.freeze({
      label: task.label,
      kind: task.kind,
      type: task.type,
      source: task.source,
      executable: task.executable === true,
      warnings: Object.freeze((task.warnings || []).map((warning) => warning.code))
    })));
  },
  getSelected() {
    return Object.freeze({ ...projectTasks.getSelected() });
  }
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  'workbench.projectTasks',
  projectTasks,
  { owner: 'core.tasks', exposeToPlugins: true, pluginView }
));

rendererPlatform.lifecycle.add(rendererPlatform.commands.register(
  'bobocloud.tasks.runSelected',
  () => projectTasks.runSelected(),
  { owner: 'core.tasks', title: 'Run Selected Task', category: 'Tasks' }
));

rendererPlatform.lifecycle.add(rendererPlatform.commands.register(
  'bobocloud.tasks.refresh',
  () => projectTasks.refresh(),
  { owner: 'core.tasks', title: 'Refresh Project Tasks', category: 'Tasks' }
));
