import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  DiagnosticsBasicSettingsUpdateDto,
  DiagnosticsCheckId,
  DiagnosticsCheckOn,
  DiagnosticsCheckSettings,
  DiagnosticsHost,
  DiagnosticsSettings,
  DiagnosticsSettingsService,
  DiagnosticsSettingsWriteDto,
  DiagnosticsSeverity
} from '../types/diagnostics';

interface DiagnosticsCatalogEntry {
  readonly id: DiagnosticsCheckId;
  readonly label: string;
  readonly desc: string;
  readonly hasLength?: boolean;
}

export const DIAGNOSTICS_CHECK_CATALOG = Object.freeze([
  { id: 'missingSemicolon', label: 'Missing semicolon', desc: 'Statements without a terminating ; (C / C++ / Java). Uses a real tokenizer, so for/if/while headers are not flagged.' },
  { id: 'strayTokens', label: 'Stray / unexpected tokens', desc: 'Invalid tokens at file scope (bare numbers, operators, unknown chars) and stray characters.' },
  { id: 'unmatchedBrackets', label: 'Unmatched brackets', desc: 'Mismatched or unclosed ( ) [ ] { }.' },
  { id: 'unclosedStrings', label: 'Unclosed strings', desc: 'String / char literals not closed on the same line.' },
  { id: 'assignmentInCondition', label: 'Assignment in condition', desc: '= used inside an if / while condition (likely meant ==).' },
  { id: 'unsafeFunctions', label: 'Unsafe functions', desc: 'gets(), scanf("%s") without field width, and similar.' },
  { id: 'trailingWhitespace', label: 'Trailing whitespace', desc: 'Spaces or tabs at the end of a line.' },
  { id: 'mixedIndent', label: 'Mixed tabs & spaces', desc: 'File mixes tab and space indentation.' },
  { id: 'longLines', label: 'Long lines', desc: 'Lines exceeding the length limit.', hasLength: true },
  { id: 'todoComments', label: 'TODO / FIXME / HACK', desc: 'Highlight task markers in comments.' },
  { id: 'cppModernize', label: 'C++ modernization', desc: 'NULL \u2192 nullptr, C-style casts \u2192 static_cast.' },
  { id: 'styleHints', label: 'Language style hints', desc: 'Python / Java / Rust / Go best-practice nits (bare except, unwrap, raw types...).' }
] satisfies readonly DiagnosticsCatalogEntry[]);

const SEVERITIES = Object.freeze([
  { value: 'error', label: 'Error', cls: 'err' },
  { value: 'warning', label: 'Warning', cls: 'warn' },
  { value: 'info', label: 'Info', cls: 'info' },
  { value: 'hint', label: 'Hint', cls: 'hint' }
] satisfies readonly { readonly value: DiagnosticsSeverity; readonly label: string; readonly cls: string }[]);

const VALID_CHECK_ON = new Set<DiagnosticsCheckOn>(['type', 'save']);
const VALID_SEVERITIES = new Set<DiagnosticsSeverity>(SEVERITIES.map((entry) => entry.value));

export interface DiagnosticsRendererState {
  diagnosticsSettings?: DiagnosticsSettings | null;
  _diagForm?: DiagnosticsForm | null;
  readonly [key: string]: unknown;
}

export interface DiagnosticsI18n {
  t(source: string): string;
  bindText?(element: Element, source: string): unknown;
  bindAttribute?(element: Element, attribute: string, source: string): unknown;
}

export interface DiagnosticsRuleRegistry {
  readonly DEFAULT_DIAGNOSTICS_SETTINGS: unknown;
  setDiagnosticsSettings(settings: DiagnosticsSettings): void;
}

export interface DiagnosticsEditorCore {
  recheckAll(): void;
}

export interface DiagnosticsToast {
  error(message: string): void;
}

export interface DiagnosticsSettingsDependencies {
  readonly host: DiagnosticsHost;
  readonly document: Document;
  readonly languageEvents: EventTarget;
  readonly getState: () => DiagnosticsRendererState;
  readonly getI18n: () => DiagnosticsI18n | null | undefined;
  readonly getRuleRegistry: () => DiagnosticsRuleRegistry | null | undefined;
  readonly getEditorCore: () => DiagnosticsEditorCore | null | undefined;
  readonly getToast?: () => DiagnosticsToast | null | undefined;
  readonly logger?: Pick<Console, 'error'>;
}

interface DiagnosticsForm {
  readonly enabled: HTMLInputElement;
  readonly checkOn: HTMLSelectElement;
  readonly debounceMs: HTMLInputElement;
  readonly lengthInputs: Partial<Record<DiagnosticsCheckId, HTMLInputElement>>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null;
}

function own(value: UnknownRecord | null, key: string): unknown {
  if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function validCheckOn(value: unknown, fallback: DiagnosticsCheckOn): DiagnosticsCheckOn {
  return typeof value === 'string' && VALID_CHECK_ON.has(value as DiagnosticsCheckOn)
    ? value as DiagnosticsCheckOn
    : fallback;
}

function validSeverity(value: unknown, fallback: DiagnosticsSeverity): DiagnosticsSeverity {
  return typeof value === 'string' && VALID_SEVERITIES.has(value as DiagnosticsSeverity)
    ? value as DiagnosticsSeverity
    : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function normalizeDiagnosticsSettings(value: unknown, defaults: unknown): DiagnosticsSettings {
  const source = record(value);
  const fallback = record(defaults);
  const fallbackCheckOn = validCheckOn(own(fallback, 'checkOn'), 'type');
  const fallbackDebounce = boundedNumber(own(fallback, 'debounceMs'), 300, 0, 5000);
  const sourceChecks = record(own(source, 'checks'));
  const fallbackChecks = record(own(fallback, 'checks'));
  const checks = {} as Record<DiagnosticsCheckId, DiagnosticsCheckSettings>;

  for (const catalogEntry of DIAGNOSTICS_CHECK_CATALOG) {
    const fallbackCheck = record(own(fallbackChecks, catalogEntry.id));
    const sourceCheck = record(own(sourceChecks, catalogEntry.id));
    const fallbackSeverity = validSeverity(own(fallbackCheck, 'severity'), 'warning');
    const check: {
      enabled: boolean;
      severity: DiagnosticsSeverity;
      maxLineLength?: number;
    } = {
      enabled: typeof own(sourceCheck, 'enabled') === 'boolean'
        ? own(sourceCheck, 'enabled') as boolean
        : (typeof own(fallbackCheck, 'enabled') === 'boolean' ? own(fallbackCheck, 'enabled') as boolean : true),
      severity: validSeverity(own(sourceCheck, 'severity'), fallbackSeverity)
    };
    const sourceLength = own(sourceCheck, 'maxLineLength');
    const fallbackLength = own(fallbackCheck, 'maxLineLength');
    if (sourceLength !== undefined || fallbackLength !== undefined || catalogEntry.hasLength) {
      check.maxLineLength = boundedNumber(
        sourceLength,
        boundedNumber(fallbackLength, 120, 20, 1000),
        20,
        1000
      );
    }
    checks[catalogEntry.id] = Object.freeze(check);
  }

  return Object.freeze({
    enabled: typeof own(source, 'enabled') === 'boolean'
      ? own(source, 'enabled') as boolean
      : (typeof own(fallback, 'enabled') === 'boolean' ? own(fallback, 'enabled') as boolean : true),
    checkOn: validCheckOn(own(source, 'checkOn'), fallbackCheckOn),
    debounceMs: boundedNumber(own(source, 'debounceMs'), fallbackDebounce, 0, 5000),
    checks: Object.freeze(checks)
  });
}

export function createDiagnosticsSettings(
  dependencies: DiagnosticsSettingsDependencies
): DiagnosticsSettingsService {
  const {
    host,
    document,
    languageEvents,
    getState,
    getI18n,
    getRuleRegistry,
    getEditorCore,
    getToast = () => undefined,
    logger = console
  } = dependencies;
  const lifecycle = new DisposableStore();
  const renderLifecycle = new DisposableStore();
  let form: DiagnosticsForm | null = null;
  let initialized = false;
  let disposed = false;
  let persistRequestEpoch = 0;
  let openEpoch = 0;
  let ioTail: Promise<void> = Promise.resolve();
  let stateSettlementTail: Promise<void> = Promise.resolve();
  let unsettledStateOperations = 0;
  let loadInFlight: Promise<boolean> | null = null;
  let persistedSnapshot: DiagnosticsSettings | null = null;
  let deferredLoadedSnapshot: {
    readonly settings: DiagnosticsSettings;
    throughEpoch: number;
  } | null = null;

  function enqueueIo<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = ioTail.then(operation, operation);
    ioTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function trackStateSettlement<Result>(operation: Promise<Result>): Promise<Result> {
    unsettledStateOperations += 1;
    const settled = operation.then(
      () => { unsettledStateOperations -= 1; },
      () => { unsettledStateOperations -= 1; }
    );
    const previous = stateSettlementTail;
    stateSettlementTail = Promise.all([previous, settled]).then(() => undefined);
    return operation;
  }

  async function waitForStateSettlement(): Promise<void> {
    let pending = stateSettlementTail;
    while (unsettledStateOperations > 0) {
      await pending;
      if (pending === stateSettlementTail) return;
      pending = stateSettlementTail;
    }
  }

  function state(): DiagnosticsRendererState {
    return getState();
  }

  function t(source: string): string {
    return getI18n()?.t(source) ?? source;
  }

  function bindText(element: Element | null, source: string): void {
    if (!element) return;
    const i18n = getI18n();
    if (i18n?.bindText) i18n.bindText(element, source);
    else element.textContent = t(source);
  }

  function bindAttribute(element: Element | null, attribute: string, source: string): void {
    if (!element) return;
    const i18n = getI18n();
    if (i18n?.bindAttribute) i18n.bindAttribute(element, attribute, source);
    else element.setAttribute(attribute, t(source));
  }

  function defaultSettings(): DiagnosticsSettings {
    return normalizeDiagnosticsSettings(undefined, getRuleRegistry()?.DEFAULT_DIAGNOSTICS_SETTINGS);
  }

  function currentSettings(): DiagnosticsSettings {
    return normalizeDiagnosticsSettings(state().diagnosticsSettings, defaultSettings());
  }

  function applySettings(settings: DiagnosticsSettings): void {
    state().diagnosticsSettings = settings;
    getRuleRegistry()?.setDiagnosticsSettings(settings);
    getEditorCore()?.recheckAll();
  }

  function notifySaveFailed(): void {
    getToast()?.error(t('Failed to save diagnostics settings'));
  }

  function applyDeferredLoadIfSettled(requestEpoch: number): void {
    if (disposed || !deferredLoadedSnapshot || requestEpoch < deferredLoadedSnapshot.throughEpoch) return;
    const loaded = deferredLoadedSnapshot.settings;
    deferredLoadedSnapshot = null;
    applySettings(loaded);
  }

  function element<TagName extends keyof HTMLElementTagNameMap>(
    tagName: TagName,
    className?: string
  ): HTMLElementTagNameMap[TagName] {
    const created = document.createElement(tagName);
    if (className) created.className = className;
    return created;
  }

  function makeToggle(checked: boolean): { wrap: HTMLLabelElement; input: HTMLInputElement } {
    const label = element('label', 'diag-toggle');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    label.append(input, element('span', 'slider'));
    return { wrap: label, input };
  }

  function severityClass(value: string): string {
    return SEVERITIES.find((entry) => entry.value === value)?.cls ?? 'warn';
  }

  function makeSeverity(value: DiagnosticsSeverity): HTMLSelectElement {
    const select = element('select', 'diag-sev-select');
    for (const severity of SEVERITIES) {
      const option = element('option');
      option.value = severity.value;
      option.textContent = t(severity.label);
      option.selected = severity.value === value;
      select.appendChild(option);
    }
    select.value = value;
    select.className = 'diag-sev-select ' + severityClass(value);
    const onChange = () => {
      select.className = 'diag-sev-select ' + severityClass(select.value);
    };
    select.addEventListener('change', onChange);
    renderLifecycle.add(toDisposable(() => select.removeEventListener('change', onChange)));
    return select;
  }

  function render(draftSettings?: unknown): void {
    renderLifecycle.clear();
    const body = document.getElementById('diag-body');
    if (!body) return;
    body.innerHTML = '';

    const settings = normalizeDiagnosticsSettings(
      draftSettings === undefined ? state().diagnosticsSettings : draftSettings,
      defaultSettings()
    );
    const generalSection = element('div');
    const generalLabel = element('div', 'ss-section-label');
    generalLabel.textContent = t('General');
    generalSection.appendChild(generalLabel);

    const enabledRow = element('div', 'diag-global-row');
    const enabledToggle = makeToggle(settings.enabled);
    const enabledLabel = element('span', 'diag-label');
    enabledLabel.textContent = t('Enable diagnostics');
    enabledLabel.style.flex = '1';
    enabledRow.append(enabledLabel, enabledToggle.wrap);
    generalSection.appendChild(enabledRow);

    const checkOnRow = element('div', 'diag-global-row');
    const checkOnLabel = element('span', 'diag-label');
    checkOnLabel.textContent = t('Check on');
    checkOnLabel.style.flex = '1';
    const checkOnSelect = element('select', 'ss-input');
    checkOnSelect.style.width = 'auto';
    for (const [value, label] of [
      ['type', 'While typing (debounced)'],
      ['save', 'On save only']
    ] as const) {
      const option = element('option');
      option.value = value;
      option.textContent = t(label);
      option.selected = value === settings.checkOn;
      checkOnSelect.appendChild(option);
    }
    checkOnSelect.value = settings.checkOn;
    checkOnRow.append(checkOnLabel, checkOnSelect);
    generalSection.appendChild(checkOnRow);

    const debounceRow = element('div', 'diag-global-row');
    const debounceLabel = element('span', 'diag-label');
    debounceLabel.textContent = t('Debounce (ms)');
    debounceLabel.style.flex = '1';
    const debounceInput = element('input', 'ss-input');
    debounceInput.type = 'number';
    debounceInput.min = '0';
    debounceInput.max = '5000';
    debounceInput.step = '50';
    debounceInput.value = String(settings.debounceMs);
    debounceRow.append(debounceLabel, debounceInput);
    generalSection.appendChild(debounceRow);
    body.appendChild(generalSection);

    const checksSection = element('div');
    const checksLabel = element('div', 'ss-section-label');
    checksLabel.textContent = t('Checks');
    checksSection.appendChild(checksLabel);
    const lengthInputs: Partial<Record<DiagnosticsCheckId, HTMLInputElement>> = {};

    for (const catalogEntry of DIAGNOSTICS_CHECK_CATALOG) {
      const check = settings.checks[catalogEntry.id];
      const row = element('div', 'diag-row');
      const left = element('div');
      left.style.flex = '1';
      const label = element('span', 'diag-label');
      label.textContent = t(catalogEntry.label);
      left.appendChild(label);
      const description = element('span', 'diag-desc');
      description.textContent = t(catalogEntry.desc);
      left.appendChild(description);
      row.appendChild(left);

      if (catalogEntry.hasLength) {
        const lengthInput = element('input', 'ss-input');
        lengthInput.type = 'number';
        lengthInput.min = '20';
        lengthInput.max = '1000';
        lengthInput.value = String(check.maxLineLength ?? 120);
        lengthInput.style.width = '80px';
        lengthInput.title = t('Max line length');
        lengthInputs[catalogEntry.id] = lengthInput;
        row.appendChild(lengthInput);
      }

      const severity = makeSeverity(check.severity);
      severity.dataset.checkId = catalogEntry.id;
      row.appendChild(severity);
      const toggle = makeToggle(check.enabled);
      toggle.input.dataset.checkId = catalogEntry.id;
      row.appendChild(toggle.wrap);
      checksSection.appendChild(row);
    }

    body.appendChild(checksSection);
    form = {
      enabled: enabledToggle.input,
      checkOn: checkOnSelect,
      debounceMs: debounceInput,
      lengthInputs
    };
    state()._diagForm = form;
  }

  function collect(): DiagnosticsSettings | null {
    if (!form) return null;
    let debounceMs = Number.parseInt(form.debounceMs.value, 10);
    if (!Number.isFinite(debounceMs)) debounceMs = 300;
    const base = currentSettings();
    const draftChecks: Partial<Record<DiagnosticsCheckId, DiagnosticsCheckSettings>> = {};
    const severityById = new Map<DiagnosticsCheckId, string>();
    document.querySelectorAll<HTMLSelectElement>('.diag-sev-select[data-check-id]').forEach((select) => {
      severityById.set(select.dataset.checkId as DiagnosticsCheckId, select.value);
    });
    document.querySelectorAll<HTMLInputElement>('.diag-toggle input[data-check-id]').forEach((checkbox) => {
      const id = checkbox.dataset.checkId as DiagnosticsCheckId;
      const previous = base.checks[id];
      const next: {
        enabled: boolean;
        severity: DiagnosticsSeverity;
        maxLineLength?: number;
      } = {
        enabled: checkbox.checked,
        severity: validSeverity(severityById.get(id), previous.severity)
      };
      if (previous.maxLineLength !== undefined) next.maxLineLength = previous.maxLineLength;
      const lengthInput = form?.lengthInputs[id];
      if (lengthInput) {
        const parsed = Number.parseInt(lengthInput.value, 10);
        next.maxLineLength = Number.isFinite(parsed) ? parsed : 120;
      }
      draftChecks[id] = next;
    });
    return normalizeDiagnosticsSettings({
      enabled: form.enabled.checked,
      checkOn: form.checkOn.value,
      debounceMs,
      checks: draftChecks
    }, base);
  }

  function showModal(): void {
    render();
    const modal = document.getElementById('diag-modal');
    if (modal) modal.style.display = 'flex';
  }

  function open(): void {
    if (disposed) return;
    const requestEpoch = ++openEpoch;
    if (unsettledStateOperations === 0) {
      showModal();
      return;
    }
    void waitForStateSettlement().then(() => {
      if (!disposed && requestEpoch === openEpoch) showModal();
    });
  }

  function close(): void {
    openEpoch += 1;
    const modal = document.getElementById('diag-modal');
    if (modal) modal.style.display = 'none';
  }

  function load(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (loadInFlight) return loadInFlight;
    const persistEpochAtStart = persistRequestEpoch;
    const pending = (async () => {
      try {
        const loaded = await enqueueIo(() => disposed
          ? Promise.resolve(null)
          : host.readSettings());
        if (disposed) return false;
        const normalized = normalizeDiagnosticsSettings(loaded, defaultSettings());
        persistedSnapshot = normalized;
        if (persistEpochAtStart !== persistRequestEpoch) {
          deferredLoadedSnapshot = {
            settings: normalized,
            throughEpoch: persistRequestEpoch
          };
          return false;
        }
        deferredLoadedSnapshot = null;
        applySettings(normalized);
        return true;
      } catch (error) {
        if (!disposed) logger.error('Load diagnostics settings:', error);
        return false;
      }
    })();
    let tracked: Promise<boolean>;
    tracked = pending.finally(() => {
      if (loadInFlight === tracked) loadInFlight = null;
    });
    loadInFlight = tracked;
    return trackStateSettlement(tracked);
  }

  function persist(settings: DiagnosticsSettingsWriteDto): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const requestEpoch = ++persistRequestEpoch;
    if (deferredLoadedSnapshot) deferredLoadedSnapshot.throughEpoch = requestEpoch;
    const pending = (async () => {
      let normalized: DiagnosticsSettings | null = null;
      try {
        const saved = await enqueueIo(async () => {
          if (disposed) return false;
          normalized = normalizeDiagnosticsSettings(
            settings,
            persistedSnapshot ?? currentSettings()
          );
          const confirmed = await host.writeSettings(normalized);
          if (confirmed === true) persistedSnapshot = normalized;
          return confirmed;
        });
        if (saved !== true || !normalized || disposed) {
          applyDeferredLoadIfSettled(requestEpoch);
          return false;
        }
        deferredLoadedSnapshot = null;
        applySettings(normalized);
        return true;
      } catch (error) {
        logger.error('diagnostics save failed:', error);
        applyDeferredLoadIfSettled(requestEpoch);
        return false;
      }
    })();
    return trackStateSettlement(pending);
  }

  async function updateBasic(update: DiagnosticsBasicSettingsUpdateDto): Promise<boolean> {
    const saved = await persist(update);
    if (!saved) notifySaveFailed();
    return saved;
  }

  async function save(): Promise<void> {
    const settings = collect();
    if (!settings) {
      close();
      return;
    }
    if (await persist(settings)) close();
    else notifySaveFailed();
  }

  function resetDefaults(): void {
    if (disposed) return;
    render(defaultSettings());
  }

  function bindStaticText(): void {
    bindText(document.querySelector('#diag-modal .ss-title'), 'Diagnostics Settings');
    bindText(document.getElementById('diag-reset'), 'Reset to Defaults');
    bindText(document.getElementById('diag-close'), 'Cancel');
    bindText(document.getElementById('diag-save'), 'Save & Re-check');
    bindAttribute(document.getElementById('diag-close-x'), 'title', 'Close');
  }

  function addListener(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function init(): void {
    if (initialized || disposed) return;
    initialized = true;
    bindStaticText();
    const saveButton = document.getElementById('diag-save');
    const cancelButton = document.getElementById('diag-close');
    const closeButton = document.getElementById('diag-close-x');
    const resetButton = document.getElementById('diag-reset');
    const modal = document.getElementById('diag-modal');
    if (saveButton) addListener(saveButton, 'click', () => { void save(); });
    if (cancelButton) addListener(cancelButton, 'click', close);
    if (closeButton) addListener(closeButton, 'click', close);
    if (resetButton) addListener(resetButton, 'click', resetDefaults);
    if (modal) addListener(modal, 'click', (event) => {
      if (event.target === modal) close();
    });
    lifecycle.add(host.onOpen(open));
    addListener(languageEvents, 'bobo:language-changed', () => {
      bindStaticText();
      const currentModal = document.getElementById('diag-modal');
      if (currentModal?.style.display === 'flex') render(collect());
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    persistRequestEpoch += 1;
    deferredLoadedSnapshot = null;
    close();
    lifecycle.dispose();
    renderLifecycle.dispose();
    const body = document.getElementById('diag-body');
    if (body) body.innerHTML = '';
    form = null;
    state()._diagForm = null;
  }

  return { init, open, close, load, persist, updateBasic, dispose };
}
