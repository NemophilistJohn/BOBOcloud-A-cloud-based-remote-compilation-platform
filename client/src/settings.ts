// Unified Settings Center with Local/Server tabs.
//
// The settings shell intentionally keeps the historical DOM and BOBO-facing
// behavior. Browser state and legacy collaborators enter through narrow ports,
// while this service owns every static listener and deferred callback.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  SettingsAiFieldOptions,
  SettingsAiFieldResult,
  SettingsAiModelDto,
  SettingsAiPurposeDto,
  SettingsAiStatusDto,
  SettingsDependencies,
  SettingsDiagnosticsStateDto,
  SettingsFacade,
  SettingsService,
  SettingsTabDto
} from '../types/settings';

export const SETTINGS_SERVICE_ID = 'workbench.settings' as const;

interface FocusableElement extends Element {
  focus?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function settingsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function isPromiseBoolean(value: unknown): value is Promise<boolean> {
  return value !== null && typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function';
}

export function createSettingsService(
  dependencies: SettingsDependencies
): SettingsService {
  const { document, window: hostWindow, state } = dependencies;
  const lifecycle = new DisposableStore();
  const aiRenderLifecycle = new DisposableStore();
  const pendingTimers = new Set<number>();
  const activeOverlays = new Set<HTMLElement>();
  const logger = dependencies.logger || console;
  let modal: HTMLElement | null = null;
  let activeTab: SettingsTabDto = 'local';
  let previousFocus: FocusableElement | null = null;
  let firstRunOpen = false;
  let serverPaneLoaded = false;
  let disposed = false;

  function schedule(callback: () => void, delayMs: number): number {
    let handle: number | null = null;
    handle = hostWindow.setTimeout(() => {
      if (handle !== null) pendingTimers.delete(handle);
      if (!disposed) callback();
    }, delayMs);
    pendingTimers.add(handle);
    return handle;
  }

  function listen(
    store: DisposableStore,
    target: EventTarget,
    type: string,
    callback: (event: Event) => void
  ): void {
    const listener = callback as EventListener;
    target.addEventListener(type, listener);
    store.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function listenStatic(
    target: EventTarget,
    type: string,
    callback: (event: Event) => void
  ): void {
    listen(lifecycle, target, type, callback);
  }

  function listenAiRender(
    target: EventTarget,
    type: string,
    callback: (event: Event) => void
  ): void {
    listen(aiRenderLifecycle, target, type, callback);
  }

  function isVisible(element: Element | null): boolean {
    if (!element) return false;
    const style = hostWindow.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0.01 && bounds.width > 16 && bounds.height > 16;
  }

  function finishFirstRunState(): void {
    firstRunOpen = false;
    modal?.classList.remove('server-first-run');
    const intro = document.getElementById('server-first-run-intro');
    const skip = document.getElementById('server-skip-first-run');
    if (intro) intro.hidden = true;
    if (skip) skip.hidden = true;
  }

  function releaseBrokenFirstRunModal(): void {
    finishFirstRunState();
    if (!modal) return;
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
  }

  function verifyFirstRunModal(): void {
    schedule(() => {
      if (!firstRunOpen || !modal) return;
      const card = modal.querySelector('.settings-card');
      if (isVisible(modal) && isVisible(card)) return;
      logger.error('Server setup guide could not render; returning control to the workbench.');
      releaseBrokenFirstRunModal();
    }, 160);
  }

  function t(
    key: unknown,
    params?: Readonly<Record<string, unknown>> | null
  ): string {
    const i18n = dependencies.getI18n();
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : String(key);
  }

  function close(): void {
    if (disposed || firstRunOpen) return;
    dependencies.getRcloneSettings()?.close();
    serverPaneLoaded = false;
    if (modal) modal.style.display = 'none';
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  }

  function saveLocalSettings(): void {
    if (disposed) return;

    // Theme
    const selectedTheme = document.querySelector<HTMLInputElement>(
      'input[name="settings-theme"]:checked'
    );
    const themeManager = dependencies.getThemeManager();
    if (selectedTheme && themeManager) {
      const themes = themeManager.listThemes();
      const theme = themes.find((item) => item.id === selectedTheme.value);
      themeManager.applyTheme(selectedTheme.value);
      const toast = dependencies.getToast();
      if (toast && theme) toast.success(t('Theme: {name}', { name: t(theme.label) }));
    }

    // Diagnostics
    const diagEnabled = document.getElementById('settings-diag-enabled') as HTMLInputElement | null;
    const diagMode = document.getElementById('settings-diag-mode') as HTMLSelectElement | null;
    let diagnosticsSave: Promise<boolean> | boolean | null = null;
    if (diagEnabled || diagMode) {
      const diagnosticsUpdate: Record<string, unknown> = {};
      if (diagEnabled) diagnosticsUpdate.enabled = diagEnabled.checked;
      if (diagMode) diagnosticsUpdate.checkOn = diagMode.value;
      const diagnostics = dependencies.getDiagnosticsSettings();
      if (diagnostics && typeof diagnostics.updateBasic === 'function') {
        diagnosticsSave = diagnostics.updateBasic(diagnosticsUpdate);
      }
    }

    if (isPromiseBoolean(diagnosticsSave)) {
      diagnosticsSave.then(function(saved) {
        if (!disposed && saved === true) close();
      }).catch(function(error: unknown) {
        if (!disposed) logger.error('Save diagnostics settings:', error);
      });
      return;
    }
    close();
  }

  function ensureDOM(): void {
    if (modal || disposed) return;
    modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Tab switching
    const tabs = modal.querySelectorAll<HTMLElement>('.settings-tab');
    tabs.forEach((tab) => {
      listenStatic(tab, 'click', () => {
        switchTab(tab.getAttribute('data-stab') || '');
      });
      listenStatic(tab, 'keydown', (rawEvent) => {
        const event = rawEvent as KeyboardEvent;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        if (!modal) return;
        const items = Array.from(modal.querySelectorAll<HTMLElement>('.settings-tab'));
        const index = items.indexOf(tab);
        const next = items[
          (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
        ];
        if (!next) return;
        next.focus();
        switchTab(next.getAttribute('data-stab') || '');
      });
    });

    // Close handlers
    for (const id of [
      'settings-close-x',
      'settings-close',
      'settings-close-workbench',
      'settings-close-lsp',
      'settings-close-language'
    ]) {
      const closeButton = document.getElementById(id);
      if (closeButton) listenStatic(closeButton, 'click', close);
    }
    listenStatic(modal, 'click', (event) => {
      if (event.target === modal) close();
    });
    listenStatic(modal, 'keydown', (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    // Local save (theme + diagnostics)
    const saveLocal = document.getElementById('settings-save-local');
    if (saveLocal) listenStatic(saveLocal, 'click', saveLocalSettings);

    // The server-save button keeps its existing handler in app.js.
  }

  function activateServerPane(): void {
    if (disposed) return;
    if (!serverPaneLoaded) {
      const serverSettings = state.serverSettings || {};
      const rawSyncInterval = serverSettings.syncInterval;
      const numericSyncInterval = Number(rawSyncInterval);
      const values: Readonly<Record<string, unknown>> = {
        'server-ip': serverSettings.ip || '',
        'server-user': serverSettings.user || '',
        'server-pass': serverSettings.pass || '',
        'server-apikey': serverSettings.apiKey || '',
        'server-http-port': serverSettings.httpPort || 3100,
        'server-ws-port': serverSettings.wsPort || 3101,
        'server-dap-child-port': serverSettings.dapChildWsPort || 3102,
        'server-cert-fingerprint': serverSettings.certificateFingerprint || '',
        'sync-interval': !rawSyncInterval
          ? 30
          : (numericSyncInterval >= 1000
              ? Math.round(numericSyncInterval / 1000)
              : rawSyncInterval)
      };
      Object.keys(values).forEach((id) => {
        const control = document.getElementById(id) as HTMLInputElement | null;
        if (control) control.value = stringValue(values[id]);
      });
      const secure = document.getElementById('server-secure-transport') as HTMLInputElement | null;
      if (secure) secure.checked = serverSettings.secureTransport === true;
      serverPaneLoaded = true;
    }
    if (dependencies.getRcloneSettings()) {
      schedule(() => {
        void dependencies.getRcloneSettings()?.open();
      }, 0);
    }
  }

  function switchTab(tab: SettingsTabDto): void {
    if (disposed || !modal) return;
    activeTab = tab;
    const tabs = modal.querySelectorAll<HTMLElement>('.settings-tab');
    const panes = modal.querySelectorAll<HTMLElement>('.settings-pane');
    const feet = modal.querySelectorAll<HTMLElement>('.settings-foot');
    tabs.forEach((item) => {
      const selected = item.getAttribute('data-stab') === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.tabIndex = selected ? 0 : -1;
    });
    panes.forEach((pane) => {
      pane.classList.toggle('active', pane.getAttribute('data-spane') === tab);
    });
    feet.forEach((foot) => {
      foot.classList.toggle('active', foot.getAttribute('data-sfoot') === tab);
    });
    const body = modal.querySelector<HTMLElement>('.settings-body');
    if (body) body.scrollTop = 0;
    if (tab === 'workbench') dependencies.getWorkbench()?.refreshControls();
    if (tab === 'language') void dependencies.getLanguagePacksPanel()?.refresh();
    if (tab === 'lsp') dependencies.getLsp()?.renderStatus();
    if (tab === 'server') activateServerPane();
    else dependencies.getRcloneSettings()?.close();
  }

  function fillModelSelect(select: HTMLSelectElement | null, selectedId: unknown): void {
    if (!select) return;
    select.innerHTML = '';
    if (!state.ai.models.length) {
      const empty = document.createElement('option');
      empty.textContent = t('No model');
      empty.value = '';
      select.appendChild(empty);
      return;
    }
    state.ai.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      option.selected = model.id === selectedId;
      select.appendChild(option);
    });
  }

  function statusLabel(
    model: SettingsAiModelDto | null | undefined,
    purpose: SettingsAiPurposeDto
  ): { readonly status: SettingsAiStatusDto; readonly text: string } {
    const aiService = dependencies.getAiService();
    const status = aiService
      ? aiService.getModelStatus(model, purpose)
      : { state: 'missing', code: 'ai.error.noModel' };
    return { status, text: t(status.code) };
  }

  function renderAiSettings(): void {
    const aiService = dependencies.getAiService();
    if (!aiService || !state.ai) return;
    fillModelSelect(
      document.getElementById('ai-chat-model-select') as HTMLSelectElement | null,
      state.ai.chatModel
    );
    fillModelSelect(
      document.getElementById('ai-inline-model-select') as HTMLSelectElement | null,
      state.ai.inlineModel
    );
    const enabled = document.getElementById('ai-inline-enabled') as HTMLInputElement | null;
    if (enabled) enabled.checked = state.ai.inlineEnabled === true;
    const debounce = document.getElementById('ai-inline-debounce') as HTMLInputElement | null;
    if (debounce) debounce.value = String(state.ai.inlineDebounceMs || 450);
    const output = document.getElementById('ai-inline-debounce-output');
    if (output) output.textContent = (state.ai.inlineDebounceMs || 450) + ' ms';
    const promptValues: Readonly<Record<string, unknown>> = {
      'ai-chat-system-prompt': state.ai.chatSystemPrompt || '',
      'ai-inline-instruction': state.ai.inlineInstruction || '',
      'ai-inline-prefix-chars': state.ai.inlinePrefixChars || 6000,
      'ai-inline-suffix-chars': Number.isFinite(state.ai.inlineSuffixChars)
        ? state.ai.inlineSuffixChars
        : 2500,
      'ai-inline-max-tokens': state.ai.inlineMaxTokens || 160
    };
    Object.keys(promptValues).forEach((id) => {
      const control = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (control) control.value = stringValue(promptValues[id]);
    });
    const chat = statusLabel(aiService.getModelFor('chat'), 'chat');
    const inlineModel = aiService.getModelFor('inline');
    const inline = statusLabel(inlineModel, 'inline');
    const instruction = document.getElementById('ai-inline-instruction') as HTMLTextAreaElement | null;
    const instructionMode = document.getElementById('ai-inline-instruction-mode');
    const instructionAvailable = !inlineModel || inlineModel.inlineMode !== 'fim';
    if (instruction) instruction.disabled = !instructionAvailable;
    if (instructionMode) instructionMode.textContent = t('ai.inlineMode.chat');
    const aiState = document.getElementById('ai-settings-state');
    if (aiState) {
      const ready = chat.status.state === 'ready' &&
        (!state.ai.inlineEnabled || inline.status.state === 'ready');
      aiState.dataset.state = ready ? 'ready' : 'unconfigured';
      aiState.textContent = ready ? t('ai.status.ready') : t('ai.status.configurationRequired');
    }
    renderAiModelList();
  }

  function renderAiModelList(): void {
    aiRenderLifecycle.clear();
    const list = document.getElementById('ai-model-list');
    if (!list) return;
    list.innerHTML = '';
    state.ai.models.forEach((model) => {
      const card = document.createElement('article');
      card.className = 'ai-model-card';
      const header = document.createElement('header');
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = model.name;
      const meta = document.createElement('small');
      meta.textContent = model.provider + ' · ' + model.modelId;
      identity.append(name, meta);
      const badge = document.createElement('span');
      badge.className = 'ai-model-badge';
      badge.textContent = model.isPreset ? t('PRESET') : t('ai.custom');
      header.append(identity, badge);
      const facts = document.createElement('dl');
      const chatFact = document.createElement('div');
      const chatTerm = document.createElement('dt');
      const chatValue = document.createElement('dd');
      chatTerm.textContent = t('ai.chatEndpoint');
      chatValue.textContent = model.endpoint || t('ai.value.notSet');
      chatFact.append(chatTerm, chatValue);
      const inlineFact = document.createElement('div');
      const inlineTerm = document.createElement('dt');
      const inlineValue = document.createElement('dd');
      inlineTerm.textContent = t('ai.inlineEndpoint');
      inlineValue.textContent = model.inlineEndpoint || model.endpoint || t('ai.value.notSet');
      inlineFact.append(inlineTerm, inlineValue);
      facts.append(chatFact, inlineFact);
      const status = document.createElement('div');
      status.className = 'ai-model-status';
      status.textContent = statusLabel(model, 'chat').text;
      const actions = document.createElement('div');
      actions.className = 'ai-model-actions';
      const test = document.createElement('button');
      test.className = 'ss-btn ss-btn-ghost';
      test.textContent = t('Test Connection');
      listenAiRender(test, 'click', async () => {
        const aiService = dependencies.getAiService();
        if (!aiService || disposed) return;
        test.disabled = true;
        status.dataset.state = 'testing';
        status.textContent = t('ai.status.testing');
        const result = await aiService.testModelConnection(model, 'chat');
        if (disposed) return;
        status.dataset.state = result.success ? 'ready' : 'error';
        status.textContent = result.success
          ? t('ai.status.connected')
          : t(result.code || 'ai.error.connectionFailed');
        test.disabled = false;
      });
      const edit = document.createElement('button');
      edit.className = 'ss-btn ss-btn-ghost';
      edit.textContent = t('Edit Model');
      listenAiRender(edit, 'click', () => editAiModel(model));
      actions.append(test, edit);
      if (!model.isPreset) {
        const remove = document.createElement('button');
        remove.className = 'ss-btn ss-btn-danger';
        remove.textContent = t('Delete model');
        listenAiRender(remove, 'click', async () => {
          const aiService = dependencies.getAiService();
          if (!aiService || disposed) return;
          await aiService.removeModel(model.id);
          if (!disposed) renderAiSettings();
        });
        actions.appendChild(remove);
      }
      card.append(header, facts, status, actions);
      list.appendChild(card);
    });
  }

  function createAiField(
    labelKey: string,
    value: unknown,
    options: SettingsAiFieldOptions = {}
  ): SettingsAiFieldResult {
    const label = document.createElement('label');
    label.className = 'ai-model-field';
    const caption = document.createElement('span');
    caption.textContent = t(labelKey);
    let input: HTMLInputElement | HTMLSelectElement;
    if (options.select) {
      input = document.createElement('select');
      options.select.forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = t(entry.label);
        option.selected = option.value === value;
        input.appendChild(option);
      });
    } else {
      input = document.createElement('input');
      if (options.type) input.type = options.type;
      if (options.readOnly) input.readOnly = true;
    }
    input.className = 'ss-input';
    input.value = stringValue(value);
    label.append(caption, input);
    return { root: label, input };
  }

  function removeOverlay(overlay: HTMLElement): void {
    activeOverlays.delete(overlay);
    overlay.remove();
  }

  function editAiModel(model?: SettingsAiModelDto | null): void {
    if (disposed) return;
    const overlay = document.createElement('div');
    activeOverlays.add(overlay);
    overlay.className = 'ai-editor-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = document.createElement('form');
    card.className = 'ai-editor-card';
    const title = document.createElement('h2');
    title.textContent = t(model ? 'Edit Model' : 'Add Custom Model');
    const locked = Boolean(model && model.isPreset);
    const name = createAiField('Model Name', model?.name, { readOnly: locked });
    const provider = createAiField('ai.provider', model?.provider || 'openai-compatible', {
      readOnly: locked
    });
    const chatEndpoint = createAiField('ai.chatEndpoint', model?.endpoint, { readOnly: locked });
    const chatModel = createAiField('ai.chatModelId', model?.modelId, { readOnly: locked });
    const inlineMode = createAiField('ai.inlineMode', model?.inlineMode || 'chat', {
      select: [
        { value: 'chat', label: 'ai.inlineMode.chat' },
        { value: 'fim', label: 'ai.inlineMode.fim' }
      ]
    });
    if (locked) inlineMode.input.disabled = true;
    const inlineEndpoint = createAiField('ai.inlineEndpoint', model?.inlineEndpoint, {
      readOnly: locked
    });
    const inlineModel = createAiField('ai.inlineModelId', model?.inlineModelId, {
      readOnly: locked
    });
    const key = createAiField('API Key', model?.apiKey, { type: 'password' });
    (key.input as HTMLInputElement).autocomplete = 'off';
    const message = document.createElement('div');
    message.className = 'ai-editor-message';
    message.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'ai-editor-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ss-btn ss-btn-ghost';
    cancel.textContent = t('Cancel');
    cancel.addEventListener('click', () => removeOverlay(overlay));
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'ss-btn ss-btn-primary';
    save.textContent = t('Save Changes');
    actions.append(cancel, save);
    card.append(
      title,
      name.root,
      provider.root,
      chatEndpoint.root,
      chatModel.root,
      inlineMode.root,
      inlineEndpoint.root,
      inlineModel.root,
      key.root,
      message,
      actions
    );
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!name.input.value.trim() || !chatEndpoint.input.value.trim() ||
          !chatModel.input.value.trim()) {
        message.textContent = t('ai.error.requiredFields');
        return;
      }
      const values = {
        id: model ? model.id : 'custom-' + Date.now(),
        name: name.input.value.trim(),
        provider: provider.input.value.trim(),
        endpoint: chatEndpoint.input.value.trim(),
        modelId: chatModel.input.value.trim(),
        apiKey: key.input.value.trim(),
        inlineMode: inlineMode.input.value,
        inlineEndpoint: inlineEndpoint.input.value.trim(),
        inlineModelId: inlineModel.input.value.trim(),
        isPreset: locked
      };
      const aiService = dependencies.getAiService();
      if (!aiService || disposed) return;
      if (model) await aiService.updateModel(model.id, values);
      else await aiService.addModel(values);
      if (disposed) return;
      removeOverlay(overlay);
      renderAiSettings();
    });
    overlay.appendChild(card);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) removeOverlay(overlay);
    });
    document.body.appendChild(overlay);
    name.input.focus();
  }

  function renderThemeChoices(): void {
    const list = document.getElementById('settings-theme-list');
    const themeManager = dependencies.getThemeManager();
    if (!list || !themeManager) return;
    const themes = themeManager.listThemes();
    const currentTheme = themeManager.getCurrentTheme();
    list.innerHTML = '';

    for (const theme of themes) {
      const row = document.createElement('label');
      row.className = 'theme-choice';
      row.setAttribute('data-theme-id', theme.id);

      const name = document.createElement('span');
      name.className = 'theme-choice-name';
      const i18n = dependencies.getI18n();
      if (i18n && typeof i18n.bindText === 'function') i18n.bindText(name, theme.label);
      else name.textContent = t(theme.label);

      const swatches = document.createElement('span');
      swatches.className = 'theme-choice-swatches';
      swatches.setAttribute('aria-hidden', 'true');
      for (const color of theme.colors) {
        const swatch = document.createElement('span');
        swatch.className = 'theme-choice-swatch';
        swatch.style.backgroundColor = color;
        swatches.appendChild(swatch);
      }

      const radio = document.createElement('input');
      radio.className = 'theme-choice-radio';
      radio.type = 'radio';
      radio.name = 'settings-theme';
      radio.value = theme.id;
      radio.checked = theme.id === currentTheme;
      if (i18n && typeof i18n.bindAttribute === 'function') {
        i18n.bindAttribute(radio, 'aria-label', theme.label);
      } else {
        radio.setAttribute('aria-label', t(theme.label));
      }

      row.appendChild(name);
      row.appendChild(swatches);
      row.appendChild(radio);
      list.appendChild(row);
    }
  }

  function loadLocalSettings(): void {
    renderThemeChoices();

    // Diagnostics
    const diagEnabled = document.getElementById('settings-diag-enabled') as HTMLInputElement | null;
    const diagMode = document.getElementById('settings-diag-mode') as HTMLSelectElement | null;
    const diagnosticsState = settingsRecord(
      state.diagnosticsSettings
    ) as SettingsDiagnosticsStateDto;
    if (diagEnabled) diagEnabled.checked = diagnosticsState.enabled !== false;
    if (diagMode) {
      diagMode.value = diagnosticsState.checkOn ? String(diagnosticsState.checkOn) : 'type';
    }
  }

  function open(tab?: SettingsTabDto): void {
    if (disposed) return;
    if (tab === 'ai') {
      dependencies.getAiSettingsCenter()?.open();
      return;
    }
    ensureDOM();
    if (!modal) return;
    modal.style.pointerEvents = '';
    previousFocus = document.activeElement as FocusableElement | null;
    serverPaneLoaded = false;
    loadLocalSettings();

    switchTab(tab || 'local');
    dependencies.getWorkbench()?.refreshControls();
    modal.style.display = 'flex';
    const selectedTab = modal.querySelector<HTMLElement>('.settings-tab.active');
    if (selectedTab) schedule(() => selectedTab.focus(), 30);
  }

  function openFirstRun(): boolean {
    if (disposed) return false;
    ensureDOM();
    if (!modal || !(state.serverSettings && state.serverSettings.firstRunRequired)) return false;
    firstRunOpen = true;
    modal.classList.add('server-first-run');
    const intro = document.getElementById('server-first-run-intro');
    const skip = document.getElementById('server-skip-first-run');
    if (intro) intro.hidden = false;
    if (skip) skip.hidden = false;
    try {
      open('server');
    } catch (error) {
      logger.error('Server setup guide could not open:', error);
      releaseBrokenFirstRunModal();
      return false;
    }
    verifyFirstRunModal();
    schedule(() => {
      const input = document.getElementById('server-ip') as HTMLInputElement | null;
      input?.focus();
    }, 40);
    return true;
  }

  function finishFirstRun(): void {
    if (disposed) return;
    finishFirstRunState();
  }

  function init(): void {
    ensureDOM();
  }

  function dispose(): void {
    if (disposed) return;
    // Disable callbacks first; cleanup below does not need to re-enter public methods.
    disposed = true;
    pendingTimers.forEach((timer) => hostWindow.clearTimeout(timer));
    pendingTimers.clear();
    aiRenderLifecycle.dispose();
    lifecycle.dispose();
    activeOverlays.forEach((overlay) => overlay.remove());
    activeOverlays.clear();
    dependencies.getRcloneSettings()?.close();
    finishFirstRunState();
    if (modal) {
      modal.style.display = 'none';
      modal.style.pointerEvents = '';
    }
    previousFocus = null;
    serverPaneLoaded = false;
    activeTab = 'local';
    modal = null;
  }

  const service: SettingsFacade & SettingsService = {
    get disposed(): boolean {
      return disposed;
    },
    init,
    open,
    close,
    openFirstRun,
    finishFirstRun,
    isFirstRunOpen: () => firstRunOpen,
    dispose
  };
  return Object.freeze(service);
}
