// Local completion preferences and stable document usage. Persisted records
// contain opaque scope hashes and symbol identities, never document source.
(function initCompletionHistory(global) {
  'use strict';

  var STORAGE_KEY = 'bobocloud.completionHistory.v2';
  var LEGACY_KEY = 'bobocloud.completionHistory.v1';
  var ENABLED_KEY = 'bobocloud.completionHistory.enabled.v1';
  var COMMAND_ID = 'bobo.completionHistory.accept';
  var MAX_RECORDS = 1800;
  var MAX_SOURCE_LENGTH = 500000;
  var MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000;
  var records = new Map();
  var models = new WeakMap();
  var observed = new Set();
  var documents = new Map();
  var pending = [];
  var persistTimer = null;
  var enabled = read(ENABLED_KEY) !== 'false';
  var scope = { accountKey: hash('local'), workspaceKey: hash('') };
  var legacy = [];
  var disposed = false;
  load();

  function read(key) {
    try { return global.localStorage && global.localStorage.getItem(key); } catch (_) { return null; }
  }

  function hash(value) {
    var text = String(value || '');
    var result = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      result = Math.imul(result ^ text.charCodeAt(index), 16777619);
    }
    return (result >>> 0).toString(16);
  }

  function labelOf(item) {
    if (typeof item === 'string') return item;
    var label = item && item.label;
    return typeof label === 'string' ? label : label && typeof label.label === 'string' ? label.label : '';
  }

  function languageOf(value) {
    var language = String(value || '').toLowerCase();
    if (['javascriptreact', 'typescriptreact', 'js', 'ts', 'node'].indexOf(language) >= 0) return 'javascript';
    if (language === 'typescript') return 'javascript';
    if (language === 'py') return 'python';
    return language;
  }

  function symbolName(value) {
    var text = labelOf(value).trim();
    var match = /([A-Za-z_$][\w$]*)\s*(?:\(|$)/.exec(text);
    return match ? match[1] : text.slice(0, 160);
  }

  function load() {
    try {
      var saved = JSON.parse(read(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) saved.slice(0, MAX_RECORDS).forEach(function(record) {
        if (!record || typeof record.key !== 'string' || record.key.length > 640 ||
            !Number.isFinite(record.count) || record.count <= 0 ||
            !Number.isFinite(record.updatedAt) || Date.now() - record.updatedAt > MAX_AGE_MS) return;
        records.set(record.key, { key: record.key, count: Math.min(100, record.count), updatedAt: record.updatedAt });
      });
      var old = JSON.parse(read(LEGACY_KEY) || '[]');
      if (Array.isArray(old)) legacy = old.slice(0, 600);
    } catch (_) {}
  }

  function persist() {
    persistTimer = null;
    var cutoff = Date.now() - MAX_AGE_MS;
    var saved = Array.from(records.values()).filter(function(record) { return record.updatedAt >= cutoff; });
    saved.sort(function(left, right) { return right.updatedAt - left.updatedAt; });
    saved = saved.slice(0, MAX_RECORDS);
    records = new Map(saved.map(function(record) { return [record.key, record]; }));
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (_) {}
  }

  function schedulePersist() {
    if (persistTimer !== null || disposed) return;
    persistTimer = global.setTimeout(persist, 500);
  }

  function configureContext(next) {
    var nextScope = {
      accountKey: hash(next && next.accountKey || 'local'),
      workspaceKey: hash(next && next.workspaceKey || '')
    };
    if (nextScope.accountKey !== scope.accountKey || nextScope.workspaceKey !== scope.workspaceKey) {
      pending = [];
      observed.forEach(function(state) { if (state.timer !== null) global.clearTimeout(state.timer); });
      observed.clear();
      documents.clear();
      models = new WeakMap();
    }
    scope = nextScope;
    if (legacy.length) {
      legacy.forEach(function(record) {
        if (!record || typeof record.key !== 'string' || !Number.isFinite(Number(record.count))) return;
        var parts = record.key.split('|');
        var context = normalizeContext({ language: parts[0], kind: parts[1] === 'call' ? 'member' : parts[1] });
        addRecord(context, parts.slice(2).join('|'), Math.min(2, Number(record.count) * 0.2), Number(record.updatedAt) || Date.now(), '*');
      });
      legacy = [];
      try { if (global.localStorage) global.localStorage.removeItem(LEGACY_KEY); } catch (_) {}
    }
  }

  function normalizeContext(context) {
    var value = context || {};
    var prefix = String(value.prefix || value.linePrefix || '');
    var match = /([A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*)(?:\.|::|->)([A-Za-z_$][\w$]*)?$/.exec(prefix);
    var receiver = value.receiver || value.receiverType || value.memberAccess && value.memberAccess.expression || match && match[1] || '';
    var importing = /^\s*(?:from|import|use)\b/.test(prefix) || /\brequire\s*\(\s*['"][^'"]*$/.test(prefix) || /^\s*#\s*include\b/.test(prefix);
    return {
      accountKey: value._historyContext ? value.accountKey : scope.accountKey,
      workspaceKey: value._historyContext ? value.workspaceKey : scope.workspaceKey,
      documentKey: value.documentKey || '',
      language: languageOf(value.language || value.languageId),
      kind: value.kind || (importing ? 'import' : receiver ? 'member' : 'symbol'),
      receiver: String(receiver).replace(/::|->/g, '.').slice(0, 256),
      word: String(value.word || match && match[2] || '').slice(0, 160),
      range: value.range || null,
      _historyContext: true
    };
  }

  // Preserve offsets and newlines while removing lexical regions that cannot
  // represent code usage. Imports are read separately from their source line.
  function maskSource(source, language) {
    var output = source.split('');
    var mode = 'code';
    var quote = '';
    for (var index = 0; index < source.length; index += 1) {
      var ch = source[index];
      var pair = source.slice(index, index + 2);
      if (mode === 'line') {
        if (ch === '\n') mode = 'code'; else output[index] = ' ';
      } else if (mode === 'block') {
        if (ch !== '\n') output[index] = ' ';
        if (pair === '*/') { output[++index] = ' '; mode = 'code'; }
      } else if (mode === 'string') {
        if (ch !== '\n') output[index] = ' ';
        if (ch === '\\') { if (index + 1 < source.length && source[index + 1] !== '\n') output[++index] = ' '; }
        else if (ch === quote) mode = 'code';
      } else if (mode === 'triple') {
        if (ch !== '\n') output[index] = ' ';
        if (source.slice(index, index + 3) === quote.repeat(3)) {
          output[index + 1] = output[index + 2] = ' ';
          index += 2;
          mode = 'code';
        }
      } else if (language === 'python' && ch === '#' || language !== 'python' && pair === '//') {
        output[index] = ' ';
        mode = 'line';
      } else if (language !== 'python' && pair === '/*') {
        output[index] = output[index + 1] = ' ';
        index += 1;
        mode = 'block';
      } else if (language === 'python' && (source.slice(index, index + 3) === '\"\"\"' || source.slice(index, index + 3) === "'''")) {
        quote = ch;
        output[index] = output[index + 1] = output[index + 2] = ' ';
        index += 2;
        mode = 'triple';
      } else if (ch === '"' || ch === "'" || ch === '`') {
        // Rust lifetimes are identifiers rather than quoted character values.
        if (language === 'rust' && ch === "'" && /[A-Za-z_]/.test(source[index + 1] || '') && source[index + 2] !== "'") continue;
        quote = ch;
        output[index] = ' ';
        mode = 'string';
      }
    }
    return output.join('');
  }

  function importAliases(source, language, code) {
    var aliases = Object.create(null);
    var sourceLines = source.split('\n');
    var codeLines = code.split('\n');
    var goImport = false;
    sourceLines.forEach(function(line, index) {
      var clean = codeLines[index] || '';
      var match;
      if (language === 'python') {
        if (/^\s*import\s/.test(clean) && (match = /^\s*import\s+(.+?)(?:\s*#.*)?$/.exec(line))) {
          match[1].split(',').forEach(function(value) {
            var entry = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(value);
            if (entry) aliases[entry[2] || entry[1].split('.')[0]] = entry[2] ? entry[1] : entry[1].split('.')[0];
          });
        } else if (/^\s*from\s/.test(clean) && (match = /^\s*from\s+([\w.]+)\s+import\s+(.+?)(?:\s*#.*)?$/.exec(line))) {
          match[2].split(',').forEach(function(value) {
            var entry = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(value);
            if (entry) aliases[entry[2] || entry[1]] = match[1] + '.' + entry[1];
          });
        }
      } else if (language === 'javascript') {
        if (/^\s*import\s/.test(clean) && (match = /^\s*import\s+(.+?)\s+from\s*['"]([^'"]+)['"]/.exec(line))) {
          var bindings = match[1];
          var namespace = /\*\s+as\s+([\w$]+)/.exec(bindings);
          var defaultName = /^([\w$]+)/.exec(bindings);
          if (namespace) aliases[namespace[1]] = match[2];
          if (defaultName) aliases[defaultName[1]] = match[2];
          var named = /\{([^}]+)\}/.exec(bindings);
          if (named) named[1].split(',').forEach(function(value) {
            var entry = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(value);
            if (entry) aliases[entry[2] || entry[1]] = match[2] + '.' + entry[1];
          });
        }
        if (/\brequire\s*\(/.test(clean) && (match = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/.exec(line))) aliases[match[1]] = match[2];
      } else if (language === 'go') {
        if (/^\s*import\s*\(/.test(clean)) goImport = true;
        if ((goImport || /^\s*import\s/.test(clean)) && (match = /^\s*(?:import\s+)?(?:([\w]+)\s+)?"([^"\n]+)"/.exec(line))) {
          var name = match[1] || match[2].split('/').pop();
          if (name !== '_') aliases[name] = match[2];
        }
        if (/^\s*\)/.test(clean)) goImport = false;
      } else if (language === 'rust' && /^\s*(?:pub\s+)?use\s/.test(clean)) {
        match = /^\s*(?:pub\s+)?use\s+([\w:]+)(?:\s+as\s+(\w+))?\s*;/.exec(line);
        if (match) aliases[match[2] || match[1].split('::').pop()] = match[1].replace(/::/g, '.');
      } else if (language === 'java' && /^\s*import\s/.test(clean)) {
        match = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
        if (match) aliases[match[1].split('.').pop()] = match[1];
      } else if ((language === 'cpp' || language === 'c') && /\bnamespace\b/.test(clean)) {
        match = /\bnamespace\s+(\w+)\s*=\s*([\w:]+)\s*;/.exec(clean);
        if (match) aliases[match[1]] = match[2].replace(/::/g, '.');
      }
      // A declared receiver type improves member identity without guessing
      // through expressions or serializing source into preference records.
      if ((match = /\b(?:const|let|var|auto)\s+(\w+)\s*=\s*new\s+([\w.]+)/.exec(clean))) aliases[match[1]] = 'type:' + canonicalReceiver(match[2], aliases);
      if (language === 'python' && (match = /^\s*(\w+)\s*:\s*([\w.]+)/.exec(clean))) aliases[match[1]] = 'type:' + canonicalReceiver(match[2], aliases);
      if (language === 'java' && (match = /\b([A-Z][\w.]*)\s+(\w+)\s*(?:=|;)/.exec(clean))) aliases[match[2]] = 'type:' + canonicalReceiver(match[1], aliases);
      if (language === 'go' && (match = /^\s*var\s+(\w+)\s+\*?([\w.]+)/.exec(clean))) aliases[match[1]] = 'type:' + canonicalReceiver(match[2], aliases);
      if (language === 'rust' && (match = /^\s*let\s+(?:mut\s+)?(\w+)\s*:\s*&?(?:mut\s+)?([\w:]+)/.exec(clean))) aliases[match[1]] = 'type:' + canonicalReceiver(match[2], aliases);
    });
    return aliases;
  }

  function canonicalReceiver(receiver, aliases) {
    var value = String(receiver || '').replace(/::|->/g, '.');
    var dot = value.indexOf('.');
    var root = dot < 0 ? value : value.slice(0, dot);
    return aliases[root] ? aliases[root] + (dot < 0 ? '' : value.slice(dot)) : value;
  }

  function analysisFor(model, state) {
    var version = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
    if (state.analysis && version !== null && state.analysis.version === version) return state.analysis;
    var source = String(model.getValue() || '');
    if (source.length > MAX_SOURCE_LENGTH || /(?:@generated|auto-generated|generated code|DO NOT EDIT)/i.test(source.slice(0, 1024))) return null;
    var language = languageOf(typeof model.getLanguageId === 'function' ? model.getLanguageId() : '');
    var code = maskSource(source, language);
    state.analysis = { version: version, source: source, code: code, aliases: importAliases(source, language, code), language: language };
    return state.analysis;
  }

  function modelState(model) {
    var state = models.get(model);
    if (!state) {
      var documentKey = hash(model.uri && model.uri.toString ? model.uri.toString() : '');
      state = { model: model, documentKey: documentKey, analysis: null, aliasContext: null, timer: null, counts: new Map(), highWater: new Map(), initialized: false, skipLearning: false, reason: 'open' };
      models.set(model, state);
      observed.add(state);
      documents.set(documentKey, state);
      if (observed.size > 64) {
        var oldest = observed.values().next().value;
        if (oldest.timer !== null) global.clearTimeout(oldest.timer);
        observed.delete(oldest);
        documents.delete(oldest.documentKey);
        models.delete(oldest.model);
      }
    }
    return state;
  }

  function contextFor(model, position, fallback) {
    var context = Object.assign({}, fallback || {});
    if (!model || !position) return normalizeContext(context);
    var state = modelState(model);
    context.language = typeof model.getLanguageId === 'function' ? model.getLanguageId() : context.language;
    context.prefix = typeof model.getLineContent === 'function' ? model.getLineContent(position.lineNumber).slice(0, position.column - 1) : context.linePrefix;
    var word = typeof model.getWordUntilPosition === 'function' ? model.getWordUntilPosition(position) : null;
    if (word) {
      context.word = word.word;
      context.range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    }
    context.documentKey = hash(model.uri && model.uri.toString ? model.uri.toString() : '');
    context = normalizeContext(context);
    if (!state.aliasContext || state.aliasContext.lineNumber !== position.lineNumber) {
      // Ordinary prefix typing reuses these imports. Only an edit before this
      // line or a cursor-line change invalidates them, avoiding a full document
      // lexical scan for each completion keystroke.
      var sourceBefore = '';
      if (typeof model.getValueInRange === 'function') {
        sourceBefore = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: 1 });
      } else if (typeof model.getLineContent === 'function') {
        var linesBefore = [];
        for (var line = 1; line < position.lineNumber && line <= 5000; line += 1) linesBefore.push(model.getLineContent(line));
        sourceBefore = linesBefore.join('\n');
      }
      sourceBefore = String(sourceBefore).slice(0, MAX_SOURCE_LENGTH);
      state.aliasContext = {
        lineNumber: position.lineNumber,
        aliases: importAliases(sourceBefore, context.language, maskSource(sourceBefore, context.language))
      };
    }
    context.receiver = canonicalReceiver(context.receiver, state.aliasContext.aliases);
    return context;
  }

  function recordKey(context, label, workspace) {
    var identity = context.kind === 'import' ? labelOf(label).trim().slice(0, 160) : symbolName(label);
    return JSON.stringify([context.accountKey, workspace, context.language, context.kind, context.receiver, identity]);
  }

  function addRecord(context, label, weight, timestamp, workspace) {
    var key = recordKey(context, label, workspace);
    var previous = records.get(key);
    records.delete(key);
    records.set(key, { key: key, count: Math.min(100, (previous && previous.count || 0) + weight), updatedAt: timestamp });
    if (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
    schedulePersist();
  }

  function recordAccepted(context, item) {
    if (!enabled || disposed || !symbolName(item)) return;
    var normalized = normalizeContext(context);
    var timestamp = Date.now();
    addRecord(normalized, item, 3, timestamp, normalized.workspaceKey);
    addRecord(normalized, item, 1, timestamp, '*');
  }

  function recordValue(context, label, weight) {
    addRecord(context, label, weight, Date.now(), context.workspaceKey);
    addRecord(context, label, weight * 0.3, Date.now(), '*');
  }

  function score(item, context) {
    if (!enabled || disposed) return 0;
    var normalized = normalizeContext(context);
    var project = records.get(recordKey(normalized, item, normalized.workspaceKey));
    var personal = records.get(recordKey(normalized, item, '*'));
    function value(record, multiplier) {
      if (!record) return 0;
      var age = Math.max(0, Date.now() - record.updatedAt);
      return Math.log1p(record.count) * multiplier * Math.pow(0.5, age / (30 * 24 * 60 * 60 * 1000));
    }
    var document = documents.get(normalized.documentKey);
    var used = document && document.counts.get(normalized.receiver + '\0' + symbolName(item)) || 0;
    return value(project, 12) + value(personal, 4) + Math.min(12, used * 2);
  }

  function matchQuality(item, context) {
    var query = String(context.word || '').toLowerCase();
    var label = symbolName(item).toLowerCase();
    if (!query) return 2;
    if (label === query) return 0;
    if (label.indexOf(query) === 0) return 1;
    return 3;
  }

  function sortText(item, context, fallback) {
    var normalized = normalizeContext(context);
    var preference = Math.max(0, 9999 - Math.round(score(item, normalized) * 10));
    return matchQuality(item, normalized) + ':' + String(preference).padStart(4, '0') + ':' + String(fallback || item && item.sortText || labelOf(item));
  }

  function rank(items, context, limit) {
    var normalized = normalizeContext(context);
    var ranked = (items || []).map(function(item, index) {
      return { item: item, index: index, quality: matchQuality(item, normalized), preference: score(item, normalized), fallback: String(item && item.sortText || labelOf(item)) };
    });
    ranked.sort(function(left, right) {
      return left.quality - right.quality || right.preference - left.preference || left.fallback.localeCompare(right.fallback) || left.index - right.index;
    });
    return ranked.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : ranked.length).map(function(entry, index) {
      return Object.assign({}, entry.item, { sortText: String(index).padStart(6, '0') });
    });
  }

  function rememberSuggestions(context, items) {
    if (!enabled || disposed) return;
    var normalized = normalizeContext(context);
    pending = pending.filter(function(entry) { return entry.at > Date.now() - 5000 && entry.context.documentKey !== normalized.documentKey; }).slice(-7);
    pending.push({ context: normalized, at: Date.now(), items: (items || []).slice(0, 500).map(function(item) {
      var edit = item && item.textEdit;
      return { label: labelOf(item), insertText: edit && edit.newText || item && item.insertText || labelOf(item), range: edit && edit.range || item && item.range || normalized.range, command: item && item.command };
    }) });
  }

  function rangeMatches(left, right) {
    if (!left || !right) return false;
    if (left.start && left.end) return left.start.line + 1 === right.startLineNumber && left.start.character + 1 === right.startColumn && left.end.line + 1 === right.endLineNumber && left.end.character + 1 === right.endColumn;
    return ['startLineNumber', 'endLineNumber', 'startColumn', 'endColumn'].every(function(key) { return left[key] === right[key]; });
  }

  function observeAcceptance(model, changes) {
    if (!Array.isArray(changes) || changes.length !== 1) return;
    var documentKey = hash(model.uri && model.uri.toString ? model.uri.toString() : '');
    pending.forEach(function(entry) {
      if (entry.at < Date.now() - 5000 || entry.context.documentKey !== documentKey) return;
      var item = entry.items.find(function(candidate) {
        // Items with our own command record themselves after insertion. Only
        // native-command candidates require the insertion observation path.
        return candidate.command && candidate.command.id !== COMMAND_ID && candidate.insertText === changes[0].text && rangeMatches(candidate.range, changes[0].range);
      });
      if (item) { recordAccepted(entry.context, item.label); entry.at = 0; }
    });
  }

  function usageCounts(analysis, allowTerminal) {
    var counts = new Map();
    var pattern = /\b([A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*)(\.|::|->)([A-Za-z_$][\w$]*)\s*(?=\(|[,\)\]\};=+*\/-])/g;
    var match;
    while ((match = pattern.exec(analysis.code))) {
      var receiver = canonicalReceiver(match[1], analysis.aliases);
      var key = receiver + '\0' + match[3];
      counts.set(key, Math.min(20, (counts.get(key) || 0) + 1));
    }
    if (allowTerminal) {
      var terminal = /\b([A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*)(\.|::|->)([A-Za-z_$][\w$]*)\s*$/gm;
      while ((match = terminal.exec(analysis.code))) {
        var terminalKey = canonicalReceiver(match[1], analysis.aliases) + '\0' + match[3];
        counts.set(terminalKey, Math.min(20, (counts.get(terminalKey) || 0) + 1));
      }
    }
    return counts;
  }

  function processObservation(state) {
    state.timer = null;
    if (disposed || !enabled) return;
    var model = state.model;
    if (typeof model.isDisposed === 'function' && model.isDisposed()) {
      observed.delete(state);
      documents.delete(state.documentKey);
      return;
    }
    var analysis = analysisFor(model, state);
    if (!analysis) return;
    var counts = usageCounts(analysis, state.reason === 'save');
    counts.forEach(function(count, key) {
      var previous = state.highWater.get(key) || 0;
      if (state.initialized && !state.skipLearning && count > previous) {
        var parts = key.split('\0');
        var context = normalizeContext({ language: analysis.language, kind: 'member', receiver: parts[0] });
        recordValue(context, parts[1], Math.min(4, count - previous) * 0.6);
      }
      state.highWater.set(key, Math.max(previous, count));
    });
    state.counts = counts;
    state.initialized = true;
    state.skipLearning = false;
  }

  function observeModel(model, options) {
    if (!enabled || disposed || !model || typeof model.getValue !== 'function') return;
    var state = modelState(model);
    var value = options || {};
    var changes = value.changes;
    observeAcceptance(model, changes);
    state.reason = value.reason || 'change';
    if (state.reason === 'open') state.skipLearning = true;
    if (Array.isArray(changes)) {
      var inserted = changes.reduce(function(total, change) { return total + String(change.text || '').length; }, 0);
      var newlines = changes.reduce(function(total, change) { return total + (String(change.text || '').match(/\n/g) || []).length; }, 0);
      if (inserted > 256 || newlines > 3 || changes.length > 12) state.skipLearning = true;
      if (state.aliasContext && changes.some(function(change) {
        return !change.range || change.range.startLineNumber < state.aliasContext.lineNumber;
      })) state.aliasContext = null;
    } else {
      state.aliasContext = null;
    }
    if (state.timer !== null) global.clearTimeout(state.timer);
    if (state.reason === 'open' || state.reason === 'save') processObservation(state);
    else state.timer = global.setTimeout(function() { processObservation(state); }, 700);
  }

  function command(context, item) {
    if (!enabled || !item || !labelOf(item) || item.command) return item && item.command;
    return { id: COMMAND_ID, title: '', arguments: [normalizeContext(context), labelOf(item)] };
  }

  function install(editorApi) {
    if (!editorApi || typeof editorApi.registerCommand !== 'function') return null;
    return editorApi.registerCommand(COMMAND_ID, function(_accessor, context, label) { recordAccepted(context, label); });
  }

  function flush() {
    observed.forEach(function(state) {
      if (state.timer !== null) { global.clearTimeout(state.timer); processObservation(state); }
    });
    if (persistTimer !== null) { global.clearTimeout(persistTimer); persist(); }
  }

  function clear() {
    if (persistTimer !== null) global.clearTimeout(persistTimer);
    persistTimer = null;
    records.clear();
    pending = [];
    legacy = [];
    observed.forEach(function(state) {
      if (state.timer !== null) global.clearTimeout(state.timer);
      state.timer = null;
      state.counts.clear();
    });
    try { if (global.localStorage) { global.localStorage.removeItem(STORAGE_KEY); global.localStorage.removeItem(LEGACY_KEY); } } catch (_) {}
  }

  function setEnabled(value) {
    enabled = value === true;
    pending = [];
    observed.forEach(function(state) {
      if (state.timer !== null) global.clearTimeout(state.timer);
      state.timer = null;
      state.counts.clear();
      state.highWater.clear();
      state.initialized = false;
    });
    try { if (global.localStorage) global.localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false'); } catch (_) {}
  }

  function dispose() {
    flush();
    disposed = true;
    observed.clear();
    documents.clear();
    models = new WeakMap();
    pending = [];
  }

  global.completionHistory = {
    configureContext: configureContext,
    contextFor: contextFor,
    observeModel: observeModel,
    rank: rank,
    score: score,
    sortText: sortText,
    rememberSuggestions: rememberSuggestions,
    command: command,
    install: install,
    recordAccepted: recordAccepted,
    isEnabled: function() { return enabled; },
    setEnabled: setEnabled,
    clear: clear,
    flush: flush,
    dispose: dispose
  };
})(typeof window !== 'undefined' ? window : globalThis);
