import type {
  TaskProblemDto,
  TaskProblemExecutionDto,
  TaskProblemMatcherDefinitionDto,
  TaskProblemMatcherDependencies,
  TaskProblemMatcherFacade,
  TaskProblemMatcherListener,
  TaskProblemMatcherMarkerDto,
  TaskProblemMatcherMonacoPort,
  TaskProblemMatcherModelPort,
  TaskProblemMatcherService,
  TaskProblemMatcherState,
  TaskProblemPatternDto,
  TaskProblemSession,
  TaskProblemSeverity
} from '../types/task-problem-matcher';

export const TASK_PROBLEM_MATCHER_SERVICE_ID = 'workbench.taskProblemMatcher';

const OWNER = 'task-problem-matcher';
const MAX_PROBLEMS = 500;
const MAX_LINE_LENGTH = 8192;

interface CompiledPattern extends TaskProblemPatternDto {
  readonly regexp: string;
  readonly re: RegExp;
}

interface ExpandedMatcher {
  readonly owner: string;
  readonly fileLocation: unknown;
  readonly patterns: readonly CompiledPattern[];
}

interface MatcherState {
  readonly matcher: ExpandedMatcher;
  index: number;
  captures: Record<string, unknown>;
}

interface MarkerLike {
  readonly owner?: unknown;
  readonly source?: unknown;
  readonly severity?: unknown;
  readonly startLineNumber?: unknown;
  readonly startColumn?: unknown;
  readonly endLineNumber?: unknown;
  readonly endColumn?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly [key: string]: unknown;
}

interface LegacyMatcherDefinition extends TaskProblemMatcherDefinitionDto {
  readonly pattern?: TaskProblemPatternDto | readonly TaskProblemPatternDto[];
}

const BUILT_INS: Readonly<Record<string, LegacyMatcherDefinition>> = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asState(value: TaskProblemMatcherState): TaskProblemMatcherState {
  return value || {};
}

function tr(
  dependencies: TaskProblemMatcherDependencies,
  source: string,
  values?: Readonly<Record<string, unknown>>
): string {
  const i18n = dependencies.getI18n();
  return i18n && typeof i18n.t === 'function' ? i18n.t(source, values) : String(source);
}

function stringValue(value: unknown): string {
  return String(value || '');
}

function relativePath(state: TaskProblemMatcherState, filePath: unknown): string {
  const root = stringValue(state.workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const value = stringValue(filePath).replace(/\\/g, '/');
  if (!root || !value) return '';
  if (value.toLowerCase().indexOf(root.toLowerCase() + '/') === 0) return value.slice(root.length + 1);
  return value;
}

function absolutePath(state: TaskProblemMatcherState, value: unknown, fileLocation: unknown): string {
  const root = stringValue(state.workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  let file = stringValue(value).trim().replace(/\\/g, '/');
  if (!root || !file || file.indexOf('\0') >= 0) return '';
  const locationKind = Array.isArray(fileLocation) ? fileLocation[0] : fileLocation;
  if (locationKind !== 'absolute' && !/^(?:[A-Za-z]:\/|\/)/.test(file)) file = root + '/' + file;
  let prefix = '';
  const driveMatch = file.match(/^([A-Za-z]:)(\/.*)?$/);
  if (driveMatch) {
    prefix = driveMatch[1] || '';
    file = driveMatch[2] || '/';
  }
  const parts: string[] = [];
  file.split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      parts.pop();
      return;
    }
    parts.push(part);
  });
  const normalized = (prefix ? prefix + '/' : '/') + parts.join('/');
  if (normalized.toLowerCase() !== root.toLowerCase() && normalized.toLowerCase().indexOf(root.toLowerCase() + '/') !== 0) return '';
  return normalized;
}

function numberAt(match: RegExpMatchArray | readonly unknown[], group: unknown, fallback: number): number {
  if (!group || !match[Number(group)]) return fallback;
  const value = Number(match[Number(group)]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function severityAt(match: readonly unknown[], group: unknown): TaskProblemSeverity {
  const raw = group && match[Number(group)] ? String(match[Number(group)]).toLowerCase() : '';
  if (raw === 'warning' || raw === 'warn') return 'warning';
  if (raw === 'info' || raw === 'note' || raw === 'information') return 'info';
  if (raw === 'hint') return 'hint';
  return 'error';
}

function safePattern(value: unknown): CompiledPattern | null {
  if (!isRecord(value) || typeof value.regexp !== 'string') return null;
  if (value.regexp.length === 0 || value.regexp.length > 512) return null;
  // Avoid regex constructs with the worst cross-engine backtracking behavior.
  if (/\\[1-9]|\(\?<?[=!]|\([^)]*[+*][^)]*\)[+*{]/.test(value.regexp)) return null;
  try {
    return Object.assign({}, value, { re: new RegExp(value.regexp) }) as CompiledPattern;
  } catch (_) {
    return null;
  }
}

function expandMatchers(value: unknown): ExpandedMatcher[] {
  const values = Array.isArray(value) ? value : [value];
  const result: LegacyMatcherDefinition[] = [];
  values.forEach((item) => {
    if (typeof item === 'string') {
      const builtIn = BUILT_INS[item];
      if (builtIn) result.push(builtIn);
      return;
    }
    if (!isRecord(item)) return;
    result.push(item as LegacyMatcherDefinition);
  });
  const expanded = result.map((item): ExpandedMatcher | null => {
    const patterns = Array.isArray(item.pattern) ? item.pattern : [item.pattern];
    const compiled = patterns.map(safePattern).filter((pattern): pattern is CompiledPattern => Boolean(pattern));
    return compiled.length ? {
      owner: String(item.owner || 'task'),
      fileLocation: (item.fileLocation || ['relative', '${workspaceFolder}']) as unknown,
      patterns: compiled
    } : null;
  });
  return expanded.filter((matcher): matcher is ExpandedMatcher => matcher !== null);
}

function mergeMatch(target: Record<string, unknown>, pattern: CompiledPattern, match: RegExpExecArray): void {
  ['file', 'line', 'column', 'endLine', 'endColumn', 'severity', 'code', 'message'].forEach((key) => {
    const group = pattern[key];
    if (group && match[Number(group)] !== undefined && match[Number(group)] !== '') {
      target[key] = match[Number(group)];
    }
  });
}

function toProblem(
  state: TaskProblemMatcherState,
  match: Record<string, unknown>,
  matcher: ExpandedMatcher
): TaskProblemDto | null {
  const filePath = absolutePath(state, match.file, matcher.fileLocation);
  if (!filePath || !match.message) return null;
  const line = Math.max(1, Number(match.line) || 1);
  const column = Math.max(1, Number(match.column) || 1);
  return {
    path: filePath,
    relativePath: relativePath(state, filePath),
    line,
    column,
    endLine: Math.max(1, Number(match.endLine) || Number(match.line) || 1),
    endColumn: Math.max(1, Number(match.endColumn) || (Number(match.column) || 1) + 1),
    severity: severityAt([null, match.severity], 1),
    code: String(match.code || ''),
    message: String(match.message).slice(0, 2000),
    owner: matcher.owner
  };
}

function matcherState(matcher: ExpandedMatcher): MatcherState {
  return { matcher, index: 0, captures: {} };
}

function consumeState(state: TaskProblemMatcherState, matcherStateValue: MatcherState, line: string): TaskProblemDto | null {
  const pattern = matcherStateValue.matcher.patterns[matcherStateValue.index];
  if (!pattern) return null;
  const match = pattern.re.exec(line);
  if (!match) {
    if (matcherStateValue.index > 0) {
      matcherStateValue.index = 0;
      matcherStateValue.captures = {};
      return consumeState(state, matcherStateValue, line);
    }
    return null;
  }
  mergeMatch(matcherStateValue.captures, pattern, match);
  if (matcherStateValue.index < matcherStateValue.matcher.patterns.length - 1) {
    matcherStateValue.index += 1;
    return null;
  }
  const result = toProblem(state, matcherStateValue.captures, matcherStateValue.matcher);
  if (pattern.loop && matcherStateValue.matcher.patterns.length > 1) {
    matcherStateValue.index = 1;
    ['line', 'column', 'endLine', 'endColumn', 'severity', 'code', 'message'].forEach((key) => {
      delete matcherStateValue.captures[key];
    });
  } else {
    matcherStateValue.index = 0;
    matcherStateValue.captures = {};
  }
  return result;
}

function markerSeverity(monaco: TaskProblemMatcherMonacoPort | null | undefined, problem: TaskProblemDto): number {
  const severity = monaco?.MarkerSeverity;
  if (!severity) return 8;
  if (problem.severity === 'warning') return severity.Warning ?? 4;
  if (problem.severity === 'info') return severity.Info ?? 2;
  if (problem.severity === 'hint') return severity.Hint ?? 1;
  return severity.Error ?? 8;
}

function markerFor(monaco: TaskProblemMatcherMonacoPort | null | undefined, problem: TaskProblemDto): TaskProblemMatcherMarkerDto {
  return {
    startLineNumber: problem.line,
    startColumn: problem.column,
    endLineNumber: problem.endLine,
    endColumn: Math.max(problem.column + 1, problem.endColumn),
    severity: markerSeverity(monaco, problem),
    message: problem.message,
    code: problem.code || undefined,
    source: problem.owner || 'task'
  };
}

function modelPath(model: TaskProblemMatcherModelPort | null | undefined): string {
  return model && model.uri && model.uri.fsPath ? String(model.uri.fsPath) : '';
}

function markerCode(marker: MarkerLike | null | undefined): string {
  if (!marker || marker.code === undefined || marker.code === null) return '';
  if (typeof marker.code === 'object' && marker.code) {
    return String((marker.code as { readonly value?: unknown }).value || '');
  }
  return String(marker.code);
}

export function createTaskProblemMatcherService(
  dependencies: TaskProblemMatcherDependencies
): TaskProblemMatcherService {
  const state = asState(dependencies.state);
  const listeners = new Set<TaskProblemMatcherListener>();
  const problemsByPath = new Map<string, TaskProblemDto[]>();
  let activeSession: TaskProblemSession | null = null;
  let problemsSnapshot: TaskProblemDto[] | null = null;
  let disposed = false;

  function invalidateProblems(): void {
    problemsSnapshot = null;
  }

  function getProblems(): TaskProblemDto[] {
    if (!problemsSnapshot) {
      problemsSnapshot = Array.from(problemsByPath.values()).flat().sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath) || left.line - right.line || left.column - right.column
      ));
    }
    return problemsSnapshot.slice();
  }

  function getMonaco(): TaskProblemMatcherMonacoPort | null | undefined {
    return dependencies.getMonaco();
  }

  function applyModel(model: unknown): void {
    const monaco = getMonaco();
    if (!monaco || !model || !monaco.editor || typeof monaco.editor.setModelMarkers !== 'function') return;
    const filePath = modelPath(model as TaskProblemMatcherModelPort);
    const problems = problemsByPath.get(relativePath(state, filePath)) || [];
    monaco.editor.setModelMarkers(model, OWNER, problems.map((problem) => markerFor(monaco, problem)));
    const editorCore = dependencies.getEditorCore();
    if (editorCore && typeof editorCore.refreshDiagnosticsForModel === 'function') {
      editorCore.refreshDiagnosticsForModel(model);
    }
  }

  function applyOpenModels(): void {
    const editor = getMonaco()?.editor;
    if (!editor || typeof editor.getModels !== 'function') return;
    editor.getModels().forEach(applyModel);
  }

  function emitChange(): void {
    if (disposed) return;
    const current = getProblems();
    listeners.forEach((listener) => {
      try {
        listener(current.slice());
      } catch (error) {
        dependencies.reportError?.(error);
      }
    });
    renderPanel();
  }

  function addProblem(problem: TaskProblemDto | null): void {
    if (!problem || getProblems().length >= MAX_PROBLEMS) return;
    const key = problem.relativePath;
    const items = problemsByPath.get(key) || [];
    if (items.some((item) => item.line === problem.line && item.column === problem.column && item.message === problem.message && item.owner === problem.owner)) return;
    items.push(problem);
    problemsByPath.set(key, items);
    invalidateProblems();
  }

  function severityFromMarker(marker: MarkerLike): TaskProblemSeverity {
    const severity = getMonaco()?.MarkerSeverity;
    if (!severity) return 'error';
    if (marker.severity === severity.Warning) return 'warning';
    if (marker.severity === severity.Info) return 'info';
    if (marker.severity === severity.Hint) return 'hint';
    return 'error';
  }

  function isWorkspaceFile(filePath: unknown): boolean {
    const root = stringValue(state.workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const value = stringValue(filePath).replace(/\\/g, '/').toLowerCase();
    return Boolean(root && value && (value === root || value.indexOf(root + '/') === 0));
  }

  function getMonacoProblems(): TaskProblemDto[] {
    const editor = getMonaco()?.editor;
    if (!editor || typeof editor.getModels !== 'function' || typeof editor.getModelMarkers !== 'function') return [];
    const result: TaskProblemDto[] = [];
    editor.getModels().some((model) => {
      const filePath = modelPath(model);
      if (!isWorkspaceFile(filePath)) return false;
      const markers = editor.getModelMarkers?.({ resource: model.uri }) || [];
      markers.forEach((markerValue) => {
        const marker = markerValue as MarkerLike;
        if (!marker || marker.owner === OWNER || result.length >= MAX_PROBLEMS) return;
        const startLine = Number(marker.startLineNumber) || 1;
        const startColumn = Number(marker.startColumn) || 1;
        result.push({
          path: filePath.replace(/\\/g, '/'),
          relativePath: relativePath(state, filePath),
          line: Math.max(1, startLine),
          column: Math.max(1, startColumn),
          endLine: Math.max(1, Number(marker.endLineNumber) || startLine),
          endColumn: Math.max(1, Number(marker.endColumn) || startColumn + 1),
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

  function getAllProblems(): TaskProblemDto[] {
    return getProblems().concat(getMonacoProblems()).slice(0, MAX_PROBLEMS).sort((left, right) => (
      left.relativePath.localeCompare(right.relativePath) || left.line - right.line || left.column - right.column || left.message.localeCompare(right.message)
    ));
  }

  function renderPanel(): void {
    const panel = dependencies.document.getElementById('panel-problems');
    if (!panel) return;
    panel.replaceChildren();
    const problems = getAllProblems();
    if (!problems.length) {
      const empty = dependencies.document.createElement('div');
      empty.className = 'problems-empty';
      empty.textContent = tr(dependencies, 'No problems');
      panel.appendChild(empty);
      return;
    }
    problems.forEach((problem) => {
      const row = dependencies.document.createElement('button') as HTMLButtonElement;
      row.type = 'button';
      row.className = 'problem-row problem-' + problem.severity;
      row.title = problem.message;
      const location = dependencies.document.createElement('span');
      location.className = 'problem-location';
      location.textContent = problem.relativePath + ':' + problem.line + ':' + problem.column;
      const message = dependencies.document.createElement('span');
      message.className = 'problem-message';
      message.textContent = problem.message;
      row.append(location, message);
      row.addEventListener('click', () => { openProblem(problem); });
      panel.appendChild(row);
    });
  }

  function clear(): void {
    if (disposed) return;
    problemsByPath.clear();
    invalidateProblems();
    applyOpenModels();
    emitChange();
  }

  function begin(execution?: TaskProblemExecutionDto | null): TaskProblemSession | null {
    if (disposed) return null;
    clear();
    const states = expandMatchers(execution?.problemMatcher).map(matcherState);
    activeSession = {
      consume(rawLine: unknown, stage?: unknown): void {
        if (!String(stage || '').startsWith('task:') || !states.length) return;
        String(rawLine === undefined ? '' : rawLine).replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
          if (line.length > MAX_LINE_LENGTH) return;
          states.forEach((matcherStateValue) => {
            const problem = consumeState(state, matcherStateValue, line);
            if (problem) addProblem(problem);
          });
        });
        applyOpenModels();
        emitChange();
      },
      finish(): void {
        activeSession = null;
        applyOpenModels();
        emitChange();
      }
    };
    return activeSession;
  }

  function openProblem(problem: TaskProblemDto | null | undefined): void {
    const workspace = dependencies.getWorkspace();
    if (!problem || !workspace || typeof workspace.openFile !== 'function') return;
    Promise.resolve(workspace.openFile(problem.path, problem.relativePath.split('/').pop() || problem.path)).then(() => {
      const editor = dependencies.getEditor();
      if (!editor) return;
      editor.revealPositionInCenter({ lineNumber: problem.line, column: problem.column });
      editor.setPosition({ lineNumber: problem.line, column: problem.column });
      editor.focus();
    }).catch((error) => dependencies.reportError?.(error));
  }

  function init(): void {
    if (disposed) return;
    renderPanel();
  }

  const service: TaskProblemMatcherService = {
    init,
    begin,
    clear,
    getProblems,
    getAllProblems,
    refreshMonacoProblems: renderPanel,
    onDidChange(listener: TaskProblemMatcherListener): () => void {
      if (disposed || typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applyModel,
    activeSession: () => activeSession,
    openProblem,
    get disposed(): boolean { return disposed; },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      activeSession = null;
      listeners.clear();
      problemsByPath.clear();
      invalidateProblems();
    }
  };
  return service;
}
