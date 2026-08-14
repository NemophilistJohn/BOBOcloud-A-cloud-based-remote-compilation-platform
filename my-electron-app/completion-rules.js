// completion-rules.js
// Editor rule registry and shared helpers for per-language plugins.
(function initEditorRuleRegistry(globalScope) {
  const plugins = new Map();
  const completionDisposables = [];

  function createSnippet(label, insertText, kind, monacoInstance, extra = {}) {
    return {
      label,
      kind,
      insertText,
      insertTextRules: monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      ...extra
    };
  }

  function createPlain(label, insertText, kind, extra = {}) {
    return {
      label,
      kind,
      insertText,
      ...extra
    };
  }

  // ──── Marker helpers with severity ────

  /**
   * Push an ERROR marker (red squiggly)
   */
  function pushError(markers, monacoInstance, lineNumber, startColumn, endColumn, message) {
    markers.push({
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: Math.max(1, startColumn),
      endColumn: Math.max(startColumn + 1, endColumn),
      message,
      severity: monacoInstance.MarkerSeverity.Error
    });
  }

  /**
   * Push a WARNING marker (yellow squiggly)
   */
  function pushWarning(markers, monacoInstance, lineNumber, startColumn, endColumn, message) {
    markers.push({
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: Math.max(1, startColumn),
      endColumn: Math.max(startColumn + 1, endColumn),
      message,
      severity: monacoInstance.MarkerSeverity.Warning
    });
  }

  /**
   * Push an INFO marker (blue squiggly)
   */
  function pushInfo(markers, monacoInstance, lineNumber, startColumn, endColumn, message) {
    markers.push({
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: Math.max(1, startColumn),
      endColumn: Math.max(startColumn + 1, endColumn),
      message,
      severity: monacoInstance.MarkerSeverity.Info
    });
  }

  // Legacy compatibility wrapper (defaults to Error)
  function pushMarker(markers, monacoInstance, lineNumber, startColumn, endColumn, message, severity) {
    markers.push({
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: Math.max(1, startColumn),
      endColumn: Math.max(startColumn + 1, endColumn),
      message,
      severity: severity || monacoInstance.MarkerSeverity.Error
    });
  }

  // ──── Balanced pair diagnostics (unchanged core, enhanced return) ────

  function createBalancedPairDiagnostics(content, monacoInstance, options = {}) {
    const markers = [];
    const lines = options.lines || content.split('\n');
    const openToClose = options.pairs || { '(': ')', '[': ']', '{': '}' };
    const closeToOpen = Object.entries(openToClose).reduce((acc, [openChar, closeChar]) => {
      acc[closeChar] = openChar;
      return acc;
    }, {});
    const lineComment = options.lineComment || null;
    const blockComments = options.blockComments || [];
    const quoteChars = new Set(options.quoteChars || ['"', '\'']);
    // settings-aware emit: options.emit(severityWord, line, c1, c2, msg)
    // severityWord ∈ 'error' | 'warning' | 'info'. Falls back to hardcoded helpers.
    const emit = options.emit || function (sev, l, c1, c2, m) {
      if (sev === 'error') pushError(markers, monacoInstance, l, c1, c2, m);
      else if (sev === 'info') pushInfo(markers, monacoInstance, l, c1, c2, m);
      else pushWarning(markers, monacoInstance, l, c1, c2, m);
    };
    const stack = [];
    let blockComment = null;
    let stringState = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      let escaped = false;

      for (let columnIndex = 0; columnIndex < line.length; columnIndex += 1) {
        const char = line[columnIndex];
        const nextChar = line[columnIndex + 1];
        const previousChar = columnIndex > 0 ? line[columnIndex - 1] : '';

        if (blockComment) {
          if (char === blockComment.end[0] && nextChar === blockComment.end[1]) {
            blockComment = null;
            columnIndex += 1;
          }
          continue;
        }

        if (stringState) {
          if (!escaped && char === stringState.quote) {
            stringState = null;
          }
          escaped = !escaped && char === '\\';
          continue;
        }

        if (lineComment) {
          const lineCommentMatches = lineComment.length === 1
            ? char === lineComment
            : char === lineComment[0] && nextChar === lineComment[1];
          if (lineCommentMatches) {
            break;
          }
        }

        const nextBlock = blockComments.find((item) => item.start[0] === char && item.start[1] === nextChar);
        if (nextBlock) {
          blockComment = nextBlock;
          columnIndex += 1;
          continue;
        }

        if (quoteChars.has(char)) {
          const isRustLifetime = options.ignoreRustLifetime
            && char === '\''
            && /[A-Za-z_]/.test(nextChar || '')
            && !/[A-Za-z0-9_]/.test(previousChar || '');

          if (!isRustLifetime) {
            stringState = { quote: char };
            escaped = false;
          }
          continue;
        }

        if (openToClose[char]) {
          stack.push({
            char,
            line: lineIndex + 1,
            column: columnIndex + 1
          });
          continue;
        }

        if (closeToOpen[char]) {
          const last = stack[stack.length - 1];
          if (!last || last.char !== closeToOpen[char]) {
            emit(
              'error',
              lineIndex + 1,
              columnIndex + 1,
              columnIndex + 2,
              `Unexpected closing "${char}"`
            );
          } else {
            stack.pop();
          }
        }
      }
    }

    stack.forEach((item) => {
      emit(
        'warning',
        item.line,
        item.column,
        item.column + 1,
        `Missing closing "${openToClose[item.char]}"`
      );
    });

    return markers;
  }

  // ──── Line-based diagnostics ────

  /**
   * Check for common issues across all languages:
   * - Trailing whitespace (warning)
   * - Mixed tabs and spaces (warning)
   * - Lines that are too long (info)
   */
  function createCommonDiagnostics(content, monacoInstance, options = {}) {
    const markers = [];
    const lines = options.lines || content.split('\n');
    const maxLineLength = options.maxLineLength || 120;
    const checkTrailingWS = options.checkTrailingWS !== false;
    const checkMixedIndent = options.checkMixedIndent !== false;
    const checkLongLines = options.checkLongLines !== false && maxLineLength > 0;
    const checkTodo = options.checkTodo !== false;

    let hasTabs = false;
    let hasSpaces = false;
    let lineComment = options.lineComment || null;

    // Combined TODO/FIXME/HACK pattern — single regex test instead of three
    const todoPattern = /\b(TODO|FIXME|HACK)\b/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip empty lines and comment-only lines
      if (line.trim() === '') continue;
      if (lineComment) {
        const commentIdx = line.indexOf(lineComment);
        if (commentIdx === 0) continue;
      }

      // Trailing whitespace
      if (checkTrailingWS && line.length > 0 && /[ \t]$/.test(line)) {
        pushWarning(markers, monacoInstance, lineNum, line.length, line.length + 1, 'Trailing whitespace');
      }

      // Tabs vs spaces detection
      if (checkMixedIndent) {
        const leading = line.match(/^(\s*)/)[1];
        if (leading.includes('\t')) hasTabs = true;
        if (leading.includes(' ')) hasSpaces = true;
      }

      // Long line
      if (checkLongLines && line.length > maxLineLength) {
        pushInfo(markers, monacoInstance, lineNum, maxLineLength, line.length,
          `Line exceeds ${maxLineLength} characters (${line.length})`);
      }

      // Single-pass TODO / FIXME / HACK detection
      if (checkTodo) {
        const todoMatch = todoPattern.exec(line);
        if (todoMatch) {
          const keyword = todoMatch[1];
          const col = todoMatch.index + 1;
          if (keyword === 'TODO') {
            pushInfo(markers, monacoInstance, lineNum, col, col + 4, 'TODO comment');
          } else {
            pushWarning(markers, monacoInstance, lineNum, col, col + keyword.length,
              keyword + ': needs attention');
          }
        }
      }
    }

    // Mixed indent warning (only if both found in same file)
    if (checkMixedIndent && hasTabs && hasSpaces) {
      pushWarning(markers, monacoInstance, 1, 1, 2, 'Mixed tabs and spaces in indentation');
    }

    return markers;
  }

  /**
   * Check for unclosed strings (multi-line string scan)
   */
  function checkUnclosedStrings(content, monacoInstance, options = {}) {
    const markers = [];
    const lines = options.lines || content.split('\n');
    const lineComment = options.lineComment || null;
    const blockComments = options.blockComments || [];
    const quoteChars = options.quoteChars || ['"', "'"];
    const emit = options.emit || function (sev, l, c1, c2, m) {
      if (sev === 'error') pushError(markers, monacoInstance, l, c1, c2, m);
      else if (sev === 'info') pushInfo(markers, monacoInstance, l, c1, c2, m);
      else pushWarning(markers, monacoInstance, l, c1, c2, m);
    };

    let inString = null;
    let stringStartLine = 0;
    let stringStartCol = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let escaped = false;
      let inComment = false;

      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        const nextCh = line[j + 1];

        // Skip comments
        if (lineComment && !inString) {
          const lcMatch = lineComment.length === 1
            ? ch === lineComment
            : ch === lineComment[0] && nextCh === lineComment[1];
          if (lcMatch) break;
        }

        // Skip block comments
        if (!inString) {
          for (const bc of blockComments) {
            if (ch === bc.start[0] && nextCh === bc.start[1]) {
              inComment = true;
              j++;
              break;
            }
            if (inComment && ch === bc.end[0] && nextCh === bc.end[1]) {
              inComment = false;
              j++;
              break;
            }
          }
          if (inComment) continue;
        }

        if (inString) {
          if (!escaped && ch === inString) {
            inString = null;
          }
          escaped = !escaped && ch === '\\';
        } else if (quoteChars.includes(ch)) {
          inString = ch;
          stringStartLine = i + 1;
          stringStartCol = j + 1;
          escaped = false;
        }
      }

      // String not closed by end of line (can span lines)
      if (inString && i === lines.length - 1) {
        emit('error', stringStartLine, stringStartCol, stringStartCol + 1,
          `Unclosed string literal starting here`);
      }
    }

    return markers;
  }

  // ──── Diagnostics settings ────
  //
  // User-configurable (via the Diagnostics Settings modal). Each check has an
  // `enabled` flag and a `severity` ('error' | 'warning' | 'info' | 'hint').
  // Plugins read these through helpers.getCheck / helpers.pushChecked so the
  // same check can be toggled or re-leveled without code changes.

  const DEFAULT_DIAGNOSTICS_SETTINGS = {
    enabled: true,
    checkOn: 'type',        // 'type' (debounced live) | 'save' (only on save)
    debounceMs: 300,
    checks: {
      missingSemicolon:      { enabled: true, severity: 'error'   },
      strayTokens:           { enabled: true, severity: 'error'   },
      unmatchedBrackets:     { enabled: true, severity: 'error'   },
      unclosedStrings:       { enabled: true, severity: 'error'   },
      assignmentInCondition: { enabled: true, severity: 'warning' },
      unsafeFunctions:       { enabled: true, severity: 'warning' },
      trailingWhitespace:    { enabled: true, severity: 'warning' },
      mixedIndent:           { enabled: true, severity: 'warning' },
      longLines:             { enabled: true, severity: 'info', maxLineLength: 120 },
      todoComments:          { enabled: true, severity: 'info'    },
      cppModernize:          { enabled: true, severity: 'info'    },
      styleHints:            { enabled: true, severity: 'warning' }
    }
  };

  function mergeSettings(user) {
    const out = JSON.parse(JSON.stringify(DEFAULT_DIAGNOSTICS_SETTINGS));
    if (!user || typeof user !== 'object') return out;
    if (typeof user.enabled === 'boolean') out.enabled = user.enabled;
    if (typeof user.checkOn === 'string') out.checkOn = user.checkOn;
    if (typeof user.debounceMs === 'number' && user.debounceMs >= 0) out.debounceMs = user.debounceMs;
    if (user.checks && typeof user.checks === 'object') {
      for (const id in user.checks) {
        if (!out.checks[id] || !user.checks[id]) continue;
        const u = user.checks[id];
        if (typeof u.enabled === 'boolean') out.checks[id].enabled = u.enabled;
        if (typeof u.severity === 'string') out.checks[id].severity = u.severity;
        if (typeof u.maxLineLength === 'number' && u.maxLineLength > 0) out.checks[id].maxLineLength = u.maxLineLength;
      }
    }
    return out;
  }

  let currentDiagSettings = mergeSettings(null);

  function setDiagnosticsSettings(s) { currentDiagSettings = mergeSettings(s); }
  function getDiagnosticsSettings() { return currentDiagSettings; }

  // Resolve a check config from (possibly partial) settings, falling back to defaults.
  function getCheck(settings, id, defaultSeverity) {
    const cfg = (settings && settings.checks && settings.checks[id]) ||
                (DEFAULT_DIAGNOSTICS_SETTINGS.checks[id]) || {};
    const defSev = defaultSeverity ||
                   (DEFAULT_DIAGNOSTICS_SETTINGS.checks[id] && DEFAULT_DIAGNOSTICS_SETTINGS.checks[id].severity) ||
                   'warning';
    return {
      enabled: cfg.enabled !== false,
      severity: cfg.severity || defSev,
      maxLineLength: cfg.maxLineLength || 0
    };
  }

  function resolveSeverity(monacoInstance, sev) {
    const M = monacoInstance && monacoInstance.MarkerSeverity;
    if (!M) return 8; // fallback: Error
    if (sev === 'error') return M.Error;
    if (sev === 'warning') return M.Warning;
    if (sev === 'hint') return M.Hint;
    return M.Info;
  }

  // Push a marker only if the given check is enabled, using its configured severity.
  function pushChecked(markers, monacoInstance, settings, checkId, defaultSeverity, line, startCol, endCol, message) {
    const chk = getCheck(settings, checkId, defaultSeverity);
    if (!chk.enabled) return;
    markers.push({
      startLineNumber: line,
      endLineNumber: line,
      startColumn: Math.max(1, startCol),
      endColumn: Math.max(startCol + 1, endCol),
      message,
      severity: resolveSeverity(monacoInstance, chk.severity)
    });
  }

  // ──── Plugin registry ────

  function registerLanguageRulePlugin(plugin) {
    if (!plugin || typeof plugin.language !== 'string') {
      throw new Error('Language rule plugin must provide a language field');
    }
    plugins.set(plugin.language, plugin);
  }

  function listLanguageRulePlugins() {
    return Array.from(plugins.values());
  }

  function getLanguageRulePlugin(language) {
    return plugins.get(language) || null;
  }

  // ──── Symbol-aware completion ( IntelliSense ) ────
  function symbolKind(monaco, kind) {
    const K = monaco.languages.CompletionItemKind;
    const kinds = {
      variable: K.Variable,
      function: K.Function,
      method: K.Method,
      field: K.Field,
      property: K.Property,
      class: K.Class,
      struct: K.Struct,
      interface: K.Interface,
      enum: K.Enum,
      enummember: K.EnumMember,
      typedef: K.Struct,
      macro: K.Keyword,
      constant: K.Constant,
      module: K.Module,
      namespace: K.Module
    };
    return kinds[kind] == null ? K.Variable : kinds[kind];
  }

  // Completion runs on every identifier keystroke. Cache extraction per model
  // prefix and cursor scope. Typing on the current line does not invalidate the
  // declarations above it, which avoids a full-file regex scan per keystroke.
  const symbolCompletionCache = new WeakMap();

  function prefixFingerprint(model, lineNumber) {
    let prefix;
    if (typeof model.getValueInRange === 'function') {
      prefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn: 1
      });
    } else {
      prefix = model.getValue().split('\n').slice(0, Math.max(0, lineNumber - 1)).join('\n');
    }
    let hash = 2166136261;
    for (let i = 0; i < prefix.length; i += 1) {
      hash ^= prefix.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return prefix.length + ':' + (hash >>> 0);
  }

  function getSymbolSuggestions(monaco, language, model, position, context, token) {
    const extractor = globalScope.symbolExtractor;
    if (!extractor || !model) return [];
    if (token && token.isCancellationRequested) return [];
    if (model.getLineCount() > 5000) return [];
    if (typeof model.getValueLength === 'function' && model.getValueLength() > 750000) return [];

    const memberKey = context.memberAccess
      ? context.memberAccess.expression + context.memberAccess.operator
      : '';
    const cacheKey = [prefixFingerprint(model, position.lineNumber), position.lineNumber, memberKey].join(':');
    const cached = symbolCompletionCache.get(model);
    if (cached && cached.key === cacheKey && cached.language === language) return cached.suggestions;

    const content = model.getValue();
    if (!content || (token && token.isCancellationRequested)) return [];
    let symbols;
    if (context.memberAccess) {
      symbols = typeof extractor.extractMembers === 'function'
        ? extractor.extractMembers(content, language, context.memberAccess.expression, position.lineNumber)
        : [];
    } else {
      symbols = extractor.extract(content, language, position.lineNumber);
    }

    if (token && token.isCancellationRequested) return [];
    const suggestions = (symbols || []).map(function (symbol) {
      return {
        label: symbol.name,
        kind: symbolKind(monaco, symbol.kind),
        detail: symbol.detail,
        insertText: symbol.insertText || symbol.name,
        sortText: '0' + String(symbol.priority == null ? 6 : symbol.priority) + '_' + symbol.name.toLowerCase(),
        commitCharacters: []
      };
    });
    symbolCompletionCache.set(model, { key: cacheKey, language: language, suggestions: suggestions });
    return suggestions;
  }

  function registerCompletionProviders(monacoInstance) {
    const monacoRef = monacoInstance || globalScope.monaco;
    if (!monacoRef) {
      throw new Error('Monaco is not available when registering completion providers');
    }

    while (completionDisposables.length) {
      const disposable = completionDisposables.pop();
      try {
        disposable.dispose();
      } catch (_error) {
      }
    }

    const engine = globalScope.completionEngine;
    if (!engine) throw new Error('completionEngine must be loaded before registering completion providers');

    listLanguageRulePlugins().forEach((plugin) => {
      const staticProvider = plugin.createCompletionProvider
        ? plugin.createCompletionProvider(monacoRef, sharedHelpers)
        : null;
      const provider = engine.createProvider({
        monaco: monacoRef,
        language: plugin.language,
        staticProvider: staticProvider,
        symbolProvider(model, position, context, token) {
          return getSymbolSuggestions(monacoRef, plugin.language, model, position, context, token);
        }
      });
      const disposable = monacoRef.languages.registerCompletionItemProvider(plugin.language, provider);
      completionDisposables.push(disposable);
    });
  }

  function getSyntaxMarkers(model, monacoInstance, checkOptions = {}) {
    const plugin = getLanguageRulePlugin(model.getLanguageId());
    if (!plugin || typeof plugin.provideDiagnostics !== 'function') {
      return [];
    }
    // Master switch: emit nothing when diagnostics are globally disabled.
    if (currentDiagSettings && currentDiagSettings.enabled === false) {
      return [];
    }
    const content = model.getValue();
    const lines = content.split('\n');
    return plugin.provideDiagnostics({
      monaco: monacoInstance || globalScope.monaco,
      model,
      content: content,
      lines: lines,                 // pre-split lines — avoid re-splitting in helpers
      helpers: sharedHelpers,
      settings: currentDiagSettings,
      largeFile: checkOptions.largeFile || false
    }) || [];
  }

  const sharedHelpers = {
    createSnippet,
    createPlain,
    pushMarker,
    pushError,
    pushWarning,
    pushInfo,
    createBalancedPairDiagnostics,
    createCommonDiagnostics,
    checkUnclosedStrings,
    // settings-aware helpers
    getCheck,
    resolveSeverity,
    pushChecked
  };

  globalScope.editorRuleRegistry = {
    registerLanguageRulePlugin,
    listLanguageRulePlugins,
    getLanguageRulePlugin,
    registerCompletionProviders,
    getSyntaxMarkers,
    setDiagnosticsSettings,
    getDiagnosticsSettings,
    mergeSettings,
    DEFAULT_DIAGNOSTICS_SETTINGS,
    helpers: sharedHelpers
  };

  globalScope.registerCompletionProviders = registerCompletionProviders;
})(typeof window !== 'undefined' ? window : globalThis);
