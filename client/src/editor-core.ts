// Monaco editor integration, keyboard commands, status bar, and diagnostics.
//
// Monaco is still loaded through its AMD loader by app.js.  This module keeps
// the editor implementation independent from that loader and receives the
// narrow renderer ports it needs from compat/editor-core-adapter.ts.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  EditorCoreAiInlinePort,
  EditorCoreCommandsPort,
  EditorCoreDapPort,
  EditorCoreDependencies,
  EditorCoreDiagnosticsSettingsPort,
  EditorCoreEditorPort,
  EditorCoreFacade,
  EditorCoreI18nPort,
  EditorCoreMarkerDto,
  EditorCoreModelChangeEvent,
  EditorCoreModelPort,
  EditorCoreMonacoPort,
  EditorCoreProjectTasksPort,
  EditorCoreRendererState,
  EditorCoreRuleRegistryPort,
  EditorCoreService,
  EditorCoreSettingsPort,
  EditorCoreTabDto,
  EditorCoreTaskProblemMatcherPort,
  EditorCoreThemePort,
  EditorCoreWorkspacePort,
  EditorCoreWorkspaceSettingsPort
} from '../types/editor-core';

export const EDITOR_CORE_SERVICE_ID = 'workbench.editorCore' as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isExpectedMonacoCancellation(reason: unknown): boolean {
  if (!isRecord(reason) || reason.name !== 'Canceled' || reason.message !== 'Canceled') return false;
  return /[\\/]monaco-editor[\\/].*[\\/]vs[\\/].*editor\.api/i.test(String(reason.stack || ''));
}

function addDisposable(
  lifecycle: DisposableStore,
  disposable: { dispose(): void } | void | null | undefined
): void {
  if (disposable && typeof disposable.dispose === 'function') lifecycle.add(disposable);
}

function markerSeverity(marker: EditorCoreMarkerDto | null | undefined): number | undefined {
  return marker && typeof marker.severity === 'number' ? marker.severity : undefined;
}

export function createEditorCoreService(
  dependencies: EditorCoreDependencies
): EditorCoreService {
  const {
    document,
    eventTarget,
    state,
    getI18n,
    getTheme,
    getWorkspace,
    getDap,
    getProjectTasks,
    getRunner,
    getCommands,
    getSettings,
    getAiInline,
    getTaskProblemMatcher,
    getDiagnosticsSettings,
    getWorkspaceSettings,
    getRuleRegistry,
    getLanguageDisplayName,
    switchToPanel,
    registerCompletionProviders,
    setTimer,
    clearTimer
  } = dependencies;

  const lifecycle = new DisposableStore();
  const diagnosticTimers = new Map<string, number>();
  let monacoRef: EditorCoreMonacoPort | null = null;
  let ownedEditor: (EditorCoreEditorPort & { dispose?(): void }) | null = null;
  let initialized = false;
  let disposed = false;

  // Monaco's word-highlighter rejects delayed work when a model changes.  The
  // cancellation is expected, but some minified builds leave it unhandled.
  const unhandledRejectionListener = (event: Event): void => {
    const reason = (event as Event & { readonly reason?: unknown }).reason;
    if (isExpectedMonacoCancellation(reason)) event.preventDefault();
  };
  eventTarget.addEventListener('unhandledrejection', unhandledRejectionListener);
  lifecycle.add(toDisposable(() => {
    eventTarget.removeEventListener('unhandledrejection', unhandledRejectionListener);
  }));

  function element(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function translate(
    source: string,
    replacements?: Readonly<Record<string, unknown>>
  ): string {
    const i18n: EditorCoreI18nPort | null | undefined = getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return source.replace(/\{([^}]+)\}/g, (match, key: string) => {
      return replacements && replacements[key] !== undefined
        ? String(replacements[key])
        : match;
    });
  }

  function updateStatusBar(
    model: EditorCoreModelPort | null,
    position: unknown
  ): void {
    if (disposed) return;
    const lineColumn = element('status-linecol');
    const language = element('status-language');
    const indent = element('status-indent');

    if (state.currentViewMode === 'diff') {
      if (lineColumn) lineColumn.textContent = 'Diff view';
      if (language) language.textContent = 'Diff';
      return;
    }

    if (!model) {
      if (lineColumn) lineColumn.textContent = 'Ln --, Col --';
      if (language) language.textContent = '--';
      return;
    }

    if (position && isRecord(position)) {
      if (lineColumn) {
        lineColumn.textContent =
          'Ln ' + String(position.lineNumber) + ', Col ' + String(position.column);
      }
    }

    const languageId = model.getLanguageId();
    if (language) language.textContent = getLanguageDisplayName(languageId);

    const options = model.getOptions();
    if (indent) {
      if (options.insertSpaces) {
        indent.textContent = 'Spaces: ' + String(options.tabSize);
      } else {
        indent.textContent = 'Tab Size: ' + String(options.tabSize);
      }
    }
  }

  function updateDiagnosticsStatus(): void {
    if (disposed) return;
    const elementRef = element('status-errors');
    if (!elementRef) return;
    const diagnostics = state.currentDiagnostics;
    if (diagnostics.errors > 0 && diagnostics.warnings > 0) {
      elementRef.textContent = '⚠ ' + translate('{errors} errors, {warnings} warnings', diagnostics);
      elementRef.style.color = '#f44747';
    } else if (diagnostics.errors > 0) {
      elementRef.textContent = '✖ ' + translate('{errors} errors', diagnostics);
      elementRef.style.color = '#f44747';
    } else if (diagnostics.warnings > 0) {
      elementRef.textContent = '⚠ ' + translate('{warnings} warnings', diagnostics);
      elementRef.style.color = '#e5c07b';
    } else {
      elementRef.textContent = '✓ ' + translate('No problems');
      elementRef.style.color = '';
    }
    elementRef.title = translate('Errors: {errors}, Warnings: {warnings}, Info: {infos}', diagnostics);
  }

  function refreshDiagnosticsForModel(model: EditorCoreModelPort | null): void {
    if (disposed || !monacoRef || !model) return;
    if (state.editor && state.editor.getModel() === model) {
      const markers = monacoRef.editor.getModelMarkers({ resource: model.uri }) || [];
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      for (const marker of markers) {
        const severity = markerSeverity(marker);
        if (severity === monacoRef.MarkerSeverity.Error) errors += 1;
        else if (severity === monacoRef.MarkerSeverity.Warning) warnings += 1;
        else infos += 1;
      }
      state.currentDiagnostics = { errors, warnings, infos };
      updateDiagnosticsStatus();
    }
    const problemMatcher: EditorCoreTaskProblemMatcherPort | null | undefined = getTaskProblemMatcher();
    if (problemMatcher && typeof problemMatcher.refreshMonacoProblems === 'function') {
      problemMatcher.refreshMonacoProblems();
    }
  }

  function showFindWidget(): void {
    if (disposed) return;
    state.editor?.trigger('keyboard', 'actions.find');
  }

  function showReplaceWidget(): void {
    if (disposed) return;
    state.editor?.trigger('keyboard', 'editor.action.startFindReplaceAction');
  }

  function diagnosticsDebounceMs(): number {
    const settings: EditorCoreDiagnosticsSettingsPort | null | undefined = getDiagnosticsSettings();
    const value = state.diagnosticsSettings?.debounceMs;
    if (typeof value === 'number' && value >= 0) return value;
    // Keep the legacy service as a fallback when the settings adapter has not
    // yet populated the shared state.
    if (settings && typeof settings === 'object') {
      const configured = state.diagnosticsSettings?.debounceMs;
      if (typeof configured === 'number' && configured >= 0) return configured;
    }
    return 300;
  }

  function shouldCheckOnType(): boolean {
    const checkOn = state.diagnosticsSettings?.checkOn;
    return !state.diagnosticsSettings || checkOn !== 'save';
  }

  function performSyntaxCheck(model: EditorCoreModelPort | null): void {
    if (disposed || !model || (typeof model.isDisposed === 'function' && model.isDisposed())) return;
    const registry: EditorCoreRuleRegistryPort | null | undefined = getRuleRegistry();
    if (!registry || !monacoRef) return;

    // Master switch: when diagnostics are globally off, clear markers and stop.
    const diagnosticSettings = state.diagnosticsSettings;
    if (diagnosticSettings && diagnosticSettings.enabled === false) {
      monacoRef.editor.setModelMarkers(model, 'syntax', []);
      refreshDiagnosticsForModel(model);
      return;
    }

    // Large files (>2000 lines): only run lightweight checks.
    const isLarge = model.getLineCount() > 2000;
    const markers = registry.getSyntaxMarkers(model, monacoRef, { largeFile: isLarge });
    monacoRef.editor.setModelMarkers(model, 'syntax', markers);
    refreshDiagnosticsForModel(model);
  }

  function scheduleSyntaxCheck(model: EditorCoreModelPort): void {
    if (disposed || !shouldCheckOnType()) return; // 'save' mode: no live checks
    const uri = model.uri.toString();
    const previous = diagnosticTimers.get(uri);
    if (previous !== undefined) clearTimer(previous);
    const timer = setTimer(() => {
      diagnosticTimers.delete(uri);
      if (!disposed && !(typeof model.isDisposed === 'function' && model.isDisposed())) {
        performSyntaxCheck(model);
      }
    }, diagnosticsDebounceMs());
    diagnosticTimers.set(uri, timer);
  }

  function recheckAll(): void {
    if (disposed || !monacoRef) return;
    monacoRef.editor.getModels().forEach((model) => performSyntaxCheck(model));
  }

  function checkActiveOnSave(): void {
    if (disposed) return;
    const model = state.editor?.getModel() || null;
    if (model) performSyntaxCheck(model);
  }

  function setupSyntaxChecking(): void {
    if (!monacoRef) return;
    addDisposable(lifecycle, monacoRef.editor.onDidCreateModel((model) => {
      addDisposable(lifecycle, model.onDidChangeContent(() => scheduleSyntaxCheck(model)));
      if (typeof model.onWillDispose === 'function') {
        addDisposable(lifecycle, model.onWillDispose(() => {
          const uri = model.uri.toString();
          const timer = diagnosticTimers.get(uri);
          if (timer === undefined) return;
          clearTimer(timer);
          diagnosticTimers.delete(uri);
        }));
      }
      // Initial check runs immediately (no debounce).
      performSyntaxCheck(model);
    }));
  }

  function createEditor(): void {
    if (!monacoRef) return;
    // Define all Monaco themes BEFORE creating the editor so the correct theme
    // is applied immediately (no fallback to vs-dark/vs).
    const theme: EditorCoreThemePort | null | undefined = getTheme();
    if (theme) theme.setMonaco(monacoRef);

    const container = element('container') as HTMLElement;
    const editor = monacoRef.editor.create(container, {
      value: '',
      language: 'plaintext',
      theme: theme ? theme.getCurrentTheme() : 'vs-dark',
      automaticLayout: true,
      // IntelliSense / completion (VSCode-like).
      quickSuggestions: { other: true, comments: false, strings: false },
      quickSuggestionsDelay: 100,
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'smart',
      acceptSuggestionOnCommitCharacter: false,
      tabCompletion: 'on',
      wordBasedSuggestions: 'currentDocument',
      wordBasedSuggestionsOnlyAffectsBrackets: false,
      suggestSelection: 'recentlyUsedByPrefix',
      snippetSuggestions: 'inline',
      parameterHints: { enabled: true, cycle: true },
      suggest: {
        localityBonus: true,
        filterGraceful: true,
        preview: true,
        showWords: true,
        showSnippets: true,
        showFunctions: true,
        showVariables: true,
        showClasses: true,
        showStructs: true,
        showInterfaces: true,
        showEnums: true,
        showModules: true,
        showKeywords: true,
        insertMode: 'insert'
      },
      autoClosingBrackets: 'always',
      autoClosingQuotes: 'always',
      autoSurround: 'languageDefined',
      matchBrackets: 'always',
      formatOnPaste: false,
      renderLineHighlight: 'line'
    });
    state.editor = editor;
    ownedEditor = editor as EditorCoreEditorPort & { dispose?(): void };

    // setMonaco already called above — no need to call it again.
    registerCompletionProviders(monacoRef);

    // Ctrl+S — Save.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyS, () => {
      getWorkspace()?.saveActiveTab?.();
    });

    // F5 — Start/continue debugging.
    editor.addCommand(monacoRef.KeyCode.F5, () => {
      const dap: EditorCoreDapPort | null | undefined = getDap();
      if (!dap) return;
      if (dap.isPaused()) dap.execute('continue');
      else if (!dap.isActive()) dap.start();
    });

    // Ctrl+F5 — Run without debugging.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.F5, () => {
      const projectTasks: EditorCoreProjectTasksPort | null | undefined = getProjectTasks();
      if (projectTasks) projectTasks.runSelected();
      else getRunner()?.runActive();
    });

    // Ctrl+F — Find.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyF, showFindWidget);
    // Ctrl+H — Find and Replace.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyH, showReplaceWidget);
    // Ctrl+D — Quick find.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyD, showFindWidget);
    // Ctrl+Shift+P — Command Palette.
    editor.addCommand(
      monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Shift | monacoRef.KeyCode.KeyP,
      () => getCommands()?.show()
    );
    // Ctrl+, — Settings.
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.Comma, () => {
      getSettings()?.open('local');
    });
    editor.addCommand(monacoRef.KeyMod.Alt | monacoRef.KeyCode.Backslash, () => {
      getAiInline()?.trigger();
    });

    // Model change → mark its owning tab dirty.  Keep this listener separate
    // from syntax checking to preserve the historical event ordering.
    addDisposable(lifecycle, monacoRef.editor.onDidCreateModel((model) => {
      addDisposable(lifecycle, model.onDidChangeContent(() => {
        for (const tab of state.tabs) {
          if (tab.model === model && !tab.dirty) {
            tab.dirty = true;
            const workspace: EditorCoreWorkspacePort | null | undefined = getWorkspace();
            workspace?.updateTabbar?.();
            workspace?.updateTitlebar?.();
          }
        }
      }));
    }));

    // Cursor position → status bar.
    addDisposable(lifecycle, editor.onDidChangeCursorPosition((event) => {
      const model = editor.getModel();
      if (model && state.currentViewMode === 'single') updateStatusBar(model, event.position);
    }));

    // Model change → status bar.
    addDisposable(lifecycle, editor.onDidChangeModel((event: EditorCoreModelChangeEvent) => {
      const model = event.newModel;
      const position = editor.getPosition();
      if (state.currentViewMode === 'single') {
        updateStatusBar(model, position);
        refreshDiagnosticsForModel(model);
      }
    }));

    setupSyntaxChecking();

    // Run output scroll tracking.
    const panelOutput = element('panel-output');
    if (panelOutput) {
      const onScroll = (): void => {
        const isAtBottom = panelOutput.scrollHeight - panelOutput.scrollTop - panelOutput.clientHeight < 50;
        state.autoScrollEnabled = isAtBottom;
      };
      panelOutput.addEventListener('scroll', onScroll);
      lifecycle.add(toDisposable(() => panelOutput.removeEventListener('scroll', onScroll)));
    }

    // Status bar click handlers.
    const lineColumn = element('status-linecol');
    if (lineColumn) {
      lineColumn.classList.add('clickable');
      const onClick = (): void => state.editor?.trigger('keyboard', 'editor.action.gotoLine');
      lineColumn.addEventListener('click', onClick);
      lifecycle.add(toDisposable(() => lineColumn.removeEventListener('click', onClick)));
    }

    const language = element('status-language');
    if (language) {
      language.classList.add('clickable');
      const onClick = (): void => state.editor?.trigger('keyboard', 'editor.action.changeLanguageMode');
      language.addEventListener('click', onClick);
      lifecycle.add(toDisposable(() => language.removeEventListener('click', onClick)));
    }

    const indent = element('status-indent');
    if (indent) {
      indent.classList.add('clickable');
      const onClick = (): void => {
        const currentModel = state.editor?.getModel();
        if (!currentModel) return;
        const options = currentModel.getOptions();
        if (options.insertSpaces) currentModel.updateOptions?.({ insertSpaces: false });
        else currentModel.updateOptions?.({ insertSpaces: true, tabSize: 4 });
        updateStatusBar(currentModel, state.editor?.getPosition());
      };
      indent.addEventListener('click', onClick);
      lifecycle.add(toDisposable(() => indent.removeEventListener('click', onClick)));
    }

    const errors = element('status-errors');
    if (errors) {
      const onClick = (): void => {
        const problemMatcher = getTaskProblemMatcher();
        if (problemMatcher && typeof problemMatcher.getAllProblems === 'function' && problemMatcher.getAllProblems().length) {
          switchToPanel?.('problems');
          return;
        }
        showFindWidget();
        state.editor?.trigger('keyboard', 'editor.action.marker.next');
      };
      errors.addEventListener('click', onClick);
      lifecycle.add(toDisposable(() => errors.removeEventListener('click', onClick)));
    }

    // Initial status bar.
    updateStatusBar(null, null);
    updateDiagnosticsStatus();

    // Hide the editor container until a file is opened; otherwise Monaco shows
    // an empty model with the first line highlighted.
    getWorkspace()?.updateEmptyState?.();
  }

  function loadDiagnosticsSettings(): void {
    const diagnosticsSettings = getDiagnosticsSettings();
    if (!diagnosticsSettings || typeof diagnosticsSettings.load !== 'function') return;
    diagnosticsSettings.load();
  }

  function initEditor(monaco: EditorCoreMonacoPort): void {
    if (disposed || initialized) return;
    monacoRef = monaco;
    getWorkspaceSettings()?.setMonaco?.(monacoRef);
    createEditor();
    if (state.editor) getWorkspaceSettings()?.attachEditor?.(state.editor);
    // Load diagnostics settings in the background (defaults apply until
    // loaded, then every model is re-checked with the user's config).
    loadDiagnosticsSettings();
    getDiagnosticsSettings()?.init?.();
    initialized = true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    for (const timer of diagnosticTimers.values()) clearTimer(timer);
    diagnosticTimers.clear();
    lifecycle.dispose();
    const editor = ownedEditor;
    ownedEditor = null;
    if (editor && typeof editor.dispose === 'function') editor.dispose();
    if (state.editor === editor) state.editor = null;
    monacoRef = null;
  }

  const facade: EditorCoreFacade = {
    init: initEditor,
    updateStatusBar,
    updateDiagnosticsStatus,
    refreshDiagnosticsForModel,
    showFindWidget,
    showReplaceWidget,
    recheckAll,
    checkActiveOnSave
  };
  const service: EditorCoreService = {
    ...facade,
    get disposed(): boolean { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
