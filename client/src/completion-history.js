// Small, local-only completion preference store. It records accepted inserts,
// never source text, and only nudges ordering after prefix/context matching.
(function initCompletionHistory(global) {
  var STORAGE_KEY = 'bobocloud.completionHistory.v1';
  var ENABLED_KEY = 'bobocloud.completionHistory.enabled.v1';
  var MAX_RECORDS = 600;
  var MAX_AGE_MS = 1000 * 60 * 60 * 24 * 120;
  var records = load();
  var pending = null;
  var enabled = loadEnabled();

  function now() { return Date.now(); }

  function load() {
    try {
      var value = JSON.parse(global.localStorage && global.localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value.filter(validRecord).slice(0, MAX_RECORDS) : [];
    } catch (_) { return []; }
  }

  function loadEnabled() {
    try { return !global.localStorage || global.localStorage.getItem(ENABLED_KEY) !== 'false'; } catch (_) { return true; }
  }

  function validRecord(value) {
    return value && typeof value === 'object' && typeof value.key === 'string' &&
      typeof value.label === 'string' && Number.isFinite(Number(value.count));
  }

  function persist() {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
    } catch (_) {}
  }

  function languageOf(context) {
    return String(context && (context.language || context.languageId) || '').toLowerCase();
  }

  function kindOf(context) {
    var prefix = String(context && (context.prefix || context.linePrefix) || '');
    if (/\b(?:import|from)\s+[A-Za-z_\w.]*(?:\s+import\s+)?[A-Za-z_\w]*$/i.test(prefix)) return 'import';
    if (context && context.memberAccess) return 'member';
    if (/[.(\[]\s*[A-Za-z_\w]*$/.test(prefix)) return 'call';
    if (/^\s*#/.test(prefix)) return 'directive';
    return 'symbol';
  }

  function keyFor(context, label) {
    return [languageOf(context), kindOf(context), String(label || '').toLowerCase()].join('|');
  }

  function prune() {
    var cutoff = now() - MAX_AGE_MS;
    records = records.filter(function(record) { return Number(record.updatedAt) >= cutoff; });
    records.sort(function(left, right) { return Number(right.updatedAt) - Number(left.updatedAt); });
    records = records.slice(0, MAX_RECORDS);
  }

  function find(key) {
    return records.find(function(record) { return record.key === key; }) || null;
  }

  function score(item, context) {
    if (!enabled) return 0;
    var label = typeof item === 'string' ? item : item && (item.label || item.insertText);
    var record = find(keyFor(context, label));
    if (!record) return 0;
    var age = Math.max(0, now() - Number(record.updatedAt || 0));
    var recency = Math.max(0, 8 - age / (1000 * 60 * 60 * 24 * 14));
    return Math.min(32, Number(record.count || 0) * 2 + recency);
  }

  function sortText(item, context, fallback) {
    var history = score(item, context);
    var bucket = String(Math.max(0, 999 - Math.round(history))).padStart(3, '0');
    return bucket + ':' + String(fallback || item && (item.sortText || item.label) || '').toLowerCase();
  }

  function rememberSuggestions(context, items) {
    if (!enabled) return;
    pending = {
      context: context || {},
      items: (items || []).map(function(item) {
        return { label: String(item && item.label || ''), insertText: String(item && item.insertText || item && item.label || '') };
      }).filter(function(item) { return item.label || item.insertText; }),
      at: now()
    };
  }

  function plainInsert(value) {
    return String(value || '').replace(/\$\{\d+(?::([^}]*))?\}/g, '$1').replace(/\$0/g, '');
  }

  function recordAccepted(context, label) {
    if (!enabled || !label) return;
    var key = keyFor(context, label);
    var record = find(key);
    if (record) {
      record.count = Number(record.count || 0) + 1;
      record.updatedAt = now();
    } else {
      records.unshift({ key: key, label: String(label), count: 1, updatedAt: now() });
    }
    prune();
    persist();
    pending = null;
  }

  function command(context, item) {
    if (!enabled || !item || !item.label) return item && item.command;
    // Preserve analyzer commands verbatim. Monaco will execute those after
    // acceptance, while candidates without one use the local history recorder.
    if (item.command) return item.command;
    return {
      id: 'bobo.completionHistory.accept',
      title: 'Record accepted completion',
      arguments: [context || {}, String(item.label), null]
    };
  }

  function install(editorApi, getEditor) {
    if (!editorApi || typeof editorApi.registerCommand !== 'function') return null;
    return editorApi.registerCommand('bobo.completionHistory.accept', function(_accessor, context, label, original) {
      recordAccepted(context, label);
      var editor = typeof getEditor === 'function' ? getEditor() : null;
      if (editor && original && typeof original.command === 'string' && typeof editor.executeCommand === 'function') {
        editor.executeCommand('completion', { id: original.command, arguments: original.arguments || [] });
      }
    });
  }

  function clear() {
    records = [];
    pending = null;
    try { if (global.localStorage) global.localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function setEnabled(value) {
    enabled = value === true;
    pending = null;
    try { if (global.localStorage) global.localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false'); } catch (_) {}
  }

  global.completionHistory = {
    score: score,
    sortText: sortText,
    rememberSuggestions: rememberSuggestions,
    command: command,
    install: install,
    recordAccepted: recordAccepted,
    isEnabled: function() { return enabled; },
    setEnabled: setEnabled,
    clear: clear
  };
})(typeof window !== 'undefined' ? window : globalThis);
