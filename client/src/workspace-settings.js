// src/workspace-settings.js - Applies the validated .vscode/settings.json subset.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var monacoRef = null;
  var modelDefaults = new WeakMap();
  var modelControlled = new WeakMap();
  var editorDefaults = new WeakMap();
  var editorControlled = new WeakMap();
  var attachedEditors = new WeakSet();
  var subscriptionsInstalled = false;
  var KNOWN_LANGUAGE_IDS = new Set([
    'c', 'cpp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'less',
    'markdown', 'php', 'plaintext', 'python', 'ruby', 'rust', 'scss', 'shell',
    'sql', 'typescript', 'xml', 'yaml'
  ]);
  var WORD_WRAP_VALUES = new Set(['off', 'on', 'wordWrapColumn', 'bounded']);

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.keys(value).forEach(function(key) { deepFreeze(value[key]); });
    return value;
  }

  function emptySnapshot() {
    return deepFreeze({
      schemaVersion: 1,
      rootPath: null,
      workspaceIdentity: null,
      settings: { editor: {}, languages: {}, associations: [] },
      warnings: []
    });
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeEditorSettings(value) {
    var result = {};
    if (!isRecord(value)) return result;
    if (Number.isInteger(value.tabSize) && value.tabSize >= 1 && value.tabSize <= 16) result.tabSize = value.tabSize;
    if (typeof value.insertSpaces === 'boolean') result.insertSpaces = value.insertSpaces;
    if (typeof value.wordWrap === 'string' && WORD_WRAP_VALUES.has(value.wordWrap)) result.wordWrap = value.wordWrap;
    return result;
  }

  function normalizeSnapshot(raw) {
    if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.rootPath !== 'string' ||
        !Number.isInteger(raw.workspaceIdentity) || !isRecord(raw.settings)) return null;
    var languages = {};
    if (isRecord(raw.settings.languages)) {
      Object.keys(raw.settings.languages).forEach(function(languageId) {
        if (KNOWN_LANGUAGE_IDS.has(languageId)) languages[languageId] = normalizeEditorSettings(raw.settings.languages[languageId]);
      });
    }
    var associations = [];
    if (Array.isArray(raw.settings.associations)) {
      raw.settings.associations.forEach(function(association) {
        if (!isRecord(association) || typeof association.pattern !== 'string' ||
            !/^\*\.[a-z0-9][a-z0-9_+-]*(?:\.[a-z0-9][a-z0-9_+-]*){0,3}$/.test(association.pattern) ||
            !KNOWN_LANGUAGE_IDS.has(association.languageId)) return;
        associations.push({ pattern: association.pattern, languageId: association.languageId });
      });
    }
    var warnings = [];
    if (Array.isArray(raw.warnings)) {
      raw.warnings.forEach(function(warning) {
        if (!isRecord(warning) || typeof warning.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(warning.code)) return;
        warnings.push({ code: warning.code, count: Math.max(1, Math.min(10000, Number(warning.count) || 1)) });
      });
    }
    return deepFreeze({
      schemaVersion: 1,
      rootPath: raw.rootPath,
      workspaceIdentity: raw.workspaceIdentity,
      settings: {
        editor: normalizeEditorSettings(raw.settings.editor),
        languages: languages,
        associations: associations
      },
      warnings: warnings
    });
  }

  function fileName(value) {
    var parts = String(value || '').replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || '';
  }

  function associatedLanguage(name) {
    var snapshot = S.workspaceSettings || emptySnapshot();
    var lowerName = fileName(name).toLowerCase();
    var associations = snapshot.settings.associations || [];
    for (var i = 0; i < associations.length; i++) {
      var suffix = associations[i].pattern.slice(1);
      if (lowerName.endsWith(suffix)) return associations[i].languageId;
    }
    return '';
  }

  function languageForFile(name, fallback) {
    return associatedLanguage(name) || fallback;
  }

  function effectiveEditorSettings(languageId) {
    var snapshot = S.workspaceSettings || emptySnapshot();
    return Object.assign({}, snapshot.settings.editor || {}, snapshot.settings.languages[languageId] || {});
  }

  function tabForModel(model) {
    for (var i = 0; i < S.tabs.length; i++) {
      if (S.tabs[i].model === model) return S.tabs[i];
    }
    return null;
  }

  function modelFileName(model) {
    var tab = tabForModel(model);
    if (tab) return tab.name;
    var uri = model && model.uri;
    return fileName(uri && (uri.fsPath || uri.path || uri.toString && uri.toString()));
  }

  function baselineForModel(model) {
    var baseline = modelDefaults.get(model);
    if (baseline) return baseline;
    var options = model.getOptions ? model.getOptions() : {};
    baseline = {
      tabSize: Number.isInteger(options.tabSize) ? options.tabSize : 4,
      insertSpaces: typeof options.insertSpaces === 'boolean' ? options.insertSpaces : true
    };
    modelDefaults.set(model, baseline);
    return baseline;
  }

  function applyModel(model) {
    if (!model || typeof model.getLanguageId !== 'function') return false;
    var name = modelFileName(model);
    var tab = tabForModel(model);
    var languageId = model.getLanguageId();
    if (tab) {
      var detected = BOBO.detectLanguage
        ? BOBO.detectLanguage(name, typeof model.getValue === 'function' ? model.getValue() : '')
        : languageId;
      languageId = languageForFile(name, detected || languageId);
    }
    var languageChanged = languageId && languageId !== model.getLanguageId();
    if (languageChanged && monacoRef && monacoRef.editor && monacoRef.editor.setModelLanguage) {
      monacoRef.editor.setModelLanguage(model, languageId);
    }
    if (tab) {
      tab.language = model.getLanguageId();
      tab.languageFromWorkspaceSettings = Boolean(associatedLanguage(name));
    }
    var baseline = baselineForModel(model);
    var settings = effectiveEditorSettings(model.getLanguageId());
    var previous = modelControlled.get(model) || {};
    var next = {};
    var updates = {};
    var currentOptions = model.getOptions ? model.getOptions() : {};
    ['tabSize', 'insertSpaces'].forEach(function(field) {
      if (settings[field] !== undefined) {
        if (!previous[field] && currentOptions[field] !== undefined) baseline[field] = currentOptions[field];
        updates[field] = settings[field];
        next[field] = true;
      } else if (previous[field]) {
        updates[field] = baseline[field];
      } else if (currentOptions[field] !== undefined) {
        baseline[field] = currentOptions[field];
      }
    });
    modelControlled.set(model, next);
    if (typeof model.updateOptions === 'function' && Object.keys(updates).length) {
      model.updateOptions(updates);
    }
    return languageChanged;
  }

  function baselineForEditor(editor) {
    var baseline = editorDefaults.get(editor);
    if (baseline) return baseline;
    var options = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
    baseline = { wordWrap: WORD_WRAP_VALUES.has(options.wordWrap) ? options.wordWrap : 'off' };
    editorDefaults.set(editor, baseline);
    return baseline;
  }

  function updateEditorWordWrap(editor) {
    if (!editor || typeof editor.updateOptions !== 'function') return;
    var model = typeof editor.getModel === 'function' ? editor.getModel() : null;
    var languageId = model && typeof model.getLanguageId === 'function' ? model.getLanguageId() : 'plaintext';
    var settings = effectiveEditorSettings(languageId);
    var controlled = editorControlled.get(editor) === true;
    var baseline = baselineForEditor(editor);
    var current = typeof editor.getRawOptions === 'function' ? editor.getRawOptions().wordWrap : baseline.wordWrap;
    if (settings.wordWrap !== undefined) {
      if (!controlled && WORD_WRAP_VALUES.has(current)) baseline.wordWrap = current;
      editor.updateOptions({ wordWrap: settings.wordWrap });
      editorControlled.set(editor, true);
    } else if (controlled) {
      editor.updateOptions({ wordWrap: baseline.wordWrap });
      editorControlled.set(editor, false);
    } else if (WORD_WRAP_VALUES.has(current)) {
      baseline.wordWrap = current;
    }
  }

  function applyActiveEditors() {
    updateEditorWordWrap(S.editor);
    if (S.splitEditor) {
      updateEditorWordWrap(S.splitEditor);
      updateEditorWordWrap(S.splitEditor.rightEditor);
    }
  }

  function applySplitModel() {
    if (!S.splitEditor || !S.splitEditor.rightEditor || !monacoRef || !monacoRef.editor) return false;
    var leftModel = typeof S.splitEditor.getModel === 'function' ? S.splitEditor.getModel() : null;
    var rightModel = typeof S.splitEditor.rightEditor.getModel === 'function' ? S.splitEditor.rightEditor.getModel() : null;
    if (!leftModel || !rightModel || typeof leftModel.getLanguageId !== 'function') return false;
    var languageId = leftModel.getLanguageId();
    var changed = typeof rightModel.getLanguageId === 'function' && rightModel.getLanguageId() !== languageId;
    if (changed && monacoRef.editor.setModelLanguage) monacoRef.editor.setModelLanguage(rightModel, languageId);
    applyModel(rightModel);
    return changed;
  }

  function applyAll() {
    if (!monacoRef || !monacoRef.editor) return;
    var languageChanged = false;
    monacoRef.editor.getModels().forEach(function(model) {
      if (applyModel(model)) languageChanged = true;
    });
    if (applySplitModel()) languageChanged = true;
    applyActiveEditors();
    if (S.editor && BOBO.editorCore && BOBO.editorCore.updateStatusBar) {
      BOBO.editorCore.updateStatusBar(S.editor.getModel(), S.editor.getPosition());
    }
    if (languageChanged) {
      if (BOBO.runtime && BOBO.runtime.autoSelectForLanguage && S.editor && S.editor.getModel()) {
        BOBO.runtime.autoSelectForLanguage(S.editor.getModel().getLanguageId());
      }
      if (BOBO.lsp && BOBO.lsp.workspaceChanged) BOBO.lsp.workspaceChanged();
      if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('language');
    }
  }

  function snapshotMatchesWorkspace(snapshot) {
    return snapshot && snapshot.rootPath === S.workspaceRoot && snapshot.workspaceIdentity === S.workspaceIdentity;
  }

  function applySnapshot(raw) {
    var snapshot = normalizeSnapshot(raw);
    if (!snapshotMatchesWorkspace(snapshot)) return false;
    S.workspaceSettings = snapshot;
    applyAll();
    return true;
  }

  async function refreshForWorkspace(rootPath, workspaceIdentity) {
    if (!global.api || typeof global.api.readWorkspaceSettings !== 'function') return false;
    var requested = { rootPath: rootPath, workspaceIdentity: workspaceIdentity };
    if (!snapshotMatchesWorkspace(S.workspaceSettings)) S.workspaceSettings = emptySnapshot();
    try {
      var snapshot = await global.api.readWorkspaceSettings(requested);
      return applySnapshot(snapshot);
    } catch (_) {
      return false;
    }
  }

  function clear() {
    S.workspaceSettings = emptySnapshot();
    applyAll();
  }

  function setMonaco(monaco) {
    if (monacoRef === monaco) return;
    monacoRef = monaco;
    modelDefaults = new WeakMap();
    modelControlled = new WeakMap();
    editorDefaults = new WeakMap();
    editorControlled = new WeakMap();
    attachedEditors = new WeakSet();
    if (monacoRef && monacoRef.editor && monacoRef.editor.onDidCreateModel) {
      monacoRef.editor.onDidCreateModel(function(model) { applyModel(model); });
    }
  }

  function attachEditor(editor) {
    if (!editor) return;
    baselineForEditor(editor);
    if (attachedEditors.has(editor)) {
      updateEditorWordWrap(editor);
      return;
    }
    attachedEditors.add(editor);
    if (typeof editor.onDidChangeModel === 'function') {
      editor.onDidChangeModel(function(event) {
        if (event && event.newModel) applyModel(event.newModel);
        updateEditorWordWrap(editor);
      });
    }
    updateEditorWordWrap(editor);
  }

  function installSubscription() {
    if (subscriptionsInstalled || !global.api || typeof global.api.onWorkspaceSettingsChanged !== 'function') return;
    subscriptionsInstalled = true;
    global.api.onWorkspaceSettingsChanged(function(snapshot) { applySnapshot(snapshot); });
  }

  S.workspaceSettings = S.workspaceSettings || emptySnapshot();
  installSubscription();

  BOBO.workspaceSettings = {
    applySnapshot: applySnapshot,
    refreshForWorkspace: refreshForWorkspace,
    clear: clear,
    setMonaco: setMonaco,
    attachEditor: attachEditor,
    applyAll: applyAll,
    applyModel: applyModel,
    languageForFile: languageForFile,
    effectiveEditorSettings: effectiveEditorSettings
  };
})(window);
