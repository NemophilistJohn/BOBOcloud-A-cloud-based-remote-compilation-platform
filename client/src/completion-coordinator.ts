export type CompletionStrategy = 'on-demand' | 'smart' | 'project';

export interface CompletionModel {
  getValue(): string;
  getLanguageId(): string;
  getVersionId(): number;
  getLineContent(line: number): string;
  getWordUntilPosition(position: CompletionPosition): { word: string; startColumn: number; endColumn: number };
}

export interface CompletionPosition { lineNumber: number; column: number }
export interface CompletionCandidate {
  label: string | { label: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
  kind?: number;
  detail?: string;
  [key: string]: unknown;
}
export interface CompletionList { items?: CompletionCandidate[]; suggestions?: CompletionCandidate[]; isIncomplete?: boolean; incomplete?: boolean }
export interface CompletionQuery { queryKind: 'catalog' | 'module' | 'project'; module?: string; cursor?: string }
export interface CompletionIndexPage {
  schema: string;
  languageId: string;
  revision: string;
  runtimeId: string;
  queryKind?: string;
  module?: string;
  roots: string[];
  entries: Array<{ module: string; kind: string; symbols?: Array<{ name: string; kind: string }> }>;
  nextCursor?: string;
  complete?: boolean;
  truncated?: boolean;
}
interface IndexNode { name: string; kind: string; members: Array<{ name: string; kind: string }>; modules: IndexNode[] }
export interface CompletionIndexRecord { schema: string; roots: IndexNode[]; truncated?: boolean }
export interface CompletionSession {
  identity: string;
  transportIdentity?: string;
  language: string;
  runtimeId: string;
  revision: string;
  strategy: CompletionStrategy;
  capacityMiB: number;
  persistent: boolean;
}
export interface CompletionProgress { state: string; completedModules: number; totalModules: number; error: string; dataRevision?: number }
export interface CompletionIndexPorts {
  query(query: CompletionQuery): Promise<CompletionIndexPage>;
  hydrate(key: string): Promise<CompletionIndexRecord | null>;
  persist(key: string, record: CompletionIndexRecord): Promise<unknown>;
  changed(progress: CompletionProgress): void;
  isBusy(): boolean;
}
export interface CompletionCoordinatorDependencies {
  now(): number;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(timer: number): void;
}
type Provider = (...args: unknown[]) => unknown;
export interface CompletionCoordinatorService {
  readonly disposed: boolean;
  configure(session: CompletionSession | null, ports?: CompletionIndexPorts): void;
  pause(): void;
  suggestions(model: CompletionModel, position: CompletionPosition): CompletionList | null;
  activity(model?: CompletionModel): void;
  setProvider(provider: Provider | null): void;
  setResolver(resolver: Provider | null): void;
  resolveCompletionItem(...args: unknown[]): unknown;
  provideWithLocal(local: unknown, ...args: unknown[]): unknown;
  progress(): CompletionProgress;
  clear(): void;
  dispose(): void;
}

const SCHEMA = 'dependency-api-index-v1';
const MAX_CANDIDATES = 4096;
const MAX_MODULES = 4096;
const SYMBOL_KINDS: Record<string, number> = {
  module: 9, package: 9, class: 7, function: 3, method: 2, property: 10, field: 5,
  variable: 6, value: 6, constant: 21, type: 25, enum: 13, alias: 18
};

export function canonicalCompletionLanguage(language: string): string {
  if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'node'].includes(language)) return 'node';
  return language === 'c++' ? 'cpp' : language;
}

export function completionLabel(item: CompletionCandidate): string {
  return typeof item.label === 'string' ? item.label : item.label?.label || '';
}

export function mergeCompletionCandidates(lists: Array<CompletionList | null | undefined>, limit = 100): CompletionList {
  const found = new Map<string, CompletionCandidate>();
  let incomplete = false;
  for (const list of lists) {
    incomplete ||= list?.isIncomplete === true || list?.incomplete === true;
    for (const item of list?.suggestions || list?.items || []) {
      const key = completionLabel(item) + '\0' + String(item.insertText || completionLabel(item));
      if (!found.has(key)) found.set(key, item);
    }
  }
  const items = [...found.values()];
  items.sort((left, right) => String(left.sortText || completionLabel(left)).localeCompare(String(right.sortText || completionLabel(right))));
  return { items: items.slice(0, limit), isIncomplete: incomplete };
}

interface ImportContext { module: string; prefix: string; imports: boolean }
interface LexicalState { quote: string; block: boolean; triple: boolean }
interface ModelImports { language: string; before: string; aliases: Map<string, string>; lexical: LexicalState; limited: boolean }
const modelImports = new WeakMap<CompletionModel, ModelImports>();

// Keep import literals available to the adapters, but never interpret code
// inside comments, strings or a previous line's multiline literal as imports.
function maskCode(source: string, language: string, initial?: LexicalState): { code: string; state: LexicalState } {
  const state = { quote: initial?.quote || '', block: initial?.block || false, triple: initial?.triple || false };
  let code = ''; let lineComment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index] || ''; const next = source[index + 1] || '';
    if (character === '\n') { lineComment = false; code += '\n'; continue; }
    if (lineComment) { code += ' '; continue; }
    if (state.block) {
      if (character === '*' && next === '/') { state.block = false; code += '  '; index++; }
      else code += ' ';
      continue;
    }
    if (state.quote) {
      if (character === '\\' && state.quote !== '`') { code += '  '; index++; continue; }
      if (character === state.quote && (!state.triple || source.slice(index, index + 3) === state.quote.repeat(3))) {
        code += state.triple ? '   ' : ' ';
        if (state.triple) index += 2;
        state.quote = ''; state.triple = false;
      } else code += ' ';
      continue;
    }
    if (language === 'python' && character === '#' || language !== 'python' && character === '/' && next === '/') {
      lineComment = true; code += ' '; continue;
    }
    if (language !== 'python' && character === '/' && next === '*') { state.block = true; code += '  '; index++; continue; }
    if (character === '"' || character === "'" || character === '`') {
      // Rust lifetimes are identifiers, not single quoted strings.
      if (language === 'rust' && character === "'" && /^'[A-Za-z_]\w*(?!')/.test(source.slice(index)) && !/^'[^'\n]*'/.test(source.slice(index))) { code += character; continue; }
      state.quote = character; state.triple = language === 'python' && source.slice(index, index + 3) === character.repeat(3);
      code += state.triple ? '   ' : ' '; if (state.triple) index += 2;
    } else code += character;
  }
  return { code, state };
}

function parseImports(source: string, language: string): { aliases: Map<string, string>; lexical: LexicalState } {
  const aliases = new Map<string, string>();
  const masked = maskCode(source, language); const lines = source.split('\n'); const codeLines = masked.code.split('\n');
  let goBlock = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || ''; const code = codeLines[index] || '';
    let match: RegExpExecArray | null;
    if (language === 'python') {
      if (/^\s*import\b/.test(code) && (match = /^\s*import\s+([^#;]+)/.exec(line))) {
        for (const item of (match[1] || '').split(',')) {
          const value = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
          if (value) aliases.set(value[2] || (value[1] || '').split('.')[0] || '', value[2] ? value[1] || '' : (value[1] || '').split('.')[0] || '');
        }
      } else if (/^\s*from\b/.test(code) && (match = /^\s*from\s+([\w.]+)\s+import\s+([^#;]+)/.exec(line))) {
        for (const item of (match[2] || '').replace(/[()]/g, '').split(',')) {
          const value = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
          if (value) aliases.set(value[2] || value[1] || '', (match[1] || '') + '.' + value[1]);
        }
      }
    } else if (language === 'node') {
      if (/^\s*import\b/.test(code) && (match = /^\s*import\s+(?:type\s+)?(?:\*\s+as\s+)?([\w$]+)(?:\s*,[^\n]*?)?\s+from\s*['"]([^'"]+)['"]/.exec(line))) aliases.set(match[1] || '', match[2] || '');
      else if (/^\s*(?:const|let|var)\b/.test(code) && (match = /^\s*(?:const|let|var)\s+([\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/.exec(line))) aliases.set(match[1] || '', match[2] || '');
    } else if (language === 'go') {
      if (/^\s*import\s*\(/.test(code)) { goBlock = true; continue; }
      if (goBlock && /^\s*\)/.test(code)) { goBlock = false; continue; }
      if ((goBlock || /^\s*import\b/.test(code)) && (match = /^\s*(?:import\s+)?(?:(\w+)\s+)?["`]([^"`]+)["`]/.exec(line))) {
        const name = match[1] || (match[2] || '').split('/').pop() || '';
        if (name !== '_') aliases.set(name, match[2] || '');
      }
    } else if (language === 'rust' && /^\s*(?:pub\s+)?(?:use|extern\s+crate)\b/.test(code)) {
      match = /^\s*(?:pub\s+)?(?:use|extern\s+crate)\s+([\w:]+)(?:\s+as\s+(\w+))?\s*;/.exec(line);
      if (match) aliases.set(match[2] || (match[1] || '').split('::').pop() || '', match[1] || '');
      match = /^\s*(?:pub\s+)?use\s+([\w:]+)::\{([^}]+)\}/.exec(line);
      if (match) for (const item of (match[2] || '').split(',')) {
        const value = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
        if (value) aliases.set(value[2] || value[1] || '', match[1] + '::' + value[1]);
      }
    } else if (language === 'java' && /^\s*import\b/.test(code) && (match = /^\s*import\s+([\w.]+)\s*;/.exec(line))) aliases.set((match[1] || '').split('.').pop() || '', match[1] || '');
    if (!/^\s*(?:import|from|use|extern)\b/.test(code) && !/\brequire\s*\(/.test(code)) {
      match = /^\s*(?:(?:const|let|var|class|def|function)\s+([\w$]+)|([\w$]+)\s*=(?!=))/.exec(code);
      if (match) aliases.delete(match[1] || match[2] || '');
    }
  }
  return { aliases, lexical: masked.state };
}

function importsBefore(model: CompletionModel, lineNumber: number, language: string): ModelImports {
  const source = model.getValue();
  let end = 0;
  for (let line = 1; line < lineNumber && end < source.length; line++) { const next = source.indexOf('\n', end); end = next < 0 ? source.length : next + 1; }
  const before = source.slice(0, Math.min(end, 500000)); const cached = modelImports.get(model);
  if (cached?.language === language && cached.before === before) return cached;
  const parsed = parseImports(before, language); const result = { language, before, ...parsed, limited: end > 500000 };
  modelImports.set(model, result); return result;
}

export function completionImportContext(model: CompletionModel, position: CompletionPosition): ImportContext | null {
  const language = canonicalCompletionLanguage(model.getLanguageId());
  const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const before = importsBefore(model, position.lineNumber, language);
  if (before.limited) return null;
  const code = maskCode(line, language, before.lexical).code;
  let match: RegExpExecArray | null;
  if (language === 'python') {
    match = /^\s*(?:import|from)\s+([\w.]*)$/.exec(code);
    if (!match && /^\s*import\b/.test(code)) match = /,\s*([\w.]*)$/.exec(code);
    if (match) {
      const value = match[1] || ''; const dot = value.lastIndexOf('.');
      return dot < 0 ? { module: '', prefix: value, imports: true } : { module: value.slice(0, dot), prefix: value.slice(dot + 1), imports: false };
    }
    match = /^\s*from\s+([\w.]+)\s+import\s+(\w*)$/.exec(code);
    if (match) return { module: match[1] || '', prefix: match[2] || '', imports: false };
  }
  if (language === 'node' || language === 'go') {
    match = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|^\s*(?:\w+\s+)?)['"`]([^'"`]*)$/.exec(line);
    if (match) {
      const header = code.slice(match.index, match.index + match[0].length - (match[1] || '').length - 1);
      if (language === 'node' ? /^(?:from\s*|import\s*|require\s*\(\s*)$/.test(header)
        : /^import\s*$/.test(header) || /^\s*\w*\s*$/.test(header) && /\bimport\s*\([^)]*$/.test(before.before)) return { module: '', prefix: match[1] || '', imports: true };
    }
  }
  if (language === 'java') {
    match = /^\s*import\s+(?:static\s+)?([\w.]*)$/.exec(code);
    if (match) return { module: '', prefix: match[1] || '', imports: true };
  }
  if (language === 'c' || language === 'cpp') {
    match = /^\s*#\s*include\s*[<"]([^>"]*)$/.exec(line);
    if (match && /^\s*#\s*include\b/.test(code)) return { module: '', prefix: match[1] || '', imports: true };
  }
  if (language === 'rust') {
    match = /^\s*(?:use|extern\s+crate)\s+([\w:]*)$/.exec(code);
    if (match) {
      const parts = (match[1] || '').split('::');
      return parts.length === 1 ? { module: '', prefix: parts[0] || '', imports: true }
        : { module: parts.slice(0, -1).join('::'), prefix: parts.at(-1) || '', imports: false };
    }
  }
  match = /([\w$]+(?:\.[\w$]+|::[\w$]+)*)(?:\.|::)([\w$]*)$/.exec(code);
  if (!match) return null;
  const receiver = match[1] || '';
  const root = receiver.split(/[.:]/)[0] || '';
  const resolved = before.aliases.get(root);
  return resolved ? { module: resolved + receiver.slice(root.length), prefix: match[2] || '', imports: false } : null;
}

export function createCompletionCoordinator(dependencies: CompletionCoordinatorDependencies): CompletionCoordinatorService {
  let session: CompletionSession | null = null;
  let ports: CompletionIndexPorts | null = null;
  let epoch = 0;
  let timer: number | null = null;
  let disposed = false;
  let paused = false;
  let provider: Provider | null = null;
  let resolver: Provider | null = null;
  interface Work { query: CompletionQuery; background: boolean }
  let active: Work | null = null;
  let lastActivity = 0;
  let currentModel: CompletionModel | undefined;
  let projectCursor: string | undefined;
  let projectDone = false;
  let projectPages = 0;
  let catalogReady = false;
  const records = new Map<string, CompletionIndexRecord>();
  const sizes = new Map<string, number>();
  let storedBytes = 0;
  let dataRevision = 0;
  const requested = new Map<string, Work>();
  const completed = new Set<string>();
  const cursors = new Map<string, string>();
  const seenCursors = new Map<string, Set<string>>();
  const failures = new Map<string, number>();
  const foreground: Work[] = [];
  const background: Work[] = [];
  const warmed = new Set<string>();
  const idleImports = new WeakMap<CompletionModel, { version: number; modules: string[] }>();
  let status: CompletionProgress = { state: 'disabled', completedModules: 0, totalModules: 0, error: '' };

  function publish(state: string, error = ''): void {
    status = { state, completedModules: warmed.size, totalModules: Math.max(warmed.size, records.get('catalog')?.roots.length || 0), error, dataRevision };
    ports?.changed({ ...status });
  }
  function stopTimer(): void { if (timer !== null) dependencies.clearTimer(timer); timer = null; }
  function schedule(delay: number): void {
    if (disposed || paused || !session || !ports) return;
    if (delay > 0 && foreground.length) delay = 0;
    stopTimer(); timer = dependencies.setTimer(() => { timer = null; void pump(); }, delay);
  }
  function store(key: string, record: CompletionIndexRecord): void {
    storedBytes -= sizes.get(key) || 0;
    records.delete(key); records.set(key, record);
    const size = JSON.stringify(record).length * 2;
    sizes.set(key, size); storedBytes += size; dataRevision++;
    const maxBytes = Math.max(128 * 1024, Math.min(64, session?.capacityMiB || 32) * 1024 * 1024);
    for (const entryKey of records.keys()) {
      if (storedBytes <= maxBytes && records.size <= MAX_MODULES) break;
      if (entryKey === 'catalog' || entryKey === key || requested.has(entryKey)) continue;
      storedBytes -= sizes.get(entryKey) || 0; sizes.delete(entryKey); records.delete(entryKey); completed.delete(entryKey);
      if (entryKey.startsWith('module:')) warmed.delete(entryKey.slice(7));
    }
  }
  function pageRecord(page: CompletionIndexPage, previous?: CompletionIndexRecord): CompletionIndexRecord {
    const roots = new Map((previous?.roots || []).map(node => [node.name, node]));
    for (const name of page.roots || []) if (!roots.has(name)) roots.set(name, { name, kind: 'module', members: [], modules: [] });
    for (const entry of page.entries || []) {
      const prior = roots.get(entry.module);
      const members = new Map((prior?.members || []).map(member => [member.name, member]));
      for (const member of entry.symbols || []) members.set(member.name, member);
      roots.set(entry.module, { name: entry.module, kind: 'module', members: [...members.values()].slice(0, MAX_CANDIDATES), modules: prior?.modules || [] });
    }
    return { schema: SCHEMA, roots: [...roots.values()].slice(0, MAX_CANDIDATES), truncated: page.truncated || previous?.truncated || undefined };
  }
  function queryKey(query: CompletionQuery): string { return query.queryKind === 'module' ? 'module:' + query.module : query.queryKind; }
  function retryReady(key: string): boolean { return dependencies.now() >= (failures.get(key) ?? -Infinity); }
  function retryDelay(key: string): number { return Math.max(0, (failures.get(key) || 0) - dependencies.now()); }
  function enqueue(query: CompletionQuery, idle = false): void {
    if (paused) return;
    const key = query.queryKind === 'module' ? 'module:' + query.module : query.queryKind;
    if (completed.has(key) || !retryReady(key)) return;
    const existing = requested.get(key);
    if (existing) {
      if (!idle && existing.background) {
        existing.background = false;
        const index = background.indexOf(existing);
        if (index >= 0) { background.splice(index, 1); foreground.push(existing); schedule(0); }
      }
      return;
    }
    const work = { query: { ...query, cursor: cursors.get(key) || query.cursor }, background: idle };
    requested.set(key, work); (idle ? background : foreground).push(work); schedule(idle ? 700 : 0);
  }
  function importedQueries(): CompletionQuery[] {
    if (!currentModel || !session) return [];
    const version = currentModel.getVersionId(); let snapshot = idleImports.get(currentModel);
    if (!snapshot || snapshot.version !== version) {
      snapshot = { version, modules: [...new Set(parseImports(currentModel.getValue().slice(0, 500000), session.language).aliases.values())] };
      idleImports.set(currentModel, snapshot);
    }
    return snapshot.modules
      .filter(module => module && !warmed.has(module) && retryReady('module:' + module)).slice(0, session.strategy === 'project' ? MAX_MODULES : 24)
      .map(module => ({ queryKind: 'module', module }));
  }
  async function fetch(work: Work, generation: number): Promise<void> {
    const query = work.query;
    const context = session; const host = ports;
    if (!context || !host) return;
    const key = query.queryKind === 'module' ? 'module:' + query.module : query.queryKind;
    try {
      if (context.persistent && query.queryKind !== 'project' && !query.cursor) {
        const cached = await host.hydrate(key);
        if (generation !== epoch) return;
        if (cached?.schema === SCHEMA && Array.isArray(cached.roots)) {
          store(key, cached);
          completed.add(key);
          if (query.module) warmed.add(query.module);
          if (query.queryKind === 'catalog') catalogReady = true;
          requested.delete(key); publish('ready'); return;
        }
      }
      const page = await host.query(query);
      if (generation !== epoch || !session) return;
      if (page.schema !== SCHEMA || canonicalCompletionLanguage(page.languageId) !== context.language ||
          page.revision !== context.revision || page.runtimeId !== context.runtimeId ||
          page.queryKind && page.queryKind !== query.queryKind || query.queryKind === 'module' && page.module && page.module !== query.module ||
          !Array.isArray(page.roots) || !Array.isArray(page.entries)) throw new Error('index_identity_mismatch');
      if (page.complete === false && !page.nextCursor) throw new Error('index_missing_cursor');
      if (page.nextCursor) {
        const seen = seenCursors.get(key) || new Set<string>();
        if (page.nextCursor === query.cursor || seen.has(page.nextCursor) || seen.size >= MAX_MODULES) throw new Error('index_cursor_loop');
        seen.add(page.nextCursor); seenCursors.set(key, seen); cursors.set(key, page.nextCursor);
      } else { completed.add(key); cursors.delete(key); seenCursors.delete(key); }
      failures.delete(key);
      if (query.queryKind === 'project') {
        projectPages += 1;
        const module = page.module || page.entries[0]?.module;
        if (module) {
          const record = pageRecord(page, records.get('module:' + module));
          store('module:' + module, record); warmed.add(module);
          completed.add('module:' + module);
          if (context.persistent) void host.persist('module:' + module, record).catch(() => {});
        }
        projectCursor = page.nextCursor;
        projectDone = !page.nextCursor;
      } else {
        const record = pageRecord(page, records.get(key));
        store(key, record);
        if (query.module && !page.nextCursor) warmed.add(query.module);
        if (query.queryKind === 'catalog') catalogReady = !page.nextCursor;
        if (!page.nextCursor && context.persistent) void host.persist(key, record).catch(() => {});
      }
      if (page.nextCursor) {
        work.query = { ...query, cursor: page.nextCursor };
        (work.background ? background : foreground).push(work);
      } else requested.delete(key);
      publish(projectDone && context.strategy === 'project' ? 'complete' : 'ready');
    } catch (error) {
      if (generation !== epoch) return;
      const retryAfter = Number((error as { retryAfterMs?: number })?.retryAfterMs);
      failures.set(key, dependencies.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(1000, Math.min(60000, retryAfter)) : 5000));
      requested.delete(key);
      publish('error', error instanceof Error ? error.message : 'index_unavailable');
    }
  }
  async function pump(): Promise<void> {
    if (active || paused || !session || !ports || disposed) return;
    if (!catalogReady && !requested.has('catalog') && retryReady('catalog')) enqueue({ queryKind: 'catalog' });
    let work = foreground.shift();
    if (!work) {
      if (session.strategy === 'on-demand') return;
      if (ports.isBusy() || dependencies.now() - lastActivity < 700) { publish('paused'); schedule(700); return; }
      const imported = importedQueries()[0];
      if (imported && !requested.has(queryKey(imported))) {
        work = { query: { ...imported, cursor: cursors.get(queryKey(imported)) }, background: true }; requested.set(queryKey(imported), work);
      }
      work ||= background.shift();
      if (!work && session.strategy === 'project' && catalogReady && !projectDone && projectPages < MAX_MODULES && retryReady('project')) {
        work = { query: { queryKind: 'project', cursor: projectCursor }, background: true }; requested.set('project', work);
      }
      if (!work) { if (failures.size) schedule(5000); return; }
    }
    active = work; const generation = epoch;
    publish('loading'); await fetch(work, generation);
    active = null;
    if (generation !== epoch) { if (session && ports) schedule(0); return; }
    if (foreground.length) schedule(0);
    else if (!catalogReady && failures.has('catalog')) schedule(retryDelay('catalog'));
    else if (session?.strategy !== 'on-demand') schedule(session?.strategy === 'project' ? 10 : 250);
  }
  function reset(): void {
    epoch += 1; paused = false; stopTimer(); records.clear(); sizes.clear(); storedBytes = 0; dataRevision++;
    requested.clear(); completed.clear(); cursors.clear(); seenCursors.clear(); failures.clear(); foreground.length = 0; background.length = 0;
    warmed.clear(); projectCursor = undefined; projectDone = false; projectPages = 0; catalogReady = false;
    currentModel = undefined; lastActivity = dependencies.now();
  }
  const service: CompletionCoordinatorService = {
    get disposed() { return disposed; },
    configure(next, host) {
      if (disposed) return;
      const changed = session?.identity !== next?.identity || session?.language !== (next ? canonicalCompletionLanguage(next.language) : undefined) || session?.runtimeId !== next?.runtimeId || session?.revision !== next?.revision;
      const policyChanged = session?.strategy !== next?.strategy || session?.persistent !== next?.persistent || session?.capacityMiB !== next?.capacityMiB;
      const transportChanged = session?.transportIdentity !== next?.transportIdentity;
      const resumed = paused;
      if (changed) reset();
      else if (transportChanged) {
        // Opaque server cursors bind the gateway session. Keep verified names
        // for this dependency revision, but restart unfinished traversals.
        epoch++; stopTimer(); requested.clear(); foreground.length = 0; background.length = 0;
        cursors.clear(); seenCursors.clear(); projectCursor = undefined; failures.clear();
      }
      if (!next || !host) { publish('disabled'); session = null; ports = null; stopTimer(); return; }
      session = next; ports = host;
      paused = false;
      if (!session || !ports) { stopTimer(); return; }
      session = { ...session, language: canonicalCompletionLanguage(session.language) };
      if (changed || (resumed || transportChanged) && !catalogReady) enqueue({ queryKind: 'catalog' });
      if (resumed || transportChanged) { publish(records.size ? 'ready' : 'paused'); schedule(0); }
      else if (policyChanged) schedule(700);
    },
    pause() {
      if (disposed || !session || paused) return;
      paused = true; epoch++; stopTimer(); requested.clear(); foreground.length = 0; background.length = 0;
      publish('paused');
    },
    suggestions(model, position) {
      if (!session || disposed || canonicalCompletionLanguage(model.getLanguageId()) !== session.language) return null;
      const context = completionImportContext(model, position);
      if (!context) return null;
      if (context.imports) enqueue({ queryKind: 'catalog' });
      else enqueue({ queryKind: 'module', module: context.module });
      const key = context.imports ? 'catalog' : 'module:' + context.module;
      const record = records.get(key);
      if (!record) return null;
      records.delete(key); records.set(key, record);
      const entries = context.imports
        ? record.roots.map(node => ({ name: node.name, kind: 'module' }))
        : record.roots.flatMap(node => node.name === context.module ? node.members.concat(node.modules.map(child => ({ name: child.name, kind: 'module' })))
          : node.name.startsWith(context.module + '.') || node.name.startsWith(context.module + '::')
            ? [{ name: node.name.slice(context.module.length).replace(/^(\.|::)/, '').split(/\.|::/)[0] || '', kind: 'module' }] : []);
      const unique = new Map(entries.map(item => [item.name, item]));
      const items = [...unique.values()].filter(item => item.name.toLowerCase().startsWith(context.prefix.toLowerCase())).map(item => ({
        label: item.name, insertText: item.name, filterText: item.name, kind: SYMBOL_KINDS[item.kind] || 6,
        sortText: '5000:' + item.name, detail: context.module, _boboSummary: true
      }));
      return { items, isIncomplete: !completed.has(key) };
    },
    activity(model) { lastActivity = dependencies.now(); currentModel = model || currentModel; if (session?.strategy !== 'on-demand') schedule(700); },
    setProvider(next) { provider = next; },
    setResolver(next) { resolver = next; },
    resolveCompletionItem(...args) { return resolver ? resolver(...args) : args[0]; },
    provideWithLocal(local, ...args) {
      if (provider) return provider(local, ...args);
      const candidate = local as { provideCompletionItems?: Provider };
      return candidate?.provideCompletionItems?.(...args) || { suggestions: [] };
    },
    progress() { return { ...status }; },
    clear() { reset(); publish('disabled'); if (session) enqueue({ queryKind: 'catalog' }); },
    dispose() { reset(); session = null; ports = null; provider = null; resolver = null; disposed = true; }
  };
  return service;
}
