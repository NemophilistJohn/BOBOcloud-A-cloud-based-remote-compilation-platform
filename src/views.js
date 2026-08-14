// src/views.js — Split/Diff view, Image preview, Theme picker
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── Split View ────
  function openSplitView() {
    if (S.currentViewMode === 'diff') closeDiffView();

    var activeTab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (!activeTab || !activeTab.model) {
      BOBO.updateRunOutput('No active file to split');
      return;
    }

    if (S.currentViewMode === 'split') {
      closeSplitView();
      return;
    }

    document.getElementById('container').style.display = 'none';
    var splitContainer = document.getElementById('split-container');
    splitContainer.classList.add('active');

    if (!S.splitEditor) {
      S.splitEditor = monaco.editor.create(document.getElementById('split-left'), {
        model: activeTab.model,
        theme: S.editor.getOption(monaco.editor.EditorOption.theme) || 'vs-dark',
        automaticLayout: true,
        readOnly: true
      });

      var rightModel = monaco.editor.createModel(
        activeTab.model.getValue(),
        activeTab.model.getLanguageId(),
        monaco.Uri.parse(activeTab.model.uri.toString() + '-split')
      );
      S.splitEditor.rightEditor = monaco.editor.create(document.getElementById('split-right'), {
        model: rightModel,
        theme: S.editor.getOption(monaco.editor.EditorOption.theme) || 'vs-dark',
        automaticLayout: true,
        readOnly: S.workspaceTransitionLocked === true || Boolean(BOBO.collaboration && BOBO.collaboration.isActiveFileReadOnly && BOBO.collaboration.isActiveFileReadOnly())
      });

      // Debounced sync from right to left (avoids per-keystroke full-content copy)
      var splitSyncTimer = null;
      rightModel.onDidChangeContent(function() {
        if (splitSyncTimer) clearTimeout(splitSyncTimer);
        splitSyncTimer = setTimeout(function() {
          var leftModel = S.splitEditor.getModel();
          if (leftModel) {
            leftModel.setValue(rightModel.getValue());
          }
        }, 150);
      });
    } else {
      S.splitEditor.setModel(activeTab.model);
      var rm = S.splitEditor.rightEditor.getModel();
      rm.setValue(activeTab.model.getValue());
      monaco.editor.setModelLanguage(rm, activeTab.model.getLanguageId());
    }

    S.splitEditor.updateOptions({ readOnly: true });
    S.splitEditor.rightEditor.updateOptions({
      readOnly: S.workspaceTransitionLocked === true || Boolean(BOBO.collaboration && BOBO.collaboration.isActiveFileReadOnly && BOBO.collaboration.isActiveFileReadOnly())
    });

    S.currentViewMode = 'split';
    if (BOBO.editorCore) BOBO.editorCore.updateStatusBar(activeTab.model, S.editor.getPosition());
    BOBO.updateRunOutput('[Split view opened — left: read-only, right: editable]');
  }

  function closeSplitView() {
    document.getElementById('split-container').classList.remove('active');
    document.getElementById('container').style.display = '';
    S.currentViewMode = 'single';

    var activeTab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (activeTab && activeTab.model && S.editor) {
      S.editor.setModel(activeTab.model);
    }
    if (BOBO.editorCore) {
      BOBO.editorCore.updateStatusBar(activeTab ? activeTab.model : null, S.editor ? S.editor.getPosition() : null);
    }
  }

  // ──── Diff View ────
  function openDiffView(originalPath, modifiedPath) {
    if (S.currentViewMode === 'split') closeSplitView();

    S.diffOriginalPath = originalPath;
    S.diffModifiedPath = modifiedPath;

    document.getElementById('container').style.display = 'none';
    document.getElementById('split-container').classList.remove('active');
    var diffContainer = document.getElementById('diff-container');
    diffContainer.classList.add('active');

    var origName = originalPath ? originalPath.split(/[/\\]/).pop() : 'Original';
    var modName = modifiedPath ? modifiedPath.split(/[/\\]/).pop() : 'Modified';
    document.getElementById('diff-original-label').textContent = origName;
    document.getElementById('diff-modified-label').textContent = modName;

    Promise.all([
      originalPath ? window.api.readFile(originalPath) : Promise.resolve(''),
      modifiedPath ? window.api.readFile(modifiedPath) : Promise.resolve('')
    ]).then(function(results) {
      var origContent = results[0];
      var modContent = results[1];
      var origLang = originalPath ? BOBO.detectLanguage(origName, origContent) : 'plaintext';
      var modLang = modifiedPath ? BOBO.detectLanguage(modName, modContent) : 'plaintext';

      if (!S.diffEditor) {
        S.diffEditor = monaco.editor.createDiffEditor(document.getElementById('diff-editor'), {
          theme: S.editor ? S.editor.getOption(monaco.editor.EditorOption.theme) : 'vs-dark',
          automaticLayout: true,
          readOnly: true
        });
      }

      var originalModel = monaco.editor.createModel(origContent, origLang);
      var modifiedModel = monaco.editor.createModel(modContent, modLang);

      S.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      S.currentViewMode = 'diff';
      BOBO.updateRunOutput('[Diff: ' + origName + ' ↔ ' + modName + ']');
    }).catch(function(err) {
      BOBO.updateRunOutput('Error opening diff: ' + err.message);
      closeDiffView();
    });
  }

  function closeDiffView() {
    document.getElementById('diff-container').classList.remove('active');
    document.getElementById('container').style.display = '';
    S.currentViewMode = 'single';
    S.diffOriginalPath = null;
    S.diffModifiedPath = null;

    if (S.diffEditor) {
      var dm = S.diffEditor.getModel();
      if (dm) {
        if (dm.original) dm.original.dispose();
        if (dm.modified) dm.modified.dispose();
      }
    }

    var activeTab = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    if (activeTab && activeTab.model && S.editor) {
      S.editor.setModel(activeTab.model);
    }
    if (BOBO.editorCore) {
      BOBO.editorCore.updateStatusBar(activeTab ? activeTab.model : null, S.editor ? S.editor.getPosition() : null);
    }
  }

  // ──── Image Preview ────
  function showImagePreview(filePath, name) {
    S.currentImagePath = filePath;
    S.imageRotation = 0;
    S.imageScale = 1;

    document.getElementById('image-preview-title').textContent = name;
    var imgElement = document.getElementById('preview-image');
    imgElement.src = 'file://' + filePath;
    imgElement.style.transform = '';

    document.getElementById('image-preview').classList.remove('hidden');
    document.getElementById('container').style.display = 'none';
  }

  function closeImagePreview() {
    S.currentImagePath = null;
    S.imageRotation = 0;
    S.imageScale = 1;
    document.getElementById('image-preview').classList.add('hidden');
    document.getElementById('container').style.display = 'block';
    document.getElementById('preview-image').src = '';
    document.getElementById('preview-image').style.transform = '';
  }

  function rotateImage(degrees) {
    S.imageRotation += degrees;
    updateImageTransform();
  }

  function zoomImage(factor) {
    S.imageScale *= factor;
    S.imageScale = Math.max(0.1, Math.min(5, S.imageScale));
    updateImageTransform();
  }

  function resetImageTransform() {
    S.imageRotation = 0;
    S.imageScale = 1;
    updateImageTransform();
  }

  function updateImageTransform() {
    var img = document.getElementById('preview-image');
    img.style.transform = 'rotate(' + S.imageRotation + 'deg) scale(' + S.imageScale + ')';
  }

  function initImagePreviewControls() {
    document.getElementById('close-image-preview').addEventListener('click', closeImagePreview);
    document.getElementById('rotate-left').addEventListener('click', function() { rotateImage(-90); });
    document.getElementById('rotate-right').addEventListener('click', function() { rotateImage(90); });
    document.getElementById('zoom-out').addEventListener('click', function() { zoomImage(0.8); });
    document.getElementById('zoom-in').addEventListener('click', function() { zoomImage(1.25); });
    document.getElementById('zoom-reset').addEventListener('click', resetImageTransform);
  }

  // ──── Theme Picker ────
  function setupThemePicker() {
    var modal = document.getElementById('theme-modal');
    var select = document.getElementById('theme-select');
    var applyBtn = document.getElementById('theme-apply');
    var cancelBtn = document.getElementById('theme-cancel');

    if (!modal || !select || !applyBtn || !cancelBtn) return;

    applyBtn.addEventListener('click', function() {
      if (window.themeManager) window.themeManager.applyTheme(select.value);
      modal.style.display = 'none';
    });

    cancelBtn.addEventListener('click', function() { modal.style.display = 'none'; });
    modal.addEventListener('click', function(event) {
      if (event.target === modal) modal.style.display = 'none';
    });
  }

  function openThemePicker() {
    if (BOBO.settings) BOBO.settings.open('local');
  }

  BOBO.views = {
    init: function() {
      setupThemePicker();
      initImagePreviewControls();
      document.getElementById('close-diff').addEventListener('click', closeDiffView);
    },

    // Split
    openSplit: openSplitView,
    closeSplit: closeSplitView,

    // Diff
    openDiff: openDiffView,
    closeDiff: closeDiffView,

    // Image preview
    showImagePreview: showImagePreview,
    closeImagePreview: closeImagePreview,

    // Theme
    openThemePicker: openThemePicker
  };
})(window);
