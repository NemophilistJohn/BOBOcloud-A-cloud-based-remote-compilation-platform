// Structured presentation for cloud run lifecycle events.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  RunOutputBeginOptionsDto,
  RunOutputDependencies,
  RunOutputDetailOptionsDto,
  RunOutputFacade,
  RunOutputFinishOptionsDto,
  RunOutputPhase,
  RunOutputService,
  RunOutputState,
  RunOutputStatusDto
} from '../types/run-output';

export const RUN_OUTPUT_SERVICE_ID = 'workbench.runOutput' as const;

const MAX_DETAIL_BADGE = 300;
const PHASE_LABELS: Readonly<Record<string, string>> = {
  preparing: 'Preparing',
  syncing: 'Synchronizing workspace',
  runtime: 'Starting runtime',
  dependencies: 'Resolving dependencies',
  workspace: 'Preparing workspace',
  container: 'Starting container',
  compiling: 'Compiling',
  running: 'Running',
  artifacts: 'Collecting results',
  analysis: 'Updating analysis environment',
  completed: 'Run completed',
  failed: 'Run failed',
  stopped: 'Run stopped'
};

const CACHED_ELEMENT_KEYS = [
  'summary', 'title', 'phase', 'meta', 'toggle', 'count', 'log'
] as const;

type CachedElementKey = typeof CACHED_ELEMENT_KEYS[number];
type CachedElements = Record<CachedElementKey, HTMLElement | null>;

interface ActiveRun {
  readonly id: number;
  readonly target: string;
  readonly runtime: string;
  state: RunOutputState;
  phase: RunOutputPhase;
  reason: string;
  reasonSource: string;
  returnCode: number | null;
  readonly startedAt: number;
  readonly startedLabel: string;
  finishedAt: number;
  detailCount: number;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function createRunOutputService(dependencies: RunOutputDependencies): RunOutputService {
  const documentRef = dependencies.document;
  const listeners = new DisposableStore();
  let activeRun: ActiveRun | null = null;
  let runSequence = 0;
  let initialized = false;
  let panelActive = true;
  let detailsVisible = false;
  let cachedElements: CachedElements | null = null;
  let disposed = false;

  function tr(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return source.replace(/\{([^}]+)\}/g, (match, key: string) => (
      replacements && replacements[key] !== undefined ? String(replacements[key]) : match
    ));
  }

  function elements(): CachedElements {
    let needsRefresh = cachedElements === null;
    if (!needsRefresh && cachedElements) {
      for (const key of CACHED_ELEMENT_KEYS) {
        const current = cachedElements[key];
        if (!current || current.isConnected === false) {
          needsRefresh = true;
          break;
        }
      }
    }
    if (needsRefresh) {
      cachedElements = {
        summary: documentRef.getElementById('run-summary'),
        title: documentRef.getElementById('run-summary-title'),
        phase: documentRef.getElementById('run-summary-phase'),
        meta: documentRef.getElementById('run-summary-meta'),
        toggle: documentRef.getElementById('run-details-toggle'),
        count: documentRef.getElementById('run-details-count'),
        log: documentRef.getElementById('run-log')
      };
    }
    return cachedElements as CachedElements;
  }

  function selectedRuntimeLabel(): string {
    if (!documentRef.querySelector) return '';
    const label = documentRef.querySelector<HTMLElement>('#runtime-btn .runtime-label');
    return label ? String(label.textContent || '').trim() : '';
  }

  function phaseLabel(phase: RunOutputPhase): string {
    return tr(PHASE_LABELS[phase] || PHASE_LABELS.preparing || 'Preparing');
  }

  function formatDuration(durationMs: unknown): string {
    const value = Math.max(0, Number(durationMs) || 0);
    if (value < 1000) return tr('{duration} ms', { duration: Math.round(value) });
    const seconds = value / 1000;
    return tr('{duration} s', {
      duration: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)
    });
  }

  function resultMeta(run: ActiveRun): string {
    const parts: string[] = [];
    if (run.runtime) parts.push(run.runtime);
    if (Number.isInteger(run.returnCode)) {
      parts.push(tr('Exit code {code}', { code: run.returnCode }));
    }
    if (run.finishedAt) parts.push(formatDuration(run.finishedAt - run.startedAt));
    return parts.join('  |  ');
  }

  function runningMeta(run: ActiveRun): string {
    return run.runtime || tr('Started at {time}', { time: run.startedLabel });
  }

  function updateToggle(elementsValue: CachedElements): void {
    const toggle = elementsValue.toggle;
    if (!toggle) return;
    toggle.hidden = !activeRun || !panelActive;
    toggle.setAttribute('aria-expanded', detailsVisible ? 'true' : 'false');
    const label = tr(detailsVisible ? 'Hide run details' : 'Show run details');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    if (elementsValue.count) {
      elementsValue.count.textContent = activeRun && activeRun.detailCount
        ? (activeRun.detailCount > MAX_DETAIL_BADGE
          ? MAX_DETAIL_BADGE + '+'
          : String(activeRun.detailCount))
        : '';
      elementsValue.count.hidden = !(activeRun && activeRun.detailCount);
    }
  }

  function sessionMatches(sessionId: number | undefined): boolean {
    return sessionId === undefined || Boolean(activeRun && activeRun.id === sessionId);
  }

  function render(): void {
    if (disposed) return;
    const el = elements();
    if (!el.summary) return;
    el.summary.hidden = !activeRun;
    if (!activeRun) {
      updateToggle(el);
      return;
    }

    el.summary.dataset.state = activeRun.state;
    if (el.title) {
      el.title.textContent = activeRun.target;
      el.title.title = activeRun.target;
    }
    if (el.phase) {
      const phaseText = activeRun.reasonSource
        ? tr(activeRun.reasonSource)
        : (activeRun.reason || phaseLabel(activeRun.phase));
      el.phase.textContent = phaseText;
      el.phase.title = phaseText;
    }
    if (el.meta) el.meta.textContent = activeRun.finishedAt
      ? resultMeta(activeRun)
      : runningMeta(activeRun);
    if (el.log) el.log.classList.toggle('show-run-details', detailsVisible);
    updateToggle(el);
  }

  function setDetailsVisible(visible: boolean): void {
    if (disposed) return;
    detailsVisible = Boolean(visible && activeRun);
    render();
  }

  function begin(options: RunOutputBeginOptionsDto = {}): number {
    if (disposed) return 0;
    const input = options || {};
    dependencies.output.clearRunOutputDetails?.();
    const now = Date.now();
    const target = stringValue(input.target || input.label || tr('Cloud run'));
    activeRun = {
      id: ++runSequence,
      target,
      runtime: stringValue(input.runtime || selectedRuntimeLabel()),
      state: 'running',
      phase: 'preparing',
      reason: '',
      reasonSource: '',
      returnCode: null,
      startedAt: now,
      startedLabel: new Date(now).toLocaleTimeString(),
      finishedAt: 0,
      detailCount: 0
    };
    detailsVisible = false;
    render();
    detail(tr('Preparing run: {target}', { target: activeRun.target }), { stage: 'client' });
    return activeRun.id;
  }

  function detail(message: string, options: RunOutputDetailOptionsDto = {}): boolean {
    const input = options || {};
    if (disposed || !sessionMatches(input.sessionId) || !activeRun || activeRun.finishedAt) {
      return false;
    }
    const updatesDetailCount = !(input.streamFragment === true && (
      input.append === true || input.replace === true
    ));
    if (updatesDetailCount) activeRun.detailCount += 1;
    dependencies.output.updateRunOutput(message, {
      ...input,
      kind: 'detail',
      stage: input.stage || '',
      raw: input.raw || ''
    });
    if (updatesDetailCount) updateToggle(elements());
    return true;
  }

  function phase(
    name: RunOutputPhase,
    message = '',
    options: RunOutputDetailOptionsDto = {}
  ): boolean {
    const input = options || {};
    if (disposed || !sessionMatches(input.sessionId) || !activeRun || activeRun.finishedAt) {
      return false;
    }
    if (PHASE_LABELS[name]) activeRun.phase = name;
    activeRun.reason = '';
    activeRun.reasonSource = '';
    render();
    if (message) detail(message, input);
    return true;
  }

  function conciseStageMessage(stage: string): string {
    if (stage.indexOf('run:') === 0) return '[' + stage + '] ' + tr('Program process started.');
    if (stage.indexOf('compile:') === 0) return '[' + stage + '] ' + tr('Compiler process started.');
    return '';
  }

  function handleStatus(payload: RunOutputStatusDto = {}, sessionId?: number): boolean {
    const input = payload || {};
    const stage = stringValue(input.stage).toLowerCase();
    const message = stringValue(input.message);
    let nextPhase: RunOutputPhase = 'preparing';

    if (stage === 'cache') nextPhase = 'dependencies';
    else if (stage === 'analysis') nextPhase = 'analysis';
    else if (stage === 'docker') nextPhase = /artifact|recycl/i.test(message) ? 'artifacts' : 'container';
    else if (stage === 'setup') nextPhase = /runtime/i.test(message) ? 'runtime' : 'workspace';
    else if (stage.indexOf('compile:') === 0) nextPhase = 'compiling';
    else if (stage.indexOf('run:') === 0 || stage.indexOf('task:') === 0) nextPhase = 'running';
    else if (stage.indexOf('artifact:') === 0 || stage === 'target') nextPhase = 'artifacts';
    else if (stage === 'plan' || stage === 'task') nextPhase = 'compiling';

    const concise = conciseStageMessage(stage);
    return phase(nextPhase, concise || message, {
      stage,
      raw: concise ? message : '',
      sessionId
    });
  }

  function finish(options: RunOutputFinishOptionsDto = {}): boolean {
    const input = options || {};
    if (disposed || !sessionMatches(input.sessionId) || !activeRun || activeRun.finishedAt) {
      return false;
    }
    const cancelled = input.cancelled === true;
    const success = input.success === true && !cancelled;
    const hasReturnCode = input.returnCode !== null &&
      input.returnCode !== undefined && input.returnCode !== '';
    const returnCode = hasReturnCode ? Number(input.returnCode) : Number.NaN;

    activeRun.finishedAt = Date.now();
    activeRun.returnCode = Number.isInteger(returnCode) ? returnCode : null;
    activeRun.state = cancelled ? 'stopped' : (success ? 'completed' : 'failed');
    activeRun.phase = activeRun.state;
    activeRun.reason = stringValue(input.message);
    activeRun.reasonSource = '';
    if (!activeRun.reason && !cancelled && !success && activeRun.returnCode === 137) {
      activeRun.reasonSource = 'Process was forcibly terminated (exit code 137). It may have exceeded a resource limit or been stopped.';
    }
    render();
    return true;
  }

  function clear(): void {
    if (disposed) return;
    activeRun = null;
    detailsVisible = false;
    const el = elements();
    if (el.summary) el.summary.hidden = true;
    if (el.log) el.log.classList.remove('show-run-details');
    updateToggle(el);
  }

  function clearTranscript(): void {
    if (disposed) return;
    if (!activeRun || activeRun.finishedAt) {
      clear();
      return;
    }
    activeRun.detailCount = 0;
    detailsVisible = false;
    render();
  }

  function setPanelActive(value: boolean): void {
    if (disposed) return;
    panelActive = value !== false;
    updateToggle(elements());
  }

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;
    const toggle = documentRef.getElementById('run-details-toggle');
    if (toggle) {
      const onClick = (): void => setDetailsVisible(!detailsVisible);
      toggle.addEventListener('click', onClick);
      listeners.add(toDisposable(() => toggle.removeEventListener('click', onClick)));
    }
    const i18n = dependencies.getI18n();
    const onChange = i18n?.onChange;
    if (i18n && typeof onChange === 'function') {
      const registration = onChange.call(i18n, () => {
        render();
        dependencies.output.refreshRunOutputOmission?.();
      });
      if (typeof registration === 'function') listeners.add(toDisposable(registration));
      else if (registration) listeners.add(registration);
    }
    render();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.dispose();
    activeRun = null;
    detailsVisible = false;
    cachedElements = null;
  }

  const facade: RunOutputFacade = {
    init,
    begin,
    detail,
    phase,
    handleStatus,
    finish,
    clear,
    clearTranscript,
    isActive: (sessionId) => Boolean(
      !disposed && activeRun && !activeRun.finishedAt && sessionMatches(sessionId)
    ),
    setDetailsVisible,
    setPanelActive
  };
  const service: RunOutputService = {
    ...facade,
    get disposed() { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
