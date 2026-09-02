import { rendererPlatform } from '../renderer/core/bootstrap.ts';
import { ContributionPoint } from '../renderer/core/contribution-registry.ts';
import { selectDocumentView } from '../renderer/core/document-view.js';
import { createSandboxedDocumentView } from '../renderer/core/document-view-sandbox.js';

(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var instances = new Map();
  var contributionSubscription = null;
  var localeSubscription = null;

  function t(source) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source) : source;
  }

  function pluginApi() {
    var api = global.api && global.api.plugins;
    if (!api || !api.documents || typeof api.loadDocumentView !== 'function') return null;
    return api;
  }

  function registrations() {
    return rendererPlatform.contributions.listEntries(ContributionPoint.DOCUMENT_VIEWS);
  }

  function find(fileName) {
    var entry = selectDocumentView(registrations(), fileName);
    if (!entry) return null;
    return Object.freeze(Object.assign({ pluginId: entry.owner }, entry.contribution));
  }

  function themeSnapshot() {
    var styles = global.getComputedStyle(document.documentElement);
    function value(name, fallback) {
      return (styles.getPropertyValue(name) || '').trim() || fallback;
    }
    return {
      kind: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      background: value('--bg-deep', '#111318'),
      surface: value('--bg-surface', '#1a1d24'),
      border: value('--border-default', '#343945'),
      text: value('--text-primary', '#e7eaf0'),
      muted: value('--text-secondary', '#9da5b4'),
      accent: value('--brand', '#4da3ff'),
      danger: value('--red', '#ef6461'),
      fontFamily: value('--font-ui', 'system-ui, sans-serif'),
      monoFontFamily: value('--font-mono', 'ui-monospace, monospace')
    };
  }

  function activeLocale() {
    return BOBO.i18n && typeof BOBO.i18n.getActive === 'function' ? BOBO.i18n.getActive() : 'en';
  }

  function showFailure(instance, error) {
    if (!instance || instance.disposed) return;
    instance.sandbox.hide();
    instance.error.hidden = false;
    instance.error.textContent = t('Document preview failed') + ': ' + (error && error.message ? error.message : t('Unknown error'));
  }

  async function create(filePath, fileName, registration) {
    var api = pluginApi();
    if (!api) throw new Error(t('Document preview failed'));
    var existing = instances.get(filePath);
    if (existing) return existing;
    var loaded = await api.loadDocumentView(registration.pluginId, registration.id);
    if (!loaded || !loaded.viewer || loaded.viewer.id !== registration.id || loaded.pluginId !== registration.pluginId) {
      throw new Error('Document viewer identity mismatch.');
    }
    var localization = typeof api.loadLocalization === 'function'
      ? await api.loadLocalization(registration.pluginId, activeLocale())
      : { locale: 'en', messages: {} };
    var documentInfo = await api.documents.open(registration.pluginId, registration.id, filePath);
    var root = document.getElementById('document-view-host');
    if (!root) {
      await api.documents.close(documentInfo.documentId).catch(function() {});
      throw new Error('Document view host is unavailable.');
    }
    var errorView = document.createElement('div');
    errorView.className = 'document-view-host-error';
    errorView.hidden = true;
    root.appendChild(errorView);
    var instance = {
      path: filePath,
      pluginId: registration.pluginId,
      viewerId: registration.id,
      documentId: documentInfo.documentId,
      error: errorView,
      sandbox: null,
      disposed: false
    };
    try {
      instance.sandbox = createSandboxedDocumentView({
        container: root,
        entry: loaded.entry,
        resources: loaded.resources,
        document: documentInfo,
        viewer: Object.assign({}, loaded.viewer, { title: registration.title }),
        localization: localization,
        theme: themeSnapshot(),
        read: function(range) {
          return api.documents.read(documentInfo.documentId, range.offset, range.length);
        },
        onError: function(error) { showFailure(instance, error); }
      });
    } catch (error) {
      errorView.remove();
      await api.documents.close(documentInfo.documentId).catch(function() {});
      throw error;
    }
    instances.set(filePath, instance);
    instance.sandbox.ready.catch(function(error) { showFailure(instance, error); });
    return instance;
  }

  function show(tab) {
    var instance = tab && tab.documentView;
    if (!instance || instance.disposed) return false;
    if (S.currentViewMode === 'split' && BOBO.views && BOBO.views.closeSplit) BOBO.views.closeSplit();
    if (S.currentViewMode === 'diff' && BOBO.views && BOBO.views.closeDiff) BOBO.views.closeDiff();
    if (BOBO.views && BOBO.views.closeImagePreview) BOBO.views.closeImagePreview();
    var editor = document.getElementById('container');
    var root = document.getElementById('document-view-host');
    if (editor) editor.style.display = 'none';
    if (root) root.classList.remove('hidden');
    instances.forEach(function(candidate) {
      candidate.error.hidden = candidate !== instance || candidate.error.textContent === '';
      if (candidate === instance) candidate.sandbox.show();
      else candidate.sandbox.hide();
    });
    S.currentViewMode = 'document-view';
    return true;
  }

  function hideAll(options) {
    options = options || {};
    var root = document.getElementById('document-view-host');
    if (root) root.classList.add('hidden');
    instances.forEach(function(instance) { instance.sandbox.hide(); });
    if (options.restoreEditor !== false) {
      var editor = document.getElementById('container');
      if (editor) editor.style.display = '';
      if (S.currentViewMode === 'document-view') S.currentViewMode = 'single';
    }
  }

  function disposeInstance(instance) {
    if (!instance || instance.disposed) return;
    instance.disposed = true;
    instances.delete(instance.path);
    try { instance.sandbox.dispose(); } catch (_) {}
    instance.error.remove();
    var api = pluginApi();
    if (api) api.documents.close(instance.documentId).catch(function() {});
  }

  function disposeTab(tab) {
    if (tab && tab.documentView) {
      disposeInstance(tab.documentView);
      tab.documentView = null;
    }
  }

  function disposeAll() {
    Array.from(instances.values()).forEach(disposeInstance);
    hideAll();
  }

  function handleContributionChange(event) {
    if (!event || event.point !== ContributionPoint.DOCUMENT_VIEWS || event.type !== 'removed') return;
    var affected = S.tabs.filter(function(tab) {
      return tab.documentView && tab.documentView.pluginId === event.owner && tab.documentView.viewerId === event.id;
    });
    affected.forEach(function(tab) {
      disposeTab(tab);
      if (BOBO.workspace && BOBO.workspace.closeTab) {
        Promise.resolve(BOBO.workspace.closeTab(tab.path, { force: true })).catch(function() {});
      }
    });
  }

  async function refreshLocalizations() {
    var api = pluginApi();
    if (!api || typeof api.loadLocalization !== 'function') return;
    await Promise.all(Array.from(instances.values()).map(async function(instance) {
      if (instance.disposed) return;
      try {
        var localization = await api.loadLocalization(instance.pluginId, activeLocale());
        if (!instance.disposed) instance.sandbox.updateLocalization(localization);
      } catch (_) {}
    }));
  }

  function init() {
    if (!contributionSubscription) {
      contributionSubscription = rendererPlatform.contributions.onDidChange(handleContributionChange);
    }
    if (!localeSubscription && BOBO.i18n && typeof BOBO.i18n.onChange === 'function') {
      localeSubscription = BOBO.i18n.onChange(function() { void refreshLocalizations(); });
    }
  }

  BOBO.documentViews = {
    init: init,
    find: find,
    create: create,
    show: show,
    hideAll: hideAll,
    disposeTab: disposeTab,
    disposeAll: disposeAll
  };
})(window);
