// Applies the validated .vscode/settings.json subset.

import { DisposableStore } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  WorkspaceEditorSettingsDto,
  WorkspaceSettingsAssociationDto,
  WorkspaceSettingsConfigKeyDto,
  WorkspaceSettingsConfigValueDto,
  WorkspaceSettingsDependencies,
  WorkspaceSettingsEditorPort,
  WorkspaceSettingsEditorRawOptionsDto,
  WorkspaceSettingsEditorUpdateDto,
  WorkspaceSettingsExcludeRuleDto,
  WorkspaceSettingsFacade,
  WorkspaceSettingsLanguageIdDto,
  WorkspaceSettingsLoadedSnapshotDto,
  WorkspaceSettingsModelPort,
  WorkspaceSettingsModelUpdateDto,
  WorkspaceSettingsMonacoPort,
  WorkspaceSettingsRenderWhitespaceDto,
  WorkspaceSettingsService,
  WorkspaceSettingsSnapshotDto,
  WorkspaceSettingsTabDto,
  WorkspaceSettingsTreeNodeDto,
  WorkspaceSettingsWarningDto,
  WorkspaceSettingsWordWrapDto
} from '../types/workspace-settings';

export const WORKSPACE_SETTINGS_SERVICE_ID = 'workbench.workspaceSettings';

const KNOWN_LANGUAGE_IDS = new Set<string>([
  'c', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'less',
  'markdown', 'php', 'plaintext', 'python', 'ruby', 'rust', 'scss', 'shell',
  'sql', 'typescript', 'xml', 'yaml'
]);
const WORD_WRAP_VALUES = new Set<string>(['off', 'on', 'wordWrapColumn', 'bounded']);
const RENDER_WHITESPACE_VALUES = new Set<string>([
  'none', 'boundary', 'selection', 'trailing', 'all'
]);
const MODEL_FIELDS = Object.freeze(['tabSize', 'insertSpaces'] as const);
const EDITOR_FIELDS = Object.freeze([
  'wordWrap', 'wordWrapColumn', 'rulers', 'renderWhitespace',
  'minimapEnabled', 'bracketPairColorizationEnabled'
] as const);
type ModelField = typeof MODEL_FIELDS[number];
type EditorField = typeof EDITOR_FIELDS[number];
type MutableEditorSettings = {
  -readonly [Key in keyof WorkspaceEditorSettingsDto]: WorkspaceEditorSettingsDto[Key];
};
interface ModelBaseline {
  tabSize: number;
  insertSpaces: boolean;
}
type ModelControlState = Partial<Record<ModelField, true>>;
type MutableModelUpdate = {
  -readonly [Key in keyof WorkspaceSettingsModelUpdateDto]: WorkspaceSettingsModelUpdateDto[Key];
};
type EditorBaseline = Record<EditorField, unknown>;
type EditorControlState = Partial<Record<EditorField, true>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value as object).forEach((key) => {
    deepFreeze(Reflect.get(value as object, key));
  });
  return value;
}

const EMPTY_SNAPSHOT: WorkspaceSettingsSnapshotDto = deepFreeze({
  schemaVersion: 1,
  rootPath: null,
  workspaceIdentity: null,
  settings: {
    editor: {},
    languages: {},
    associations: [],
    files: { exclude: [] }
  },
  warnings: []
});

export function createEmptyWorkspaceSettingsSnapshot(): WorkspaceSettingsSnapshotDto {
  return EMPTY_SNAPSHOT;
}

function isLanguageId(value: string): value is WorkspaceSettingsLanguageIdDto {
  return KNOWN_LANGUAGE_IDS.has(value);
}

function isWordWrap(value: unknown): value is WorkspaceSettingsWordWrapDto {
  return typeof value === 'string' && WORD_WRAP_VALUES.has(value);
}

function isRenderWhitespace(value: unknown): value is WorkspaceSettingsRenderWhitespaceDto {
  return typeof value === 'string' && RENDER_WHITESPACE_VALUES.has(value);
}

export function normalizeWorkspaceEditorSettings(value: unknown): WorkspaceEditorSettingsDto {
  const result: MutableEditorSettings = {};
  if (!isRecord(value)) return result;
  if (typeof value.tabSize === 'number' && Number.isInteger(value.tabSize) &&
      value.tabSize >= 1 && value.tabSize <= 16) result.tabSize = value.tabSize;
  if (typeof value.insertSpaces === 'boolean') result.insertSpaces = value.insertSpaces;
  if (isWordWrap(value.wordWrap)) result.wordWrap = value.wordWrap;
  if (typeof value.wordWrapColumn === 'number' && Number.isInteger(value.wordWrapColumn) &&
      value.wordWrapColumn >= 1 && value.wordWrapColumn <= 1000) {
    result.wordWrapColumn = value.wordWrapColumn;
  }
  if (Array.isArray(value.rulers) && value.rulers.length <= 32 && value.rulers.every((column): column is number => (
    typeof column === 'number' && Number.isInteger(column) && column >= 1 && column <= 1000
  ))) result.rulers = value.rulers.slice();
  if (isRenderWhitespace(value.renderWhitespace)) {
    result.renderWhitespace = value.renderWhitespace;
  }
  if (typeof value.minimapEnabled === 'boolean') result.minimapEnabled = value.minimapEnabled;
  if (typeof value.bracketPairColorizationEnabled === 'boolean') {
    result.bracketPairColorizationEnabled = value.bracketPairColorizationEnabled;
  }
  return result;
}

function normalizeExcludeRules(value: unknown): WorkspaceSettingsExcludeRuleDto[] {
  const rules: WorkspaceSettingsExcludeRuleDto[] = [];
  if (!isRecord(value) || !Array.isArray(value.exclude)) return rules;
  value.exclude.slice(0, 128).forEach((rule) => {
    if (!isRecord(rule) || typeof rule.pattern !== 'string' || rule.pattern.length > 256 ||
        typeof rule.regexp !== 'string' || rule.regexp.length > 4096 ||
        (rule.flags !== '' && rule.flags !== 'i')) return;
    try {
      rules.push({
        pattern: rule.pattern,
        regexp: rule.regexp,
        flags: rule.flags,
        matcher: new RegExp(rule.regexp, rule.flags)
      });
    } catch (_) {}
  });
  return rules;
}

export function normalizeWorkspaceSettingsSnapshot(
  raw: unknown
): WorkspaceSettingsLoadedSnapshotDto | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.rootPath !== 'string' ||
      typeof raw.workspaceIdentity !== 'number' || !Number.isInteger(raw.workspaceIdentity) ||
      !isRecord(raw.settings)) return null;
  const rawSettings = raw.settings;

  const languages: Partial<Record<WorkspaceSettingsLanguageIdDto, WorkspaceEditorSettingsDto>> = {};
  const rawLanguages = rawSettings.languages;
  if (isRecord(rawLanguages)) {
    Object.keys(rawLanguages).forEach((languageId) => {
      if (isLanguageId(languageId)) {
        languages[languageId] = normalizeWorkspaceEditorSettings(rawLanguages[languageId]);
      }
    });
  }

  const associations: WorkspaceSettingsAssociationDto[] = [];
  if (Array.isArray(rawSettings.associations)) {
    rawSettings.associations.forEach((association) => {
      if (!isRecord(association) || typeof association.pattern !== 'string' ||
          !/^\*\.[a-z0-9][a-z0-9_+-]*(?:\.[a-z0-9][a-z0-9_+-]*){0,3}$/.test(association.pattern) ||
          typeof association.languageId !== 'string' || !isLanguageId(association.languageId)) return;
      associations.push({
        pattern: association.pattern,
        languageId: association.languageId
      });
    });
  }

  const warnings: WorkspaceSettingsWarningDto[] = [];
  if (Array.isArray(raw.warnings)) {
    raw.warnings.forEach((warning) => {
      if (!isRecord(warning) || typeof warning.code !== 'string' ||
          !/^[A-Z0-9_]{1,80}$/.test(warning.code)) return;
      warnings.push({
        code: warning.code,
        count: Math.max(1, Math.min(10000, Number(warning.count) || 1))
      });
    });
  }

  return deepFreeze({
    schemaVersion: 1,
    rootPath: raw.rootPath,
    workspaceIdentity: raw.workspaceIdentity,
    settings: {
      editor: normalizeWorkspaceEditorSettings(rawSettings.editor),
      languages,
      associations,
      files: { exclude: normalizeExcludeRules(rawSettings.files) }
    },
    warnings
  });
}

function fileName(value: unknown): string {
  const parts = String(value || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function normalizedPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function cloneEditorValue(value: unknown): unknown {
  return Array.isArray(value) ? value.slice() : value;
}

function disposableFrom(value: Disposable | void): Disposable | null {
  return value && typeof value.dispose === 'function' ? value : null;
}

export function createWorkspaceSettingsService(
  dependencies: WorkspaceSettingsDependencies
): WorkspaceSettingsService {
  const state = dependencies.state;
  const lifecycle = new DisposableStore({
    onError: (event) => reportDisposeError(event.error)
  });
  let monacoRef: WorkspaceSettingsMonacoPort | null = null;
  let modelDefaults = new WeakMap<WorkspaceSettingsModelPort, ModelBaseline>();
  let modelControlled = new WeakMap<WorkspaceSettingsModelPort, ModelControlState>();
  let editorDefaults = new WeakMap<WorkspaceSettingsEditorPort, EditorBaseline>();
  let editorControlled = new WeakMap<WorkspaceSettingsEditorPort, EditorControlState>();
  let attachedEditors = new WeakSet<WorkspaceSettingsEditorPort>();
  const editorSubscriptions = new Map<WorkspaceSettingsEditorPort, Disposable>();
  let monacoSubscription: Disposable | null = null;
  let subscriptionsInstalled = false;
  let refreshGeneration = 0;
  let disposed = false;

  function reportDisposeError(error: unknown): void {
    try {
      dependencies.reportError('dispose', error);
    } catch (_) {
      // Error observers cannot interrupt lifecycle cleanup.
    }
  }

  function disposeOwned(disposable: Disposable | null): void {
    if (!disposable) return;
    lifecycle.delete(disposable);
    try {
      disposable.dispose();
    } catch (error) {
      reportDisposeError(error);
    }
  }

  function disposeEditorSubscriptions(): void {
    const subscriptions = Array.from(editorSubscriptions.values()).reverse();
    editorSubscriptions.clear();
    subscriptions.forEach(disposeOwned);
  }

  function currentSnapshot(): WorkspaceSettingsSnapshotDto {
    return state.workspaceSettings || EMPTY_SNAPSHOT;
  }

  function associatedLanguage(name: unknown): WorkspaceSettingsLanguageIdDto | '' {
    const snapshot = currentSnapshot();
    const lowerName = fileName(name).toLowerCase();
    const associations = snapshot.settings.associations || [];
    for (let index = 0; index < associations.length; index += 1) {
      const association = associations[index];
      if (!association) continue;
      const suffix = association.pattern.slice(1);
      if (lowerName.endsWith(suffix)) return association.languageId;
    }
    return '';
  }

  function languageForFile(name: unknown, fallback: string): string {
    return associatedLanguage(name) || fallback;
  }

  function effectiveEditorSettings(languageId: string): WorkspaceEditorSettingsDto {
    const snapshot = currentSnapshot();
    return Object.assign(
      {},
      snapshot.settings.editor || {},
      isLanguageId(languageId) ? snapshot.settings.languages[languageId] || {} : {}
    );
  }

  function configValue(
    key: WorkspaceSettingsConfigKeyDto | string,
    languageId?: string
  ): WorkspaceSettingsConfigValueDto {
    const effective = effectiveEditorSettings(languageId || 'plaintext');
    switch (String(key || '')) {
      case 'editor.tabSize': return effective.tabSize;
      case 'editor.insertSpaces': return effective.insertSpaces;
      case 'editor.wordWrap': return effective.wordWrap;
      case 'editor.wordWrapColumn': return effective.wordWrapColumn;
      case 'editor.renderWhitespace': return effective.renderWhitespace;
      case 'editor.minimap.enabled': return effective.minimapEnabled;
      case 'editor.bracketPairColorization.enabled': {
        return effective.bracketPairColorizationEnabled;
      }
      default: return undefined;
    }
  }

  function relativeWorkspacePath(value: unknown): string {
    const target = normalizedPath(value);
    const root = normalizedPath(state.workspaceRoot);
    if (!target || !root) return target;
    if (target === root) return '';
    if (target.indexOf(root + '/') === 0) return target.slice(root.length + 1);
    return target;
  }

  function isPathExcluded(value: unknown): boolean {
    const relative = relativeWorkspacePath(value);
    if (!relative) return false;
    const rules = currentSnapshot().settings.files.exclude || [];
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      if (rule?.matcher.test(relative)) return true;
    }
    return false;
  }

  function filterTreeChildren<Node extends WorkspaceSettingsTreeNodeDto>(
    children: readonly Node[] | null | undefined
  ): Node[] {
    return Array.isArray(children) ? children.filter((node): node is Node => (
      Boolean(node && !isPathExcluded(node.path))
    )) : [];
  }

  function tabForModel(model: WorkspaceSettingsModelPort): WorkspaceSettingsTabDto | null {
    for (let index = 0; index < state.tabs.length; index += 1) {
      const tab = state.tabs[index];
      if (tab?.model === model) return tab;
    }
    return null;
  }

  function modelFileName(model: WorkspaceSettingsModelPort): string {
    const tab = tabForModel(model);
    if (tab) return tab.name || '';
    const uri = model.uri;
    return fileName(uri && (uri.fsPath || uri.path || (uri.toString && uri.toString())));
  }

  function baselineForModel(model: WorkspaceSettingsModelPort): ModelBaseline {
    let baseline = modelDefaults.get(model);
    if (baseline) return baseline;
    const options = model.getOptions ? model.getOptions() : {};
    baseline = {
      tabSize: typeof options.tabSize === 'number' && Number.isInteger(options.tabSize)
        ? options.tabSize
        : 4,
      insertSpaces: typeof options.insertSpaces === 'boolean' ? options.insertSpaces : true
    };
    modelDefaults.set(model, baseline);
    return baseline;
  }

  function updateModelBaseline(
    baseline: ModelBaseline,
    field: ModelField,
    value: unknown
  ): void {
    if (field === 'tabSize') {
      if (typeof value === 'number' && Number.isInteger(value)) baseline.tabSize = value;
      return;
    }
    if (typeof value === 'boolean') baseline.insertSpaces = value;
  }

  function updateModelOption(
    updates: MutableModelUpdate,
    field: ModelField,
    value: unknown
  ): void {
    if (field === 'tabSize') {
      if (typeof value === 'number' && Number.isInteger(value)) updates.tabSize = value;
      return;
    }
    if (typeof value === 'boolean') updates.insertSpaces = value;
  }

  function applyModel(model: WorkspaceSettingsModelPort | null | undefined): boolean {
    if (disposed || !model || typeof model.getLanguageId !== 'function') return false;
    const name = modelFileName(model);
    const tab = tabForModel(model);
    let languageId = model.getLanguageId();
    if (tab) {
      const detectLanguage = dependencies.getDetectLanguage();
      const detected = detectLanguage
        ? detectLanguage(name, typeof model.getValue === 'function' ? model.getValue() : '')
        : languageId;
      languageId = languageForFile(name, detected || languageId);
    }
    const languageChanged = Boolean(languageId && languageId !== model.getLanguageId());
    if (languageChanged && monacoRef?.editor?.setModelLanguage) {
      monacoRef.editor.setModelLanguage(model, languageId);
    }
    if (tab) {
      tab.language = model.getLanguageId();
      tab.languageFromWorkspaceSettings = Boolean(associatedLanguage(name));
    }
    const baseline = baselineForModel(model);
    const settings = effectiveEditorSettings(model.getLanguageId());
    const previous = modelControlled.get(model) || {};
    const next: ModelControlState = {};
    const updates: MutableModelUpdate = {};
    const currentOptions = model.getOptions ? model.getOptions() : {};
    MODEL_FIELDS.forEach((field) => {
      const configured = settings[field];
      if (configured !== undefined) {
        const current = currentOptions[field];
        if (!previous[field] && current !== undefined) {
          updateModelBaseline(baseline, field, current);
        }
        updateModelOption(updates, field, configured);
        next[field] = true;
      } else if (previous[field]) {
        updateModelOption(updates, field, baseline[field]);
      } else {
        const current = currentOptions[field];
        if (current !== undefined) updateModelBaseline(baseline, field, current);
      }
    });
    modelControlled.set(model, next);
    if (typeof model.updateOptions === 'function' && Object.keys(updates).length) {
      model.updateOptions(updates);
    }
    return languageChanged;
  }

  function editorValue(options: WorkspaceSettingsEditorRawOptionsDto, field: EditorField): unknown {
    if (field === 'minimapEnabled') {
      return options.minimap && typeof options.minimap.enabled === 'boolean'
        ? options.minimap.enabled
        : undefined;
    }
    if (field === 'bracketPairColorizationEnabled') {
      return options.bracketPairColorization &&
        typeof options.bracketPairColorization.enabled === 'boolean'
        ? options.bracketPairColorization.enabled
        : undefined;
    }
    return options[field];
  }

  function validEditorValue(field: EditorField, value: unknown): boolean {
    if (field === 'wordWrap') return isWordWrap(value);
    if (field === 'wordWrapColumn') {
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;
    }
    if (field === 'rulers') return Array.isArray(value);
    if (field === 'renderWhitespace') return isRenderWhitespace(value);
    return typeof value === 'boolean';
  }

  function editorUpdate(field: EditorField, value: unknown): WorkspaceSettingsEditorUpdateDto {
    if (field === 'minimapEnabled') return { minimap: { enabled: Boolean(value) } };
    if (field === 'bracketPairColorizationEnabled') {
      return { bracketPairColorization: { enabled: Boolean(value) } };
    }
    const update: Record<string, unknown> = {};
    update[field] = cloneEditorValue(value);
    return update as WorkspaceSettingsEditorUpdateDto;
  }

  function baselineForEditor(editor: WorkspaceSettingsEditorPort): EditorBaseline {
    let baseline = editorDefaults.get(editor);
    if (baseline) return baseline;
    const options = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
    baseline = {
      wordWrap: isWordWrap(options.wordWrap) ? options.wordWrap : 'off',
      wordWrapColumn: typeof options.wordWrapColumn === 'number' && Number.isInteger(options.wordWrapColumn)
        ? options.wordWrapColumn
        : 80,
      rulers: Array.isArray(options.rulers) ? options.rulers.slice() : [],
      renderWhitespace: isRenderWhitespace(options.renderWhitespace)
        ? options.renderWhitespace
        : 'selection',
      minimapEnabled: options.minimap && typeof options.minimap.enabled === 'boolean'
        ? options.minimap.enabled
        : true,
      bracketPairColorizationEnabled: options.bracketPairColorization &&
        typeof options.bracketPairColorization.enabled === 'boolean'
        ? options.bracketPairColorization.enabled
        : true
    };
    editorDefaults.set(editor, baseline);
    return baseline;
  }

  function updateEditorOptions(editor: WorkspaceSettingsEditorPort | null | undefined): void {
    if (!editor || typeof editor.updateOptions !== 'function') return;
    const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
    const languageId = model && typeof model.getLanguageId === 'function'
      ? model.getLanguageId()
      : 'plaintext';
    const settings = effectiveEditorSettings(languageId);
    const previous = editorControlled.get(editor) || {};
    const next: EditorControlState = {};
    const baseline = baselineForEditor(editor);
    const raw = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
    EDITOR_FIELDS.forEach((field) => {
      const current = editorValue(raw, field);
      const configured = settings[field];
      if (configured !== undefined) {
        if (!previous[field] && validEditorValue(field, current)) {
          baseline[field] = cloneEditorValue(current);
        }
        editor.updateOptions?.(editorUpdate(field, configured));
        next[field] = true;
      } else if (previous[field]) {
        editor.updateOptions?.(editorUpdate(field, baseline[field]));
      } else if (validEditorValue(field, current)) {
        baseline[field] = cloneEditorValue(current);
      }
    });
    editorControlled.set(editor, next);
  }

  function applyActiveEditors(): void {
    updateEditorOptions(state.editor);
    if (state.splitEditor) {
      updateEditorOptions(state.splitEditor);
      updateEditorOptions(state.splitEditor.rightEditor);
    }
  }

  function applySplitModel(): boolean {
    if (!state.splitEditor || !state.splitEditor.rightEditor || !monacoRef?.editor) return false;
    const leftModel = typeof state.splitEditor.getModel === 'function'
      ? state.splitEditor.getModel()
      : null;
    const rightModel = typeof state.splitEditor.rightEditor.getModel === 'function'
      ? state.splitEditor.rightEditor.getModel()
      : null;
    if (!leftModel || !rightModel || typeof leftModel.getLanguageId !== 'function') return false;
    const languageId = leftModel.getLanguageId();
    const changed = typeof rightModel.getLanguageId === 'function' &&
      rightModel.getLanguageId() !== languageId;
    if (changed && monacoRef.editor.setModelLanguage) {
      monacoRef.editor.setModelLanguage(rightModel, languageId);
    }
    applyModel(rightModel);
    return changed;
  }

  function applyAll(): void {
    if (disposed || !monacoRef?.editor) return;
    let languageChanged = false;
    monacoRef.editor.getModels().forEach((model) => {
      if (applyModel(model)) languageChanged = true;
    });
    if (applySplitModel()) languageChanged = true;
    applyActiveEditors();
    const activeEditor = state.editor;
    const editorCore = dependencies.getEditorCore();
    if (activeEditor && editorCore) {
      editorCore.updateStatusBar(
        typeof activeEditor.getModel === 'function' ? activeEditor.getModel() : null,
        typeof activeEditor.getPosition === 'function' ? activeEditor.getPosition() : null
      );
    }
    if (languageChanged) {
      const activeModel = activeEditor && typeof activeEditor.getModel === 'function'
        ? activeEditor.getModel()
        : null;
      const runtime = dependencies.getRuntime();
      if (runtime && activeModel) runtime.autoSelectForLanguage(activeModel.getLanguageId());
      dependencies.getLsp()?.workspaceChanged();
      dependencies.getEnvironmentActivity()?.contextChanged('language');
    }
  }

  function snapshotMatchesWorkspace(
    snapshot: WorkspaceSettingsSnapshotDto | null
  ): snapshot is WorkspaceSettingsLoadedSnapshotDto {
    return Boolean(snapshot && snapshot.rootPath === state.workspaceRoot &&
      snapshot.workspaceIdentity === state.workspaceIdentity);
  }

  function excludeRuleSignature(rules: readonly WorkspaceSettingsExcludeRuleDto[]): string {
    return JSON.stringify(rules.map((rule) => [rule.pattern, rule.regexp, rule.flags]));
  }

  function applySnapshot(raw: unknown): boolean {
    if (disposed) return false;
    const snapshot = normalizeWorkspaceSettingsSnapshot(raw);
    if (!snapshotMatchesWorkspace(snapshot)) return false;
    const previousRules = currentSnapshot().settings.files.exclude || [];
    refreshGeneration += 1;
    state.workspaceSettings = snapshot;
    applyAll();
    const nextRules = snapshot.settings.files.exclude;
    const changed = excludeRuleSignature(previousRules) !== excludeRuleSignature(nextRules);
    const workspace = dependencies.getWorkspace();
    if (changed && state.workspaceTree && workspace && typeof workspace.renderTree === 'function') {
      workspace.renderTree(state.workspaceTree);
    }
    const fileSearch = dependencies.getFileSearch();
    if (changed && fileSearch && typeof fileSearch.refreshCache === 'function') {
      fileSearch.refreshCache(true);
    }
    return true;
  }

  async function refreshForWorkspace(rootPath: string, workspaceIdentity: number): Promise<boolean> {
    if (disposed) return false;
    const requestGeneration = ++refreshGeneration;
    const requested = Object.freeze({ rootPath, workspaceIdentity });
    if (!snapshotMatchesWorkspace(state.workspaceSettings)) state.workspaceSettings = EMPTY_SNAPSHOT;
    try {
      const snapshot = await dependencies.host.read(requested);
      if (disposed || requestGeneration !== refreshGeneration) return false;
      return applySnapshot(snapshot);
    } catch (_) {
      return false;
    }
  }

  function clear(): void {
    if (disposed) return;
    refreshGeneration += 1;
    state.workspaceSettings = EMPTY_SNAPSHOT;
    applyAll();
  }

  function setMonaco(monaco: WorkspaceSettingsMonacoPort | null | undefined): void {
    if (disposed || monacoRef === monaco) return;
    disposeOwned(monacoSubscription);
    monacoSubscription = null;
    disposeEditorSubscriptions();
    monacoRef = monaco || null;
    modelDefaults = new WeakMap();
    modelControlled = new WeakMap();
    editorDefaults = new WeakMap();
    editorControlled = new WeakMap();
    attachedEditors = new WeakSet();
    const monacoEditor = monacoRef?.editor;
    const onDidCreateModel = monacoEditor?.onDidCreateModel;
    if (onDidCreateModel) {
      monacoSubscription = disposableFrom(onDidCreateModel.call(
        monacoEditor,
        (model) => { applyModel(model); }
      ));
      if (monacoSubscription) lifecycle.add(monacoSubscription);
    }
  }

  function attachEditor(editor: WorkspaceSettingsEditorPort | null | undefined): void {
    if (disposed || !editor) return;
    baselineForEditor(editor);
    if (attachedEditors.has(editor)) {
      updateEditorOptions(editor);
      return;
    }
    attachedEditors.add(editor);
    if (typeof editor.onDidChangeModel === 'function') {
      const subscription = disposableFrom(editor.onDidChangeModel((event) => {
        if (event?.newModel) applyModel(event.newModel);
        updateEditorOptions(editor);
      }));
      if (subscription) {
        editorSubscriptions.set(editor, subscription);
        lifecycle.add(subscription);
      }
    }
    updateEditorOptions(editor);
  }

  function installSubscription(): void {
    if (subscriptionsInstalled || disposed) return;
    subscriptionsInstalled = true;
    lifecycle.add(dependencies.host.onDidChange((snapshot) => {
      applySnapshot(snapshot);
    }));
  }

  state.workspaceSettings = state.workspaceSettings || EMPTY_SNAPSHOT;
  installSubscription();

  return Object.freeze({
    get disposed(): boolean { return disposed; },
    applySnapshot,
    refreshForWorkspace,
    clear,
    setMonaco,
    attachEditor,
    applyAll,
    applyModel,
    languageForFile,
    effectiveEditorSettings,
    configValue,
    isPathExcluded,
    filterTreeChildren,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      refreshGeneration += 1;
      monacoSubscription = null;
      editorSubscriptions.clear();
      lifecycle.dispose();
      monacoRef = null;
      modelDefaults = new WeakMap();
      modelControlled = new WeakMap();
      editorDefaults = new WeakMap();
      editorControlled = new WeakMap();
      attachedEditors = new WeakSet();
    }
  } satisfies WorkspaceSettingsService);
}

export type { WorkspaceSettingsFacade };
