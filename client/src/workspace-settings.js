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
  var RENDER_WHITESPACE_VALUES = new Set(['none', 'boundary', 'selection', 'trailing', 'all']);
  var EDITOR_FIELDS = [
    'wordWrap', 'wordWrapColumn', 'rulers', 'renderWhitespace',
    'minimapEnabled', 'bracketPairColorizationEnabled'
  ];

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
      settings: { editor: {}, languages: {}, associations: [], files: { exclude: [] } },
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
    if (Number.isInteger(value.wordWrapColumn) && value.wordWrapColumn >= 1 && value.wordWrapColumn <= 1000) result.wordWrapColumn = value.wordWrapColumn;
    if (Array.isArray(value.rulers) && value.rulers.length <= 32 && value.rulers.every(function(column) {
      return Number.isInteger(column) && column >= 1 && column <= 1000;
    })) result.rulers = value.rulers.slice();
    if (typeof value.renderWhitespace === 'string' && RENDER_WHITESPACE_VALUES.has(value.renderWhitespace)) {
      result.renderWhitespace = value.renderWhitespace;
    }
    if (typeof value.minimapEnabled === 'boolean') result.minimapEnabled = value.minimapEnabled;
    if (typeof value.bracketPairColorizationEnabled === 'boolean') {
      result.bracketPairColorizationEnabled = value.bracketPairColorizationEnabled;
    }
    return result;
  }

  function normalizeExcludeRules(value) {
    var rules = [];
    if (!isRecord(value) || !Array.isArray(value.exclude)) return rules;
    value.exclude.slice(0, 128).forEach(function(rule) {
      if (!isRecord(rule) || typeof rule.pattern !== 'string' || rule.pattern.length > 256 ||
          typeof rule.regexp !== 'string' || rule.regexp.length > 4096 || (rule.flags !== '' && rule.flags !== 'i')) return;
      try {
        rules.push({ pattern: rule.pattern, regexp: rule.regexp, flags: rule.flags, matcher: new RegExp(rule.regexp, rule.flags) });
      } catch (_) {}
    });
    return rules;
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
    var files = { exclude: normalizeExcludeRules(raw.settings.files) };
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
        associations: associations,
        files: files
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

  function configValue(key, languageId) {
    var names = {
      'editor.tabSize': 'tabSize',
      'editor.insertSpaces': 'insertSpaces',
      'editor.wordWrap': 'wordWrap',
      'editor.wordWrapColumn': 'wordWrapColumn',
      'editor.renderWhitespace': 'renderWhitespace',
      'editor.minimap.enabled': 'minimapEnabled',
      'editor.bracketPairColorization.enabled': 'bracketPairColorizationEnabled'
    };
    var field = names[String(key || '')];
    if (!field) return undefined;
    var effective = effectiveEditorSettings(languageId || 'plaintext');
    return effective[field];
  }

  function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  function relativeWorkspacePath(value) {
    var target = normalizedPath(value);
    var root = normalizedPath(S.workspaceRoot);
    if (!target || !root) return target;
    if (target === root) return '';
    if (target.indexOf(root + '/') === 0) return target.slice(root.length + 1);
    return target;
  }

  function isPathExcluded(value) {
    var relative = relativeWorkspacePath(value);
    if (!relative) return false;
    var snapshot = S.workspaceSettings || emptySnapshot();
    var files = snapshot.settings.files || {};
    var rules = Array.isArray(files.exclude) ? files.exclude : [];
    for (var i = 0; i < rules.length; i++) {
      rules[i].matcher.lastIndex = 0;
      if (rules[i].matcher.test(relative)) return true;
    }
    return false;
  }

  function filterTreeChildren(children) {
    return Array.isArray(children) ? children.filter(function(node) {
      return node && !isPathExcluded(node.path);
    }) : [];
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

  function editorValue(options, field) {
    if (field === 'minimapEnabled') return options.minimap && typeof options.minimap.enabled === 'boolean' ? options.minimap.enabled : undefined;
    if (field === 'bracketPairColorizationEnabled') {
      return options.bracketPairColorization && typeof options.bracketPairColorization.enabled === 'boolean'
        ? options.bracketPairColorization.enabled
        : undefined;
    }
    return options[field];
  }

  function validEditorValue(field, value) {
    if (field === 'wordWrap') return WORD_WRAP_VALUES.has(value);
    if (field === 'wordWrapColumn') return Number.isInteger(value) && value >= 1 && value <= 1000;
    if (field === 'rulers') return Array.isArray(value);
    if (field === 'renderWhitespace') return RENDER_WHITESPACE_VALUES.has(value);
    return typeof value === 'boolean';
  }

  function cloneEditorValue(value) {
    return Array.isArray(value) ? value.slice() : value;
  }

  function editorUpdate(field, value) {
    if (field === 'minimapEnabled') return { minimap: { enabled: value } };
    if (field === 'bracketPairColorizationEnabled') return { bracketPairColorization: { enabled: value } };
    var update = {};
    update[field] = cloneEditorValue(value);
    return update;
  }

  function baselineForEditor(editor) {
    var baseline = editorDefaults.get(editor);
    if (baseline) return baseline;
    var options = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
    baseline = {
      wordWrap: WORD_WRAP_VALUES.has(options.wordWrap) ? options.wordWrap : 'off',
      wordWrapColumn: Number.isInteger(options.wordWrapColumn) ? options.wordWrapColumn : 80,
      rulers: Array.isArray(options.rulers) ? options.rulers.slice() : [],
      renderWhitespace: RENDER_WHITESPACE_VALUES.has(options.renderWhitespace) ? options.renderWhitespace : 'selection',
      minimapEnabled: options.minimap && typeof options.minimap.enabled === 'boolean' ? options.minimap.enabled : true,
      bracketPairColorizationEnabled: options.bracketPairColorization && typeof options.bracketPairColorization.enabled === 'boolean'
        ? options.bracketPairColorization.enabled
        : true
    };
    editorDefaults.set(editor, baseline);
    return baseline;
  }

  function updateEditorOptions(editor) {
    if (!editor || typeof editor.updateOptions !== 'function') return;
    var model = typeof editor.getModel === 'function' ? editor.getModel() : null;
    var languageId = model && typeof model.getLanguageId === 'function' ? model.getLanguageId() : 'plaintext';
    var settings = effectiveEditorSettings(languageId);
    var previous = editorControlled.get(editor) || {};
    var next = {};
    var baseline = baselineForEditor(editor);
    var raw = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
    EDITOR_FIELDS.forEach(function(field) {
      var current = editorValue(raw, field);
      if (settings[field] !== undefined) {
        if (!previous[field] && validEditorValue(field, current)) baseline[field] = cloneEditorValue(current);
        editor.updateOptions(editorUpdate(field, settings[field]));
        next[field] = true;
      } else if (previous[field]) {
        editor.updateOptions(editorUpdate(field, baseline[field]));
      } else if (validEditorValue(field, current)) {
        baseline[field] = cloneEditorValue(current);
      }
    });
    editorControlled.set(editor, next);
  }

  function applyActiveEditors() {
    updateEditorOptions(S.editor);
    if (S.splitEditor) {
      updateEditorOptions(S.splitEditor);
      updateEditorOptions(S.splitEditor.rightEditor);
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
    var previousRules = S.workspaceSettings && S.workspaceSettings.settings && S.workspaceSettings.settings.files
      ? S.workspaceSettings.settings.files.exclude
      : [];
    S.workspaceSettings = snapshot;
    applyAll();
    var nextRules = snapshot.settings.files.exclude;
    var changed = JSON.stringify(previousRules.map(function(rule) { return [rule.pattern, rule.regexp, rule.flags]; })) !==
      JSON.stringify(nextRules.map(function(rule) { return [rule.pattern, rule.regexp, rule.flags]; }));
    if (changed && S.workspaceTree && BOBO.workspace && typeof BOBO.workspace.renderTree === 'function') {
      BOBO.workspace.renderTree(S.workspaceTree);
    }
    if (changed && BOBO.fileSearch && typeof BOBO.fileSearch.refreshCache === 'function') {
      BOBO.fileSearch.refreshCache(true);
    }
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
      updateEditorOptions(editor);
      return;
    }
    attachedEditors.add(editor);
    if (typeof editor.onDidChangeModel === 'function') {
      editor.onDidChangeModel(function(event) {
        if (event && event.newModel) applyModel(event.newModel);
        updateEditorOptions(editor);
      });
    }
    updateEditorOptions(editor);
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
    effectiveEditorSettings: effectiveEditorSettings,
    configValue: configValue,
    isPathExcluded: isPathExcluded,
    filterTreeChildren: filterTreeChildren
  };
})(window);
