// completion-rules.ts
// Editor rule registry and shared helpers for per-language plugins.
import type {
  EditorRuleAnalyzedContextDto,
  EditorRuleBalancedPairOptions,
  EditorRuleBlockCommentDto,
  EditorRuleCheckConfigDto,
  EditorRuleCommonDiagnosticOptions,
  EditorRuleCompletionContextDto,
  EditorRuleCompletionItemDto,
  EditorRuleCompletionProvider,
  EditorRuleCancellationToken,
  EditorRuleDiagnosticEmit,
  EditorRuleDiagnosticsSettingsDto,
  EditorRuleGlobals,
  EditorRuleHelpers,
  EditorRuleLanguageId,
  EditorRuleLanguagePlugin,
  EditorRuleMarkerDto,
  EditorRuleMonacoPort,
  EditorRulePositionDto,
  EditorRuleProviderRegistration,
  EditorRuleRegistryPort,
  EditorRuleSymbolDto,
  EditorRuleSymbolKind,
  EditorRuleTextModelPort,
  EditorRuleUnclosedStringOptions
} from './types/editor-rules';
import type { DiagnosticsCheckId, DiagnosticsSeverity } from './types/diagnostics';

type EditorRuleMutableCheck = {
  enabled: boolean;
  severity: string;
  maxLineLength?: number;
};

type EditorRuleMutableSettings = {
  enabled: boolean;
  // Keep the legacy open string behavior here; normalization closes this at
  // the diagnostics service boundary.
  checkOn: string;
  debounceMs: number;
  checks: Record<DiagnosticsCheckId, EditorRuleMutableCheck>;
};

type EditorRuleGlobal = typeof globalThis & EditorRuleGlobals & {
  monaco?: EditorRuleMonacoPort;
};

type SymbolCacheEntry = {
  readonly key: string;
  readonly language: EditorRuleLanguageId;
  readonly suggestions: readonly EditorRuleCompletionItemDto[];
};

type SymbolCompletionContext = EditorRuleCompletionContextDto & {
  readonly memberAccess?: EditorRuleAnalyzedContextDto['memberAccess'];
};

type BalancedStackEntry = {
  readonly char: string;
  readonly line: number;
  readonly column: number;
};

type StringState = { readonly quote: string };

type UnknownRecord = Record<string, unknown>;

(function initEditorRuleRegistry(globalScope: EditorRuleGlobal): void {
  const plugins = new Map<EditorRuleLanguageId, EditorRuleLanguagePlugin>();
  const completionDisposables: EditorRuleProviderRegistration[] = [];

  function createSnippet(
    label: string,
    insertText: string,
    kind: number,
    monacoInstance: EditorRuleMonacoPort,
    extra: Readonly<Record<string, unknown>> = {}
  ): EditorRuleCompletionItemDto {
    return {
      label,
      kind,
      insertText,
      insertTextRules: monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      ...extra
    };
  }

  function createPlain(
    label: string,
    insertText: string,
    kind: number,
    extra: Readonly<Record<string, unknown>> = {}
  ): EditorRuleCompletionItemDto {
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
  function pushError(
    markers: EditorRuleMarkerDto[],
    monacoInstance: EditorRuleMonacoPort,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void {
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
  function pushWarning(
    markers: EditorRuleMarkerDto[],
    monacoInstance: EditorRuleMonacoPort,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void {
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
  function pushInfo(
    markers: EditorRuleMarkerDto[],
    monacoInstance: EditorRuleMonacoPort,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void {
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
  function pushMarker(
    markers: EditorRuleMarkerDto[],
    monacoInstance: EditorRuleMonacoPort,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
    message: string,
    severity?: number
  ): void {
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

  function createBalancedPairDiagnostics(
    content: string,
    monacoInstance: EditorRuleMonacoPort,
    options: EditorRuleBalancedPairOptions = {}
  ): EditorRuleMarkerDto[] {
    const markers: EditorRuleMarkerDto[] = [];
    const lines = options.lines || content.split('\n');
    const openToClose: Readonly<Record<string, string>> = options.pairs || { '(': ')', '[': ']', '{': '}' };
    const closeToOpen = Object.entries(openToClose).reduce<Record<string, string>>((acc, [openChar, closeChar]) => {
      acc[closeChar] = openChar;
      return acc;
    }, {});
    const lineComment = options.lineComment || null;
    const blockComments = options.blockComments || [];
    const quoteChars = new Set(options.quoteChars || ['"', '\'']);
    // settings-aware emit: options.emit(severityWord, line, c1, c2, msg)
    // severityWord ∈ 'error' | 'warning' | 'info'. Falls back to hardcoded helpers.
    const emit: EditorRuleDiagnosticEmit = options.emit || function (
      sev: DiagnosticsSeverity,
      l: number,
      c1: number,
      c2: number,
      m: string
    ): void {
      if (sev === 'error') pushError(markers, monacoInstance, l, c1, c2, m);
      else if (sev === 'info') pushInfo(markers, monacoInstance, l, c1, c2, m);
      else pushWarning(markers, monacoInstance, l, c1, c2, m);
    };
    const stack: BalancedStackEntry[] = [];
    let blockComment: EditorRuleBlockCommentDto | null = null;
    let stringState: StringState | null = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      let escaped = false;

      for (let columnIndex = 0; columnIndex < line.length; columnIndex += 1) {
        const char = line[columnIndex] ?? '';
        const nextChar = line[columnIndex + 1] ?? '';
        const previousChar = columnIndex > 0 ? line[columnIndex - 1] ?? '' : '';

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
        `Missing closing "${openToClose[item.char] as string}"`
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
  function createCommonDiagnostics(
    content: string,
    monacoInstance: EditorRuleMonacoPort,
    options: EditorRuleCommonDiagnosticOptions = {}
  ): EditorRuleMarkerDto[] {
    const markers: EditorRuleMarkerDto[] = [];
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
      const line = lines[i] ?? '';
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
        const leading = line.match(/^(\s*)/)?.[1] ?? '';
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
          const keyword = todoMatch[1] ?? '';
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
  function checkUnclosedStrings(
    content: string,
    monacoInstance: EditorRuleMonacoPort,
    options: EditorRuleUnclosedStringOptions = {}
  ): EditorRuleMarkerDto[] {
    const markers: EditorRuleMarkerDto[] = [];
    const lines = options.lines || content.split('\n');
    const lineComment = options.lineComment || null;
    const blockComments = options.blockComments || [];
    const quoteChars = options.quoteChars || ['"', "'"];
    const emit: EditorRuleDiagnosticEmit = options.emit || function (
      sev: DiagnosticsSeverity,
      l: number,
      c1: number,
      c2: number,
      m: string
    ): void {
      if (sev === 'error') pushError(markers, monacoInstance, l, c1, c2, m);
      else if (sev === 'info') pushInfo(markers, monacoInstance, l, c1, c2, m);
      else pushWarning(markers, monacoInstance, l, c1, c2, m);
    };

    let inString: string | null = null;
    let stringStartLine = 0;
    let stringStartCol = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      let escaped = false;
      let inComment = false;

      for (let j = 0; j < line.length; j++) {
        const ch = line[j] ?? '';
        const nextCh = line[j + 1] ?? '';

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

  const DEFAULT_DIAGNOSTICS_SETTINGS: EditorRuleMutableSettings = {
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

  function asRecord(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' ? value as UnknownRecord : null;
  }

  function mergeSettings(user: unknown): EditorRuleMutableSettings {
    const out = JSON.parse(JSON.stringify(DEFAULT_DIAGNOSTICS_SETTINGS)) as EditorRuleMutableSettings;
    const source = asRecord(user);
    if (!source) return out;
    if (typeof source.enabled === 'boolean') out.enabled = source.enabled;
    if (typeof source.checkOn === 'string') out.checkOn = source.checkOn;
    if (typeof source.debounceMs === 'number' && source.debounceMs >= 0) out.debounceMs = source.debounceMs;
    const userChecks = asRecord(source.checks);
    if (userChecks) {
      for (const id in userChecks) {
        const checkId = id as DiagnosticsCheckId;
        const target = out.checks[checkId];
        const update = asRecord(userChecks[id]);
        if (!target || !update) continue;
        if (typeof update.enabled === 'boolean') target.enabled = update.enabled;
        if (typeof update.severity === 'string') target.severity = update.severity;
        if (typeof update.maxLineLength === 'number' && update.maxLineLength > 0) {
          target.maxLineLength = update.maxLineLength;
        }
      }
    }
    return out;
  }

  function mergeSettingsForPort(user: unknown): EditorRuleDiagnosticsSettingsDto {
    return mergeSettings(user) as unknown as EditorRuleDiagnosticsSettingsDto;
  }

  let currentDiagSettings = mergeSettings(null);

  function setDiagnosticsSettings(s: unknown): void { currentDiagSettings = mergeSettings(s); }
  function getDiagnosticsSettings(): EditorRuleDiagnosticsSettingsDto {
    return currentDiagSettings as unknown as EditorRuleDiagnosticsSettingsDto;
  }

  // Resolve a check config from (possibly partial) settings, falling back to defaults.
  function getCheck(
    settings: unknown,
    id: DiagnosticsCheckId | string,
    defaultSeverity?: DiagnosticsSeverity
  ): EditorRuleCheckConfigDto {
    const settingsRecord = asRecord(settings);
    const settingsChecks = asRecord(settingsRecord?.checks);
    const checkId = id as DiagnosticsCheckId;
    const cfg = asRecord(settingsChecks?.[id]) ||
                asRecord(DEFAULT_DIAGNOSTICS_SETTINGS.checks[checkId]) || {};
    const defaultConfig = DEFAULT_DIAGNOSTICS_SETTINGS.checks[checkId];
    const defSev = defaultSeverity || defaultConfig?.severity || 'warning';
    const severity = typeof cfg.severity === 'string' && cfg.severity
      ? cfg.severity
      : defSev;
    return {
      enabled: cfg.enabled !== false,
      severity: severity as DiagnosticsSeverity,
      maxLineLength: (cfg.maxLineLength as number | undefined) || 0
    };
  }

  function resolveSeverity(monacoInstance: EditorRuleMonacoPort, sev: DiagnosticsSeverity): number {
    const M = monacoInstance && monacoInstance.MarkerSeverity;
    if (!M) return 8; // fallback: Error
    if (sev === 'error') return M.Error;
    if (sev === 'warning') return M.Warning;
    if (sev === 'hint') return M.Hint as number;
    return M.Info;
  }

  // Push a marker only if the given check is enabled, using its configured severity.
  function pushChecked(
    markers: EditorRuleMarkerDto[],
    monacoInstance: EditorRuleMonacoPort,
    settings: unknown,
    checkId: DiagnosticsCheckId | string,
    defaultSeverity: DiagnosticsSeverity,
    line: number,
    startCol: number,
    endCol: number,
    message: string
  ): void {
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

  function registerLanguageRulePlugin(plugin: EditorRuleLanguagePlugin): void {
    if (!plugin || typeof plugin.language !== 'string') {
      throw new Error('Language rule plugin must provide a language field');
    }
    plugins.set(plugin.language, plugin);
  }

  function listLanguageRulePlugins(): readonly EditorRuleLanguagePlugin[] {
    return Array.from(plugins.values());
  }

  function getLanguageRulePlugin(language: EditorRuleLanguageId): EditorRuleLanguagePlugin | null {
    return plugins.get(language) || null;
  }

  // ──── Symbol-aware completion ( IntelliSense ) ────
  function symbolKind(monaco: EditorRuleMonacoPort, kind: EditorRuleSymbolKind): number {
    const K = monaco.languages.CompletionItemKind;
    const kinds: Record<string, number> = {
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
  const symbolCompletionCache = new WeakMap<EditorRuleTextModelPort, SymbolCacheEntry>();

  function prefixFingerprint(model: EditorRuleTextModelPort, lineNumber: number): string {
    let prefix: string;
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

  function getSymbolSuggestions(
    monaco: EditorRuleMonacoPort,
    language: EditorRuleLanguageId,
    model: EditorRuleTextModelPort,
    position: EditorRulePositionDto,
    context: EditorRuleCompletionContextDto,
    token?: EditorRuleCancellationToken
  ): readonly EditorRuleCompletionItemDto[] {
    const extractor = globalScope.symbolExtractor;
    if (!extractor || !model) return [];
    if (token && token.isCancellationRequested) return [];
    if (model.getLineCount() > 5000) return [];
    if (typeof model.getValueLength === 'function' && model.getValueLength() > 750000) return [];

    const analyzedContext = context as SymbolCompletionContext;
    const memberAccess = analyzedContext.memberAccess;
    const memberKey = memberAccess
      ? memberAccess.expression + memberAccess.operator
      : '';
    const cacheKey = [prefixFingerprint(model, position.lineNumber), position.lineNumber, memberKey].join(':');
    const cached = symbolCompletionCache.get(model);
    if (cached && cached.key === cacheKey && cached.language === language) return cached.suggestions;

    const content = model.getValue();
    if (!content || (token && token.isCancellationRequested)) return [];
    let symbols: readonly EditorRuleSymbolDto[];
    if (memberAccess) {
      symbols = typeof extractor.extractMembers === 'function'
        ? extractor.extractMembers(content, language, memberAccess.expression, position.lineNumber)
        : [];
    } else {
      symbols = extractor.extract(content, language, position.lineNumber);
    }

    if (token && token.isCancellationRequested) return [];
    const suggestions: EditorRuleCompletionItemDto[] = (symbols || []).map(function (symbol) {
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

  function disposeCompletionProviders(): void {
    while (completionDisposables.length) {
      const disposable = completionDisposables.pop();
      if (!disposable) continue;
      try {
        disposable.dispose();
      } catch (_error) {
        // A stale Monaco provider must not prevent remaining providers from
        // being released during re-registration or platform teardown.
      }
    }
  }

  function registerCompletionProviders(monacoInstance?: EditorRuleMonacoPort): void {
    const monacoRef = monacoInstance || globalScope.monaco;
    if (!monacoRef) {
      throw new Error('Monaco is not available when registering completion providers');
    }

    disposeCompletionProviders();

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

  function getSyntaxMarkers(
    model: EditorRuleTextModelPort,
    monacoInstance: EditorRuleMonacoPort,
    checkOptions: { readonly largeFile?: boolean } = {}
  ): readonly EditorRuleMarkerDto[] {
    const language = typeof model.getLanguageId === 'function' ? model.getLanguageId() : '';
    const plugin = getLanguageRulePlugin(language);
    const provideDiagnostics = plugin?.provideDiagnostics;
    if (!plugin || typeof provideDiagnostics !== 'function') {
      return [];
    }
    // Master switch: emit nothing when diagnostics are globally disabled.
    if (currentDiagSettings && currentDiagSettings.enabled === false) {
      return [];
    }
    const content = model.getValue();
    const lines = content.split('\n');
    return provideDiagnostics.call(plugin, {
      monaco: monacoInstance || globalScope.monaco as EditorRuleMonacoPort,
      model,
      content: content,
      lines: lines,                 // pre-split lines — avoid re-splitting in helpers
      helpers: sharedHelpers,
      settings: currentDiagSettings as unknown as EditorRuleDiagnosticsSettingsDto,
      largeFile: checkOptions.largeFile || false
    }) || [];
  }

  const sharedHelpers: EditorRuleHelpers = {
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

  function dispose(): void {
    disposeCompletionProviders();
  }

  const editorRuleRegistry: EditorRuleRegistryPort = {
    dispose,
    registerLanguageRulePlugin,
    listLanguageRulePlugins,
    getLanguageRulePlugin,
    registerCompletionProviders,
    getSyntaxMarkers,
    setDiagnosticsSettings,
    getDiagnosticsSettings,
    mergeSettings: mergeSettingsForPort,
    // The mutable internal copy intentionally keeps legacy open strings;
    // expose its expected renderer shape through the DTO contract.
    DEFAULT_DIAGNOSTICS_SETTINGS: DEFAULT_DIAGNOSTICS_SETTINGS as unknown as EditorRuleDiagnosticsSettingsDto,
    helpers: sharedHelpers
  };

  globalScope.editorRuleRegistry = editorRuleRegistry;
  globalScope.registerCompletionProviders = registerCompletionProviders;
})(typeof window !== 'undefined' ? window : globalThis);
