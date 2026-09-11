import { DisposableStore, toDisposable } from '../renderer/core/disposable';
import type {
  OutputPanelDependencies,
  OutputPanelFacade,
  OutputPanelService
} from '../types/output-panel';

export const OUTPUT_PANEL_SERVICE_ID = 'workbench.outputPanel' as const;

type PanelTab = HTMLElement & { click(): void; focus(): void };

function listen(
  store: DisposableStore,
  target: EventTarget,
  type: string,
  listener: EventListener
): void {
  target.addEventListener(type, listener);
  store.add(toDisposable(() => target.removeEventListener(type, listener)));
}

export function createOutputPanelService(
  dependencies: OutputPanelDependencies
): OutputPanelService {
  const listeners = new DisposableStore();
  let initialized = false;
  let disposed = false;

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;

    const tabs = Array.from(
      dependencies.document.querySelectorAll<PanelTab>('#panel-tabs .panel-tab')
    );
    const contents = Array.from(
      dependencies.document.querySelectorAll<HTMLElement>('#bottom-panel .panel-content')
    );
    const clearButton = dependencies.document.getElementById('panel-clear');

    for (const tab of tabs) {
      listen(listeners, tab, 'click', () => {
        const panelName = tab.getAttribute('data-panel');
        const workbench = dependencies.getWorkbench();
        if (workbench) {
          if (panelName === 'debug' && workbench.ensureBottomPanelSize) {
            workbench.ensureBottomPanelSize(300);
          } else {
            workbench.revealPanel?.();
          }
        }

        for (const item of tabs) {
          item.classList.remove('active');
          item.setAttribute('aria-selected', 'false');
        }
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        for (const content of contents) content.classList.remove('active');
        const panel = panelName === null
          ? null
          : dependencies.document.getElementById('panel-' + panelName);
        panel?.classList.add('active');

        dependencies.state.activePanel = panelName;
        dependencies.getRunOutput()?.setPanelActive?.(panelName === 'output');

        if (panelName === 'terminal') dependencies.getTerminal()?.activate?.();
      });

      listen(listeners, tab, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
        const visible = tabs.filter((item) => getComputedStyle(item).display !== 'none');
        const index = visible.indexOf(tab);
        if (index < 0 || visible.length === 0) return;
        keyboardEvent.preventDefault();
        const offset = keyboardEvent.key === 'ArrowRight' ? 1 : -1;
        const next = visible[(index + offset + visible.length) % visible.length];
        next?.focus();
        next?.click();
      });
    }

    if (clearButton) {
      listen(listeners, clearButton, 'click', () => {
        const activePanel = dependencies.state.activePanel;
        if (activePanel === 'output') {
          const clearRunOutput = dependencies.getClearRunOutput();
          if (clearRunOutput) {
            clearRunOutput();
          } else {
            const log = dependencies.document.getElementById('run-log');
            if (log) log.textContent = '';
            dependencies.state.runLogInitialized = true;
            const runOutput = dependencies.getRunOutput();
            if (runOutput?.clearTranscript) runOutput.clearTranscript();
            else runOutput?.clear?.();
          }
        } else if (activePanel === 'terminal') {
          dependencies.getTerminal()?.clear?.();
        } else if (activePanel === 'debug') {
          dependencies.getDap()?.clearConsole?.();
        } else if (activePanel === 'problems') {
          dependencies.getTaskProblemMatcher()?.clear?.();
        }
      });
    }

    dependencies.getRunOutput()?.setPanelActive?.(
      (dependencies.state.activePanel || 'output') === 'output'
    );
  }

  function switchToPanel(panelName: string): void {
    if (disposed) return;
    const tab = Array.from(
      dependencies.document.querySelectorAll<PanelTab>('#panel-tabs .panel-tab')
    ).find((item) => item.getAttribute('data-panel') === panelName);
    tab?.click();
  }

  function setupOutputResizer(): void {
    if (disposed) return;
    dependencies.getWorkbench()?.init?.();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    listeners.dispose();
  }

  const facade: OutputPanelFacade = { init, setupOutputResizer };
  const service: OutputPanelService = {
    ...facade,
    switchToPanel,
    get disposed() { return disposed; },
    dispose
  };
  return Object.freeze(service);
}

export default createOutputPanelService;
