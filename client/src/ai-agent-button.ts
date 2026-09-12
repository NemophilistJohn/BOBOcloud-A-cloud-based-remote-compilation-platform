// Compact AI status button and quick-settings menu.
//
// The DOM and the five-key BOBO projection remain compatible with the
// historical renderer module.  Browser, host, and sibling-module access is
// supplied through the typed dependency object so this service can be owned
// and disposed by the private renderer registry.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  AiAgentButtonAiState,
  AiAgentButtonDependencies,
  AiAgentButtonFacade,
  AiAgentButtonProfileDto,
  AiAgentButtonService
} from '../types/ai-agent-button';

export const AI_AGENT_BUTTON_SERVICE_ID = 'workbench.aiAgentButton' as const;

const LED_COLORS = Object.freeze(['red', 'yellow', 'green'] as const);

type LedColor = (typeof LED_COLORS)[number];

interface MenuElements {
  readonly root: HTMLDivElement;
  readonly select: HTMLSelectElement;
  readonly checkbox: HTMLInputElement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function resultErrorKey(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const code = value.code;
  if (typeof code === 'string' && code) return code;
  const error = value.error;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function profileId(value: AiAgentButtonProfileDto | null | undefined): string {
  return value && typeof value.id === 'string' ? value.id : '';
}

function profileName(value: AiAgentButtonProfileDto | null | undefined): string {
  return value && typeof value.name === 'string' ? value.name : '';
}

function inlineEnabled(state: AiAgentButtonAiState): boolean {
  return Boolean(state.inline && state.inline.enabled);
}

export function createAiAgentButtonService(
  dependencies: AiAgentButtonDependencies
): AiAgentButtonService {
  const { document, state } = dependencies;
  const lifecycle = new DisposableStore({
    onError: (event) => {
      // Keep cleanup failures isolated from the renderer composition root.
      try {
        console.error('AI agent button disposal:', event.error);
      } catch (_) {
        // Console implementations supplied by embedders may themselves fail.
      }
    }
  });

  let button: HTMLButtonElement | null = null;
  let separator: HTMLSpanElement | null = null;
  let lights: HTMLSpanElement[] = [];
  let menu: MenuElements | null = null;
  let outsideListenerActive = false;
  let outsideTimer: number | null = null;
  let startupTimer: number | null = null;
  let initialized = false;
  let disposed = false;

  function t(key: unknown, params?: Readonly<Record<string, unknown>> | null): string {
    try {
      const i18n = dependencies.getI18n();
      if (i18n && typeof i18n.t === 'function') return i18n.t(key, params);
    } catch (_) {
      // Translation is presentation-only; retain the historical key fallback.
    }
    return String(key);
  }

  function closeOnOutside(event: PointerEvent): void {
    if (!menu || !button) return;
    const target = event.target;
    const insideMenu = target !== null &&
      typeof (target as Node).nodeType === 'number' &&
      menu.root.contains(target as Node);
    if (!insideMenu && target !== button) {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      outsideListenerActive = false;
      closeMenu();
    }
  }

  function closeMenu(): void {
    if (outsideTimer !== null) {
      try {
        dependencies.clearTimer(outsideTimer);
      } catch (_) {
        // Timer cleanup is best effort during renderer teardown.
      }
      outsideTimer = null;
    }
    if (outsideListenerActive) {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      outsideListenerActive = false;
    }
    if (menu) menu.root.remove();
    menu = null;
  }

  function currentAiService() {
    try {
      return dependencies.getAiService() || null;
    } catch (_) {
      return null;
    }
  }

  function updateTitle(): void {
    if (!button || disposed) return;
    const aiService = currentAiService();
    let model = null;
    let status: { code?: unknown } = { code: 'ai.error.noModel' };
    try {
      model = aiService?.getProfileFor('chat') || null;
      status = aiService?.getModelStatus(model, 'chat') || status;
    } catch (_) {
      // Keep the no-model title when a sibling service is not ready.
    }
    button.setAttribute('title', t('AI chat - {model} - {status}', {
      model: model ? profileName(model) : t('No model'),
      status: t(status.code || 'ai.error.noModel')
    }));
    button.setAttribute('aria-label', t('ai.statusButton.aria'));
  }

  function updateLEDs(status: string): void {
    if (disposed) return;
    lights.forEach((light) => {
      light.className = 'ai-led ai-led-' + String(light.dataset.led || '');
    });
    if (status === 'idle' && lights[2]) lights[2].classList.add('ai-led-active');
    if ((status === 'thinking' || status === 'testing') && lights[1]) {
      lights[1].classList.add('ai-led-thinking');
    }
    if (status === 'error' && lights[0]) lights[0].classList.add('ai-led-error');
    updateTitle();
  }

  function option(
    select: HTMLSelectElement,
    model: AiAgentButtonProfileDto,
    selected: string | null | undefined
  ): void {
    const item = document.createElement('option');
    item.value = profileId(model);
    item.textContent = profileName(model);
    item.selected = item.value === selected;
    select.appendChild(item);
  }

  async function selectProfile(select: HTMLSelectElement): Promise<void> {
    const desired = select.value;
    select.disabled = true;
    try {
      const aiService = currentAiService();
      const result = aiService
        ? await aiService.setProfileFor('chat', desired)
        : { success: false, code: 'ai.error.settingsWrite' };
      if (disposed) return;
      select.value = state.ai.chatProfileId || '';
      if (!result || result.success === false) {
        const toast = dependencies.getToast();
        toast?.error?.(t(resultErrorKey(result, 'ai.error.settingsWrite')));
      }
    } catch (error) {
      if (!disposed) {
        select.value = state.ai.chatProfileId || '';
        const toast = dependencies.getToast();
        toast?.error?.(t(resultErrorKey(error, 'ai.error.settingsWrite')));
      }
    } finally {
      if (!disposed) select.disabled = false;
    }
  }

  async function setInlineEnabled(checkbox: HTMLInputElement): Promise<void> {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    try {
      const inline = (() => {
        try {
          return dependencies.getAiInline() || null;
        } catch (_) {
          return null;
        }
      })();
      const result = inline
        ? await inline.setEnabled(desired)
        : { success: false, code: 'ai.error.settingsWrite' };
      if (disposed) return;
      checkbox.checked = inlineEnabled(state.ai);
      if (!result || result.success === false) {
        const toast = dependencies.getToast();
        toast?.error?.(t(resultErrorKey(result, 'ai.error.settingsWrite')));
      }
    } catch (error) {
      if (!disposed) {
        checkbox.checked = inlineEnabled(state.ai);
        const toast = dependencies.getToast();
        toast?.error?.(t(resultErrorKey(error, 'ai.error.settingsWrite')));
      }
    } finally {
      if (!disposed) checkbox.disabled = false;
    }
  }

  function openMenu(): void {
    if (disposed || !button || !document.body) return;
    closeMenu();

    const root = document.createElement('div');
    root.className = 'context-menu ai-menu ai-status-menu';
    root.setAttribute('role', 'menu');

    const heading = document.createElement('div');
    heading.className = 'ai-menu-header';
    heading.textContent = t('ai.quickSettings');
    root.appendChild(heading);

    const row = document.createElement('label');
    row.className = 'ai-menu-row';
    const label = document.createElement('span');
    label.className = 'ai-menu-label';
    label.textContent = t('ai.chatModel');
    const select = document.createElement('select');
    select.className = 'ai-compact-select';
    const profiles = state.ai.chatProfiles || [];
    const selectedProfile = state.ai.chatProfileId || '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('ai.control.value.none');
    none.selected = !selectedProfile;
    select.appendChild(none);
    if (!profiles.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('ai.control.noProfiles');
      select.appendChild(empty);
      select.disabled = true;
    }
    profiles.forEach((profile) => option(select, profile, selectedProfile));
    select.addEventListener('change', () => { void selectProfile(select); });
    row.append(label, select);
    root.appendChild(row);

    const completion = document.createElement('label');
    completion.className = 'ai-menu-row ai-menu-toggle';
    const completionText = document.createElement('span');
    completionText.textContent = t('ai.inline.enable');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = inlineEnabled(state.ai);
    checkbox.addEventListener('change', () => { void setInlineEnabled(checkbox); });
    completion.append(completionText, checkbox);
    root.appendChild(completion);

    const settings = document.createElement('button');
    settings.className = 'ai-menu-settings';
    settings.textContent = t('ai.openSettings');
    settings.addEventListener('click', () => {
      closeMenu();
      try {
        dependencies.getSettingsCenter()?.open?.();
      } catch (_) {
        // The lazy AI presentation bundle may still be loading.
      }
    });
    root.appendChild(settings);

    document.body.appendChild(root);
    menu = { root, select, checkbox };

    const rect = button.getBoundingClientRect();
    root.style.left = Math.max(6, rect.right - root.offsetWidth) + 'px';
    root.style.top = Math.max(6, rect.top - root.offsetHeight - 6) + 'px';

    let timer: number | null = null;
    let firedSynchronously = false;
    let handle: number | null = null;
    const callback = (): void => {
      firedSynchronously = true;
      if (timer === handle) timer = null;
      if (outsideTimer === handle) outsideTimer = null;
      if (disposed || !menu || menu.root !== root) return;
      document.addEventListener('pointerdown', closeOnOutside, true);
      outsideListenerActive = true;
    };
    handle = dependencies.setTimer(callback, 0);
    timer = handle;
    outsideTimer = firedSynchronously ? null : handle;
    if (firedSynchronously) timer = null;
  }

  function toggleChat(open?: boolean): void {
    if (disposed) return;
    const next = typeof open === 'boolean' ? open : !state.ai.chatOpen;
    state.ai.chatOpen = next;
    try {
      dependencies.getWorkbench()?.setAuxiliaryVisible(next, { skipContent: true });
    } catch (_) {
      // The workbench may not have finished composing yet.
    }
    try {
      dependencies.getChatPanel()?.setVisible?.(next);
    } catch (_) {
      // Lazy AI UI failures must not break the status-bar control.
    }
    try {
      const aiService = currentAiService();
      if (aiService) void Promise.resolve(aiService.saveSettings()).catch(() => {});
    } catch (_) {
      // Saving is best-effort, matching the legacy fire-and-forget call.
    }
  }

  function createButton(): HTMLButtonElement | null {
    const right = document.querySelector<HTMLElement>('#statusbar .status-right');
    if (!right) return null;

    separator = document.createElement('span');
    separator.className = 'status-sep';
    right.appendChild(separator);

    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'status-item clickable ai-agent-btn';
    element.dataset.aiBtn = 'true';
    const label = document.createElement('span');
    label.className = 'ai-btn-label';
    label.textContent = 'AI';
    element.appendChild(label);

    lights = LED_COLORS.map((color: LedColor) => {
      const light = document.createElement('span');
      light.className = 'ai-led ai-led-' + color;
      light.dataset.led = color;
      light.setAttribute('aria-hidden', 'true');
      element.appendChild(light);
      return light;
    });

    const onClick = (): void => { closeMenu(); toggleChat(); };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      openMenu();
    };
    element.addEventListener('click', onClick);
    element.addEventListener('contextmenu', onContextMenu);
    lifecycle.add(toDisposable(() => {
      element.removeEventListener('click', onClick);
      element.removeEventListener('contextmenu', onContextMenu);
    }));
    right.appendChild(element);
    return element;
  }

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;
    button = createButton();
    updateLEDs(state.ai.status);

    try {
      const hostDisposable = dependencies.host?.onOpenAiSettings(() => {
        if (disposed) return;
        try {
          dependencies.getSettingsCenter()?.open?.();
        } catch (_) {
          // The lazy AI presentation bundle may still be loading.
        }
      });
      if (hostDisposable) lifecycle.add(hostDisposable);
    } catch (_) {
      // Older preload fixtures may not provide the optional menu event.
    }

    let timer: number | null = null;
    let firedSynchronously = false;
    let handle: number | null = null;
    const callback = (): void => {
      firedSynchronously = true;
      if (timer === handle) timer = null;
      if (startupTimer === handle) startupTimer = null;
      if (!disposed && state.ai.chatOpen) toggleChat(true);
    };
    handle = dependencies.setTimer(callback, 300);
    timer = handle;
    if (firedSynchronously) timer = null;
    startupTimer = timer;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (startupTimer !== null) {
      try {
        dependencies.clearTimer(startupTimer);
      } catch (_) {
        // Continue removing DOM and listeners even if a host timer rejects cleanup.
      }
      startupTimer = null;
    }
    closeMenu();
    if (button) button.remove();
    if (separator) separator.remove();
    button = null;
    separator = null;
    lights = [];
    lifecycle.dispose();
  }

  const facade: AiAgentButtonFacade = {
    init,
    updateLEDs,
    toggleChat,
    openMenu,
    closeMenu
  };
  const service: AiAgentButtonService = {
    ...facade,
    get disposed() { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
