import { SharedDocument } from './realtime-document';
import type { SharedDraft, SharedFile, SharedOperation, SharedPane, SharedState, RealtimeHost, RealtimeFacade } from '../types/realtime';

interface Position { lineNumber: number; column: number }
interface Model {
  uri: { fsPath?: string; toString(): string }; getValue(): string; isDisposed(): boolean;
  getOffsetAt(position: Position): number; getPositionAt(offset: number): Position;
  getFullModelRange(): unknown; applyEdits(edits: { range: unknown; text: string }[]): void;
  onDidChangeContent(listener: (event: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void): { dispose(): void };
}
interface Editor {
  updateOptions(options: { readOnly: boolean }): void;
  getModel(): Model | null; getSelection(): { getStartPosition(): Position; getEndPosition(): Position } | null;
  getPosition(): Position | null; onDidChangeCursorSelection(fn: () => void): { dispose(): void };
  createContextKey(name: string, value: boolean): { set(value: boolean): void };
  addAction(action: Record<string, unknown>): { dispose(): void };
  createDecorationsCollection(decorations?: unknown[]): { set(decorations: unknown[]): void; clear(): void };
  addContentWidget(widget: CursorWidget): void;
  removeContentWidget(widget: CursorWidget): void;
}
interface CursorWidget { getId(): string; getDomNode(): HTMLElement; getPosition(): { position: Position; preference: number[] }; allowEditorOverflow: boolean }
interface Tab { path: string; name: string; model?: Model; dirty: boolean }
interface TeamMapping { teamId: string; projectId: string; branch: string; localPath: string; projectName?: string; realtimeEpoch?: string }
export interface RealtimeDependencies {
  document: Document; events: Window; host: RealtimeHost;
  state: { workspaceRoot: string | null; workspaceIdentity: unknown; tabs: Tab[]; activeTabPath: string | null;
    collaboration: { current: TeamMapping | null }; auth: { user: { id?: string; name?: string } | null; mode?: string; token?: string }; selectedRuntime: string; setupCommands: string[] };
  send(action: string, payload: Record<string, unknown>): Promise<unknown>;
  t(key: string, params?: Record<string, unknown>): string;
  confirm(options: Record<string, unknown>): Promise<boolean>;
  notify(text: string, error?: boolean): void;
  workspace: { updateTabbar(): void; updateTitlebar(): void; closeTab(path: string, options?: { force: boolean }): Promise<boolean>;
    renderTree(tree: unknown): void; saveAllTabs(options?: unknown): Promise<boolean>; renameSharedFile(oldPath: string, newPath: string): void;
    prepareSharedViews(readTextFile: (path: string) => Promise<string>): Promise<{ path: string; text: string }[]>;
    applySharedSnapshot(files: SharedFile[]): Promise<void> };
  refreshTree(): Promise<unknown>;
  editors(): Editor[];
  runArgs(language: string): Record<string, unknown>;
  language(path: string): string;
  projectKey(path: string): string;
  output(message: Record<string, unknown>): void;
  panel(): void;
  syncPersonal(): Promise<boolean>;
  prepareRunnerTransition(): Promise<unknown>;
}
interface DocumentState {
  file: SharedFile; doc: SharedDocument; model?: Model; subscription?: { dispose(): void };
  pending: SharedOperation[]; sending: boolean; suppress: boolean;
  undo: SharedOperation[][]; redo: SharedOperation[][]; lastEdit: number;
}
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function emptyState(): SharedState { return { enabled: false, epoch: '', branch: '', revision: 0, files: [], presence: [], deletions: [] }; }
function peerColor(userId: string): number {
  let hash = 0;
  for (const character of userId) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return hash % 6;
}

export function createRealtimeService(d: RealtimeDependencies): RealtimeFacade & { dispose(): void; refresh(): Promise<void> } {
  const { state: local, document: document, events, host, t } = d;
  let shared = emptyState(), online = false, disposed = false, joining = false, initializing = false, actor = '';
  let generation = 0, sequence = 0, reconnectTimer: number | undefined, draftTimer: number | undefined;
  let joiningGeneration = -1;
  const requestNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const documents = new Map<string, DocumentState>();
  const recovered = new Map<string, SharedDraft>();
  const requests = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: number }>();
  const listeners: (() => void)[] = [];
  const editorBindings = new Map<Editor, { dispose(): void }[]>();
  const decorations = new Map<Editor, ReturnType<Editor['createDecorationsCollection']>>();
  const cursorWidgets = new Map<Editor, CursorWidget[]>();
  const activeKeys = new Map<Editor, { set(value: boolean): void }>();
  const pendingLoads = new Map<string, Promise<DocumentState>>();
  let panel: HTMLElement | null = null;
  let refreshPromise: Promise<void> | null = null;
  let reconciliation: Promise<void> | null = null;
  let lastRunId = '', lastRunEvent = 0;
  let draftContext = '';
  let stateQueue = Promise.resolve();
  let deferredState: SharedState | null = null;
  let runObserver: ((event: Record<string, unknown>) => void) | null = null;

  function on(target: EventTarget, name: string, fn: EventListener): void {
    target.addEventListener(name, fn); listeners.push(() => target.removeEventListener(name, fn));
  }
  function mapping(): TeamMapping | null { return local.collaboration.current; }
  function authIdentity(): string {
    const auth = local.auth;
    if (auth.mode === 'single') return 'single';
    if (!auth.user || ((auth.mode === 'multi' || 'token' in auth) && !auth.token)) return '';
    return JSON.stringify([auth.mode || '', auth.user.id || auth.user.name || '', auth.token || '']);
  }
  function isActive(): boolean { return !!mapping()?.realtimeEpoch; }
  function relative(path: string): string {
    const root = (local.workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    const normalized = path.replace(/\\/g, '/');
    if (!root || !normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) throw new Error(t('File is outside the shared workspace'));
    return normalized.slice(root.length + 1);
  }
  function absolute(path: string): string { return (local.workspaceRoot || '').replace(/[\\/]$/, '') + '/' + path; }
  function fileAt(path: string): SharedFile | undefined { return shared.files.find(file => file.path === relative(path)); }
  function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  function request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!online || !authIdentity()) return Promise.reject(new Error(t('Collaboration is reconnecting. Your edits are kept locally.')));
    const requestId = actor + '-' + requestNonce + '-' + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = events.setTimeout(() => { requests.delete(requestId); reject(new Error(t('Collaboration request timed out'))); }, 20000);
      requests.set(requestId, { resolve, reject, timer });
      void host.send({ ...message, epoch: shared.epoch, requestId }).catch(error => {
        clearTimeout(timer); requests.delete(requestId); reject(error);
      });
    });
  }
  function draftValues(): SharedDraft[] {
    const values = [...recovered.values(), ...Array.from(documents.values()).filter(item => item.pending.length).map(item => ({
      fileId: item.file.id, path: item.file.path, epoch: shared.epoch, text: item.doc.text(),
      pending: item.pending, nodes: item.doc.snapshot(), clock: item.doc.clock
    }))];
    return [...new Map(values.map(draft => [draft.fileId, draft])).values()];
  }
  function persistDrafts(): Promise<unknown> {
    clearTimeout(draftTimer);
    return host.drafts({ drafts: draftValues(), contextKey: draftContext || undefined });
  }
  function scheduleDrafts(): void {
    clearTimeout(draftTimer);
    draftTimer = events.setTimeout(() => { void persistDrafts().catch(error => d.notify(errorMessage(error), true)); }, 150);
  }
  function publishText(item: DocumentState): void {
    const model = item.model;
    if (!model || model.isDisposed()) return;
    const before = model.getValue(), after = item.doc.text();
    if (before === after) return;
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const from = model.getPositionAt(start), to = model.getPositionAt(before.length - end);
    item.suppress = true;
    try { model.applyEdits([{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: after.slice(start, after.length - end) }]); }
    finally { item.suppress = false; }
  }
  function saved(item: DocumentState): void {
    for (const tab of local.tabs) if (tab.model === item.model) tab.dirty = item.pending.length > 0;
    d.workspace.updateTabbar(); d.workspace.updateTitlebar();
  }
  async function sendPending(item: DocumentState): Promise<void> {
    if (item.sending || !online) return;
    item.sending = true;
    const turn = generation;
    try {
      do {
        while (item.pending.length && online && turn === generation) {
          const operation = item.pending[0]!;
          await request({ type: 'edit', fileId: item.file.id, ...operation });
          if (turn !== generation) return;
          item.pending.shift(); saved(item); scheduleDrafts();
        }
        if (!online || turn !== generation) return;
        await host.materialize([{ ...item.file, content: item.doc.text() }], { epoch: shared.epoch, workspaceIdentity: local.workspaceIdentity });
        // Typing can enqueue more edits during the filesystem await. Keep the
        // same sender until those edits are acknowledged and materialized too.
      } while (item.pending.length && online && turn === generation);
    } catch (error) { if (turn === generation) d.notify(errorMessage(error), true); }
    finally { item.sending = false; }
  }
  function applyLocal(item: DocumentState, operation: SharedOperation, history = true): void {
    if (history) {
      const inverse = item.doc.inverse(operation), now = Date.now();
      const previous = item.undo[item.undo.length - 1];
      if (previous && now - item.lastEdit < 700 && !operation.delete.length) previous.unshift(inverse);
      else item.undo.push([inverse]);
      item.lastEdit = now; item.redo = [];
    }
    item.doc.apply(operation); item.pending.push(operation); saved(item); scheduleDrafts();
    void sendPending(item); sendPresence();
  }
  function bindModel(item: DocumentState, model: Model): void {
    if (item.model === model) return;
    item.subscription?.dispose(); item.model = model;
    publishText(item);
    item.subscription = model.onDidChangeContent(event => {
      if (item.suppress || !isActive()) return;
      try {
        const operation = item.doc.change(event.changes);
        applyLocal(item, operation);
      } catch (error) { d.notify(errorMessage(error), true); }
    });
    saved(item);
  }
  async function loadFile(file: SharedFile): Promise<DocumentState> {
    const present = documents.get(file.id);
    if (present) return present;
    const pending = pendingLoads.get(file.id);
    if (pending) return pending;
    const turn = generation;
    const load = request({ type: 'open', fileId: file.id }).then(message => {
      if (turn !== generation) throw new Error(t('Collaboration workspace changed'));
      const loaded = message.file as SharedFile;
      if (!loaded || loaded.binary || !Array.isArray(loaded.nodes)) throw new Error(t('This file is available as a local snapshot only'));
      const item: DocumentState = { file: loaded, doc: new SharedDocument(actor, loaded.nodes), pending: [], sending: false, suppress: false, undo: [], redo: [], lastEdit: 0 };
      documents.set(file.id, item); return item;
    }).finally(() => pendingLoads.delete(file.id));
    pendingLoads.set(file.id, load); return load;
  }
  async function prepareFile(path: string): Promise<void> {
    if (!isActive()) return;
    const file = fileAt(path);
    if (!file || file.directory) throw new Error(t('The shared file no longer exists'));
    if (file.binary) return;
    const turn = generation, context = { epoch: shared.epoch, workspaceIdentity: local.workspaceIdentity };
    const item = await loadFile(file);
    if (turn !== generation) throw new Error(t('Collaboration workspace changed'));
    await host.materialize([{ ...file, content: item.doc.text() }], context);
  }
  function undo(editor: Editor, redo: boolean): void {
    if (!isActive()) return;
    const item = Array.from(documents.values()).find(item => item.model === editor.getModel());
    if (!item) return;
    const source = redo ? item.redo : item.undo, target = redo ? item.undo : item.redo;
    const old = source.pop(); if (!old) return;
    const inverses: SharedOperation[] = [];
    for (const step of old) {
      const operation = item.doc.reidentify(step);
      inverses.unshift(item.doc.inverse(operation));
      applyLocal(item, operation, false);
    }
    target.push(inverses); item.lastEdit = 0; publishText(item);
  }
  function bindEditors(): void {
    const visible = d.editors();
    for (const editor of visible) {
      if (!editorBindings.has(editor)) {
        const key = editor.createContextKey('boboRealtimeEditing', false);
        activeKeys.set(editor, key);
        editorBindings.set(editor, [
          editor.onDidChangeCursorSelection(sendPresence),
          editor.addAction({ id: 'bobo.shared.undo', label: t('Undo my edit'), keybindings: [2048 | 56], precondition: 'boboRealtimeEditing && editorTextFocus && !editorReadonly', run: () => undo(editor, false) }),
          editor.addAction({ id: 'bobo.shared.redo', label: t('Redo my edit'), keybindings: [2048 | 1024 | 56, 2048 | 55], precondition: 'boboRealtimeEditing && editorTextFocus && !editorReadonly', run: () => undo(editor, true) })
        ]);
      }
      activeKeys.get(editor)!.set(isActive());
      const model = editor.getModel();
      const tab = local.tabs.find(tab => tab.model === model);
      if (isActive() && model && tab) {
        const file = fileAt(tab.path);
        editor.updateOptions({ readOnly: initializing || !file || !!file.binary });
        const turn = generation;
        if (file && !file.binary) void loadFile(file).then(item => { if (turn === generation && !model.isDisposed()) bindModel(item, model); }).catch(error => d.notify(errorMessage(error), true));
      }
    }
    for (const [editor, bindings] of editorBindings) {
      if (visible.includes(editor)) continue;
      bindings.forEach(binding => binding.dispose()); editorBindings.delete(editor);
      for (const widget of cursorWidgets.get(editor) || []) editor.removeContentWidget(widget);
      cursorWidgets.delete(editor);
      decorations.get(editor)?.clear(); decorations.delete(editor); activeKeys.delete(editor);
    }
    sendPresence(); renderCursors();
  }
  let presenceTimer: number | undefined;
  function sendPresence(): void {
    clearTimeout(presenceTimer);
    presenceTimer = events.setTimeout(() => {
      if (!isActive() || !online || !authIdentity()) return;
      const panes: SharedPane[] = [];
      d.editors().forEach((editor, index) => {
        const model = editor.getModel(), item = Array.from(documents.values()).find(item => item.model === model);
        if (!model || !item) return;
        const selection = editor.getSelection(), position = editor.getPosition();
        const start = selection?.getStartPosition() || position, end = selection?.getEndPosition() || position;
        panes.push({ paneId: String(index), fileId: item.file.id, editing: item.undo.length > 0 || item.pending.length > 0,
          cursor: start && end ? { anchor: item.doc.anchor(model.getOffsetAt(start)), focus: item.doc.anchor(model.getOffsetAt(end)) } : undefined });
      });
      void host.send({ type: 'presence', epoch: shared.epoch, panes }).catch(() => {});
    }, 70);
  }
  function renderCursors(): void {
    for (const editor of d.editors()) {
      for (const widget of cursorWidgets.get(editor) || []) editor.removeContentWidget(widget);
      cursorWidgets.set(editor, []);
      let collection = decorations.get(editor);
      if (!collection) { collection = editor.createDecorationsCollection(); decorations.set(editor, collection); }
      const item = Array.from(documents.values()).find(item => item.model === editor.getModel());
      if (!item?.model || !isActive()) { collection.clear(); continue; }
      const values: unknown[] = [];
      (shared.presence || []).forEach(person => {
        if (person.sessionId === actor) return;
        const color = peerColor(person.userId || person.name);
        for (const pane of person.panes || []) {
          if (pane.fileId !== item.file.id || !pane.cursor) continue;
          const start = item.model!.getPositionAt(item.doc.offset(pane.cursor.anchor));
          const end = item.model!.getPositionAt(item.doc.offset(pane.cursor.focus));
          values.push({ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
            options: { className: 'realtime-selection realtime-color-' + color,
              after: { content: '\u200b', inlineClassName: 'realtime-cursor realtime-color-' + color },
              hoverMessage: { value: person.name }, stickiness: 1 } });
          const label = document.createElement('div');
          label.className = 'realtime-cursor-label realtime-color-' + color;
          label.innerHTML = avatar(person) + '<span>' + esc(person.name) + '</span>';
          const widget: CursorWidget = { getId: () => 'shared-cursor-' + person.sessionId + '-' + pane.paneId,
            getDomNode: () => label, getPosition: () => ({ position: end, preference: [1, 2] }), allowEditorOverflow: true };
          editor.addContentWidget(widget); cursorWidgets.get(editor)!.push(widget);
        }
      });
      collection.set(values);
    }
    renderPresence();
  }
  function avatar(person: { name: string; avatar?: string }): string {
    const image = person.avatar || '';
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return '<img src="' + esc(image) + '" alt="">';
    const preset = /^(ocean|forest|sunset|graphite|violet|rose|amber)$/.test(image) ? image : 'graphite';
    return '<span class="avatar-' + preset + '">' + esc(Array.from(person.name || '?')[0]) + '</span>';
  }
  function renderPresence(): void {
    document.querySelectorAll('.realtime-tree-people').forEach(el => el.remove());
    if (!isActive()) return;
    document.querySelectorAll<HTMLElement>('#file-tree .tree-row[data-type="file"][data-path]').forEach(row => {
      let file: SharedFile | undefined;
      try { file = fileAt(row.dataset.path!); } catch (_) { return; }
      if (!file) return;
      const people = (shared.presence || []).filter(person => person.panes?.some(pane => pane.fileId === file!.id) || person.held?.[file!.id]);
      const unique = people.filter((person, index) => people.findIndex(p => p.userId === person.userId) === index);
      if (!unique.length) return;
      const rail = document.createElement('span'); rail.className = 'realtime-tree-people';
      rail.title = unique.map(person => person.name).join(', ');
      rail.innerHTML = unique.slice(0, 3).map(person => '<i>' + avatar(person) + '</i>').join('') + (unique.length > 3 ? '<small>+' + (unique.length - 3) + '</small>' : '');
      const sync = row.querySelector(':scope > .tree-sync-rail');
      const decoration = sync || row.querySelector(':scope > .tree-decoration-rail');
      row.insertBefore(rail, decoration);
    });
  }
  function renderPanel(): void {
    const container = document.getElementById('panel-team'); if (!container) return;
    const old = document.getElementById('team-workbench'); if (old) old.hidden = isActive();
    if (!panel) { panel = document.createElement('section'); panel.className = 'realtime-panel'; container.append(panel); }
    panel.hidden = !isActive() && !recovered.size;
    panel.classList.toggle('realtime-recovery-only', !isActive());
    if (!isActive()) {
      panel.innerHTML = Array.from(recovered.values()).map(draft => '<button data-recover="' + esc(draft.fileId) + '">' + esc(t('Export recovered edits for {path}', { path: draft.path })) + '</button>').join('');
      return;
    }
    const deletions = shared.deletions || [];
    const input = panel.querySelector<HTMLInputElement>('[data-rt-stdin]');
    const value = input?.value || '', focused = input === document.activeElement;
    const stop = document.getElementById('stop-code') as HTMLButtonElement | null;
    if (stop) stop.disabled = shared.run?.status !== 'running';
    panel.innerHTML = '<header><strong>' + esc(t('Live collaboration')) + '</strong><span role="status">' + esc(t(online ? 'Changes are saved to the shared workspace' : 'Collaboration is reconnecting. Your edits are kept locally.')) + '</span>' + (!online ? '<button data-rt="reconnect">' + esc(t('Reconnect')) + '</button>' : '') + '<button data-rt="version">' + esc(t('Create version')) + '</button><button data-rt="personal">' + esc(t('Save personal cloud snapshot')) + '</button></header>' +
      '<div class="realtime-panel-grid"><section><h4>' + esc(t('People and files')) + '</h4>' +
      (shared.presence || []).map(person => '<div class="realtime-person">' + avatar(person) + '<strong>' + esc(person.name) + '</strong><small>' + esc((person.panes || []).map(pane => shared.files.find(file => file.id === pane.fileId)?.path || '').filter(Boolean).join(', ')) + '</small></div>').join('') + '</section>' +
      '<section><h4>' + esc(t('Shared runs and events')) + '</h4>' + (shared.run ? '<div class="realtime-run"><strong>' + esc(t(shared.run.status)) + '</strong><code>' + esc(shared.run.id.slice(0, 12)) + '</code><button data-rt="output">' + esc(t('Show output')) + '</button><button data-rt="stop">' + esc(t('Stop')) + '</button></div>' + (shared.run.status === 'running' ? '<form class="realtime-stdin"><input data-rt-stdin maxlength="8192" aria-label="' + esc(t('Shared program input')) + '"><button type="submit">' + esc(t('Send input')) + '</button></form>' : '') : '<small>' + esc(t('No shared run yet')) + '</small>') +
      deletions.map(vote => '<article class="realtime-delete"><strong>' + esc(t('Delete {path}?', { path: shared.files.find(file => file.id === vote.fileId)?.path || vote.path })) + '</strong><time>' + esc(new Date(vote.expiresAt).toLocaleTimeString()) + '</time><button data-vote="' + esc(vote.id) + '" data-decision="consent">' + esc(t('Agree')) + '</button><button data-vote="' + esc(vote.id) + '" data-decision="veto">' + esc(t('Keep file')) + '</button>' + (vote.requestedBy === local.auth.user?.id ? '<button data-vote="' + esc(vote.id) + '" data-decision="cancel">' + esc(t('Cancel request')) + '</button>' : '') + '</article>').join('') +
      Array.from(recovered.values()).map(draft => '<button data-recover="' + esc(draft.fileId) + '">' + esc(t('Export recovered edits for {path}', { path: draft.path })) + '</button>').join('') + '</section></div>';
    const replacement = panel.querySelector<HTMLInputElement>('[data-rt-stdin]');
    if (replacement) { replacement.value = value; if (focused) replacement.focus(); }
  }
  async function applyState(next: SharedState): Promise<void> {
    const turn = generation, context = { epoch: shared.epoch, workspaceIdentity: local.workspaceIdentity };
    const previous = shared;
    if (!next.enabled) {
      await reconcileDisabled(next);
      return;
    }
    shared = next;
    const current = mapping(); if (current) current.realtimeEpoch = next.enabled ? next.epoch : undefined;
    const changes: SharedFile[] = [];
    for (const file of next.files) {
      const old = previous.files.find(item => item.id === file.id);
      if (old && old.path !== file.path) {
        changes.push({ ...file, previousPath: old.path } as SharedFile);
        d.workspace.renameSharedFile(absolute(old.path), absolute(file.path));
        const item = documents.get(file.id); if (item) item.file = file;
      } else if (!old && !previous.files.length) continue;
      else if (!old) {
        if (file.directory) changes.push(file);
        else if (!file.binary) {
          const item = await loadFile(file);
          if (turn !== generation) return;
          changes.push({ ...file, content: item.doc.text() });
        } else {
          const snapshot = await d.send('getRealtimeSnapshot', { teamId: current?.teamId, projectId: current?.projectId, epoch: next.epoch }) as { files: SharedFile[] };
          if (turn !== generation) return;
          const loaded = snapshot.files.find(item => item.id === file.id);
          if (loaded) changes.push(loaded);
        }
      }
    }
    for (const file of previous.files) if (!next.files.some(item => item.id === file.id)) {
      const item = documents.get(file.id);
      if (item?.pending.length) {
        const saved = draftValues().find(draft => draft.fileId === file.id);
        if (saved) recovered.set(file.id, saved);
        await persistDrafts();
        if (turn !== generation) return;
      }
      const tabs = local.tabs.filter(tab => tab.path.replace(/\\/g, '/') === absolute(file.path).replace(/\\/g, '/'));
      for (const tab of tabs) {
        await d.workspace.closeTab(tab.path, { force: true });
        if (turn !== generation) return;
      }
      item?.subscription?.dispose(); documents.delete(file.id);
      changes.push({ ...file, deleted: true } as SharedFile);
    }
    if (turn !== generation) return;
    if (changes.length && online) {
      await host.materialize(changes, context);
      if (turn !== generation) return;
      const tree = await d.refreshTree();
      if (turn !== generation) return;
      d.workspace.renderTree(tree);
    }
    renderPanel(); bindEditors();
  }
  async function reconcileDisabled(info: SharedState): Promise<void> {
    if (reconciliation) return reconciliation;
    reconciliation = performReconciliation(info).finally(() => { reconciliation = null; });
    return reconciliation;
  }
  async function performReconciliation(info: SharedState): Promise<void> {
    const current = mapping(); if (!current?.realtimeEpoch) return;
    const turn = generation;
    const draft = await host.drafts();
    if (turn !== generation) return;
    draftContext = draft.contextKey;
    for (const saved of draft.drafts) recovered.set(saved.fileId, saved);
    for (const saved of draftValues()) recovered.set(saved.fileId, saved);
    await persistDrafts();
    if (turn !== generation) return;
    const snapshot = await d.send('getRealtimeSnapshot', { teamId: current.teamId, projectId: current.projectId, epoch: info.epoch }) as SharedState;
    if (turn !== generation || mapping() !== current || snapshot.enabled || snapshot.epoch !== info.epoch) return;
    const retainedDrafts = new Map(recovered);
    const retainedContext = draftContext;
    await host.materialize(snapshot.files, { reconcile: true, previousEpoch: current.realtimeEpoch, epoch: info.epoch, workspaceIdentity: local.workspaceIdentity });
    if (turn !== generation) return;
    current.realtimeEpoch = undefined;
    await leave();
    const settled = generation;
    draftContext = retainedContext;
    for (const [id, value] of retainedDrafts) recovered.set(id, value);
    await d.workspace.applySharedSnapshot(snapshot.files);
    if (settled !== generation || mapping() !== current) return;
    const tree = await d.refreshTree();
    if (settled !== generation) return;
    d.workspace.renderTree(tree); renderPanel();
    events.dispatchEvent(new Event('bobo:realtime-mode-changed'));
  }
  function receive(message: Record<string, unknown>): void {
    if (message.workspaceIdentity !== undefined && message.workspaceIdentity !== local.workspaceIdentity) return;
    const pending = typeof message.requestId === 'string' && requests.get(message.requestId);
    if (pending && ['ack', 'document', 'error'].includes(String(message.type))) {
      clearTimeout(pending.timer); requests.delete(message.requestId as string);
      if (message.type === 'error') pending.reject(new Error(String(message.message || message.code)));
      else pending.resolve(message);
    }
    if (message.type === 'state') {
      if (joining) { deferredState = message.state as SharedState; return; }
      const turn = generation;
      stateQueue = stateQueue.then(() => turn === generation ? applyState(message.state as SharedState) : undefined).catch(error => d.notify(errorMessage(error), true));
    }
    if (message.type === 'operation') {
      const item = documents.get(String(message.fileId));
      if (item) {
        item.doc.apply({ insert: message.insert as SharedFile['nodes'] || [], delete: message.delete as string[] || [] }); publishText(item); saved(item); renderCursors();
        if (!item.pending.length) void host.materialize([{ ...item.file, content: item.doc.text() }], { epoch: shared.epoch, workspaceIdentity: local.workspaceIdentity }).catch(error => d.notify(errorMessage(error), true));
      }
    }
    if (message.type === 'presence') { shared.presence = message.presence as SharedState['presence'] || []; shared.deletions = message.deletions as SharedState['deletions'] || []; renderPanel(); renderCursors(); }
    if (message.type === 'runEvent') {
      const event = message.event as Record<string, unknown>;
      if (lastRunId !== message.runId) { lastRunId = String(message.runId); lastRunEvent = 0; }
      lastRunEvent++; d.output({ ...event, runId: message.runId });
      runObserver?.({ ...event, runId: message.runId });
      if (event.type === 'result') runObserver = null;
      if (shared.run) shared.run.status = event.type === 'result' ? (event.success ? 'completed' : 'failed') : 'running';
      renderPanel();
    }
    if (message.type === 'disconnected') {
      online = false; renderPanel();
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error(t('Collaboration disconnected'))); }
      requests.clear();
      clearTimeout(reconnectTimer);
      reconnectTimer = events.setTimeout(() => { void join(false).catch(error => d.notify(errorMessage(error), true)); }, 1500);
    }
    if (message.type === 'error' && !pending) d.notify(String(message.message || message.code), true);
    if (message.type === 'reset') leaveAndRefresh();
  }
  async function join(initial: boolean): Promise<void> {
    if ((joining && joiningGeneration === generation) || disposed || !mapping() || !authIdentity()) return;
    joining = true;
    const turn = generation, current = mapping()!, identity = authIdentity();
    joiningGeneration = turn;
    const isCurrent = () => turn === generation && identity === authIdentity() && mapping() === current && !disposed;
    try {
      if (documents.size) await persistDrafts();
      if (!isCurrent()) return;
      const draft = await host.drafts();
      if (!isCurrent()) return;
      actor = draft.sessionId; draftContext = draft.contextKey;
      const authoritative = await d.send('getRealtimeState', { teamId: current.teamId, projectId: current.projectId }) as SharedState;
      if (!isCurrent()) return;
      if (!authoritative.enabled) { await reconcileDisabled(authoritative); return; }
      if (shared.epoch !== authoritative.epoch) {
        for (const saved of draft.drafts) recovered.set(saved.fileId, saved);
        documents.forEach(item => item.subscription?.dispose()); documents.clear();
        shared = authoritative; current.realtimeEpoch = authoritative.epoch; initial = true;
      }
      const next = await host.connect({ teamId: current.teamId, projectId: current.projectId, epoch: shared.epoch, sessionId: actor });
      if (!isCurrent()) return;
      online = true; shared = next; current.realtimeEpoch = next.epoch;
      if (initial) {
        initializing = true;
        d.editors().forEach(editor => editor.updateOptions({ readOnly: true }));
        const previewDrafts = await d.workspace.prepareSharedViews(path => host.readTextFile(path));
        if (!isCurrent()) return;
        for (const saved of previewDrafts) {
          const id = 'local-' + saved.path;
          recovered.set(id, { fileId: id, path: relative(saved.path), epoch: 'local-preview', text: saved.text, pending: [], nodes: [], clock: 0 });
        }
        for (const tab of local.tabs.filter(tab => tab.dirty && tab.model)) {
          const id = 'local-' + tab.path;
          recovered.set(id, { fileId: id, path: relative(tab.path), epoch: 'local-buffer', text: tab.model!.getValue(), pending: [], nodes: [], clock: 0 });
        }
        if (recovered.size) await persistDrafts();
        if (!isCurrent()) return;
        const tree = await d.refreshTree() as { children?: unknown[] } | null;
        if (!isCurrent()) return;
        if (tree?.children?.some(entry => (entry as { name?: string }).name !== '.bobocloud-team.json') &&
            !await d.confirm({ title: t('Replace local folder with shared snapshot?'),
              message: t('Existing local files will be replaced after the complete shared snapshot is downloaded. Unsent collaboration drafts are preserved.'),
              confirmLabel: t('Replace'), cancelLabel: t('Cancel'), danger: true })) {
          await host.close(); online = false; renderPanel(); return;
        }
        if (!isCurrent()) return;
        const snapshot = await d.send('getRealtimeSnapshot', { teamId: current.teamId, projectId: current.projectId, epoch: next.epoch }) as { files: (SharedFile & { data?: string })[] };
        if (!isCurrent()) return;
        await host.materialize(snapshot.files.map(file => ({ ...file, base64: file.base64 || file.data })), { replace: true, epoch: next.epoch, workspaceIdentity: local.workspaceIdentity });
        if (!isCurrent()) return;
        const treeAfter = await d.refreshTree();
        if (!isCurrent()) return;
        d.workspace.renderTree(treeAfter);
      }
      for (const saved of draft.drafts) {
        const file = next.files.find(file => file.id === saved.fileId);
        if (saved.epoch !== next.epoch || !file) { recovered.set(saved.fileId, saved); d.notify(t('Recovered edits are available in local collaboration drafts'), true); continue; }
        const item = await loadFile(file);
        if (!isCurrent()) return;
        if (!item.pending.length) {
          for (const operation of saved.pending) item.doc.apply(operation);
          item.pending = saved.pending;
        }
        recovered.delete(saved.fileId);
        const tab = local.tabs.find(tab => tab.path.replace(/\\/g, '/') === absolute(file.path).replace(/\\/g, '/'));
        if (tab?.model) bindModel(item, tab.model);
      }
      for (const item of documents.values()) {
        if (!next.files.some(file => file.id === item.file.id)) continue;
        // Merge the current server document before retrying idempotent edits.
        const snapshot = await request({ type: 'open', fileId: item.file.id });
        if (!isCurrent()) return;
        item.doc.apply({ insert: (snapshot.file as SharedFile).nodes || [], delete: [] });
        publishText(item); void sendPending(item);
      }
      if (next.run?.id && lastRunId !== next.run.id) { lastRunId = next.run.id; lastRunEvent = 0; }
      const replay = next.run?.events || [];
      for (const event of replay.slice(lastRunEvent)) { d.output({ ...event, runId: next.run!.id }); lastRunEvent++; }
      initializing = false; bindEditors(); renderPanel();
    } catch (error) {
      if (!isCurrent()) return;
      online = false; renderPanel();
      if (isCurrent()) {
        clearTimeout(reconnectTimer); reconnectTimer = events.setTimeout(() => { void join(false); }, 3000);
      }
      d.notify(errorMessage(error), true);
    } finally {
      if (joiningGeneration === turn) joining = false;
      const next = isCurrent() ? deferredState : null; if (isCurrent()) deferredState = null;
      if (next && isCurrent() && online) stateQueue = stateQueue.then(() => turn === generation ? applyState(next) : undefined).catch(error => d.notify(errorMessage(error), true));
    }
  }
  async function refresh(): Promise<void> {
    const identity = authIdentity();
    if (!identity || disposed || !mapping()) return;
    if (refreshPromise) return refreshPromise;
    const turn = generation, current = mapping();
    const isCurrent = () => turn === generation && identity === authIdentity() && mapping() === current && !disposed;
    const work: Promise<void> = (async () => {
      if (!current || !isCurrent()) return;
      const info = await d.send('getRealtimeState', { teamId: current.teamId, projectId: current.projectId }) as SharedState;
      if (!isCurrent()) return;
      if (info.enabled && (!isActive() || !online || shared.epoch !== info.epoch)) await join(!isActive() || shared.epoch !== info.epoch || documents.size === 0);
      else if (!info.enabled && isActive()) await reconcileDisabled(info);
    })().catch(error => { if (isCurrent()) d.notify(errorMessage(error), true); }).finally(() => { if (refreshPromise === work) refreshPromise = null; });
    refreshPromise = work;
    return work;
  }
  async function save(path?: string): Promise<boolean> {
    if (!isActive()) return false;
    if (!online) throw new Error(t('Collaboration is reconnecting. Your edits are kept locally.'));
    const items = path ? [documents.get(fileAt(path)?.id || '')].filter(Boolean) as DocumentState[] : Array.from(documents.values());
    for (const item of items) {
      void sendPending(item);
      const deadline = Date.now() + 15000;
      while (item.pending.length || item.sending) {
        if (!online || Date.now() > deadline) throw new Error(t('Shared edits are still waiting for confirmation'));
        await new Promise(resolve => events.setTimeout(resolve, 30));
      }
    }
    await persistDrafts(); return true;
  }
  async function fileOperation(kind: 'create' | 'mkdir' | 'rename' | 'delete', path: string, target?: string): Promise<unknown> {
    await save();
    if (kind === 'create' || kind === 'mkdir') await request({ type: 'create', path: relative(path), content: '', directory: kind === 'mkdir' });
    else {
      const file = fileAt(path); if (!file) throw new Error(t('The shared file no longer exists'));
      await request(kind === 'rename' ? { type: 'rename', fileId: file.id, path: relative(target!) } : { type: 'deleteRequest', fileId: file.id });
      if (kind === 'delete') { d.panel(); return { pending: true }; }
    }
    return { path: target || path };
  }
  async function manage(project: Record<string, unknown>): Promise<void> {
    const ids = { teamId: project.team_id, projectId: project.id };
    const info = await d.send('getRealtimeState', ids) as SharedState;
    const enable = !info.enabled;
    if (!await d.confirm({ title: t(enable ? 'Enable live collaboration' : 'Return to Git collaboration'),
      message: t(enable ? 'Share this branch with every team member? Save and publish personal changes before switching.' : 'Save the shared workspace as a Git version and return to normal collaboration?'),
      confirmLabel: t('Continue'), cancelLabel: t('Cancel') })) return;
    if (isActive()) await save();
    if (!isActive() && local.tabs.some(tab => tab.dirty)) {
      if (!await d.workspace.saveAllTabs()) throw new Error(t('Save your local changes before switching collaboration mode'));
    }
    await d.prepareRunnerTransition();
    await host.prepareTransition();
    await d.send('setRealtimeMode', { ...ids, branch: project.default_branch || mapping()?.branch || 'main', enabled: enable, epoch: info.epoch });
    await refresh(); d.notify(t('Collaboration mode updated'));
  }
  async function openProject(_project: Record<string, unknown>, _mapping: Record<string, unknown>): Promise<boolean> { await refresh(); return isActive(); }
  async function run(path: string): Promise<boolean> {
    await save();
    const runtime = local.selectedRuntime;
    const language = d.language(path);
    await request({ type: 'run', run: { filePath: relative(path), runtime, folderKey: d.projectKey(local.workspaceRoot || ''),
      folderName: mapping()?.projectName || 'shared', ...d.runArgs(language), setupCommands: local.setupCommands } });
    d.panel(); return true;
  }
  async function stop(): Promise<void> { await request({ type: 'cancelRun' }); }
  async function runTask(task: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void): Promise<boolean> {
    await save();
    if (shared.run?.status === 'running' || runObserver) throw new Error(t('A run is already in progress. Stop it before starting another one.'));
    runObserver = onEvent;
    try {
      await request({ type: 'run', run: { task, runtime: local.selectedRuntime, folderKey: d.projectKey(local.workspaceRoot || ''), folderName: mapping()?.projectName || 'shared', setupCommands: local.setupCommands } });
      d.panel(); return true;
    } catch (error) { runObserver = null; throw error; }
  }
  async function leave(): Promise<void> {
    const turn = ++generation;
    refreshPromise = null; joining = false;
    deferredState = null;
    runObserver?.({ type: 'error', code: 'workspace-change', message: t('Collaboration workspace changed') }); runObserver = null;
    const persistence = documents.size || recovered.size ? persistDrafts().catch(() => {}) : Promise.resolve();
    online = false; initializing = false; clearTimeout(reconnectTimer); clearTimeout(presenceTimer);
    documents.forEach(item => item.subscription?.dispose()); documents.clear(); pendingLoads.clear();
    requests.forEach(pending => { clearTimeout(pending.timer); pending.reject(new Error(t('Collaboration workspace changed'))); }); requests.clear();
    shared = emptyState(); recovered.clear(); draftContext = '';
    await Promise.all([host.close(), persistence]);
    if (turn === generation) { renderPanel(); bindEditors(); }
  }
  function leaveAndRefresh(): void {
    const completion = leave(), turn = generation;
    void completion.then(() => { if (turn === generation && authIdentity()) return refresh(); });
  }
  listeners.push(host.onMessage(receive));
  on(events, 'bobo:visible-editors-changed', bindEditors);
  on(events, 'bobo:team-workspace-changed', () => { void refresh(); });
  on(events, 'bobo:workspace-changed', leaveAndRefresh);
  on(events, 'bobo:auth-changed', leaveAndRefresh);
  on(document, 'click', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-realtime-project], [data-vote], [data-rt]');
    if (!button) return;
    if (button.dataset.realtimeProject) void manage({ team_id: button.dataset.team, id: button.dataset.realtimeProject, default_branch: button.dataset.branch }).catch(error => d.notify(errorMessage(error), true));
    if (button.dataset.vote) void save().then(() => request({ type: 'deleteVote', deleteId: button.dataset.vote, decision: button.dataset.decision })).catch(error => d.notify(errorMessage(error), true));
    if (button.dataset.rt === 'stop') void stop().catch(error => d.notify(errorMessage(error), true));
    if (button.dataset.rt === 'output') document.querySelector<HTMLElement>('[data-panel="output"]')?.click();
    if (button.dataset.rt === 'reconnect') void join(true);
    if (button.dataset.rt === 'version') void save().then(() => d.send('createRealtimeVersion', { teamId: mapping()?.teamId, projectId: mapping()?.projectId, epoch: shared.epoch, commitMessage: t('Shared workspace checkpoint') })).then(() => d.notify(t('Shared version created'))).catch(error => d.notify(errorMessage(error), true));
    if (button.dataset.rt === 'personal') void save().then(d.syncPersonal).then(() => d.notify(t('Personal cloud snapshot saved'))).catch(error => d.notify(errorMessage(error), true));
  });
  on(document, 'submit', event => {
    const form = (event.target as Element).closest('.realtime-stdin');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input');
    if (!input) return;
    const data = input.value + '\n'; input.value = '';
    void request({ type: 'stdin', data }).catch(error => { input.value = data.trimEnd(); d.notify(errorMessage(error), true); });
  });
  on(document, 'click', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-recover]');
    if (button?.dataset.recover) void host.recover(button.dataset.recover).catch(error => d.notify(errorMessage(error), true));
  });
  const timer = events.setInterval(() => { if (!authIdentity()) return; if (mapping() && !isActive()) void refresh(); else if (isActive()) renderPresence(); }, 5000);
  return { isActive, prepareFile, save, fileOperation, openProject, manage, run, runTask, stop,
    syncPersonal: async () => { await save(); return d.syncPersonal(); }, leave, refresh,
    dispose() { disposed = true; clearInterval(timer); void leave(); listeners.forEach(fn => fn()); editorBindings.forEach(items => items.forEach(item => item.dispose())); panel?.remove(); } };
}
