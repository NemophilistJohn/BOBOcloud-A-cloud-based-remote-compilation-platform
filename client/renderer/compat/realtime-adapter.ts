import { createRealtimeService, type RealtimeDependencies } from '../../src/realtime';
import { rendererPlatform } from '../core/bootstrap';
import { I18N_SERVICE_ID } from './i18n-adapter';
import { TOAST_SERVICE_ID } from '../../src/toast';
import { CONFIRM_SERVICE_ID } from '../../src/confirm-dialog';
import type { RealtimeFacade } from '../../types/realtime';
import type { ViewsService } from '../../types/views';

interface Legacy {
  state: RealtimeDependencies['state'];
  workspace: RealtimeDependencies['workspace'];
  views?: ViewsService;
  realtime?: RealtimeFacade;
  runner?: { prepareWorkspaceLeave(): Promise<unknown> };
  runConfig?: { getArgs(language: string): Record<string, unknown> };
  detectLanguage(path: string): string;
  projectKey(path: string): string;
  sendToServer(action: string, payload: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }>;
  switchToPanel?(name: string): void;
  updateRunOutput?(message: string, options?: Record<string, unknown>): void;
  runOutput?: { begin(options: unknown): unknown; stdout(text: string, options?: unknown): void;
    stderr(text: string, options?: unknown): void; detail(text: string): void; handleStatus(message: unknown, session?: unknown): void; finish(options: unknown): void };
}
const bobo = (window as unknown as { BOBO: Legacy }).BOBO;
const toast = rendererPlatform.services.require(TOAST_SERVICE_ID);
let outputRun = '';
let outputSession: unknown;
const realtime = createRealtimeService({
  document, events: window, host: rendererPlatform.services.require('host.realtime'), state: bobo.state,
  t: (key, params) => rendererPlatform.services.require(I18N_SERVICE_ID).t(key, params),
  confirm: options => rendererPlatform.services.require(CONFIRM_SERVICE_ID).confirm(options),
  notify: (text, error) => error ? toast.error(text) : toast.success(text),
  async send(action, payload) {
    const result = await bobo.sendToServer(action, payload);
    if (!result?.success) throw new Error(result?.error || 'Collaboration request failed');
    return result.data;
  },
  workspace: bobo.workspace,
  refreshTree: () => rendererPlatform.services.require('host.collaboration').refreshWorkspace(),
  editors: () => bobo.views?.getVisibleEditors() as unknown as ReturnType<RealtimeDependencies['editors']> || [],
  runArgs: language => bobo.runConfig?.getArgs(language) || {},
  language: path => bobo.detectLanguage(path),
  projectKey: path => bobo.projectKey(path),
  output(message) {
    const run = String(message.runId || '');
    if (outputRun !== run) { outputRun = run; outputSession = bobo.runOutput?.begin({ target: rendererPlatform.services.require(I18N_SERVICE_ID).t('Shared run {id}', { id: run.slice(0, 8) }) }); }
    const line = String(message.line || message.message || '');
    if (message.type === 'stdout' || message.type === 'stderr') {
      const stream = String(message.type), fragment = message.fragment === true;
      bobo.updateRunOutput?.(fragment ? line : (stream === 'stderr' ? '[stderr] ' : '') + line,
        fragment ? { streamFragment: true, streamKey: stream + ':' + String(message.stage || ''), stage: message.stage,
          append: message.append, replace: message.replace, newline: message.newline, outputPrefix: stream === 'stderr' ? '[stderr] ' : '' } : undefined);
    }
    else if (message.type === 'result') bobo.runOutput?.finish({ ...message, sessionId: outputSession });
    else if (message.type === 'status') bobo.runOutput?.handleStatus(message, outputSession);
    else if (line) bobo.runOutput?.detail(line);
  },
  panel: () => bobo.switchToPanel?.('team'),
  prepareRunnerTransition: async () => bobo.runner?.prepareWorkspaceLeave(),
  syncPersonal: async () => {
    const result = await bobo.sendToServer('snapshotRealtimePersonal', { teamId: bobo.state.collaboration.current?.teamId,
      projectId: bobo.state.collaboration.current?.projectId, epoch: bobo.state.collaboration.current?.realtimeEpoch });
    if (!result.success) throw new Error(result.error || 'Personal snapshot failed');
    return true;
  }
});
bobo.realtime = realtime;
rendererPlatform.lifecycle.add({ dispose: realtime.dispose });
