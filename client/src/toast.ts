// Lightweight, lifecycle-owned toast notification service.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  ToastDependencies,
  ToastFacade,
  ToastKind,
  ToastService
} from '../types/toast';

export const TOAST_SERVICE_ID = 'workbench.toast' as const;
const TOAST_DURATION = 3500;
const REMOVE_DURATION = 150;

export function createToastService(dependencies: ToastDependencies): ToastService {
  const listeners = new DisposableStore();
  const activeTimers = new Set<number>();
  let container: HTMLDivElement | null = null;
  let disposed = false;

  function schedule(callback: () => void, delayMs: number): number {
    let timer: number | null = null;
    let firedSynchronously = false;
    const assignedTimer = dependencies.setTimer(() => {
      firedSynchronously = true;
      if (timer !== null) activeTimers.delete(timer);
      callback();
    }, delayMs);
    timer = assignedTimer;
    if (!firedSynchronously) activeTimers.add(assignedTimer);
    return assignedTimer;
  }

  function ensureContainer(): HTMLDivElement {
    if (container) return container;
    container = dependencies.document.createElement('div');
    container.id = 'toast-container';
    dependencies.document.body.appendChild(container);
    return container;
  }

  function dismiss(toast: HTMLDivElement): void {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('removing');
    schedule(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, REMOVE_DURATION);
  }

  function show(message: string, kind: ToastKind): void {
    if (disposed) return;
    const toastContainer = ensureContainer();
    const toast = dependencies.document.createElement('div');
    toast.className = 'toast toast-' + (kind || 'info');

    const icon = dependencies.document.createElement('span');
    icon.className = 'toast-icon';
    const iconSet = dependencies.getIcons();
    if (iconSet) {
      if (kind === 'success') icon.innerHTML = iconSet.check || '';
      else if (kind === 'error') icon.innerHTML = iconSet.close || '';
      else icon.innerHTML = iconSet.cloud || '';
    }

    const messageElement = dependencies.document.createElement('span');
    messageElement.className = 'toast-msg';
    messageElement.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(messageElement);
    toastContainer.appendChild(toast);

    let timer = 0;
    let clickDisposable: Disposable;
    function onClick(): void {
      dependencies.clearTimer(timer);
      activeTimers.delete(timer);
      clickDisposable.dispose();
      listeners.delete(clickDisposable);
      dismiss(toast);
    }
    clickDisposable = toDisposable(() => {
      toast.removeEventListener('click', onClick);
    });
    listeners.add(clickDisposable);
    timer = schedule(() => {
      clickDisposable.dispose();
      listeners.delete(clickDisposable);
      dismiss(toast);
    }, TOAST_DURATION);
    toast.addEventListener('click', onClick);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const timer of activeTimers) dependencies.clearTimer(timer);
    activeTimers.clear();
    listeners.dispose();
    if (container?.parentNode) container.parentNode.removeChild(container);
    container = null;
  }

  const facade: ToastFacade = {
    success: (message) => show(message, 'success'),
    error: (message) => show(message, 'error'),
    info: (message) => show(message, 'info')
  };
  const service: ToastService = {
    get disposed() { return disposed; },
    success: facade.success,
    error: facade.error,
    info: facade.info,
    dispose
  };
  return Object.freeze(service);
}
