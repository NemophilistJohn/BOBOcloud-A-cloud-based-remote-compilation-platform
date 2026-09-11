import {
  createTaskProblemMatcherService,
  TASK_PROBLEM_MATCHER_SERVICE_ID
} from '../../src/task-problem-matcher';
import type {
  TaskProblemMatcherEditorPort,
  TaskProblemMatcherEditorCorePort,
  TaskProblemMatcherFacade,
  TaskProblemMatcherI18nPort,
  TaskProblemMatcherMonacoPort,
  TaskProblemMatcherService,
  TaskProblemMatcherState,
  TaskProblemMatcherWorkspacePort
} from '../../types/task-problem-matcher';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyTaskProblemNamespace {
  state?: TaskProblemMatcherState;
  i18n?: TaskProblemMatcherI18nPort;
  workspace?: TaskProblemMatcherWorkspacePort;
  editorCore?: TaskProblemMatcherEditorCorePort;
  taskProblemMatcher?: TaskProblemMatcherFacade;
}

type RendererWindow = Window & {
  BOBO?: LegacyTaskProblemNamespace;
  monaco?: TaskProblemMatcherMonacoPort;
};

const legacyWindow = window as RendererWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const state = BOBO.state || {};
BOBO.state = state;

const matcher: TaskProblemMatcherService = createTaskProblemMatcherService({
  document,
  state,
  getMonaco: () => legacyWindow.monaco,
  getI18n: () => BOBO.i18n,
  getWorkspace: () => BOBO.workspace,
  getEditor: () => {
    const editor = state.editor;
    return editor && typeof editor === 'object' ? editor as TaskProblemMatcherEditorPort : null;
  },
  getEditorCore: () => BOBO.editorCore,
  reportError: (error) => console.error('task problem matcher:', error)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  TASK_PROBLEM_MATCHER_SERVICE_ID,
  matcher,
  { owner: 'core.task-problem-matcher', exposeToPlugins: false }
));

// Preserve the historical writable facade while keeping disposal registry-owned.
BOBO.taskProblemMatcher = {
  init: matcher.init,
  begin: matcher.begin,
  clear: matcher.clear,
  getProblems: matcher.getProblems,
  getAllProblems: matcher.getAllProblems,
  refreshMonacoProblems: matcher.refreshMonacoProblems,
  onDidChange: matcher.onDidChange,
  applyModel: matcher.applyModel,
  activeSession: matcher.activeSession,
  openProblem: matcher.openProblem
};

matcher.init();
