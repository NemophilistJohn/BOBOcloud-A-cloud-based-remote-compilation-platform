// Split, diff, image-preview, and theme-picker presentation service.
// Native file reads and legacy collaborators are injected by the compatibility adapter.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  ViewsCodeEditorPort,
  ViewsDependencies,
  ViewsDiffEditorPort,
  ViewsDiffModelDto,
  ViewsService,
  ViewsSplitEditorPort,
  ViewsTabDto,
  ViewsTextModelPort
} from '../types/views';

export const VIEWS_SERVICE_ID = 'workbench.views' as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { readonly message?: unknown }).message);
  }
  return String(error);
}

function baseName(filePath: string | null | undefined, fallback: string): string {
  if (!filePath) return fallback;
  return filePath.split(/[/\\]/).pop() || fallback;
}

function disposeSilently(disposable: { dispose?(): void } | null | undefined): void {
  try {
    disposable?.dispose?.();
  } catch (_) {
    // Teardown must continue so the remaining editor resources are released.
  }
}

export function createViewsService(dependencies: ViewsDependencies): ViewsService {
  const document = dependencies.document;
  const state = dependencies.state;
  const listeners = new DisposableStore();
  let initialized = false;
  let disposed = false;
  let diffRequestEpoch = 0;
  const splitListeners = new DisposableStore();
  let activePane: 'left' | 'right' = 'right';
  let routingPane = false;
  let splitOpen = false;
  const panePaths: { left: string | null; right: string | null } = { left: null, right: null };
  const splitSurfaces = new Set<HTMLElement>();
  const focusBound = new WeakSet<HTMLElement>();
  const paneStates = { left: new Map<string, unknown>(), right: new Map<string, unknown>() };
  let ownedSplitEditor: ViewsSplitEditorPort | null = null;
  let ownedDiffEditor: ViewsDiffEditorPort | null = null;

  function requiredElement<ElementType extends HTMLElement>(id: string): ElementType {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing required view element: ' + id);
    return element as ElementType;
  }

  function activeTab(): ViewsTabDto | null {
    return state.tabs.find((tab) => tab.path === state.activeTabPath) || null;
  }

  function monaco() {
    const value = dependencies.getMonaco();
    if (!value?.editor || !value.Uri) throw new Error('Monaco is unavailable.');
    return value;
  }

  function editorTheme(): string {
    const editor = state.editor;
    if (!editor) return 'vs-dark';
    return editor.getOption(monaco().editor.EditorOption.theme) || 'vs-dark';
  }

  function translate(source: string): string {
    return dependencies.translate?.(source) || source;
  }

  function getVisibleEditors(): readonly ViewsCodeEditorPort[] {
    if (disposed || state.currentViewMode === 'diff') return [];
    if (state.currentViewMode === 'split' && state.splitEditor) {
      return [state.splitEditor, state.splitEditor.rightEditor].filter(editor => !!editor.getModel());
    }
    if (state.currentImagePath || !activeTab()?.model) return [];
    return state.editor ? [state.editor] : [];
  }

  function getActiveEditor(): ViewsCodeEditorPort | null {
    if (state.currentViewMode === 'split' && state.splitEditor) {
      const editor = activePane === 'left' ? state.splitEditor : state.splitEditor.rightEditor;
      return editor.getModel() ? editor : null;
    }
    return state.editor;
  }

  function tabForEditor(editor: ViewsCodeEditorPort): ViewsTabDto | null {
    const model = editor.getModel();
    return model ? state.tabs.find((tab) => tab.model === model) || null : null;
  }

  function updateStatus(tab: ViewsTabDto | null): void {
    dependencies.getEditorCore()?.updateStatusBar(tab?.model || null, getActiveEditor()?.getPosition());
    dependencies.getEditorCore()?.refreshDiagnosticsForModel?.(tab?.model || null);
  }

  function publishEditors(): void {
    for (const pane of ['left', 'right'] as const) {
      const container = document.getElementById('split-' + pane + '-pane');
      const editor = pane === 'left' ? state.splitEditor : state.splitEditor?.rightEditor;
      const tab = editor ? tabForEditor(editor) : null;
      const surface = panePaths[pane] ? dependencies.resolveSurface?.(panePaths[pane]!) : null;
      const label = document.getElementById('split-' + pane + '-label');
      if (label) {
        label.textContent = tab ? baseName(tab.path, '') : surface?.title || translate('Open a file or plugin tab');
        label.title = tab?.path || surface?.title || '';
      }
      if (container) container.classList.toggle('focused', activePane === pane);
    }
    dependencies.notifyVisibleEditorsChanged?.();
  }

  function paintSplit(): void {
    const visible = new Set<HTMLElement>();
    const documents: string[] = [];
    for (const pane of ['left', 'right'] as const) {
      const key = panePaths[pane];
      const editor = pane === 'left' ? state.splitEditor : state.splitEditor?.rightEditor;
      // Workspace renames replace a model and its tab path before publishing
      // visible-editor changes. Follow that file-owned model in both panes.
      if (key && !state.tabs.some(item => item.path === key) && editor?.getModel()) {
        const renamed = tabForEditor(editor);
        if (renamed) panePaths[pane] = renamed.path;
      }
      const tab = state.tabs.find(item => item.path === panePaths[pane]);
      if (editor && editor.getModel() !== (tab?.model || null)) editor.setModel(tab?.model || null);
      const surface = key ? dependencies.resolveSurface?.(key) : null;
      if (surface) {
        if (surface.kind === 'document') documents.push(key!);
        for (const element of surface.elements) {
          element.classList.add('workbench-split-surface');
          element.classList.toggle('workbench-split-left', pane === 'left');
          element.classList.toggle('workbench-split-right', pane === 'right');
          element.dataset.splitTabKey = key!;
          element.hidden = element.classList.contains('document-view-host-error') && !element.textContent;
          element.classList.remove('hidden');
          if (surface.kind === 'workbench') element.classList.add('active');
          visible.add(element); splitSurfaces.add(element);
          if (!focusBound.has(element)) {
            const focus = () => { if (splitOpen && !routingPane) focusPane(element.classList.contains('workbench-split-left') ? 'left' : 'right'); };
            element.addEventListener('pointerdown', focus, true);
            listeners.add(toDisposable(() => element.removeEventListener('pointerdown', focus, true)));
            focusBound.add(element);
          }
        }
      }
      const container = document.getElementById('split-' + pane + '-pane');
      container?.classList.toggle('empty-pane', !tab?.model && !surface);
    }
    for (const element of splitSurfaces) {
      if (visible.has(element)) continue;
      element.hidden = true;
      element.classList.remove('workbench-split-surface', 'workbench-split-left', 'workbench-split-right', 'active');
      delete element.dataset.splitTabKey;
    }
    dependencies.showSplitDocuments?.(documents, panePaths[activePane]);
    requiredElement('split-container').classList.add('active');
    requiredElement('container').style.display = 'none';
    state.currentImagePath = null;
    state.currentViewMode = 'split';
    state.editor?.setModel(getActiveEditor()?.getModel() || null);
    refreshReadOnly(); publishEditors();
  }

  function refreshReadOnly(): void {
    const collaboration = dependencies.getCollaboration();
    for (const editor of getVisibleEditors()) {
      const tab = tabForEditor(editor);
      const locked = collaboration?.isFileReadOnly
        ? Boolean(tab && collaboration.isFileReadOnly(tab.path))
        : Boolean(tab?.path === state.activeTabPath && collaboration?.isActiveFileReadOnly?.());
      editor.updateOptions({ readOnly: state.workspaceTransitionLocked === true || locked });
    }
  }

  function activateTab(filePath: string): boolean {
    if (disposed || routingPane || (!splitOpen && state.currentViewMode !== 'split') || !state.splitEditor) return false;
    if (!splitOpen) {
      panePaths.left = tabForEditor(state.splitEditor)?.path || null;
      panePaths.right = tabForEditor(state.splitEditor.rightEditor)?.path || null;
      splitOpen = true;
    }
    const tab = state.tabs.find(candidate => candidate.path === filePath);
    const surface = dependencies.resolveSurface?.(filePath);
    if (!tab?.model && !surface) return false;
    const other = activePane === 'left' ? 'right' : 'left';
    const otherSurface = panePaths[other] ? dependencies.resolveSurface?.(panePaths[other]!) : null;
    // A document/plugin view has one live instance. Reuse it rather than
    // cloning its private draft or reloading an iframe.
    if (surface && otherSurface?.id === surface.id) activePane = other;
    const editor = activePane === 'left' ? state.splitEditor : state.splitEditor.rightEditor;
    const previous = tabForEditor(editor);
    if (previous && previous.path !== filePath) paneStates[activePane].set(previous.path, editor.saveViewState?.());
    const changed = panePaths[activePane] !== filePath;
    panePaths[activePane] = filePath;
    if (changed) {
      routingPane = true;
      state.currentViewMode = 'single';
      try { dependencies.activateFile?.(filePath); }
      finally { routingPane = false; }
    }
    state.activeTabPath = filePath;
    paintSplit();
    const saved = paneStates[activePane].get(filePath);
    if (changed && saved && tab?.model) editor.restoreViewState?.(saved);
    updateStatus(tab || null);
    dependencies.onPaneFocus?.();
    if (changed && tab?.model) editor.focus?.();
    return true;
  }

  function focusPane(pane: 'left' | 'right'): void {
    if (!splitOpen || !state.splitEditor) return;
    activePane = pane;
    const path = panePaths[pane];
    if (path) activateTab(path);
    else { state.activeTabPath = null; paintSplit(); }
  }

  function createSplitEditor(tab: ViewsTabDto): void {
    const editorApi = monaco().editor;
    let leftEditor: ViewsCodeEditorPort | null = null;
    let rightEditor: ViewsCodeEditorPort | null = null;
    try {
      const options = { model: tab.model || null, theme: editorTheme(), automaticLayout: true, readOnly: false };
      leftEditor = editorApi.create(requiredElement('split-left'), options);
      rightEditor = editorApi.create(requiredElement('split-right'), options);
      const splitEditor = leftEditor as ViewsSplitEditorPort;
      splitEditor.rightEditor = rightEditor;
      state.splitEditor = splitEditor;
      ownedSplitEditor = splitEditor;
      for (const [pane, editor] of [['left', leftEditor], ['right', rightEditor]] as const) {
        dependencies.getWorkspaceSettings()?.attachEditor?.(editor);
        const focus = editor.onDidFocusEditorWidget?.(() => focusPane(pane));
        if (focus) splitListeners.add(focus);
        const cursor = editor.onDidChangeCursorPosition?.(() => {
          if (getActiveEditor() === editor && state.currentViewMode === 'split') updateStatus(tabForEditor(editor));
        });
        if (cursor) splitListeners.add(cursor);
      }
    } catch (error) {
      splitListeners.clear();
      if (state.splitEditor === leftEditor) state.splitEditor = null;
      ownedSplitEditor = null;
      disposeSilently(rightEditor);
      disposeSilently(leftEditor);
      throw error;
    }
  }

  function openSplit(filePath?: string): void {
    if (disposed || state.workspaceTransitionLocked) return;
    if (state.currentViewMode === 'diff') closeDiff();
    const key = filePath || state.activeTabPath;
    const tab = state.tabs.find(candidate => candidate.path === key);
    const surface = key ? dependencies.resolveSurface?.(key) : null;
    if (!key || (!tab?.model && !surface)) {
      dependencies.updateRunOutput(translate('No active file to split'));
      return;
    }
    if (splitOpen || state.currentViewMode === 'split') {
      activePane = 'right'; activateTab(key); getActiveEditor()?.focus?.(); return;
    }
    const initialViewState = state.editor?.saveViewState?.();
    if (!state.splitEditor) createSplitEditor(tab || { path: key });
    splitOpen = true;
    panePaths.left = key;
    panePaths.right = tab?.model ? key : null;
    activePane = 'right';
    state.activeTabPath = panePaths.right;
    paintSplit();
    if (initialViewState && tab?.model) {
      state.splitEditor?.restoreViewState?.(initialViewState);
      state.splitEditor?.rightEditor.restoreViewState?.(initialViewState);
    }
    updateStatus(tab || null);
    dependencies.onPaneFocus?.();
    getActiveEditor()?.focus?.();
  }

  function closeSplit(): void {
    if (disposed) return;
    const editor = getActiveEditor();
    const viewState = editor?.saveViewState?.();
    const key = panePaths[activePane] || panePaths[activePane === 'left' ? 'right' : 'left'] || state.activeTabPath;
    const model = editor?.getModel() || activeTab()?.model || null;
    splitOpen = false;
    for (const element of splitSurfaces) {
      element.classList.remove('workbench-split-surface', 'workbench-split-left', 'workbench-split-right');
      element.classList.remove('active');
      delete element.dataset.splitTabKey;
      element.hidden = true;
    }
    splitSurfaces.clear();
    dependencies.showSplitDocuments?.([], null);
    requiredElement('split-container').classList.remove('active');
    requiredElement('container').style.display = '';
    state.currentViewMode = 'single';
    state.editor?.setModel(model);
    state.splitEditor?.setModel(null);
    state.splitEditor?.rightEditor.setModel(null);
    panePaths.left = null; panePaths.right = null;
    paneStates.left.clear(); paneStates.right.clear();
    if (key) dependencies.activateFile?.(key);
    if (viewState) state.editor?.restoreViewState?.(viewState);
    refreshReadOnly(); updateStatus(activeTab()); publishEditors();
    if (activeTab()?.model) state.editor?.focus?.();
  }

  function onTabClosed(filePath: string): void {
    paneStates.left.delete(filePath); paneStates.right.delete(filePath);
    if (!state.splitEditor || (!splitOpen && state.currentViewMode !== 'split')) return;
    const closed = state.tabs.find(tab => tab.path === filePath);
    for (const pane of ['left', 'right'] as const) {
      const editor = pane === 'left' ? state.splitEditor : state.splitEditor.rightEditor;
      if (panePaths[pane] === filePath || (closed?.model && editor.getModel() === closed.model)) {
        const otherKey = panePaths[pane === 'left' ? 'right' : 'left'];
        const otherSurface = otherKey ? dependencies.resolveSurface?.(otherKey) : null;
        const available = state.tabs.filter(tab => tab.path !== filePath &&
          (!otherSurface || dependencies.resolveSurface?.(tab.path)?.id !== otherSurface.id));
        const replacement = available.find(tab => tab.model) || available[0];
        panePaths[pane] = replacement?.path || null;
        editor.setModel(replacement?.model || null);
      }
    }
    paintSplit();
  }

  function detachDiffModels(editor: ViewsDiffEditorPort): ViewsDiffModelDto | null {
    const model = editor.getModel();
    if (!model) return null;
    editor.setModel(null);
    return model;
  }

  function disposeDiffModels(model: ViewsDiffModelDto | null): void {
    if (!model) return;
    disposeSilently(model.original);
    disposeSilently(model.modified);
  }

  function publishDiff(
    requestEpoch: number,
    originalPath: string | null | undefined,
    modifiedPath: string | null | undefined,
    originalName: string,
    modifiedName: string,
    originalContent: string,
    modifiedContent: string,
    diffContainer: HTMLElement
  ): void {
    if (disposed || requestEpoch !== diffRequestEpoch ||
        state.diffOriginalPath !== originalPath ||
        state.diffModifiedPath !== modifiedPath ||
        !diffContainer.classList.contains('active')) return;

    const editorApi = monaco().editor;
    if (!state.diffEditor) {
      state.diffEditor = editorApi.createDiffEditor(requiredElement('diff-editor'), {
        theme: editorTheme(),
        automaticLayout: true,
        readOnly: true
      });
      ownedDiffEditor = state.diffEditor;
    }

    let originalModel: ViewsTextModelPort | null = null;
    let modifiedModel: ViewsTextModelPort | null = null;
    try {
      originalModel = editorApi.createModel(
        originalContent,
        originalPath ? dependencies.detectLanguage(originalName, originalContent) : 'plaintext'
      );
      modifiedModel = editorApi.createModel(
        modifiedContent,
        modifiedPath ? dependencies.detectLanguage(modifiedName, modifiedContent) : 'plaintext'
      );
      const previous = detachDiffModels(state.diffEditor);
      disposeDiffModels(previous);
      state.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    } catch (error) {
      disposeSilently(originalModel);
      disposeSilently(modifiedModel);
      throw error;
    }

    state.currentViewMode = 'diff';
    publishEditors();
    dependencies.updateRunOutput('[Diff: ' + originalName + ' ↔ ' + modifiedName + ']');
  }

  function openDiff(
    originalPath?: string | null,
    modifiedPath?: string | null
  ): void {
    if (disposed) return;
    if (state.currentViewMode === 'split') closeSplit();
    const requestEpoch = ++diffRequestEpoch;

    state.diffOriginalPath = originalPath;
    state.diffModifiedPath = modifiedPath;
    requiredElement('container').style.display = 'none';
    requiredElement('split-container').classList.remove('active');
    const diffContainer = requiredElement('diff-container');
    diffContainer.classList.add('active');

    const originalName = baseName(originalPath, 'Original');
    const modifiedName = baseName(modifiedPath, 'Modified');
    requiredElement('diff-original-label').textContent = originalName;
    requiredElement('diff-modified-label').textContent = modifiedName;

    let originalRead: Promise<string>;
    let modifiedRead: Promise<string>;
    try {
      originalRead = originalPath ? dependencies.host.readFile(originalPath) : Promise.resolve('');
      modifiedRead = modifiedPath ? dependencies.host.readFile(modifiedPath) : Promise.resolve('');
    } catch (error) {
      if (requestEpoch === diffRequestEpoch) {
        dependencies.updateRunOutput('Error opening diff: ' + errorMessage(error));
        closeDiff();
      }
      return;
    }

    void Promise.all([originalRead, modifiedRead]).then(([originalContent, modifiedContent]) => {
      publishDiff(
        requestEpoch,
        originalPath,
        modifiedPath,
        originalName,
        modifiedName,
        originalContent,
        modifiedContent,
        diffContainer
      );
    }).catch((error: unknown) => {
      if (disposed || requestEpoch !== diffRequestEpoch) return;
      dependencies.updateRunOutput('Error opening diff: ' + errorMessage(error));
      closeDiff();
    });
  }

  function closeDiff(): void {
    if (disposed) return;
    diffRequestEpoch += 1;
    requiredElement('diff-container').classList.remove('active');
    requiredElement('container').style.display = '';
    state.currentViewMode = 'single';
    state.diffOriginalPath = null;
    state.diffModifiedPath = null;

    if (state.diffEditor) disposeDiffModels(detachDiffModels(state.diffEditor));
    const tab = activeTab();
    if (tab?.model && state.editor) state.editor.setModel(tab.model);
    updateStatus(tab);
    publishEditors();
  }

  function updateImageTransform(): void {
    const image = requiredElement<HTMLImageElement>('preview-image');
    image.style.transform = 'rotate(' + state.imageRotation + 'deg) scale(' + state.imageScale + ')';
  }

  function rotateImage(degrees: number): void {
    state.imageRotation += degrees;
    updateImageTransform();
  }

  function zoomImage(factor: number): void {
    state.imageScale = Math.max(0.1, Math.min(5, state.imageScale * factor));
    updateImageTransform();
  }

  function resetImageTransform(): void {
    state.imageRotation = 0;
    state.imageScale = 1;
    updateImageTransform();
  }

  function showImagePreview(filePath: string, name: string): void {
    if (disposed) return;
    state.currentImagePath = filePath;
    state.imageRotation = 0;
    state.imageScale = 1;
    requiredElement('image-preview-title').textContent = name;
    const image = requiredElement<HTMLImageElement>('preview-image');
    image.src = 'file://' + filePath;
    image.style.transform = '';
    requiredElement('image-preview').classList.remove('hidden');
    requiredElement('container').style.display = 'none';
    publishEditors();
  }

  function closeImagePreview(): void {
    if (disposed) return;
    state.currentImagePath = null;
    state.imageRotation = 0;
    state.imageScale = 1;
    requiredElement('image-preview').classList.add('hidden');
    requiredElement('container').style.display = state.currentViewMode === 'single' ? 'block' : 'none';
    const image = requiredElement<HTMLImageElement>('preview-image');
    image.src = '';
    image.style.transform = '';
    publishEditors();
  }

  function openThemePicker(): void {
    if (disposed) return;
    dependencies.getSettings()?.open('local');
  }

  function listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    listeners.add(toDisposable(() => target.removeEventListener(type, listener)));
  }

  function init(): void {
    if (initialized || disposed) return;
    const closeImage = requiredElement('close-image-preview');
    const rotateLeft = requiredElement('rotate-left');
    const rotateRight = requiredElement('rotate-right');
    const zoomOut = requiredElement('zoom-out');
    const zoomIn = requiredElement('zoom-in');
    const zoomReset = requiredElement('zoom-reset');
    const closeDiffButton = requiredElement('close-diff');

    try {
      listen(closeImage, 'click', closeImagePreview);
      listen(rotateLeft, 'click', () => rotateImage(-90));
      listen(rotateRight, 'click', () => rotateImage(90));
      listen(zoomOut, 'click', () => zoomImage(0.8));
      listen(zoomIn, 'click', () => zoomImage(1.25));
      listen(zoomReset, 'click', resetImageTransform);
      listen(closeDiffButton, 'click', closeDiff);
      const splitButton = document.getElementById('editor-split-action');
      if (splitButton) listen(splitButton, 'click', () => openSplit());
      for (const pane of ['left', 'right'] as const) {
        const element = document.getElementById('split-' + pane + '-pane');
        if (element) listen(element, 'pointerdown', () => focusPane(pane));
      }
      const closeSplitButton = document.getElementById('close-split');
      if (closeSplitButton) listen(closeSplitButton, 'click', closeSplit);
      if (typeof document.addEventListener === 'function') {
        const onKeyDown = (event: KeyboardEvent): void => {
          if (state.currentViewMode === 'split' && event.key === 'F5' && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            if (event.ctrlKey || event.metaKey) dependencies.runActiveFile?.();
            else dependencies.debugActiveFile?.();
            return;
          }
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          if (event.key === '\\') {
            event.preventDefault();
            event.stopPropagation();
            openSplit();
          } else if (state.currentViewMode === 'split' && event.key.toLowerCase() === 's' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            dependencies.saveActiveFile?.();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        listeners.add(toDisposable(() => document.removeEventListener('keydown', onKeyDown, true)));
      }

      const modal = document.getElementById('theme-modal');
      const select = document.getElementById('theme-select') as HTMLSelectElement | null;
      const apply = document.getElementById('theme-apply');
      const cancel = document.getElementById('theme-cancel');
      if (modal && select && apply && cancel) {
        listen(apply, 'click', () => {
          dependencies.getTheme()?.applyTheme(select.value);
          modal.style.display = 'none';
        });
        listen(cancel, 'click', () => {
          modal.style.display = 'none';
        });
        listen(modal, 'click', (event) => {
          if (event.target === modal) modal.style.display = 'none';
        });
      }
      initialized = true;
    } catch (error) {
      listeners.clear();
      throw error;
    }
  }

  function dispose(): void {
    if (disposed) return;
    const imageWasVisible = state.currentImagePath != null;
    splitOpen = false;
    for (const element of splitSurfaces) {
      element.classList.remove('workbench-split-surface', 'workbench-split-left', 'workbench-split-right');
      element.classList.remove('active');
      delete element.dataset.splitTabKey;
      element.hidden = true;
    }
    splitSurfaces.clear();
    dependencies.showSplitDocuments?.([], null);
    disposed = true;
    initialized = false;
    diffRequestEpoch += 1;
    splitListeners.dispose();
    listeners.dispose();

    const diffEditor = state.diffEditor;
    if (diffEditor) {
      try {
        disposeDiffModels(detachDiffModels(diffEditor));
      } catch (_) {
        disposeDiffModels(diffEditor.getModel());
      }
    }
    if (diffEditor === ownedDiffEditor) {
      disposeSilently(ownedDiffEditor);
      state.diffEditor = null;
    }
    ownedDiffEditor = null;

    if (state.splitEditor === ownedSplitEditor) state.splitEditor = null;
    disposeSilently(ownedSplitEditor?.rightEditor);
    disposeSilently(ownedSplitEditor);
    ownedSplitEditor = null;

    document.getElementById('split-container')?.classList.remove('active');
    document.getElementById('diff-container')?.classList.remove('active');
    document.getElementById('image-preview')?.classList.add('hidden');
    const image = document.getElementById('preview-image') as HTMLImageElement | null;
    if (image) {
      image.src = '';
      image.style.transform = '';
    }
    if (state.currentViewMode === 'split' || state.currentViewMode === 'diff') {
      state.currentViewMode = 'single';
      const tab = activeTab();
      if (tab?.model && state.editor) state.editor.setModel(tab.model);
      const container = document.getElementById('container');
      if (container) container.style.display = '';
    }
    if (imageWasVisible) {
      const container = document.getElementById('container');
      if (container) container.style.display = 'block';
    }
    state.diffOriginalPath = null;
    state.diffModifiedPath = null;
    state.currentImagePath = null;
    state.imageRotation = 0;
    state.imageScale = 1;
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    init,
    openSplit,
    closeSplit,
    getActiveEditor,
    getVisibleEditors,
    activateTab,
    isSplitActive: () => splitOpen,
    onTabClosed,
    refreshReadOnly,
    openDiff,
    closeDiff,
    showImagePreview,
    closeImagePreview,
    openThemePicker,
    dispose
  });
}
