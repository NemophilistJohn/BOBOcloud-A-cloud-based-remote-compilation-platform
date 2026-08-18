// src/ai-context.js — Context gathering for AI chat and inline completions
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function chatContextPolicy() {
    return S.ai && S.ai.chat && S.ai.chat.context ? S.ai.chat.context : {};
  }

  function inlineContextPolicy() {
    return S.ai && S.ai.inline && S.ai.inline.context ? S.ai.inline.context : {};
  }

  function boundedText(value, limit, keep) {
    value = String(value || '');
    limit = Math.max(0, Math.floor(Number(limit) || 0));
    if (BOBO.aiPrompts && BOBO.aiPrompts.truncate) return BOBO.aiPrompts.truncate(value, limit, keep || 'middle');
    if (value.length <= limit) return value;
    if (!limit) return '';
    return keep === 'tail' ? value.slice(-limit) : value.slice(0, limit);
  }

  // ──── Current File Context ────
  function getCurrentFileContext() {
    if (S.ai.autoContextDisabled) return null;
    var tab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (!tab) return null;
    if ((S.ai.excludedAutoContextPaths || []).indexOf(tab.path) >= 0) return null;

    var ctx = {
      path: tab.path,
      name: tab.name,
      language: tab.language || 'plaintext',
      content: '',
      totalLines: 0,
      model: tab.model
    };

    if (tab.model && tab.language !== 'image') {
      var content = tab.model.getValue();
      ctx.totalLines = tab.model.getLineCount();
      ctx.content = boundedText(content, chatContextPolicy().currentFileChars, 'middle');
    }

    return ctx;
  }

  // ──── Selection Context ────
  function getSelectionContext() {
    if (S.ai.autoContextDisabled) return null;
    var editor = S.editor;
    if (S.currentViewMode === 'split' && S.splitEditor) {
      editor = S.splitEditor.rightEditor;
    }

    if (!editor) return null;

    var selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return null;

    var model = editor.getModel();
    if (!model) return null;

    var text = model.getValueInRange(selection);
    if (!text || text.trim().length === 0) return null;

    var trimmed = boundedText(text, chatContextPolicy().selectionChars, 'middle');

    return {
      text: trimmed,
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      totalChars: text.length
    };
  }

  // ──── Project Structure Context ────
  function getProjectContext() {
    if (S.ai.autoContextDisabled) return null;
    if (!S.workspaceRoot) return null;

    var parts = [];
    parts.push('Workspace: ' + S.workspaceRoot);

    // Gather file tree info from DOM
    var treeEl = document.getElementById('file-tree');
    if (treeEl) {
      var allRows = treeEl.querySelectorAll('.tree-row[data-type="file"]');
      var fileCount = allRows.length;
      parts.push('Total files: ' + fileCount);

      // Group by extension
      var extCount = {};
      for (var i = 0; i < allRows.length; i++) {
        var name = allRows[i].getAttribute('data-name');
        if (!name) continue;
        var ext = name.split('.').pop().toLowerCase();
        if (ext === name) ext = '(no extension)';
        extCount[ext] = (extCount[ext] || 0) + 1;
      }

      // Show top extensions (sorted)
      var sorted = Object.keys(extCount).sort(function(a, b) {
        return extCount[b] - extCount[a];
      });

      if (sorted.length > 0) {
        parts.push('File types:');
        var shown = 0;
        for (var j = 0; j < sorted.length && shown < 15; j++) {
          parts.push('  - .' + sorted[j] + ': ' + extCount[sorted[j]] + ' files');
          shown++;
        }
      }

      // List top-level folder structure (first 150 items)
      var rootUl = treeEl.querySelector('ul');
      if (rootUl) {
        var topItems = rootUl.querySelectorAll(':scope > li > .tree-row');
        var itemsShown = 0;
        for (var k = 0; k < topItems.length && itemsShown < 150; k++) {
          var row = topItems[k];
          var itemName = row.getAttribute('data-name');
          var itemType = row.getAttribute('data-type');
          var prefix = itemType === 'folder' ? '[dir] ' : '[file] ';
          parts.push(prefix + itemName);
          itemsShown++;
        }
      }
    }

    return boundedText(parts.join('\n'), chatContextPolicy().projectChars, 'middle');
  }

  // ──── Open Tabs Context ────
  function getActiveTabContexts() {
    if (S.ai.autoContextDisabled) return [];
    var tabs = [];
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i];
      var info = {
        name: t.name,
        path: t.path,
        language: t.language || 'plaintext',
        lines: 0
      };
      if (t.model && t.language !== 'image') {
        info.lines = t.model.getLineCount();
      }
      tabs.push(info);
    }
    return tabs;
  }

  // ──── Full Context Builder ────
  function buildFullContext() {
    return {
      currentFile: getCurrentFileContext(),
      selection: getSelectionContext(),
      projectStructure: getProjectContext(),
      openTabs: getActiveTabContexts(),
      referencedFiles: (S.ai.referencedFiles || []).map(function(f) {
        return { path: f.path, name: f.name };
      })
    };
  }

  // ──── Inline Completion Context ────
  function getInlineContext(requestModel, requestPosition) {
    var editor = S.editor;
    var model = requestModel || (editor && editor.getModel ? editor.getModel() : null);
    if (!model) return null;

    var position = requestPosition || (editor && editor.getPosition ? editor.getPosition() : null);
    if (!position) return null;

    var tab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });

    // Keep the nearest prefix and suffix. ai-service applies a second hard
    // budget before transport so a provider can never receive an entire file.
    var fullValue = model.getValue();
    var offset = model.getOffsetAt(position);
    var codeBefore = fullValue.substring(0, offset);
    var codeAfter = fullValue.substring(offset);

    var policy = inlineContextPolicy();
    var rawPrefixChars = policy.prefixChars !== undefined ? policy.prefixChars : S.ai.inlinePrefixChars;
    var parsedPrefixChars = Number(rawPrefixChars);
    var prefixChars = Math.max(500, Math.min(16000, Number.isFinite(parsedPrefixChars) ? parsedPrefixChars : 6000));
    var rawSuffixChars = policy.suffixChars !== undefined ? policy.suffixChars : S.ai.inlineSuffixChars;
    var parsedSuffixChars = rawSuffixChars === undefined || rawSuffixChars === null || rawSuffixChars === ''
      ? 2500
      : Number(rawSuffixChars);
    var suffixChars = Math.max(0, Math.min(8000, Number.isFinite(parsedSuffixChars) ? parsedSuffixChars : 2500));
    var ctxBefore = codeBefore.length > prefixChars
      ? codeBefore.substring(codeBefore.length - prefixChars)
      : codeBefore;
    var ctxAfter = codeAfter.length > suffixChars
      ? codeAfter.substring(0, suffixChars)
      : codeAfter;

    return {
      codeBefore: ctxBefore,
      codeAfter: ctxAfter,
      language: tab ? tab.language : model.getLanguageId(),
      fileName: tab ? tab.name : 'untitled',
      position: { line: position.lineNumber, column: position.column },
      version: typeof model.getVersionId === 'function' ? model.getVersionId() : 0
    };
  }

  BOBO.aiContext = {
    getCurrentFileContext: getCurrentFileContext,
    getSelectionContext: getSelectionContext,
    getProjectContext: getProjectContext,
    getActiveTabContexts: getActiveTabContexts,
    buildFullContext: buildFullContext,
    getInlineContext: getInlineContext
  };
})(window);
