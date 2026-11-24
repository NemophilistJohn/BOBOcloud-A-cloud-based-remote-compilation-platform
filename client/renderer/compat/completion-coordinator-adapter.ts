import { createCompletionCoordinator } from '../../src/completion-coordinator';
import { rendererPlatform } from '../core/bootstrap';

// The compatibility learner batches writes; flush its last stable observations
// while the workbench still owns the renderer, then release pending timers.
const history = (window as unknown as {
  completionHistory?: { dispose(): void }
}).completionHistory;
if (history) rendererPlatform.lifecycle.add({ dispose: () => history.dispose() });

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  'workbench.completion',
  createCompletionCoordinator({
    now: () => Date.now(),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: timer => window.clearTimeout(timer)
  }),
  { owner: 'core.completion', exposeToPlugins: false }
));
