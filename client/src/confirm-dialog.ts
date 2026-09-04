import type {
  ConfirmDependencies,
  ConfirmDetailsOptions,
  ConfirmDetailsResultDto,
  ConfirmOptions,
  ConfirmService
} from '../types/confirm-dialog';

export const CONFIRM_SERVICE_ID = 'workbench.confirm';

type ConfirmResponse = boolean | ConfirmDetailsResultDto;
type RuntimeConfirmOptions = Readonly<Record<string, unknown>>;

interface ConfirmDialogDom {
  readonly overlay: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly message: HTMLDivElement;
  readonly option: HTMLLabelElement;
  readonly optionInput: HTMLInputElement;
  readonly optionText: HTMLSpanElement;
  readonly confirmButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement;
}

interface ConfirmRequest {
  readonly options: RuntimeConfirmOptions;
  readonly resolve: (response: ConfirmResponse) => void;
  previouslyFocused: Element | null;
}

function cloneOptions(options: unknown): RuntimeConfirmOptions {
  return options !== null && typeof options === 'object'
    ? { ...(options as Record<string, unknown>) }
    : {};
}

function displayText(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}

function responseFor(
  options: RuntimeConfirmOptions,
  confirmed: boolean,
  checkboxChecked: boolean
): ConfirmResponse {
  if (options.returnDetails === true) {
    return { confirmed, checkboxChecked };
  }
  return confirmed;
}

function canFocus(element: Element | null): element is Element & { focus(): void } {
  return element !== null && typeof (element as { focus?: unknown }).focus === 'function';
}

function restoreFocus(element: Element | null): void {
  if (!canFocus(element)) return;
  try {
    element.focus();
  } catch (_) {
    // Focus restoration cannot interrupt request settlement or disposal.
  }
}

export function createConfirmService(dependencies: ConfirmDependencies): ConfirmService {
  const hostDocument = dependencies.document;
  const pendingRequests: ConfirmRequest[] = [];
  let dom: ConfirmDialogDom | null = null;
  let activeRequest: ConfirmRequest | null = null;
  let closing = false;
  let closingResponse: ConfirmResponse | undefined;
  let focusTimer: number | null = null;
  let closeTimer: number | null = null;
  let disposed = false;

  function clearFocusTimer(): void {
    if (focusTimer === null) return;
    const timer = focusTimer;
    focusTimer = null;
    dependencies.clearTimer(timer);
  }

  function clearCloseTimer(): void {
    if (closeTimer === null) return;
    const timer = closeTimer;
    closeTimer = null;
    dependencies.clearTimer(timer);
  }

  function onOverlayClick(event: MouseEvent): void {
    if (dom && event.target === dom.overlay) close(false);
  }

  function onOverlayKeydown(event: KeyboardEvent): void {
    const currentDom = dom;
    if (!currentDom) return;
    if (event.key === 'Tab') {
      const focusable: Array<HTMLInputElement | HTMLButtonElement> = currentDom.option.hidden
        ? [currentDom.cancelButton, currentDom.confirmButton]
        : [currentDom.optionInput, currentDom.cancelButton, currentDom.confirmButton];
      const current = hostDocument.activeElement;
      const index = focusable.findIndex((element) => element === current);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      } else if (!event.shiftKey && (index === -1 || index === focusable.length - 1)) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      close(true);
    }
  }

  function ensureDOM(): ConfirmDialogDom | null {
    if (disposed) return null;
    if (dom) return dom;
    if (!hostDocument.body) return null;

    const overlay = hostDocument.createElement('div');
    overlay.id = 'confirm-dialog';
    overlay.setAttribute('aria-hidden', 'true');

    const card = hostDocument.createElement('div');
    card.className = 'confirm-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'confirm-dialog-title');
    card.setAttribute('aria-describedby', 'confirm-dialog-message');

    const body = hostDocument.createElement('div');
    body.className = 'confirm-body';

    const title = hostDocument.createElement('div');
    title.className = 'confirm-title';
    title.id = 'confirm-dialog-title';

    const message = hostDocument.createElement('div');
    message.className = 'confirm-message';
    message.id = 'confirm-dialog-message';

    const option = hostDocument.createElement('label');
    option.className = 'confirm-option';
    option.hidden = true;
    const optionInput = hostDocument.createElement('input');
    optionInput.type = 'checkbox';
    const optionText = hostDocument.createElement('span');
    option.appendChild(optionInput);
    option.appendChild(optionText);

    body.appendChild(title);
    body.appendChild(message);
    body.appendChild(option);

    const foot = hostDocument.createElement('div');
    foot.className = 'confirm-foot';

    const cancelButton = hostDocument.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'confirm-btn confirm-btn-ghost';
    cancelButton.onclick = () => close(false);

    const confirmButton = hostDocument.createElement('button');
    confirmButton.type = 'button';
    confirmButton.onclick = () => close(true);

    foot.appendChild(cancelButton);
    foot.appendChild(confirmButton);
    card.appendChild(body);
    card.appendChild(foot);
    overlay.appendChild(card);
    overlay.addEventListener('click', onOverlayClick);
    overlay.addEventListener('keydown', onOverlayKeydown);
    hostDocument.body.appendChild(overlay);

    dom = {
      overlay,
      title,
      message,
      option,
      optionInput,
      optionText,
      confirmButton,
      cancelButton
    };
    return dom;
  }

  function showNext(): void {
    const currentDom = dom;
    if (disposed || !currentDom || activeRequest || closing || pendingRequests.length === 0) return;
    const request = pendingRequests.shift();
    if (!request) return;
    activeRequest = request;

    currentDom.title.textContent = displayText(request.options.title, 'Confirm');
    currentDom.message.textContent = displayText(request.options.message, '');

    const checkboxLabel = displayText(request.options.checkboxLabel, '').trim();
    currentDom.option.hidden = !checkboxLabel;
    currentDom.optionInput.checked = Boolean(
      checkboxLabel && request.options.checkboxChecked === true
    );
    currentDom.optionText.textContent = checkboxLabel;

    currentDom.confirmButton.textContent = displayText(request.options.confirmLabel, 'Confirm');
    currentDom.cancelButton.textContent = displayText(request.options.cancelLabel, 'Cancel');
    currentDom.confirmButton.className = 'confirm-btn ' + (
      request.options.danger ? 'confirm-btn-danger' : 'confirm-btn-primary'
    );

    request.previouslyFocused = hostDocument.activeElement;
    currentDom.overlay.setAttribute('aria-hidden', 'false');
    currentDom.overlay.classList.add('open');

    let timer = 0;
    timer = dependencies.setTimer(() => {
      if (focusTimer !== timer) return;
      focusTimer = null;
      if (activeRequest === request && !closing && !disposed && dom === currentDom) {
        currentDom.confirmButton.focus();
      }
    }, 50);
    focusTimer = timer;
  }

  function close(confirmed: boolean): void {
    const currentDom = dom;
    const request = activeRequest;
    if (!currentDom || !request || closing || disposed) return;
    closing = true;
    clearFocusTimer();
    closingResponse = responseFor(
      request.options,
      confirmed === true,
      Boolean(!currentDom.option.hidden && currentDom.optionInput.checked)
    );

    currentDom.overlay.classList.remove('open');
    currentDom.overlay.setAttribute('aria-hidden', 'true');
    currentDom.option.hidden = true;
    currentDom.optionInput.checked = false;
    currentDom.optionText.textContent = '';

    const response = closingResponse;
    let timer = 0;
    timer = dependencies.setTimer(() => {
      if (closeTimer !== timer) return;
      closeTimer = null;
      if (disposed || activeRequest !== request) return;
      restoreFocus(request.previouslyFocused);
      activeRequest = null;
      closing = false;
      closingResponse = undefined;
      request.resolve(response);
      showNext();
    }, 150);
    closeTimer = timer;
  }

  function confirm(options: ConfirmDetailsOptions): Promise<ConfirmDetailsResultDto>;
  function confirm(options?: ConfirmOptions): Promise<boolean>;
  function confirm(options?: unknown): Promise<ConfirmResponse> {
    const requestOptions = cloneOptions(options);
    if (!ensureDOM()) {
      return Promise.resolve(responseFor(requestOptions, false, false));
    }
    return new Promise<ConfirmResponse>((resolve) => {
      pendingRequests.push({
        options: requestOptions,
        resolve,
        previouslyFocused: null
      });
      showNext();
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    const currentRequest = activeRequest;
    const currentResponse = currentRequest
      ? closing && closingResponse !== undefined
        ? closingResponse
        : responseFor(currentRequest.options, false, false)
      : undefined;
    const queuedRequests = pendingRequests.splice(0);
    clearFocusTimer();
    clearCloseTimer();

    const currentDom = dom;
    if (currentDom) {
      currentDom.overlay.removeEventListener('click', onOverlayClick);
      currentDom.overlay.removeEventListener('keydown', onOverlayKeydown);
      currentDom.cancelButton.onclick = null;
      currentDom.confirmButton.onclick = null;
      currentDom.overlay.remove();
    }

    dom = null;
    activeRequest = null;
    closing = false;
    closingResponse = undefined;

    if (currentRequest) {
      restoreFocus(currentRequest.previouslyFocused);
      currentRequest.resolve(currentResponse ?? responseFor(currentRequest.options, false, false));
    }
    queuedRequests.forEach((request) => {
      request.resolve(responseFor(request.options, false, false));
    });
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    confirm,
    dispose
  });
}
