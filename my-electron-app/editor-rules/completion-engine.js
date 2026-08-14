// Context-aware completion pipeline shared by every language rule plugin.
(function initCompletionEngine(globalScope) {
  'use strict';

  const SNIPPET_PATTERN = /\$(?:\d+|\{\d+(?::[^}]*)?\})/;
  const SAFE_TRIGGERS = {
    c: new Set(['#', '.', '>']),
    cpp: new Set(['#', '.', ':', '>']),
    java: new Set(['.']),
    go: new Set(['.']),
    python: new Set(['.']),
    rust: new Set(['.', ':'])
  };

  function labelText(item) {
    if (!item) return '';
    if (typeof item.label === 'string') return item.label;
    return item.label && typeof item.label.label === 'string' ? item.label.label : '';
  }

  function linePrefix(model, position) {
    if (!model || !position) return '';
    if (typeof model.getLineContent === 'function') {
      return model.getLineContent(position.lineNumber).slice(0, Math.max(0, position.column - 1));
    }
    const lines = String(model.getValue ? model.getValue() : '').split('\n');
    return (lines[position.lineNumber - 1] || '').slice(0, Math.max(0, position.column - 1));
  }

  function wordAt(model, position) {
    if (model && typeof model.getWordUntilPosition === 'function') {
      const word = model.getWordUntilPosition(position);
      if (word) return word;
    }
    const prefix = linePrefix(model, position);
    const match = /[A-Za-z_$][\w$]*$/.exec(prefix);
    const value = match ? match[0] : '';
    return {
      word: value,
      startColumn: position.column - value.length,
      endColumn: position.column
    };
  }

  function offsetAt(model, position) {
    if (model && typeof model.getOffsetAt === 'function') return model.getOffsetAt(position);
    const lines = String(model && model.getValue ? model.getValue() : '').split('\n');
    let offset = 0;
    for (let i = 0; i < position.lineNumber - 1; i += 1) offset += (lines[i] || '').length + 1;
    return offset + Math.max(0, position.column - 1);
  }

  function lexicalStateAt(model, position, language) {
    const content = String(model && model.getValue ? model.getValue() : '');
    const limit = Math.min(content.length, offsetAt(model, position));
    let state = 'code';
    let quote = '';
    let escaped = false;

    for (let i = 0; i < limit; i += 1) {
      const ch = content[i];
      const next = content[i + 1] || '';
      const nextTwo = content.slice(i, i + 3);

      if (state === 'line-comment') {
        if (ch === '\n') state = 'code';
        continue;
      }
      if (state === 'block-comment') {
        if (ch === '*' && next === '/') {
          state = 'code';
          i += 1;
        }
        continue;
      }
      if (state === 'triple-string') {
        if (nextTwo === quote.repeat(3)) {
          state = 'code';
          i += 2;
        }
        continue;
      }
      if (state === 'string') {
        if (!escaped && ch === quote) state = 'code';
        escaped = !escaped && ch === '\\';
        if (ch !== '\\') escaped = false;
        continue;
      }

      if (language === 'python' && ch === '#') {
        state = 'line-comment';
        continue;
      }
      if (language !== 'python' && ch === '/' && next === '/') {
        state = 'line-comment';
        i += 1;
        continue;
      }
      if (language !== 'python' && ch === '/' && next === '*') {
        state = 'block-comment';
        i += 1;
        continue;
      }
      if (language === 'python' && (nextTwo === '"""' || nextTwo === "'''")) {
        state = 'triple-string';
        quote = ch;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || (language === 'go' && ch === '`')) {
        // A Rust lifetime ('a) is not a character literal.
        if (language === 'rust' && ch === "'" && /[A-Za-z_]/.test(next) && content[i + 2] !== "'") {
          continue;
        }
        state = 'string';
        quote = ch;
        escaped = false;
      }
    }
    return state;
  }

  function safeTriggerCharacters(language, declared) {
    const allowed = SAFE_TRIGGERS[language] || new Set(['.']);
    const result = [];
    (declared || []).forEach(function (trigger) {
      if (allowed.has(trigger) && result.indexOf(trigger) === -1) result.push(trigger);
    });
    return result;
  }

  function analyzeContext(model, position, language, requestContext) {
    const prefix = linePrefix(model, position);
    const word = wordAt(model, position);
    const beforeWord = prefix.slice(0, Math.max(0, prefix.length - String(word.word || '').length));
    const memberMatch = /([A-Za-z_$][\w$]*)\s*(\.|->|::)\s*$/.exec(beforeWord);
    const trimmed = prefix.trimStart();
    const triggerCharacter = requestContext && requestContext.triggerCharacter;
    const rangeStart = trimmed.startsWith('#') && /^#\s*[A-Za-z_]*$/.test(trimmed)
      ? prefix.indexOf('#') + 1
      : word.startColumn;

    let invalidTrigger = false;
    if (triggerCharacter === '>' && !/->\s*$/.test(prefix)) invalidTrigger = true;
    if (triggerCharacter === ':' && !/::\s*$/.test(prefix)) invalidTrigger = true;
    if (triggerCharacter === '#' && !/^\s*#/.test(prefix)) invalidTrigger = true;
    if (triggerCharacter === '.' && /(?:^|\W)\d+\.$/.test(prefix)) invalidTrigger = true;

    return {
      language: language,
      linePrefix: prefix,
      word: String(word.word || ''),
      memberAccess: memberMatch ? {
        expression: memberMatch[1],
        operator: memberMatch[2]
      } : null,
      preprocessor: (language === 'c' || language === 'cpp') && /^\s*#/.test(prefix),
      lexicalState: lexicalStateAt(model, position, language),
      invalidTrigger: invalidTrigger,
      triggerCharacter: triggerCharacter || '',
      range: {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: Math.max(1, rangeStart),
        endColumn: word.endColumn || position.column
      }
    };
  }

  function matchScore(item, context) {
    const query = context.word.toLowerCase();
    if (!query) return 4;
    const label = labelText(item).toLowerCase();
    const tail = label.split(/[.:\s/]+/).filter(Boolean).pop() || label;
    if (label === query || tail === query) return 0;
    if (label.startsWith(query) || tail.startsWith(query)) return 1;
    if (label.split(/[.:\s/]+/).some(function (part) { return part.startsWith(query); })) return 2;
    if (query.length >= 2 && (label.includes(query) || tail.includes(query))) return 3;
    return -1;
  }

  function rewriteForMember(item, context) {
    const copy = { ...item };
    const label = labelText(copy);
    const root = context.memberAccess.expression;
    const operator = context.memberAccess.operator;
    const receiverPrefix = root + operator;
    let insertText = String(copy.insertText == null ? label : copy.insertText);
    let allowed = false;

    if (label.startsWith(receiverPrefix)) {
      copy.filterText = label.slice(receiverPrefix.length);
      copy.label = label.slice(receiverPrefix.length);
      if (insertText.startsWith(receiverPrefix)) insertText = insertText.slice(receiverPrefix.length);
      allowed = true;
    }

    if (insertText.startsWith(receiverPrefix)) {
      insertText = insertText.slice(receiverPrefix.length);
      const insertedName = /^([A-Za-z_$][\w$]*)/.exec(insertText);
      if (insertedName) {
        copy.label = insertedName[1];
        copy.filterText = insertedName[1];
      }
      allowed = true;
    }

    const placeholderPrefix = /^\$\{\d+(?::[^}]*)?\}(?:\.|->|::)/;
    if (placeholderPrefix.test(insertText)) {
      insertText = insertText.replace(placeholderPrefix, '');
      allowed = true;
    }

    if (!allowed) return null;

    copy.insertText = insertText;
    return copy;
  }

  function normalizeSuggestion(item, context, monaco, source, index) {
    if (!item || !labelText(item)) return null;
    let normalized = { ...item };
    context.monaco = monaco;

    if (context.preprocessor) {
      if (!labelText(normalized).startsWith('#')) return null;
    } else if (context.memberAccess && source === 'static') {
      normalized = rewriteForMember(normalized, context);
      if (!normalized) return null;
    } else if (!context.memberAccess && labelText(normalized).startsWith('#')) {
      return null;
    }

    const score = matchScore(normalized, context);
    if (score < 0) return null;

    const insertText = String(normalized.insertText == null ? labelText(normalized) : normalized.insertText);
    normalized.insertText = insertText;
    normalized.range = normalized.range || context.range;
    normalized.filterText = normalized.filterText || labelText(normalized);
    normalized.commitCharacters = normalized.commitCharacters || [];
    if (SNIPPET_PATTERN.test(insertText) && normalized.insertTextRules == null) {
      normalized.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }

    const sourceRank = source === 'symbol' ? '0' : '1';
    normalized.sortText = normalized.sortText || sourceRank + String(score) + '_' + labelText(normalized).toLowerCase() + '_' + index;
    return normalized;
  }

  function dedupeSuggestions(suggestions) {
    const seen = new Set();
    return suggestions.filter(function (item) {
      const key = labelText(item).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function combineSuggestions(staticSuggestions, symbolSuggestions, context, monaco) {
    if (context.invalidTrigger || context.lexicalState !== 'code') return { suggestions: [] };
    const combined = [];

    (symbolSuggestions || []).forEach(function (item, index) {
      const normalized = normalizeSuggestion(item, context, monaco, 'symbol', index);
      if (normalized) combined.push(normalized);
    });
    (staticSuggestions || []).forEach(function (item, index) {
      const normalized = normalizeSuggestion(item, context, monaco, 'static', index);
      if (normalized) combined.push(normalized);
    });

    return { suggestions: dedupeSuggestions(combined).slice(0, 120) };
  }

  function createProvider(options) {
    const monaco = options.monaco;
    const language = options.language;
    const staticProvider = options.staticProvider || null;
    const symbolProvider = options.symbolProvider || function () { return []; };
    let staticCache = null;

    function staticSuggestions(model, position, context, token) {
      if (!staticProvider || typeof staticProvider.provideCompletionItems !== 'function') return [];
      if (staticCache) return staticCache;
      const result = staticProvider.provideCompletionItems(model, position, context, token) || {};
      if (result && typeof result.then === 'function') {
        return result.then(function (resolved) {
          staticCache = (resolved && resolved.suggestions) || [];
          return staticCache;
        });
      }
      staticCache = result.suggestions || [];
      return staticCache;
    }

    return {
      triggerCharacters: safeTriggerCharacters(language, staticProvider && staticProvider.triggerCharacters),
      provideCompletionItems(model, position, requestContext, token) {
        if (token && token.isCancellationRequested) return { suggestions: [] };
        const context = analyzeContext(model, position, language, requestContext || {});
        if (context.invalidTrigger || context.lexicalState !== 'code') return { suggestions: [] };
        const symbols = symbolProvider(model, position, context, token) || [];
        const statics = staticSuggestions(model, position, requestContext || {}, token);
        if (statics && typeof statics.then === 'function') {
          return statics.then(function (resolved) {
            if (token && token.isCancellationRequested) return { suggestions: [] };
            return combineSuggestions(resolved, symbols, context, monaco);
          });
        }
        return combineSuggestions(statics, symbols, context, monaco);
      }
    };
  }

  globalScope.completionEngine = {
    analyzeContext: analyzeContext,
    combineSuggestions: combineSuggestions,
    createProvider: createProvider,
    dedupeSuggestions: dedupeSuggestions,
    lexicalStateAt: lexicalStateAt,
    safeTriggerCharacters: safeTriggerCharacters
  };
})(typeof window !== 'undefined' ? window : globalThis);
