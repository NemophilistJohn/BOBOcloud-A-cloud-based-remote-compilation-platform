// src/ai-inline.js - Monaco inline suggestions with debounce and latest-wins cancellation
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var monacoRef = null;
  var registrations = Object.create(null);
  var sequence = 0;
  var debounceTimer = null;
  var pendingResolve = null;

  function empty() { return { items: [] }; }

  function inlineSettings() {
    var canonical = S.ai && S.ai.inline;
    return canonical && typeof canonical === 'object' ? canonical : {
      enabled: S.ai && S.ai.inlineEnabled === true,
      debounceMs: S.ai && S.ai.inlineDebounceMs
    };
  }

  function cancelPending() {
    sequence += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (pendingResolve) pendingResolve(empty());
    pendingResolve = null;
    if (BOBO.aiService && BOBO.aiService.cancelInline) BOBO.aiService.cancelInline();
  }

  function schedule(model, position, token) {
    cancelPending();
    var requestSequence = sequence;
    var modelVersion = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
    var delay = Math.max(150, Math.min(2000, Number(inlineSettings().debounceMs) || 450));

    return new Promise(function(resolve) {
      pendingResolve = resolve;
      var cancelled = false;
      if (token && token.onCancellationRequested) {
        token.onCancellationRequested(function() {
          cancelled = true;
          if (requestSequence === sequence) cancelPending();
        });
      }
      debounceTimer = setTimeout(async function() {
        debounceTimer = null;
        pendingResolve = null;
        if (cancelled || requestSequence !== sequence || inlineSettings().enabled !== true) return resolve(empty());
        var context = BOBO.aiContext && BOBO.aiContext.getInlineContext
          ? BOBO.aiContext.getInlineContext(model, position)
          : null;
        if (!context) return resolve(empty());

        var result = await BOBO.aiService.getInlineCompletion(context);
        if (cancelled || requestSequence !== sequence || inlineSettings().enabled !== true) return resolve(empty());
        if (modelVersion !== null && typeof model.getVersionId === 'function' && model.getVersionId() !== modelVersion) return resolve(empty());
        if (!result || !result.success || !result.text) return resolve(empty());
        resolve({
          items: [{
            insertText: result.text,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            }
          }]
        });
      }, delay);
    });
  }

  function createProvider() {
    return {
      provideInlineCompletions: function(model, position, context, token) {
        if (!S.ai || inlineSettings().enabled !== true || !BOBO.aiService) return empty();
        var automatic = monacoRef.languages.InlineCompletionTriggerKind.Automatic;
        if (context && context.triggerKind !== automatic) return empty();
        return schedule(model, position, token);
      },
      disposeInlineCompletions: function() {},
      // Kept for Monaco versions that used the earlier provider hook name.
      freeInlineCompletions: function() {}
    };
  }

  function registerForLanguage(language) {
    if (!monacoRef || registrations[language]) return;
    try {
      registrations[language] = monacoRef.languages.registerInlineCompletionsProvider(language, createProvider()) || true;
    } catch (error) {
      console.warn('AI inline provider unavailable for ' + language);
    }
  }

  function registerForAllLanguages() {
    if (!monacoRef) return;
    [
      'python', 'javascript', 'typescript', 'java', 'c', 'cpp', 'go', 'rust',
      'html', 'css', 'json', 'xml', 'yaml', 'markdown', 'sql', 'shell', 'plaintext',
      'ruby', 'php', 'swift', 'kotlin', 'csharp', 'scala', 'lua', 'perl', 'r'
    ].forEach(registerForLanguage);
    if (monacoRef.editor && monacoRef.editor.onDidCreateModel) {
      monacoRef.editor.onDidCreateModel(function(model) { registerForLanguage(model.getLanguageId()); });
    }
  }

  async function setEnabled(enabled) {
    var value = enabled === true;
    if (!BOBO.aiService || typeof BOBO.aiService.updateSettings !== 'function') {
      return { success: false, code: 'ai.error.settingsWrite' };
    }
    if (value && (!S.ai || !S.ai.inlineProfileId)) {
      return { success: false, code: 'ai.error.noModel' };
    }
    var result = await BOBO.aiService.updateSettings({ inline: { enabled: value } });
    if (!result || result.success === false) return result || { success: false, code: 'ai.error.settingsWrite' };
    if (!value) cancelPending();
    return result;
  }

  function trigger() {
    var editor = S.currentViewMode === 'split' && S.splitEditor && S.splitEditor.rightEditor
      ? S.splitEditor.rightEditor
      : S.editor;
    if (!editor || typeof editor.trigger !== 'function') return false;
    editor.trigger('bobo.ai', 'editor.action.inlineSuggest.trigger', {});
    return true;
  }

  function init(monaco) {
    monacoRef = monaco || global.monaco;
    if (!monacoRef) return;
    registerForAllLanguages();
  }

  BOBO.aiInline = {
    init: init,
    setEnabled: setEnabled,
    trigger: trigger,
    cancelPending: cancelPending,
    registerForLanguage: registerForLanguage,
    registerForAllLanguages: registerForAllLanguages,
    _createProvider: createProvider
  };
})(window);
