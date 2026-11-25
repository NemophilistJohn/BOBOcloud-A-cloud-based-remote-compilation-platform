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
    if (disposed || state.currentViewMode === 'diff' || state.currentImagePath) return [];
    if (state.currentViewMode === 'split' && state.splitEditor) {
      return [state.splitEditor, state.splitEditor.rightEditor];
    }
    return state.editor ? [state.editor] : [];
  }

  function getActiveEditor(): ViewsCodeEditorPort | null {
    if (state.currentViewMode === 'split' && state.splitEditor) {
      return activePane === 'left' ? state.splitEditor : state.splitEditor.rightEditor;
    }
    return state.editor;
  }

  function tabForEditor(editor: ViewsCodeEditorPort): ViewsTabDto | null {
    return state.tabs.find((tab) => tab.model === editor.getModel()) || null;
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
      const label = document.getElementById('split-' + pane + '-label');
      if (label) {
        label.textContent = tab ? baseName(tab.path, '') : '';
        label.title = tab?.path || '';
      }
      if (container) container.classList.toggle('focused', activePane === pane);
    }
    dependencies.notifyVisibleEditorsChanged?.();
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
    if (disposed || state.currentViewMode !== 'split' || !state.splitEditor) return false;
    const tab = state.tabs.find((candidate) => candidate.path === filePath);
    const editor = getActiveEditor();
    if (!tab?.model || !editor) return false;
    const previous = tabForEditor(editor);
    if (previous && previous.path !== filePath) paneStates[activePane].set(previous.path, editor.saveViewState?.());
    if (editor.getModel() !== tab.model) {
      editor.setModel(tab.model);
      const saved = paneStates[activePane].get(filePath);
      if (saved) editor.restoreViewState?.(saved);
    }
    // The primary editor remains the legacy active-model bridge for run/LSP.
    state.editor?.setModel(tab.model);
    refreshReadOnly();
    updateStatus(tab);
    publishEditors();
    return true;
  }

  function focusPane(pane: 'left' | 'right'): void {
    if (state.currentViewMode !== 'split' || !state.splitEditor) return;
    activePane = pane;
    const editor = getActiveEditor();
    const tab = editor && tabForEditor(editor);
    if (tab) {
      if (state.activeTabPath !== tab.path) dependencies.activateFile?.(tab.path);
      state.activeTabPath = tab.path;
      state.editor?.setModel(tab.model || null);
      refreshReadOnly();
      updateStatus(tab);
    }
    publishEditors();
  }

  function createSplitEditor(tab: ViewsTabDto & { readonly model: ViewsTextModelPort }): void {
    const editorApi = monaco().editor;
    let leftEditor: ViewsCodeEditorPort | null = null;
    let rightEditor: ViewsCodeEditorPort | null = null;
    try {
      const options = { model: tab.model, theme: editorTheme(), automaticLayout: true, readOnly: false };
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
    const tab = filePath ? state.tabs.find((candidate) => candidate.path === filePath) : activeTab();
    if (!tab?.model) {
      dependencies.updateRunOutput(translate('No active file to split'));
      return;
    }
    if (state.currentViewMode === 'split') {
      activePane = 'right';
      dependencies.activateFile?.(tab.path);
      activateTab(tab.path);
      getActiveEditor()?.focus?.();
      return;
    }
    if (state.activeTabPath !== tab.path) dependencies.activateFile?.(tab.path);
    const initialViewState = state.editor?.saveViewState?.();
    if (!state.splitEditor) createSplitEditor(tab as ViewsTabDto & { readonly model: ViewsTextModelPort });
    else {
      state.splitEditor.setModel(tab.model);
      state.splitEditor.rightEditor.setModel(tab.model);
    }
    requiredElement('container').style.display = 'none';
    requiredElement('split-container').classList.add('active');
    state.currentViewMode = 'split';
    activePane = 'right';
    if (initialViewState) {
      state.splitEditor?.restoreViewState?.(initialViewState);
      state.splitEditor?.rightEditor.restoreViewState?.(initialViewState);
    }
    refreshReadOnly();
    updateStatus(tab);
    publishEditors();
    getActiveEditor()?.focus?.();
  }

  function closeSplit(): void {
    if (disposed) return;
    const editor = getActiveEditor();
    const viewState = editor?.saveViewState?.();
    const model = editor?.getModel() || activeTab()?.model || null;
    requiredElement('split-container').classList.remove('active');
    requiredElement('container').style.display = '';
    state.currentViewMode = 'single';
    state.editor?.setModel(model);
    if (viewState) state.editor?.restoreViewState?.(viewState);
    // Split panes never own the file models. Detach them before tab disposal.
    state.splitEditor?.setModel(null);
    state.splitEditor?.rightEditor.setModel(null);
    paneStates.left.clear();
    paneStates.right.clear();
    refreshReadOnly();
    updateStatus(activeTab());
    publishEditors();
    state.editor?.focus?.();
  }

  function onTabClosed(filePath: string): void {
    paneStates.left.delete(filePath);
    paneStates.right.delete(filePath);
    const closed = state.tabs.find((tab) => tab.path === filePath);
    if (!closed?.model || !state.splitEditor) return;
    const replacement = state.tabs.find((tab) => tab.path !== filePath && tab.model)?.model || null;
    for (const editor of [state.splitEditor, state.splitEditor.rightEditor]) {
      if (editor.getModel() === closed.model) editor.setModel(replacement);
    }
    if (state.editor?.getModel() === closed.model) state.editor.setModel(replacement);
    publishEditors();
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
