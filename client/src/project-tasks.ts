import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  ProjectTaskConfigurationDto,
  ProjectTaskDto,
  ProjectTaskEditorContext,
  ProjectTaskInputRequestDto,
  ProjectTaskInputValues,
  ProjectTaskResolveRequestDto,
  ProjectTaskResolveResultDto,
  ProjectTaskSelection,
  ProjectTaskWarningDto,
  ProjectTasksHost,
  ProjectTasksRunnerPort,
  ProjectTasksService
} from '../types/project-tasks';

export interface ProjectTasksEditorSelection {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly [key: string]: unknown;
}

export interface ProjectTasksEditorModel {
  getLanguageId?(): string;
  getValueInRange?(selection: ProjectTasksEditorSelection): string;
}

export interface ProjectTasksEditor {
  getModel?(): ProjectTasksEditorModel | null;
  getSelection?(): ProjectTasksEditorSelection | null;
}

export interface ProjectTasksRendererState {
  workspaceRoot?: string;
  workspaceIdentity?: unknown;
  selectedRuntime?: unknown;
  activeTabPath?: string;
  editor?: ProjectTasksEditor | null;
  readonly [key: string]: unknown;
}

type TranslationValues = Readonly<Record<string, string | number>>;

export interface ProjectTasksI18n {
  t(source: string, replacements?: TranslationValues): string;
  bindText?(element: Element, source: string, replacements?: TranslationValues): unknown;
  bindAttribute?(
    element: Element,
    attribute: string,
    source: string,
    replacements?: TranslationValues
  ): unknown;
  onChange?(listener: () => void): Disposable | (() => void) | undefined;
}

export interface ProjectTasksFeatureDecision {
  readonly available: boolean;
  readonly state?: string;
  readonly reason?: string;
}

export interface ProjectTasksCloudFeaturePolicy {
  evaluate(feature: 'run' | 'tasks'): ProjectTasksFeatureDecision;
}

export interface ProjectTasksDependencies {
  readonly host: ProjectTasksHost;
  readonly document: Document;
  readonly window: Window;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly getState: () => ProjectTasksRendererState;
  readonly getI18n: () => ProjectTasksI18n | null | undefined;
  readonly getCloudFeaturePolicy: () => ProjectTasksCloudFeaturePolicy | null | undefined;
  readonly getRunner: () => ProjectTasksRunnerPort | null | undefined;
  readonly updateRunOutput: (message: string) => void;
}

interface TaskInputDialog {
  readonly overlay: HTMLDivElement;
  readonly card: HTMLFormElement;
  readonly title: HTMLHeadingElement;
  readonly description: HTMLLabelElement;
  readonly fieldHost: HTMLDivElement;
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
  control: HTMLInputElement | HTMLSelectElement | null;
  previousFocus: HTMLElement | null;
}

interface ActiveTaskInput {
  readonly resolve: (result: TaskInputResult) => void;
  readonly rootPath: string;
  readonly workspaceIdentity: unknown;
}

interface TaskInputResult {
  readonly cancelled: boolean;
  readonly value: string | null;
  readonly rootPath: string;
  readonly workspaceIdentity: unknown;
}

const EMPTY_CONFIGURATION: ProjectTaskConfigurationDto = Object.freeze({
  version: '2.0.0',
  workspaceRoot: '',
  tasks: Object.freeze([]),
  inputs: Object.freeze([]),
  warnings: Object.freeze([]),
  sources: Object.freeze([])
});

const KNOWN_WARNING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  TASKS_JSON_PARSE_ERROR: 'Task file could not be parsed at {path}:{line}:{column} ({reason}).',
  TASKS_INVALID_ROOT: 'Task file must contain a JSON object: {path}',
  TASKS_VERSION_UNSUPPORTED: 'Task file {path} uses version {version}; only 2.0.0 can run.',
  TASKS_ARRAY_MISSING: 'Task file must define a tasks array: {path}',
  TASK_INPUT_DEFINITION_INVALID: 'Task input "{input}" is invalid in {path}.',
  TASK_INPUT_TYPE_UNSUPPORTED: 'Task input "{input}" uses unsupported type "{type}" in {path}.',
  TASK_INPUT_COMMAND_NOT_ALLOWED: 'Task input "{input}" uses command "{command}", which is not an allowed built-in command.',
  TASK_INPUT_DUPLICATE: 'Task input "{input}" is defined more than once in {path}.',
  TASK_INPUT_CONFLICT: 'Task input "{input}" from {sourcePath} overrides the input from {overriddenSourcePath}.',
  TASK_INPUT_UNAVAILABLE: 'Task "{task}" references unavailable input "{input}".',
  TASK_COMMAND_NOT_ALLOWED: 'Task "{task}" references command "{command}", which is not an allowed built-in command.',
  TASK_CONFIG_NOT_ALLOWED: 'Task "{task}" references setting "{setting}", which is outside the imported settings whitelist.',
  TASK_LABEL_MISSING: 'Task #{index} has no label in {path}.',
  TASK_TYPE_UNSUPPORTED: 'Task "{task}" uses unsupported type "{type}". Only shell and process can run.',
  TASK_BACKGROUND_UNSUPPORTED: 'Task "{task}" is a background task, which is not supported yet.',
  TASK_DEPENDS_ORDER_UNSUPPORTED: 'Task "{task}" uses unsupported dependency order "{order}".',
  TASK_COMMAND_MISSING: 'Task "{task}" has neither a command nor a dependency.',
  TASK_PRESENTATION_VALUE_INVALID: 'Task "{task}" has an invalid {field} value; the default output behavior is used.',
  TASK_PRESENTATION_FIELD_UNSUPPORTED: 'Task "{task}" uses {field}, which the shared cloud output panel cannot represent.',
  TASK_RUN_ON_MANUAL_ONLY: 'Task "{task}" requests folder-open execution, but BOBOCLOUD only runs workspace tasks explicitly.',
  TASK_RUN_OPTION_UNSUPPORTED: 'Task "{task}" uses unsupported run option {field}.',
  TASK_PLATFORM_CLOUD_LINUX: 'Task "{task}" keeps Windows and macOS overrides, but cloud execution uses the Linux override.',
  TASK_LABEL_CONFLICT: 'Task "{task}" from {sourcePath} overrides the task from {overriddenSourcePath}.',
  TASKS_LOAD_FAILED: 'Task configuration could not be loaded.'
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isDisposable(value: unknown): value is Disposable {
  return value !== null && typeof value === 'object' &&
    typeof (value as { dispose?: unknown }).dispose === 'function';
}

function comparableWorkspaceRoot(value: unknown): string {
  const slashNormalized = String(value || '').replace(/\\/g, '/');
  let normalized = slashNormalized.replace(/\/+$/, '');
  if (!normalized && slashNormalized.startsWith('//')) normalized = '//';
  else if (!normalized && slashNormalized.startsWith('/')) normalized = '/';
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function sameWorkspaceRoot(left: unknown, right: unknown): boolean {
  return comparableWorkspaceRoot(left) === comparableWorkspaceRoot(right);
}

export function createProjectTasks(dependencies: ProjectTasksDependencies): ProjectTasksService {
  const {
    host,
    document,
    window: rendererWindow,
    storage,
    getState,
    getI18n,
    getCloudFeaturePolicy,
    getRunner,
    updateRunOutput
  } = dependencies;

  let lifecycle = new DisposableStore();
  let dialogLifecycle: DisposableStore | null = null;
  let initialized = false;
  let disposed = false;
  let lifecycleEpoch = 0;
  let refreshContextEpoch = 0;
  let refreshGeneration = 0;
  let refreshQueued = false;
  let refreshFlight: Promise<ProjectTaskConfigurationDto> | null = null;
  let configuration = EMPTY_CONFIGURATION;
  let selected: ProjectTaskSelection = { type: 'file', label: '' };
  let taskInputDialog: TaskInputDialog | null = null;
  let activeTaskInput: ActiveTaskInput | null = null;
  let workspaceRefreshTimer: Disposable | null = null;
  let configurationRefreshTimer: Disposable | null = null;
  let inputFocusTimer: Disposable | null = null;

  function state(): ProjectTasksRendererState {
    return getState();
  }

  function tr(source: string, replacements?: TranslationValues): string {
    const i18n = getI18n();
    if (i18n?.t) return i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => {
      const replacement = replacements?.[key];
      return replacement === undefined ? match : String(replacement);
    });
  }

  function bindText(element: Element, source: string, replacements?: TranslationValues): void {
    const i18n = getI18n();
    if (i18n?.bindText) i18n.bindText(element, source, replacements);
    else element.textContent = tr(source, replacements);
  }

  function bindAttribute(
    element: Element,
    attribute: string,
    source: string,
    replacements?: TranslationValues
  ): void {
    const i18n = getI18n();
    if (i18n?.bindAttribute) i18n.bindAttribute(element, attribute, source, replacements);
    else element.setAttribute(attribute, tr(source, replacements));
  }

  function featureDecision(type: ProjectTaskSelection['type']): ProjectTasksFeatureDecision {
    const policy = getCloudFeaturePolicy();
    return policy?.evaluate(type === 'task' ? 'tasks' : 'run') ?? {
      available: false,
      state: 'unknown',
      reason: 'policy_unavailable'
    };
  }

  function unavailableText(type: ProjectTaskSelection['type']): string {
    return type === 'task'
      ? tr('Cloud tasks are unavailable on this server.')
      : tr('Cloud run is unavailable on this server.');
  }

  function selectionStorageKey(): string {
    return 'bobocloud.runTarget.' + String(state().workspaceRoot || '_global');
  }

  function loadSelection(): void {
    try {
      const value = JSON.parse(storage.getItem(selectionStorageKey()) || 'null') as unknown;
      if (value !== null && typeof value === 'object') {
        const candidate = value as { type?: unknown; label?: unknown };
        if ((candidate.type === 'file' || candidate.type === 'task') && typeof candidate.label === 'string') {
          selected = { type: candidate.type, label: candidate.label };
        } else {
          selected = { type: 'file', label: '' };
        }
      } else {
        selected = { type: 'file', label: '' };
      }
    } catch {
      selected = { type: 'file', label: '' };
    }
    if (selected.type === 'task' && !configuration.tasks.some((task) => task.label === selected.label)) {
      selected = { type: 'file', label: '' };
    }
  }

  function saveSelection(): void {
    try {
      storage.setItem(selectionStorageKey(), JSON.stringify(selected));
    } catch {
      // Storage may be unavailable in restricted renderer contexts.
    }
  }

  function warningPath(item: ProjectTaskWarningDto, property: 'path' | 'sourcePath' | 'overriddenSourcePath' = 'path'): string {
    const filePath = String(item[property] || '');
    const root = String(state().workspaceRoot || '');
    if (root && filePath.toLowerCase().startsWith(root.toLowerCase())) {
      return filePath.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    }
    return filePath || (item.source === 'bobocloud' ? '.bobocloud/tasks.json' : '.vscode/tasks.json');
  }

  function warningText(item: ProjectTaskWarningDto): string {
    const values: TranslationValues = {
      path: warningPath(item),
      sourcePath: warningPath(item, 'sourcePath'),
      overriddenSourcePath: warningPath(item, 'overriddenSourcePath'),
      line: item.line || 0,
      column: item.column || 0,
      reason: item.reason || item.code || '',
      version: item.version || '',
      index: Number(item.taskIndex || 0) + 1,
      task: item.task || '',
      type: item.taskType || item.inputType || '',
      input: item.inputId || '',
      command: item.command || '',
      setting: item.configKey || '',
      order: item.dependsOrder || '',
      field: item.field || ''
    };
    const source = KNOWN_WARNING_TEXT[item.code];
    return source ? tr(source, values) : String(item.message || item.code || tr('Unknown task configuration warning'));
  }

  function updatePrimaryButton(): void {
    const button = document.getElementById('run-code');
    if (!button) return;
    const target = selected.type === 'task' ? selected.label : tr('Current File');
    const targetFeature = featureDecision(selected.type);
    bindAttribute(button, 'title', 'Run {target}', { target });
    bindAttribute(button, 'aria-label', 'Run {target}', { target });
    button.dataset.runTargetType = selected.type;
    button.dataset.runTargetLabel = selected.label || '';
    if (!targetFeature.available) {
      button.title = unavailableText(selected.type);
      button.setAttribute('aria-label', button.title);
    }
    const configButton = document.getElementById('run-config-btn');
    if (configButton) {
      const configTitle = selected.type === 'task'
        ? tr('Run configuration is only available for Current File')
        : tr('Run configuration');
      configButton.setAttribute('title', configTitle);
      configButton.setAttribute('aria-label', configTitle);
    }
    getRunner()?.refreshControls();
  }

  const onOutsidePointer: EventListener = (event) => {
    const menu = document.getElementById('run-target-menu');
    const button = document.getElementById('run-target-btn');
    const target = event.target as Node | null;
    if (menu && target && !menu.contains(target) && button && !button.contains(target)) closeMenu();
  };
  const onMenuContextChanged: EventListener = () => closeMenu();

  function closeMenu(options?: { readonly restoreFocus?: boolean }): void {
    const menu = document.getElementById('run-target-menu');
    const button = document.getElementById('run-target-btn');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('contextmenu', onOutsidePointer, true);
    document.removeEventListener('scroll', onMenuContextChanged, true);
    rendererWindow.removeEventListener('resize', onMenuContextChanged);
    rendererWindow.removeEventListener('blur', onMenuContextChanged);
    if (options?.restoreFocus && button) button.focus();
  }

  function createMenuItem(task: ProjectTaskDto | null): HTMLButtonElement {
    const isFile = task === null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-target-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(
      isFile ? selected.type === 'file' : selected.type === 'task' && selected.label === task.label
    ));
    const itemType: ProjectTaskSelection['type'] = isFile ? 'file' : 'task';
    const itemFeature = featureDecision(itemType);
    button.disabled = !itemFeature.available || Boolean(task && !task.executable);
    if (!itemFeature.available) button.title = unavailableText(itemType);
    else if (task?.warnings.length) button.title = task.warnings.map(warningText).join('\n');

    const check = document.createElement('span');
    check.className = 'run-target-check';
    check.textContent = button.getAttribute('aria-checked') === 'true' ? '\u2713' : '';
    const label = document.createElement('span');
    label.className = 'run-target-label';
    if (isFile) bindText(label, 'Current File');
    else label.textContent = task.label;
    const source = document.createElement('span');
    source.className = 'run-target-source';
    source.textContent = isFile ? 'F5' : (task.source === 'bobocloud' ? 'BOBO' : 'VS Code');
    button.append(check, label, source);
    button.addEventListener('click', () => {
      selected = isFile ? { type: 'file', label: '' } : { type: 'task', label: task.label };
      saveSelection();
      updatePrimaryButton();
      closeMenu({ restoreFocus: true });
    });
    return button;
  }

  function appendSection(menu: HTMLElement, title: string, tasks: readonly (ProjectTaskDto | null)[]): void {
    if (tasks.length === 0) return;
    const heading = document.createElement('div');
    heading.className = 'run-target-section';
    bindText(heading, title);
    menu.appendChild(heading);
    tasks.forEach((task) => menu.appendChild(createMenuItem(task)));
  }

  function createRerunMenuItem(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-target-item run-target-command';
    button.setAttribute('role', 'menuitem');
    const taskFeature = featureDecision('task');
    const runner = getRunner();
    const canRerun = Boolean(runner?.canRerunLastProjectTask());
    button.disabled = !taskFeature.available || !canRerun;
    if (!taskFeature.available) button.title = unavailableText('task');
    else if (!canRerun) button.title = tr('No project task is available to rerun in this workspace.');

    const icon = document.createElement('span');
    icon.className = 'run-target-check run-target-command-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u21BB';
    const label = document.createElement('span');
    label.className = 'run-target-label';
    bindText(label, 'Rerun Last Task');
    button.append(icon, label);
    button.addEventListener('click', () => {
      closeMenu({ restoreFocus: true });
      void rerunLast();
    });
    return button;
  }

  function renderMenu(): void {
    const menu = document.getElementById('run-target-menu');
    if (!menu) return;
    menu.replaceChildren();
    appendSection(menu, 'Single File', [null]);
    const visibleTasks = configuration.tasks.filter((task) => !task.hide);
    const sections = Object.freeze([
      ['build', 'Build Tasks'],
      ['test', 'Test Tasks'],
      ['run', 'Run Tasks'],
      ['custom', 'Custom Tasks']
    ] as const);
    sections.forEach(([kind, title]) => {
      appendSection(menu, title, visibleTasks.filter((task) => task.kind === kind));
    });
    if (visibleTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'run-target-empty';
      bindText(empty, 'No project tasks found');
      menu.appendChild(empty);
    }
    if (configuration.warnings.length > 0) {
      const warning = document.createElement('div');
      warning.className = 'run-target-warning';
      bindText(warning, '{count} task configuration warning(s)', { count: configuration.warnings.length });
      warning.title = configuration.warnings.map(warningText).join('\n');
      menu.appendChild(warning);
    }
    const divider = document.createElement('div');
    divider.className = 'run-target-divider';
    divider.setAttribute('role', 'separator');
    menu.append(divider, createRerunMenuItem());
  }

  function positionMenu(): void {
    const menu = document.getElementById('run-target-menu');
    const button = document.getElementById('run-target-btn');
    if (!menu || !button) return;
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, rendererWindow.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > rendererWindow.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function openMenu(): void {
    renderMenu();
    positionMenu();
    const button = document.getElementById('run-target-btn');
    if (button) button.setAttribute('aria-expanded', 'true');
    document.querySelector<HTMLElement>('#run-target-menu .run-target-item:not(:disabled)')?.focus();
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('contextmenu', onOutsidePointer, true);
    document.addEventListener('scroll', onMenuContextChanged, true);
    rendererWindow.addEventListener('resize', onMenuContextChanged);
    rendererWindow.addEventListener('blur', onMenuContextChanged);
  }

  function clearTimer(timer: Disposable | null): null {
    if (timer) {
      timer.dispose();
      lifecycle.delete(timer);
    }
    return null;
  }

  function schedule(callback: () => void, delay: number): Disposable {
    let disposable: Disposable;
    const handle = rendererWindow.setTimeout(() => {
      lifecycle.delete(disposable);
      callback();
    }, delay);
    disposable = toDisposable(() => rendererWindow.clearTimeout(handle));
    lifecycle.add(disposable);
    return disposable;
  }

  function finishTaskInput(cancelled: boolean): void {
    if (!taskInputDialog || !activeTaskInput) return;
    inputFocusTimer = clearTimer(inputFocusTimer);
    const pending = activeTaskInput;
    activeTaskInput = null;
    taskInputDialog.overlay.classList.remove('open');
    taskInputDialog.overlay.setAttribute('aria-hidden', 'true');
    const value = cancelled ? null : String(taskInputDialog.control?.value || '');
    if (taskInputDialog.control) taskInputDialog.control.value = '';
    taskInputDialog.fieldHost.replaceChildren();
    taskInputDialog.control = null;
    taskInputDialog.previousFocus?.focus();
    taskInputDialog.previousFocus = null;
    pending.resolve({
      cancelled,
      value,
      rootPath: pending.rootPath,
      workspaceIdentity: pending.workspaceIdentity
    });
  }

  function addDialogListener(target: EventTarget, type: string, listener: EventListener): void {
    if (!dialogLifecycle) return;
    target.addEventListener(type, listener);
    dialogLifecycle.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function ensureTaskInputDialog(): TaskInputDialog {
    if (taskInputDialog) return taskInputDialog;
    const overlay = document.createElement('div');
    overlay.id = 'task-input-dialog';
    overlay.setAttribute('aria-hidden', 'true');
    const card = document.createElement('form');
    card.className = 'task-input-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'task-input-title');
    card.setAttribute('aria-describedby', 'task-input-description');
    const body = document.createElement('div');
    body.className = 'task-input-body';
    const title = document.createElement('h2');
    title.id = 'task-input-title';
    title.className = 'task-input-title';
    const description = document.createElement('label');
    description.id = 'task-input-description';
    description.className = 'task-input-description';
    const fieldHost = document.createElement('div');
    fieldHost.className = 'task-input-field';
    const foot = document.createElement('div');
    foot.className = 'task-input-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ss-btn ss-btn-ghost';
    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.className = 'ss-btn ss-btn-primary';
    foot.append(cancel, confirm);
    body.append(title, description, fieldHost);
    card.append(body, foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    taskInputDialog = {
      overlay,
      card,
      title,
      description,
      fieldHost,
      cancel,
      confirm,
      control: null,
      previousFocus: null
    };
    dialogLifecycle = new DisposableStore();
    lifecycle.add(dialogLifecycle);
    dialogLifecycle.add(toDisposable(() => overlay.remove()));
    addDialogListener(cancel, 'click', () => finishTaskInput(true));
    addDialogListener(card, 'submit', (event) => {
      event.preventDefault();
      finishTaskInput(false);
    });
    addDialogListener(overlay, 'pointerdown', (event) => {
      if (event.target === overlay) finishTaskInput(true);
    });
    addDialogListener(overlay, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        finishTaskInput(true);
        return;
      }
      if (keyboardEvent.key !== 'Tab' || !taskInputDialog) return;
      const focusable = [taskInputDialog.control, cancel, confirm].filter(
        (item): item is HTMLInputElement | HTMLSelectElement | HTMLButtonElement => item !== null
      );
      const index = focusable.findIndex((item) => item === document.activeElement);
      if (keyboardEvent.shiftKey && index <= 0) {
        keyboardEvent.preventDefault();
        focusable[focusable.length - 1]?.focus();
      } else if (!keyboardEvent.shiftKey && index === focusable.length - 1) {
        keyboardEvent.preventDefault();
        focusable[0]?.focus();
      }
    });
    return taskInputDialog;
  }

  function updateTaskInputDialogText(): void {
    if (!taskInputDialog) return;
    taskInputDialog.title.textContent = tr('Task input');
    taskInputDialog.cancel.textContent = tr('Cancel');
    taskInputDialog.confirm.textContent = tr('Continue');
  }

  function promptTaskInput(request: ProjectTaskInputRequestDto): Promise<TaskInputResult> {
    const dialog = ensureTaskInputDialog();
    if (activeTaskInput) finishTaskInput(true);
    updateTaskInputDialogText();
    dialog.description.textContent = request.description || (request.type === 'pickString'
      ? tr('Choose a value for {input}', { input: request.id })
      : tr('Enter a value for {input}', { input: request.id }));
    dialog.fieldHost.replaceChildren();
    let control: HTMLInputElement | HTMLSelectElement;
    if (request.type === 'pickString') {
      control = document.createElement('select');
      request.options.forEach((option) => {
        const item = document.createElement('option');
        item.value = String(option.value);
        item.textContent = String(option.label);
        control.appendChild(item);
      });
      if (request.default !== undefined && request.options.some((option) => option.value === request.default)) {
        control.value = request.default;
      }
    } else {
      control = document.createElement('input');
      control.type = request.password ? 'password' : 'text';
      control.value = request.default === undefined ? '' : String(request.default);
      control.autocomplete = 'off';
      control.spellcheck = false;
    }
    control.className = 'ss-input';
    control.setAttribute('aria-labelledby', 'task-input-description');
    dialog.fieldHost.appendChild(control);
    dialog.control = control;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.previousFocus = previousFocus && typeof previousFocus.focus === 'function' ? previousFocus : null;
    dialog.overlay.setAttribute('aria-hidden', 'false');
    dialog.overlay.classList.add('open');
    inputFocusTimer = clearTimer(inputFocusTimer);
    inputFocusTimer = schedule(() => {
      inputFocusTimer = null;
      if (dialog.control !== control || !activeTaskInput) return;
      control.focus();
      if (request.type === 'promptString') (control as HTMLInputElement).select();
    }, 0);
    return new Promise((resolve) => {
      activeTaskInput = {
        resolve,
        rootPath: String(state().workspaceRoot || ''),
        workspaceIdentity: state().workspaceIdentity
      };
    });
  }

  async function resolveInputRequests(
    requests: readonly ProjectTaskInputRequestDto[]
  ): Promise<Record<string, string> | null> {
    const values: Record<string, string> = {};
    for (const request of requests || []) {
      const result = await promptTaskInput(request);
      const currentState = state();
      if (result.cancelled || result.rootPath !== String(currentState.workspaceRoot || '') ||
          result.workspaceIdentity !== currentState.workspaceIdentity || result.value === null) {
        return null;
      }
      values[request.id] = result.value;
    }
    return values;
  }

  function cancelInput(): boolean {
    if (!activeTaskInput) return false;
    finishTaskInput(true);
    return true;
  }

  function clearConfiguration(): void {
    configuration = EMPTY_CONFIGURATION;
    selected = { type: 'file', label: '' };
    updatePrimaryButton();
    closeMenu();
  }

  function invalidateRefreshes(): void {
    refreshGeneration += 1;
    refreshContextEpoch += 1;
    refreshQueued = false;
    refreshFlight = null;
  }

  function refreshContextCurrent(
    requestGeneration: number,
    rootPath: string,
    workspaceIdentity: unknown,
    contextEpoch: number,
    serviceEpoch: number
  ): boolean {
    const currentState = state();
    return !disposed && serviceEpoch === lifecycleEpoch && contextEpoch === refreshContextEpoch &&
      requestGeneration === refreshGeneration && rootPath === String(currentState.workspaceRoot || '') &&
      workspaceIdentity === currentState.workspaceIdentity;
  }

  async function runRefreshLoop(
    serviceEpoch: number,
    contextEpoch: number
  ): Promise<ProjectTaskConfigurationDto> {
    while (!disposed && serviceEpoch === lifecycleEpoch && contextEpoch === refreshContextEpoch && refreshQueued) {
      refreshQueued = false;
      const currentState = state();
      const rootPath = String(currentState.workspaceRoot || '');
      const workspaceIdentity = currentState.workspaceIdentity;
      const requestGeneration = ++refreshGeneration;
      if (!rootPath) {
        clearConfiguration();
        continue;
      }
      let nextConfiguration: ProjectTaskConfigurationDto;
      try {
        nextConfiguration = await host.list();
      } catch (error) {
        nextConfiguration = {
          ...EMPTY_CONFIGURATION,
          workspaceRoot: rootPath,
          warnings: [{ code: 'TASKS_LOAD_FAILED', message: errorMessage(error) }]
        };
      }
      // A request that arrived while the read was in flight needs a fresh
      // snapshot. Do not briefly publish the superseded result.
      if (refreshQueued) continue;
      if (!sameWorkspaceRoot(nextConfiguration.workspaceRoot, rootPath)) continue;
      if (!refreshContextCurrent(
        requestGeneration,
        rootPath,
        workspaceIdentity,
        contextEpoch,
        serviceEpoch
      )) continue;
      configuration = nextConfiguration;
      loadSelection();
      updatePrimaryButton();
      const menu = document.getElementById('run-target-menu');
      if (menu && !menu.hidden) renderMenu();
    }
    return configuration;
  }

  function refresh(): Promise<ProjectTaskConfigurationDto> {
    if (disposed) return Promise.resolve(configuration);
    if (!state().workspaceRoot) {
      invalidateRefreshes();
      clearConfiguration();
      return Promise.resolve(configuration);
    }
    refreshQueued = true;
    if (refreshFlight) return refreshFlight;
    const serviceEpoch = lifecycleEpoch;
    const contextEpoch = refreshContextEpoch;
    const flight = runRefreshLoop(serviceEpoch, contextEpoch);
    refreshFlight = flight;
    const onFlightSettled = () => {
      if (refreshFlight !== flight) return;
      refreshFlight = null;
      if (!disposed && refreshQueued && serviceEpoch === lifecycleEpoch && contextEpoch === refreshContextEpoch) {
        void refresh();
      }
    };
    void flight.then(onFlightSettled, onFlightSettled);
    return flight;
  }

  function editorContext(): ProjectTaskEditorContext {
    const currentState = state();
    const context: {
      activeFile: string;
      languageId: string;
      selectedText: string;
      lineNumber: string | number;
      columnNumber: string | number;
    } = {
      activeFile: currentState.activeTabPath || '',
      languageId: '',
      selectedText: '',
      lineNumber: '',
      columnNumber: ''
    };
    const editor = currentState.editor;
    if (!editor) return context;
    const activeModel = editor.getModel?.();
    if (activeModel?.getLanguageId) context.languageId = String(activeModel.getLanguageId() || '');
    const selection = editor.getSelection?.();
    if (!selection) return context;
    context.lineNumber = selection.startLineNumber;
    context.columnNumber = selection.startColumn;
    if (activeModel?.getValueInRange) context.selectedText = activeModel.getValueInRange(selection);
    return context;
  }

  async function runSelected(): Promise<boolean | void> {
    const targetFeature = featureDecision(selected.type);
    if (!targetFeature.available) {
      updateRunOutput(unavailableText(selected.type));
      return false;
    }
    const runner = getRunner();
    if (!runner) return false;
    if (selected.type !== 'task') return runner.runActive();
    const currentState = state();
    if (!currentState.selectedRuntime) {
      updateRunOutput(tr(
        'Project tasks require a Docker runtime. Select a cloud runtime before running {task}.',
        { task: selected.label }
      ));
      document.getElementById('runtime-btn')?.focus();
      return false;
    }
    try {
      return await runner.runProjectTask({ label: selected.label, context: editorContext() });
    } catch (error) {
      updateRunOutput(tr('Task configuration could not be loaded: {message}', { message: errorMessage(error) }));
      return false;
    }
  }

  function rerunLast(): false | Promise<boolean | void> {
    const runner = getRunner();
    if (!runner) return false;
    return runner.rerunLastProjectTask(editorContext());
  }

  function resolveTask(request: ProjectTaskResolveRequestDto): Promise<ProjectTaskResolveResultDto> {
    return host.resolve(request);
  }

  function addListener(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function trackExternalDisposable(value: Disposable | (() => void) | undefined): void {
    if (typeof value === 'function') lifecycle.add(toDisposable(value));
    else if (isDisposable(value)) lifecycle.add(value);
  }

  function scheduleWorkspaceRefresh(delay: number): void {
    workspaceRefreshTimer = clearTimer(workspaceRefreshTimer);
    workspaceRefreshTimer = schedule(() => {
      workspaceRefreshTimer = null;
      void refresh();
    }, delay);
  }

  function scheduleConfigurationRefresh(): void {
    if (configurationRefreshTimer) return;
    configurationRefreshTimer = schedule(() => {
      configurationRefreshTimer = null;
      void refresh();
    }, 25);
  }

  function init(): void {
    if (initialized) return;
    if (disposed) {
      disposed = false;
      lifecycleEpoch += 1;
      lifecycle = new DisposableStore();
    }
    initialized = true;
    const button = document.getElementById('run-target-btn');
    if (button) {
      addListener(button, 'click', (event) => {
        event.stopPropagation();
        const menu = document.getElementById('run-target-menu');
        if (!menu || menu.hidden) openMenu();
        else closeMenu({ restoreFocus: true });
      });
      addListener(button, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'ArrowDown') return;
        keyboardEvent.preventDefault();
        openMenu();
        document.querySelector<HTMLElement>('#run-target-menu .run-target-item:not(:disabled)')?.focus();
      });
    }
    const menu = document.getElementById('run-target-menu');
    if (menu) addListener(menu, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      const items = Array.from(menu.querySelectorAll<HTMLElement>('.run-target-item:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        closeMenu({ restoreFocus: true });
        return;
      }
      if (keyboardEvent.key === 'Tab') {
        closeMenu();
        return;
      }
      if (keyboardEvent.key === 'Home' && items.length) {
        keyboardEvent.preventDefault();
        items[0]?.focus();
        return;
      }
      if (keyboardEvent.key === 'End' && items.length) {
        keyboardEvent.preventDefault();
        items[items.length - 1]?.focus();
        return;
      }
      if (keyboardEvent.key === 'ArrowDown' && items.length) {
        keyboardEvent.preventDefault();
        items[(index + 1 + items.length) % items.length]?.focus();
      } else if (keyboardEvent.key === 'ArrowUp' && items.length) {
        keyboardEvent.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      }
    });

    addListener(rendererWindow, 'bobo:workspace-changed', (event) => {
      cancelInput();
      invalidateRefreshes();
      clearConfiguration();
      const rootPath = (event as CustomEvent<{ rootPath?: unknown }>).detail?.rootPath;
      if (rootPath || state().workspaceRoot) scheduleWorkspaceRefresh(0);
    });
    addListener(rendererWindow, 'bobo:server-capabilities-changed', () => {
      closeMenu();
      updatePrimaryButton();
    });
    lifecycle.add(host.onWorkspaceOpened(() => scheduleWorkspaceRefresh(50)));
    lifecycle.add(host.onConfigurationChanged(scheduleConfigurationRefresh));
    trackExternalDisposable(getI18n()?.onChange?.(() => {
      updatePrimaryButton();
      updateTaskInputDialogText();
      const activeMenu = document.getElementById('run-target-menu');
      if (activeMenu && !activeMenu.hidden) renderMenu();
    }));
    void refresh();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    lifecycleEpoch += 1;
    invalidateRefreshes();
    cancelInput();
    closeMenu();
    inputFocusTimer = clearTimer(inputFocusTimer);
    workspaceRefreshTimer = clearTimer(workspaceRefreshTimer);
    configurationRefreshTimer = clearTimer(configurationRefreshTimer);
    lifecycle.dispose();
    dialogLifecycle = null;
    taskInputDialog = null;
  }

  return {
    init,
    refresh,
    runSelected,
    rerunLast,
    resolveTask,
    resolveInputRequests,
    cancelInput,
    getSelected: () => ({ ...selected }),
    getConfiguration: () => configuration,
    dispose
  };
}
