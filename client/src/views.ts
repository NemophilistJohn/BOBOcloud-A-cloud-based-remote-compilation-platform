// Split, diff, image-preview, and theme-picker presentation service.
// Native file reads and legacy collaborators are injected by the compatibility adapter.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
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
  let splitSyncTimer: number | null = null;
  let splitModelSubscription: Disposable | null = null;
  let ownedSplitEditor: ViewsSplitEditorPort | null = null;
  let ownedSplitModel: ViewsTextModelPort | null = null;
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

  function primaryEditor(): ViewsCodeEditorPort {
    if (!state.editor) throw new Error('The primary editor is unavailable.');
    return state.editor;
  }

  function editorTheme(): string {
    const editor = state.editor;
    if (!editor) return 'vs-dark';
    return editor.getOption(monaco().editor.EditorOption.theme) || 'vs-dark';
  }

  function splitReadOnly(): boolean {
    return state.workspaceTransitionLocked === true || Boolean(
      dependencies.getCollaboration()?.isActiveFileReadOnly?.()
    );
  }

  function updateStatus(tab: ViewsTabDto | null): void {
    const editorCore = dependencies.getEditorCore();
    if (!editorCore) return;
    editorCore.updateStatusBar(
      tab?.model || null,
      state.editor ? state.editor.getPosition() : null
    );
  }

  function clearSplitSyncTimer(): void {
    if (splitSyncTimer === null) return;
    dependencies.clearTimer(splitSyncTimer);
    splitSyncTimer = null;
  }

  function bindSplitModel(rightModel: ViewsTextModelPort): void {
    disposeSilently(splitModelSubscription);
    splitModelSubscription = rightModel.onDidChangeContent(() => {
      clearSplitSyncTimer();
      splitSyncTimer = dependencies.setTimer(() => {
        splitSyncTimer = null;
        const splitEditor = state.splitEditor;
        if (disposed || !splitEditor || splitEditor !== ownedSplitEditor) return;
        const leftModel = splitEditor.getModel();
        if (leftModel) leftModel.setValue(rightModel.getValue());
      }, 150);
    });
  }

  function createSplitEditor(tab: ViewsTabDto & { readonly model: ViewsTextModelPort }): void {
    const editorApi = monaco().editor;
    const editor = primaryEditor();
    let leftEditor: ViewsCodeEditorPort | null = null;
    let rightEditor: ViewsCodeEditorPort | null = null;
    let rightModel: ViewsTextModelPort | null = null;
    try {
      leftEditor = editorApi.create(requiredElement('split-left'), {
        model: tab.model,
        theme: editor.getOption(editorApi.EditorOption.theme) || 'vs-dark',
        automaticLayout: true,
        readOnly: true
      });
      rightModel = editorApi.createModel(
        tab.model.getValue(),
        tab.model.getLanguageId(),
        monaco().Uri.parse(tab.model.uri.toString() + '-split')
      );
      rightEditor = editorApi.create(requiredElement('split-right'), {
        model: rightModel,
        theme: editor.getOption(editorApi.EditorOption.theme) || 'vs-dark',
        automaticLayout: true,
        readOnly: splitReadOnly()
      });
      const splitEditor = leftEditor as ViewsSplitEditorPort;
      splitEditor.rightEditor = rightEditor;
      state.splitEditor = splitEditor;
      ownedSplitEditor = splitEditor;
      ownedSplitModel = rightModel;
      const workspaceSettings = dependencies.getWorkspaceSettings();
      workspaceSettings?.attachEditor?.(splitEditor);
      workspaceSettings?.attachEditor?.(rightEditor);
      bindSplitModel(rightModel);
    } catch (error) {
      if (state.splitEditor === leftEditor) state.splitEditor = null;
      ownedSplitEditor = null;
      ownedSplitModel = null;
      disposeSilently(splitModelSubscription);
      splitModelSubscription = null;
      disposeSilently(rightEditor);
      disposeSilently(rightModel);
      disposeSilently(leftEditor);
      throw error;
    }
  }

  function openSplit(): void {
    if (disposed) return;
    if (state.currentViewMode === 'diff') closeDiff();

    const tab = activeTab();
    if (!tab?.model) {
      dependencies.updateRunOutput('No active file to split');
      return;
    }
    if (state.currentViewMode === 'split') {
      closeSplit();
      return;
    }

    requiredElement('container').style.display = 'none';
    requiredElement('split-container').classList.add('active');

    if (!state.splitEditor) {
      createSplitEditor(tab as ViewsTabDto & { readonly model: ViewsTextModelPort });
    } else {
      state.splitEditor.setModel(tab.model);
      const rightModel = state.splitEditor.rightEditor.getModel();
      if (!rightModel) throw new Error('The split editor model is unavailable.');
      rightModel.setValue(tab.model.getValue());
      monaco().editor.setModelLanguage(rightModel, tab.model.getLanguageId());
    }

    const splitEditor = state.splitEditor;
    if (!splitEditor) throw new Error('The split editor is unavailable.');
    splitEditor.updateOptions({ readOnly: true });
    splitEditor.rightEditor.updateOptions({ readOnly: splitReadOnly() });
    state.currentViewMode = 'split';
    updateStatus(tab);
    dependencies.updateRunOutput('[Split view opened — left: read-only, right: editable]');
  }

  function closeSplit(): void {
    if (disposed) return;
    requiredElement('split-container').classList.remove('active');
    requiredElement('container').style.display = '';
    state.currentViewMode = 'single';

    const tab = activeTab();
    if (tab?.model && state.editor) state.editor.setModel(tab.model);
    updateStatus(tab);
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
  }

  function closeImagePreview(): void {
    if (disposed) return;
    state.currentImagePath = null;
    state.imageRotation = 0;
    state.imageScale = 1;
    requiredElement('image-preview').classList.add('hidden');
    requiredElement('container').style.display = 'block';
    const image = requiredElement<HTMLImageElement>('preview-image');
    image.src = '';
    image.style.transform = '';
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
    clearSplitSyncTimer();
    disposeSilently(splitModelSubscription);
    splitModelSubscription = null;
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
    disposeSilently(ownedSplitModel);
    ownedSplitEditor = null;
    ownedSplitModel = null;

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
    openDiff,
    closeDiff,
    showImagePreview,
    closeImagePreview,
    openThemePicker,
    dispose
  });
}
