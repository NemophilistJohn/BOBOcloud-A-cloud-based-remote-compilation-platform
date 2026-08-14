// src/editor-core.js — Monaco editor, keyboard commands, status bar, diagnostics
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var monacoRef = null;

  function isExpectedMonacoCancellation(reason) {
    if (!reason || reason.name !== 'Canceled' || reason.message !== 'Canceled') return false;
    var stack = String(reason.stack || '');
    return /[\\/]monaco-editor[\\/].*[\\/]vs[\\/].*editor\.api/i.test(stack);
  }

  // Monaco's word-highlighter rejects delayed work when a model changes. That
  // cancellation is expected, but some minified builds leave it unhandled.
  global.addEventListener('unhandledrejection', function(event) {
    if (isExpectedMonacoCancellation(event.reason)) event.preventDefault();
  });

  // ──── Status Bar ────
  function updateStatusBar(model, position) {
    if (S.currentViewMode === 'diff') {
      document.getElementById('status-linecol').textContent = 'Diff view';
      document.getElementById('status-language').textContent = 'Diff';
      return;
    }

    if (!model) {
      document.getElementById('status-linecol').textContent = 'Ln --, Col --';
      document.getElementById('status-language').textContent = '--';
      return;
    }

    if (position) {
      document.getElementById('status-linecol').textContent =
        'Ln ' + position.lineNumber + ', Col ' + position.column;
    }

    var langId = model.getLanguageId();
    document.getElementById('status-language').textContent = BOBO.langDisplayName(langId);

    var opts = model.getOptions();
    if (opts.insertSpaces) {
      document.getElementById('status-indent').textContent = 'Spaces: ' + opts.tabSize;
    } else {
      document.getElementById('status-indent').textContent = 'Tab Size: ' + opts.tabSize;
    }
  }

  function updateDiagnosticsStatus() {
    var el = document.getElementById('status-errors');
    var translate = BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t : function(source) { return source; };
    var d = S.currentDiagnostics;
    if (d.errors > 0 && d.warnings > 0) {
      el.textContent = '⚠ ' + translate('{errors} errors, {warnings} warnings', d);
      el.style.color = '#f44747';
    } else if (d.errors > 0) {
      el.textContent = '✖ ' + translate('{errors} errors', d);
      el.style.color = '#f44747';
    } else if (d.warnings > 0) {
      el.textContent = '⚠ ' + translate('{warnings} warnings', d);
      el.style.color = '#e5c07b';
    } else {
      el.textContent = '✓ ' + translate('No problems');
      el.style.color = '';
    }
    el.title = translate('Errors: {errors}, Warnings: {warnings}, Info: {infos}', d);
  }

  function refreshDiagnosticsForModel(model) {
    if (!monacoRef || !model || !S.editor || S.editor.getModel() !== model) return;
    var markers = monacoRef.editor.getModelMarkers({ resource: model.uri });
    var errCount = 0, warnCount = 0, infoCount = 0;
    for (var i = 0; i < markers.length; i++) {
      if (markers[i].severity === monacoRef.MarkerSeverity.Error) errCount++;
      else if (markers[i].severity === monacoRef.MarkerSeverity.Warning) warnCount++;
      else infoCount++;
    }
    S.currentDiagnostics = { errors: errCount, warnings: warnCount, infos: infoCount };
    updateDiagnosticsStatus();
  }

  // ──── Find / Replace ────
  function showFindWidget() {
    if (S.editor) S.editor.trigger('keyboard', 'actions.find');
  }

  function showReplaceWidget() {
    if (S.editor) S.editor.trigger('keyboard', 'editor.action.startFindReplaceAction');
  }

  // ──── Diagnostics (optimized: debounced + large file skip) ────
  var diagTimers = {}; // model URI → debounce timer ID

  function performSyntaxCheck(model) {
    if (!model || (typeof model.isDisposed === 'function' && model.isDisposed())) return;
    var registry = window.editorRuleRegistry;
    if (!registry) return;

    // Master switch: when diagnostics are globally off, clear markers and stop.
    var ds = S.diagnosticsSettings;
    if (ds && ds.enabled === false) {
      monacoRef.editor.setModelMarkers(model, 'syntax', []);
      refreshDiagnosticsForModel(model);
      return;
    }

    // Large files (>2000 lines): only run lightweight checks
    var lineCount = model.getLineCount();
    var isLarge = lineCount > 2000;

    var checkOptions = { largeFile: isLarge };
    var markers = registry.getSyntaxMarkers(model, monacoRef, checkOptions);
    monacoRef.editor.setModelMarkers(model, 'syntax', markers);

    refreshDiagnosticsForModel(model);
  }

  function getDebounceMs() {
    var s = S.diagnosticsSettings;
    if (s && typeof s.debounceMs === 'number' && s.debounceMs >= 0) return s.debounceMs;
    return 300;
  }
  function shouldCheckOnType() {
    var s = S.diagnosticsSettings;
    return !s || s.checkOn !== 'save';
  }

  function scheduleSyntaxCheck(model) {
    if (!shouldCheckOnType()) return; // 'save' mode: no live checks
    var uri = model.uri.toString();
    if (diagTimers[uri]) {
      clearTimeout(diagTimers[uri]);
    }
    diagTimers[uri] = setTimeout(function() {
      delete diagTimers[uri];
      if (typeof model.isDisposed === 'function' && model.isDisposed()) return;
      performSyntaxCheck(model);
    }, getDebounceMs());
  }

  // Re-run diagnostics on every open model (used after settings change).
  function recheckAll() {
    if (!monacoRef) return;
    monacoRef.editor.getModels().forEach(function(m) { performSyntaxCheck(m); });
  }

  // Run on the active model only (used for 'checkOn: save' mode).
  function checkActiveOnSave() {
    var model = S.editor && S.editor.getModel();
    if (model) performSyntaxCheck(model);
  }

  function setupSyntaxChecking() {
    monacoRef.editor.onDidCreateModel(function(model) {
      model.onDidChangeContent(function() { scheduleSyntaxCheck(model); });
      if (typeof model.onWillDispose === 'function') {
        model.onWillDispose(function() {
          var uri = model.uri.toString();
          if (!diagTimers[uri]) return;
          clearTimeout(diagTimers[uri]);
          delete diagTimers[uri];
        });
      }
      // Initial check runs immediately (no debounce)
      performSyntaxCheck(model);
    });
  }

  // ──── Editor Creation ────
  function createEditor() {
    // Define all Monaco themes BEFORE creating the editor so the correct
    // theme is applied immediately (no fallback to vs-dark/vs).
    if (window.themeManager) window.themeManager.setMonaco(monacoRef);

    S.editor = monacoRef.editor.create(document.getElementById('container'), {
      value: '',
      language: 'plaintext',
      theme: window.themeManager ? window.themeManager.getCurrentTheme() : 'vs-dark',
      automaticLayout: true,
      // ── IntelliSense / completion (VSCode-like) ──
      quickSuggestions: { other: true, comments: false, strings: false }, // pop up while typing identifiers
      quickSuggestionsDelay: 100,
      suggestOnTriggerCharacters: true,        // pop up on language-specific triggers
      acceptSuggestionOnEnter: 'smart',        // do not turn an unrelated suggestion into an accidental newline replacement
      acceptSuggestionOnCommitCharacter: false,
      tabCompletion: 'on',                     // Tab accepts + navigates snippet placeholders
      wordBasedSuggestions: 'currentDocument', // suggest words from the current doc (safety net for own variables)
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
      renderLineHighlight: 'line'   // highlight current line with theme color
    });

    // setMonaco already called above — no need to call again.
    // Register completions
    window.registerCompletionProviders();

    // ── Keyboard shortcuts ──
    // Ctrl+S — Save
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyS, function() {
      if (BOBO.workspace && BOBO.workspace.saveActiveTab) BOBO.workspace.saveActiveTab();
    });

    // F5 - Start/continue debugging
    S.editor.addCommand(monacoRef.KeyCode.F5, function() {
      if (!BOBO.dap) return;
      if (BOBO.dap.isPaused()) BOBO.dap.execute('continue');
      else if (!BOBO.dap.isActive()) BOBO.dap.start();
    });

    // Ctrl+F5 - Run without debugging
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.F5, function() {
      if (BOBO.projectTasks) BOBO.projectTasks.runSelected();
      else BOBO.runner.runActive();
    });

    // Ctrl+F — Find
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyF, showFindWidget);

    // Ctrl+H — Find and Replace
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyH, showReplaceWidget);

    // Ctrl+D — Quick find
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyD, showFindWidget);

    // Ctrl+Shift+P - Command Palette
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyMod.Shift | monacoRef.KeyCode.KeyP, function() {
      if (BOBO.commands) BOBO.commands.show();
    });

    // Ctrl+, - Settings
    S.editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.Comma, function() {
      if (BOBO.settings) BOBO.settings.open('local');
    });

    S.editor.addCommand(monacoRef.KeyMod.Alt | monacoRef.KeyCode.Backslash, function() {
      if (BOBO.aiInline) BOBO.aiInline.trigger();
    });

    // ── Event listeners ──
    monacoRef.editor.onDidCreateModel(function(model) {
      model.onDidChangeContent(function() {
        for (var i = 0; i < S.tabs.length; i++) {
          var t = S.tabs[i];
          if (t.model === model && !t.dirty) {
            t.dirty = true;
            if (BOBO.workspace) {
              BOBO.workspace.updateTabbar();
              BOBO.workspace.updateTitlebar();
            }
          }
        }
      });
    });

    // Cursor position → Status bar
    S.editor.onDidChangeCursorPosition(function(e) {
      var model = S.editor.getModel();
      if (model && S.currentViewMode === 'single') {
        updateStatusBar(model, e.position);
      }
    });

    // Model change → Status bar
    S.editor.onDidChangeModel(function(e) {
      var model = e.newModel;
      var position = S.editor.getPosition();
      if (S.currentViewMode === 'single') {
        updateStatusBar(model, position);
        refreshDiagnosticsForModel(model);
      }
    });

    // Setup syntax checking
    setupSyntaxChecking();

    // Run output scroll tracking
    var panelOutput = document.getElementById('panel-output');
    if (panelOutput) {
      panelOutput.addEventListener('scroll', function() {
        var isAtBottom = panelOutput.scrollHeight - panelOutput.scrollTop - panelOutput.clientHeight < 50;
        S.autoScrollEnabled = isAtBottom;
      });
    }

    // ── Status bar click handlers ──
    var linecolEl = document.getElementById('status-linecol');
    linecolEl.classList.add('clickable');
    linecolEl.addEventListener('click', function() {
      if (S.editor) S.editor.trigger('keyboard', 'editor.action.gotoLine');
    });

    var langEl = document.getElementById('status-language');
    langEl.classList.add('clickable');
    langEl.addEventListener('click', function() {
      if (S.editor) S.editor.trigger('keyboard', 'editor.action.changeLanguageMode');
    });

    var indentEl = document.getElementById('status-indent');
    indentEl.classList.add('clickable');
    indentEl.addEventListener('click', function() {
      var model = S.editor.getModel();
      if (!model) return;
      var opts = model.getOptions();
      if (opts.insertSpaces) {
        model.updateOptions({ insertSpaces: false });
      } else {
        model.updateOptions({ insertSpaces: true, tabSize: 4 });
      }
      updateStatusBar(model, S.editor.getPosition());
    });

    var errorsEl = document.getElementById('status-errors');
    errorsEl.addEventListener('click', function() {
      showFindWidget();
      S.editor.trigger('keyboard', 'editor.action.marker.next');
    });

    // Initial status bar
    updateStatusBar(null, null);
    updateDiagnosticsStatus();

    // Hide the editor container until a file is opened; otherwise Monaco
    // shows an empty model with the first line highlighted.
    if (BOBO.workspace && BOBO.workspace.updateEmptyState) {
      BOBO.workspace.updateEmptyState();
    }
  }

  function loadDiagnosticsSettings() {
    if (!global.api || !global.api.readDiagnosticsSettings) return;
    global.api.readDiagnosticsSettings().then(function (s) {
      S.diagnosticsSettings = s;
      var reg = global.editorRuleRegistry;
      if (reg) reg.setDiagnosticsSettings(s);
      // apply to any models that were checked before settings loaded
      recheckAll();
    }).catch(function (e) { console.error('Load diagnostics settings:', e); });
  }

  function initEditor(monaco) {
    monacoRef = monaco;
    createEditor();
    // Load diagnostics settings in the background (defaults apply until loaded,
    // then every model is re-checked with the user's config).
    loadDiagnosticsSettings();
    if (BOBO.diagnosticsSettings && BOBO.diagnosticsSettings.init) BOBO.diagnosticsSettings.init();
  }

  BOBO.editorCore = {
    init: initEditor,
    updateStatusBar: updateStatusBar,
    updateDiagnosticsStatus: updateDiagnosticsStatus,
    refreshDiagnosticsForModel: refreshDiagnosticsForModel,
    showFindWidget: showFindWidget,
    showReplaceWidget: showReplaceWidget,
    recheckAll: recheckAll,
    checkActiveOnSave: checkActiveOnSave
  };
})(window);
