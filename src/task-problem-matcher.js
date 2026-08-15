// src/task-problem-matcher.js -- VS Code compatible task-output diagnostics.
// Matchers are intentionally evaluated only in the renderer. A task file is
// user-controlled project configuration; no pattern reaches the cloud runner.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var OWNER = 'task-problem-matcher';
  var MAX_PROBLEMS = 500;
  var MAX_LINE_LENGTH = 8192;
  var listeners = new Set();
  var problemsByPath = new Map();
  var activeSession = null;

  var BUILT_INS = {
    '$gcc': { owner: 'gcc', fileLocation: ['relative', '${workspaceFolder}'], pattern: {
      regexp: '^(.+?):(\\d+):(\\d+):\\s*(?:(fatal error|error|warning|note):\\s*)?(.*)$',
      file: 1, line: 2, column: 3, severity: 4, message: 5
    } },
    '$go': { owner: 'go', fileLocation: ['relative', '${workspaceFolder}'], pattern: {
      regexp: '^(.+?):(\\d+):(\\d+):\\s*(.*)$', file: 1, line: 2, column: 3, message: 4
    } },
    '$tsc': { owner: 'tsc', fileLocation: ['relative', '${workspaceFolder}'], pattern: {
      regexp: '^(.+?)\\((\\d+),(\\d+)\\):\\s*(error|warning)\\s+TS(\\d+):\\s*(.*)$',
      file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6
    } },
    '$eslint-compact': { owner: 'eslint', fileLocation: ['relative', '${workspaceFolder}'], pattern: [
      { regexp: '^(.+?):\\s*$', file: 1 },
      { regexp: '^\\s*(\\d+):(\\d+)\\s+(error|warning)\\s+(.*?)(?:\\s{2,}(\\S+))?$', line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true }
    ] },
    '$eslint-stylish': { owner: 'eslint', fileLocation: ['relative', '${workspaceFolder}'], pattern: [
      { regexp: '^(.+?)\\s*$', file: 1 },
      { regexp: '^\\s*(\\d+):(\\d+)\\s+(error|warning)\\s+(.*?)(?:\\s{2,}(\\S+))?$', line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true }
    ] },
    '$rustc': { owner: 'rustc', fileLocation: ['relative', '${workspaceFolder}'], pattern: [
      { regexp: '^(error|warning)(?:\\[([^\\]]+)\\])?:\\s*(.*)$', severity: 1, code: 2, message: 3 },
      { regexp: '^\\s*--?>\\s+(.+?):(\\d+):(\\d+)', file: 1, line: 2, column: 3 }
    ] },
    '$mscompile': { owner: 'mscompile', fileLocation: ['relative', '${workspaceFolder}'], pattern: {
      regexp: '^(.+?)\\((\\d+)(?:,(\\d+))?\\):\\s*(error|warning)\\s+([A-Z]+\\d+):\\s*(.*)$',
      file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6
    } }
  };

  function tr(source, values) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source, values) : String(source);
  }

  function emitChange() {
    listeners.forEach(function(listener) {
      try { listener(getProblems()); } catch (_) {}
    });
    renderPanel();
  }

  function relativePath(filePath) {
    var root = String(S.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var value = String(filePath || '').replace(/\\/g, '/');
    if (!root || !value) return '';
    if (value.toLowerCase().indexOf(root.toLowerCase() + '/') === 0) return value.slice(root.length + 1);
    return value;
  }

  function absolutePath(value, fileLocation) {
    var root = String(S.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var file = String(value || '').trim().replace(/\\/g, '/');
    if (!root || !file || file.indexOf('\0') >= 0) return '';
    var locationKind = Array.isArray(fileLocation) ? fileLocation[0] : fileLocation;
    if (locationKind !== 'absolute' && !/^(?:[A-Za-z]:\/|\/)/.test(file)) file = root + '/' + file;
    var prefix = '';
    var driveMatch = file.match(/^([A-Za-z]:)(\/.*)?$/);
    if (driveMatch) {
      prefix = driveMatch[1];
      file = driveMatch[2] || '/';
    }
    var parts = [];
    file.split('/').forEach(function(part) {
      if (!part || part === '.') return;
      if (part === '..') { parts.pop(); return; }
      parts.push(part);
    });
    var normalized = (prefix ? prefix + '/' : '/') + parts.join('/');
    if (normalized.toLowerCase() !== root.toLowerCase() && normalized.toLowerCase().indexOf(root.toLowerCase() + '/') !== 0) return '';
    return normalized;
  }

  function numberAt(match, group, fallback) {
    if (!group || !match[group]) return fallback;
    var value = Number(match[group]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  function severityAt(match, group) {
    var raw = group && match[group] ? String(match[group]).toLowerCase() : '';
    if (raw === 'warning' || raw === 'warn') return 'warning';
    if (raw === 'info' || raw === 'note' || raw === 'information') return 'info';
    if (raw === 'hint') return 'hint';
    return 'error';
  }

  function safePattern(pattern) {
    if (!pattern || typeof pattern !== 'object' || typeof pattern.regexp !== 'string') return null;
    if (pattern.regexp.length === 0 || pattern.regexp.length > 512) return null;
    // Avoid the regex constructs with the worst cross-engine backtracking
    // behaviour. This keeps project-local task config from freezing the UI.
    if (/\\[1-9]|\(\?<?[=!]|\([^)]*[+*][^)]*\)[+*{]/.test(pattern.regexp)) return null;
    try {
      return Object.assign({}, pattern, { re: new RegExp(pattern.regexp) });
    } catch (_) {
      return null;
    }
  }

  function expandMatchers(value) {
    var values = Array.isArray(value) ? value : [value];
    var result = [];
    values.forEach(function(item) {
      if (typeof item === 'string') {
        if (BUILT_INS[item]) result.push(BUILT_INS[item]);
        return;
      }
      if (!item || typeof item !== 'object') return;
      result.push(item);
    });
    return result.map(function(item) {
      var patterns = Array.isArray(item.pattern) ? item.pattern : [item.pattern];
      patterns = patterns.map(safePattern).filter(Boolean);
      return patterns.length ? {
        owner: String(item.owner || 'task'),
        fileLocation: item.fileLocation || ['relative', '${workspaceFolder}'],
        patterns: patterns
      } : null;
    }).filter(Boolean);
  }

  function mergeMatch(target, pattern, match) {
    ['file', 'line', 'column', 'endLine', 'endColumn', 'severity', 'code', 'message'].forEach(function(key) {
      if (pattern[key] && match[pattern[key]] !== undefined && match[pattern[key]] !== '') target[key] = match[pattern[key]];
    });
  }

  function toProblem(match, matcher) {
    var filePath = absolutePath(match.file, matcher.fileLocation);
    if (!filePath || !match.message) return null;
    return {
      path: filePath,
      relativePath: relativePath(filePath),
      line: Math.max(1, Number(match.line) || 1),
      column: Math.max(1, Number(match.column) || 1),
      endLine: Math.max(1, Number(match.endLine) || Number(match.line) || 1),
      endColumn: Math.max(1, Number(match.endColumn) || (Number(match.column) || 1) + 1),
      severity: severityAt([null, match.severity], 1),
      code: String(match.code || ''),
      message: String(match.message).slice(0, 2000),
      owner: matcher.owner
    };
  }

  function matcherState(matcher) {
    return { matcher: matcher, index: 0, captures: {} };
  }

  function consumeState(state, line) {
    var pattern = state.matcher.patterns[state.index];
    var match = pattern.re.exec(line);
    if (!match) {
      if (state.index > 0) {
        state.index = 0;
        state.captures = {};
        return consumeState(state, line);
      }
      return null;
    }
    mergeMatch(state.captures, pattern, match);
    if (state.index < state.matcher.patterns.length - 1) {
      state.index += 1;
      return null;
    }
    var result = toProblem(state.captures, state.matcher);
    if (pattern.loop && state.matcher.patterns.length > 1) {
      state.index = 1;
      ['line', 'column', 'endLine', 'endColumn', 'severity', 'code', 'message'].forEach(function(key) { delete state.captures[key]; });
    } else {
      state.index = 0;
      state.captures = {};
    }
    return result;
  }

  function markerSeverity(problem) {
    if (!global.monaco || !global.monaco.MarkerSeverity) return 8;
    if (problem.severity === 'warning') return global.monaco.MarkerSeverity.Warning;
    if (problem.severity === 'info') return global.monaco.MarkerSeverity.Info;
    if (problem.severity === 'hint') return global.monaco.MarkerSeverity.Hint;
    return global.monaco.MarkerSeverity.Error;
  }

  function markerFor(problem) {
    return {
      startLineNumber: problem.line,
      startColumn: problem.column,
      endLineNumber: problem.endLine,
      endColumn: Math.max(problem.column + 1, problem.endColumn),
      severity: markerSeverity(problem),
      message: problem.message,
      code: problem.code || undefined,
      source: problem.owner || 'task'
    };
  }

  function applyModel(model) {
    if (!global.monaco || !model || !global.monaco.editor) return;
    var filePath = model.uri && model.uri.fsPath ? model.uri.fsPath : '';
    var problems = problemsByPath.get(relativePath(filePath)) || [];
    global.monaco.editor.setModelMarkers(model, OWNER, problems.map(markerFor));
    if (BOBO.editorCore && BOBO.editorCore.refreshDiagnosticsForModel) BOBO.editorCore.refreshDiagnosticsForModel(model);
  }

  function applyOpenModels() {
    if (!global.monaco || !global.monaco.editor) return;
    global.monaco.editor.getModels().forEach(applyModel);
  }

  function addProblem(problem) {
    if (!problem || getProblems().length >= MAX_PROBLEMS) return;
    var key = problem.relativePath;
    var items = problemsByPath.get(key) || [];
    if (items.some(function(item) { return item.line === problem.line && item.column === problem.column && item.message === problem.message && item.owner === problem.owner; })) return;
    items.push(problem);
    problemsByPath.set(key, items);
  }

  function getProblems() {
    return Array.from(problemsByPath.values()).flat().sort(function(a, b) {
      return a.relativePath.localeCompare(b.relativePath) || a.line - b.line || a.column - b.column;
    });
  }

  function severityFromMarker(marker) {
    if (!global.monaco || !global.monaco.MarkerSeverity) return 'error';
    if (marker.severity === global.monaco.MarkerSeverity.Warning) return 'warning';
    if (marker.severity === global.monaco.MarkerSeverity.Info) return 'info';
    if (marker.severity === global.monaco.MarkerSeverity.Hint) return 'hint';
    return 'error';
  }

  function markerCode(marker) {
    if (!marker || marker.code === undefined || marker.code === null) return '';
    if (typeof marker.code === 'object') return String(marker.code.value || '');
    return String(marker.code);
  }

  function isWorkspaceFile(filePath) {
    var root = String(S.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    var value = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    return Boolean(root && value && (value === root || value.indexOf(root + '/') === 0));
  }

  // Monaco markers are the shared diagnostics truth for syntax rules and LSP.
  // Task output remains separately owned so Clear only clears the active task.
  function getMonacoProblems() {
    if (!global.monaco || !global.monaco.editor || !global.monaco.editor.getModels || !global.monaco.editor.getModelMarkers) return [];
    var result = [];
    global.monaco.editor.getModels().some(function(model) {
      var filePath = model && model.uri && model.uri.fsPath ? model.uri.fsPath : '';
      if (!isWorkspaceFile(filePath)) return false;
      var markers = global.monaco.editor.getModelMarkers({ resource: model.uri }) || [];
      markers.forEach(function(marker) {
        if (!marker || marker.owner === OWNER || result.length >= MAX_PROBLEMS) return;
        result.push({
          path: String(filePath).replace(/\\/g, '/'),
          relativePath: relativePath(filePath),
          line: Math.max(1, Number(marker.startLineNumber) || 1),
          column: Math.max(1, Number(marker.startColumn) || 1),
          endLine: Math.max(1, Number(marker.endLineNumber) || Number(marker.startLineNumber) || 1),
          endColumn: Math.max(1, Number(marker.endColumn) || (Number(marker.startColumn) || 1) + 1),
          severity: severityFromMarker(marker),
          code: markerCode(marker),
          message: String(marker.message || '').slice(0, 2000),
          owner: String(marker.source || marker.owner || 'editor')
        });
      });
      return result.length >= MAX_PROBLEMS;
    });
    return result;
  }

  function getAllProblems() {
    return getProblems().concat(getMonacoProblems()).slice(0, MAX_PROBLEMS).sort(function(a, b) {
      return a.relativePath.localeCompare(b.relativePath) || a.line - b.line || a.column - b.column || a.message.localeCompare(b.message);
    });
  }

  function clear() {
    problemsByPath.clear();
    applyOpenModels();
    emitChange();
  }

  function begin(execution) {
    clear();
    var states = expandMatchers(execution && execution.problemMatcher).map(matcherState);
    activeSession = {
      consume: function(rawLine, stage) {
        if (!String(stage || '').startsWith('task:') || !states.length) return;
        String(rawLine === undefined ? '' : rawLine).replace(/\r\n?/g, '\n').split('\n').forEach(function(line) {
          if (line.length > MAX_LINE_LENGTH) return;
          states.forEach(function(state) {
            var problem = consumeState(state, line);
            if (problem) addProblem(problem);
          });
        });
        applyOpenModels();
        emitChange();
      },
      finish: function() { activeSession = null; applyOpenModels(); emitChange(); }
    };
    return activeSession;
  }

  function openProblem(problem) {
    if (!problem || !BOBO.workspace || !BOBO.workspace.openFile) return;
    BOBO.workspace.openFile(problem.path, problem.relativePath.split('/').pop()).then(function() {
      if (S.editor) {
        S.editor.revealPositionInCenter({ lineNumber: problem.line, column: problem.column });
        S.editor.setPosition({ lineNumber: problem.line, column: problem.column });
        S.editor.focus();
      }
    });
  }

  function renderPanel() {
    var panel = global.document && global.document.getElementById('panel-problems');
    if (!panel) return;
    panel.replaceChildren();
    var problems = getAllProblems();
    if (!problems.length) {
      var empty = document.createElement('div');
      empty.className = 'problems-empty';
      empty.textContent = tr('No problems');
      panel.appendChild(empty);
      return;
    }
    problems.forEach(function(problem) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'problem-row problem-' + problem.severity;
      row.title = problem.message;
      var location = document.createElement('span');
      location.className = 'problem-location';
      location.textContent = problem.relativePath + ':' + problem.line + ':' + problem.column;
      var message = document.createElement('span');
      message.className = 'problem-message';
      message.textContent = problem.message;
      row.append(location, message);
      row.addEventListener('click', function() { openProblem(problem); });
      panel.appendChild(row);
    });
  }

  function init() {
    renderPanel();
  }

  BOBO.taskProblemMatcher = {
    init: init,
    begin: begin,
    clear: clear,
    getProblems: getProblems,
    getAllProblems: getAllProblems,
    refreshMonacoProblems: renderPanel,
    onDidChange: function(listener) { listeners.add(listener); return function() { listeners.delete(listener); }; },
    applyModel: applyModel,
    activeSession: function() { return activeSession; },
    openProblem: openProblem
  };
})(window);
