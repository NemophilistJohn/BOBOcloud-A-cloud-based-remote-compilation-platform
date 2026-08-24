// Extension details are workbench pages, not editor models. The page receives
// only the sanitized status descriptor exposed by the preload bridge.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var PAGE_ID = 'plugin-details-view';
  var TAB_PREFIX = 'plugin-details:';
  var initialized = false;
  var busy = false;
  var refreshTokens = new Map();
  var pendingUnderlyingView = null;

  function t(key, params) {
    try { return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key, params) : interpolate(key, params); } catch (error) { return interpolate(key, params); }
  }

  function interpolate(value, params) {
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, key) {
      return params && params[key] != null ? String(params[key]) : match;
    });
  }

  function pluginApi() {
    var api = global.api && global.api.plugins;
    return api && typeof api === 'object' ? api : null;
  }

  function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function strings(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function(item) { return typeof item === 'string' && item.length > 0 && item.length <= 240; });
  }

  function dedupe(values) {
    return values.filter(function(value, index) { return values.indexOf(value) === index; });
  }

  function safeId(value) {
    var id = String(value || '');
    return /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(id) ? id : '';
  }

  function tabKey(id) {
    return TAB_PREFIX + encodeURIComponent(id);
  }

  function idFromTabKey(key) {
    if (typeof key !== 'string' || key.indexOf(TAB_PREFIX) !== 0) return '';
    try { return safeId(decodeURIComponent(key.slice(TAB_PREFIX.length))); } catch (error) { return ''; }
  }

  function arrayFromRecord(record, fields) {
    for (var i = 0; i < fields.length; i++) {
      if (Array.isArray(record && record[fields[i]])) return strings(record[fields[i]]);
    }
    return [];
  }

  function normalizeDetail(value) {
    var record = isPlainObject(value) ? value : {};
    var manifest = isPlainObject(record.manifest) ? record.manifest : {};
    var id = safeId(record.id || manifest.id);
    if (!id) return null;
    var requested = dedupe(arrayFromRecord(record, ['requestedPermissions', 'permissions']).concat(arrayFromRecord(manifest, ['permissions'])));
    var granted = dedupe(arrayFromRecord(record, ['grantedPermissions', 'grants'])).filter(function(permission) {
      return requested.indexOf(permission) >= 0;
    });
    var integrity = isPlainObject(record.integrity) ? record.integrity : {};
    var engines = isPlainObject(manifest.engines) ? manifest.engines : {};
    var contributes = isPlainObject(manifest.contributes) ? manifest.contributes : {};

    return {
      id: id,
      key: tabKey(id),
      name: String(record.displayName || manifest.displayName || manifest.name || id).slice(0, 160),
      description: String(record.description || manifest.description || '').slice(0, 4000),
      version: String(record.version || manifest.version || '').slice(0, 80),
      enabled: record.enabled === true && String(record.status || '') !== 'invalid' && String(record.status || '') !== 'incompatible',
      status: String(record.status || (record.enabled === true ? 'enabled' : 'disabled')).slice(0, 80),
      requestedPermissions: requested,
      grantedPermissions: granted,
      integrity: { valid: integrity.valid === true, reason: String(integrity.reason || '').slice(0, 180) },
      activationEvents: dedupe(strings(manifest.activationEvents)),
      contributionPoints: Object.keys(contributes).filter(function(key) { return /^[a-zA-Z0-9._-]{1,120}$/.test(key); }).sort(),
      engines: {
        bobocloud: String(engines.bobocloud || '').slice(0, 120),
        pluginApi: String(engines.pluginApi || '').slice(0, 120)
      },
      installedAt: String(record.installedAt || '').slice(0, 120)
    };
  }

  function tabs() {
    if (!Array.isArray(S.pluginDetailTabs)) S.pluginDetailTabs = [];
    return S.pluginDetailTabs;
  }

  function findTabById(id) {
    return tabs().find(function(tab) { return tab.id === id; }) || null;
  }

  function findTabByKey(key) {
    var id = idFromTabKey(key);
    return id ? findTabById(id) : null;
  }

  function activeTab() {
    return findTabByKey(S.activeTabPath);
  }

  function view() {
    var root = document.getElementById(PAGE_ID);
    if (root) return root;
    var editor = document.getElementById('editor');
    if (!editor) return null;
    root = document.createElement('section');
    root.id = PAGE_ID;
    root.className = 'plugin-details-view';
    root.hidden = true;
    root.setAttribute('role', 'tabpanel');
    root.setAttribute('aria-label', t('Plugin details'));
    editor.appendChild(root);
    root.addEventListener('click', onViewClick);
    return root;
  }

  function append(parent, tagName, className, value) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (value != null) element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function icon(kind) {
    if (kind === 'play') return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.45v11.1c0 .5.55.8.97.54l8.3-5.55a.65.65 0 0 0 0-1.08l-8.3-5.55A.65.65 0 0 0 4 2.45Z"/></svg>';
    if (kind === 'pause') return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.75c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Zm6 0c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Z"/></svg>';
    if (kind === 'refresh') return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.3 6.5A5.5 5.5 0 1 0 13.1 10M13.3 2.7v3.8H9.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function actionButton(action, label, id, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'plugin-details-icon-button';
    button.dataset.pluginDetailsAction = action;
    button.dataset.pluginId = id;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled === true;
    button.innerHTML = icon(action === 'enable' ? 'play' : action === 'disable' ? 'pause' : action);
    return button;
  }

  function statusDescriptor(detail) {
    if (detail.status === 'incompatible') return { text: t('Incompatible'), tone: 'error' };
    if (detail.status === 'invalid' || !detail.integrity.valid) return { text: t('Integrity check failed'), tone: 'error' };
    return detail.enabled ? { text: t('Enabled'), tone: 'enabled' } : { text: t('Disabled'), tone: 'disabled' };
  }

  function formatInstalledAt(value) {
    if (!value) return '--';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    try { return date.toLocaleString(document.documentElement.lang || undefined); } catch (error) { return date.toISOString(); }
  }

  function fact(parent, label, value, tone) {
    var row = document.createElement('div');
    row.className = 'plugin-details-fact';
    append(row, 'dt', 'plugin-details-fact-label', label);
    var result = append(row, 'dd', 'plugin-details-fact-value', value);
    if (tone) result.dataset.tone = tone;
    parent.appendChild(row);
  }

  function section(page, title) {
    var container = document.createElement('section');
    container.className = 'plugin-details-section';
    append(container, 'h2', 'plugin-details-section-title', title);
    page.appendChild(container);
    return container;
  }

  function renderPermissions(page, detail) {
    var content = section(page, t('Requested permissions'));
    if (!detail.requestedPermissions.length) {
      append(content, 'p', 'plugin-details-empty', t('No additional permissions requested'));
      return;
    }
    var list = document.createElement('div');
    list.className = 'plugin-details-permissions';
    detail.requestedPermissions.forEach(function(permission) {
      var granted = detail.grantedPermissions.indexOf(permission) >= 0;
      var row = document.createElement('div');
      row.className = 'plugin-details-permission';
      var copy = document.createElement('div');
      copy.className = 'plugin-details-permission-copy';
      append(copy, 'code', 'plugin-details-permission-id', permission);
      append(copy, 'span', 'plugin-details-permission-state', granted ? t('Granted permissions') : t('Requested permissions')).dataset.granted = granted ? 'true' : 'false';
      row.appendChild(copy);
      var control = document.createElement('button');
      control.type = 'button';
      control.className = 'ss-btn ss-btn-ghost plugin-details-permission-action';
      control.dataset.pluginDetailsAction = granted ? 'revoke' : 'grant';
      control.dataset.pluginId = detail.id;
      control.dataset.permission = permission;
      control.disabled = busy;
      control.textContent = granted ? t('Revoke') : t('Grant');
      row.appendChild(control);
      list.appendChild(row);
    });
    content.appendChild(list);
  }

  function renderSimpleList(page, title, values, emptyText, className) {
    var content = section(page, title);
    if (!values.length) {
      append(content, 'p', 'plugin-details-empty', emptyText);
      return;
    }
    var list = document.createElement('ul');
    list.className = className || 'plugin-details-list';
    values.forEach(function(value) { append(list, 'li', '', value); });
    content.appendChild(list);
  }

  function renderPage(tab, options) {
    var root = view();
    if (!root || !tab || !tab.detail) return;
    options = options || {};
    var scrollTop = options.resetScroll ? 0 : root.scrollTop;
    var detail = tab.detail;
    var state = statusDescriptor(detail);
    root.setAttribute('aria-label', t('Plugin details') + ': ' + detail.name);
    root.replaceChildren();

    var page = document.createElement('div');
    page.className = 'plugin-details-page';
    page.dataset.pluginId = detail.id;
    root.appendChild(page);

    var header = document.createElement('header');
    header.className = 'plugin-details-hero';
    var identity = document.createElement('div');
    identity.className = 'plugin-details-identity';
    var mark = append(identity, 'span', 'plugin-details-mark', detail.name.slice(0, 1).toUpperCase() || '+');
    mark.setAttribute('aria-hidden', 'true');
    var copy = document.createElement('div');
    copy.className = 'plugin-details-copy';
    append(copy, 'span', 'plugin-details-kicker', t('Extension'));
    append(copy, 'h1', 'plugin-details-title', detail.name);
    var metadata = document.createElement('div');
    metadata.className = 'plugin-details-metadata';
    append(metadata, 'code', 'plugin-details-id', detail.id);
    if (detail.version) append(metadata, 'span', 'plugin-details-version', 'v' + detail.version);
    var badge = append(metadata, 'span', 'plugin-details-status', state.text);
    badge.dataset.tone = state.tone;
    copy.appendChild(metadata);
    identity.appendChild(copy);
    header.appendChild(identity);

    var actions = document.createElement('div');
    actions.className = 'plugin-details-actions';
    actions.appendChild(actionButton('refresh', t('Refresh details'), detail.id, busy));
    if (detail.status !== 'invalid' && detail.status !== 'incompatible') {
      actions.appendChild(actionButton(detail.enabled ? 'disable' : 'enable', detail.enabled ? t('Disable plugin') : t('Enable plugin'), detail.id, busy));
    }
    actions.appendChild(actionButton('uninstall', t('Uninstall plugin'), detail.id, busy));
    header.appendChild(actions);
    page.appendChild(header);

    append(page, 'p', 'plugin-details-description' + (detail.description ? '' : ' is-empty'), detail.description || t('No description provided.'));

    var facts = document.createElement('dl');
    facts.className = 'plugin-details-facts';
    fact(facts, t('Status'), state.text, state.tone);
    fact(facts, t('Integrity'), detail.integrity.valid ? t('Verified') : t('Verification failed'), detail.integrity.valid ? 'enabled' : 'error');
    fact(facts, t('Installed'), formatInstalledAt(detail.installedAt));
    fact(facts, t('Plugin API'), detail.engines.pluginApi || '--');
    fact(facts, t('BOBOCloud'), detail.engines.bobocloud || '--');
    page.appendChild(facts);

    var message = append(page, 'p', 'plugin-details-message', tab.message || '');
    if (tab.messageTone) message.dataset.tone = tab.messageTone;
    if (!tab.message) message.hidden = true;

    renderPermissions(page, detail);
    renderSimpleList(page, t('Activation events'), detail.activationEvents, t('No activation events declared'), 'plugin-details-list plugin-details-code-list');
    renderSimpleList(page, t('Contributions'), detail.contributionPoints, t('No contributions declared'), 'plugin-details-list plugin-details-code-list');
    if (!detail.integrity.valid && detail.integrity.reason) {
      var integritySection = section(page, t('Integrity'));
      append(integritySection, 'p', 'plugin-details-integrity-reason', detail.integrity.reason);
    }

    root.scrollTop = scrollTop;
  }

  function captureUnderlyingView(filePath) {
    var split = document.getElementById('split-container');
    var diff = document.getElementById('diff-container');
    var image = document.getElementById('image-preview');
    return {
      filePath: filePath || '',
      mode: S.currentViewMode === 'split' || S.currentViewMode === 'diff' ? S.currentViewMode : 'single',
      splitActive: Boolean(split && split.classList.contains('active')),
      diffActive: Boolean(diff && diff.classList.contains('active')),
      imageActive: Boolean(image && !image.classList.contains('hidden')),
      diffOriginalPath: S.diffOriginalPath || '',
      diffModifiedPath: S.diffModifiedPath || ''
    };
  }

  function concealUnderlyingViews() {
    var split = document.getElementById('split-container');
    var diff = document.getElementById('diff-container');
    var image = document.getElementById('image-preview');
    if (split) split.classList.remove('active');
    if (diff) diff.classList.remove('active');
    if (image) image.classList.add('hidden');
    if (BOBO.documentViews) BOBO.documentViews.hideAll({ restoreEditor: false });
  }

  function restoreUnderlyingView(fileTab) {
    var snapshot = pendingUnderlyingView;
    if (!snapshot || !fileTab || snapshot.filePath !== fileTab.path) return;
    pendingUnderlyingView = null;
    if (snapshot.mode === 'split' && snapshot.splitActive && fileTab.model && BOBO.views && BOBO.views.openSplit) {
      BOBO.views.openSplit();
      return;
    }
    if (snapshot.mode === 'diff' && snapshot.diffActive && BOBO.views && BOBO.views.openDiff) {
      BOBO.views.openDiff(snapshot.diffOriginalPath, snapshot.diffModifiedPath);
      return;
    }
    // Image tabs are restored by workspace.activateTab() itself.
  }

  function activate(tab, options) {
    if (!tab) return false;
    options = options || {};
    var root = view();
    if (!root) return false;
    var previousDetailsTab = activeTab();
    var fileTab = S.tabs.find(function(candidate) { return candidate.path === S.activeTabPath; });
    if (fileTab) {
      tab.previousFilePath = fileTab.path;
      tab.previousView = captureUnderlyingView(fileTab.path);
      pendingUnderlyingView = null;
    } else if (previousDetailsTab && previousDetailsTab.previousView) {
      tab.previousFilePath = previousDetailsTab.previousFilePath;
      tab.previousView = previousDetailsTab.previousView;
    }
    concealUnderlyingViews();
    var container = document.getElementById('container');
    if (container) container.style.display = 'none';
    root.hidden = false;
    root.classList.add('active');
    S.currentViewMode = 'plugin-details';
    S.activeTabPath = tab.key;
    renderPage(tab, { resetScroll: options.resetScroll === true });
    if (BOBO.workspace) {
      BOBO.workspace.updateTabbar();
      BOBO.workspace.updateTitlebar();
      BOBO.workspace.updateEmptyState();
    }
    return true;
  }

  function deactivate(tabOverride) {
    if (S.currentViewMode !== 'plugin-details') return;
    var tab = tabOverride || activeTab();
    if (tab && tab.previousView) pendingUnderlyingView = tab.previousView;
    var root = document.getElementById(PAGE_ID);
    if (root) {
      root.hidden = true;
      root.classList.remove('active');
    }
    var container = document.getElementById('container');
    if (container) container.style.display = '';
    S.currentViewMode = 'single';
  }

  function restoreAfterClose(tab) {
    var candidate = tab && tab.previousFilePath && S.tabs.find(function(fileTab) { return fileTab.path === tab.previousFilePath; });
    if (!candidate && S.tabs.length) candidate = S.tabs[S.tabs.length - 1];
    deactivate(tab);
    if (candidate && BOBO.workspace && BOBO.workspace.activateTab) {
      BOBO.workspace.activateTab(candidate.path);
      return;
    }
    S.activeTabPath = null;
    if (BOBO.workspace) {
      BOBO.workspace.updateTabbar();
      BOBO.workspace.updateTitlebar();
      BOBO.workspace.updateEmptyState();
    }
  }

  function closeByKey(key) {
    var tab = findTabByKey(key);
    if (!tab) return false;
    var wasActive = S.activeTabPath === tab.key;
    var index = tabs().indexOf(tab);
    if (index >= 0) tabs().splice(index, 1);
    if (wasActive) restoreAfterClose(tab);
    else if (BOBO.workspace) BOBO.workspace.updateTabbar();
    return true;
  }

  function closeById(id) {
    var tab = findTabById(id);
    return tab ? closeByKey(tab.key) : false;
  }

  function statusMessage(tab, text, tone) {
    if (!tab) return;
    tab.message = text || '';
    tab.messageTone = tone || '';
    if (S.activeTabPath === tab.key) renderPage(tab);
  }

  function genericError() {
    return t('Unknown error');
  }

  async function refreshDetail(id, options) {
    options = options || {};
    var validId = safeId(id);
    var api = pluginApi();
    if (!validId || !api || typeof api.get !== 'function') return false;
    var request = (refreshTokens.get(validId) || 0) + 1;
    refreshTokens.set(validId, request);
    try {
      var result = await Promise.resolve(api.get(validId));
      if (refreshTokens.get(validId) !== request) return false;
      var detail = normalizeDetail(result);
      if (!detail) {
        closeById(validId);
        return false;
      }
      var tab = findTabById(validId);
      if (!tab) {
        tab = { id: validId, key: tabKey(validId), detail: detail, previousFilePath: '', message: '', messageTone: '' };
        tabs().push(tab);
      } else {
        tab.detail = detail;
      }
      if (options.activate) activate(tab, { resetScroll: options.resetScroll === true });
      else if (S.activeTabPath === tab.key) renderPage(tab);
      else if (BOBO.workspace) BOBO.workspace.updateTabbar();
      return true;
    } catch (error) {
      var existing = findTabById(validId);
      if (existing) statusMessage(existing, genericError(), 'error');
      return false;
    }
  }

  async function open(id) {
    var validId = safeId(id);
    if (!validId) return false;
    return refreshDetail(validId, { activate: true, resetScroll: S.activeTabPath !== tabKey(validId) });
  }

  async function updatePlugin(id, action, permission) {
    if (busy) return;
    var tab = findTabById(id);
    var api = pluginApi();
    if (!tab || !api) return;
    var method = action === 'enable' || action === 'disable' || action === 'grant' || action === 'revoke' ? action : '';
    if (!method || typeof api[method] !== 'function') return;
    busy = true;
    renderPage(tab);
    try {
      if (action === 'grant' || action === 'revoke') await Promise.resolve(api[method](id, permission));
      else await Promise.resolve(api[method](id));
      await refreshDetail(id, { activate: S.activeTabPath === tab.key });
      var current = findTabById(id);
      if (current) statusMessage(current, action === 'enable' ? t('Plugin enabled') : action === 'disable' ? t('Plugin disabled') : action === 'grant' ? t('Permission granted') : t('Permission revoked'), 'success');
    } catch (error) {
      statusMessage(tab, genericError(), 'error');
    } finally {
      busy = false;
      var active = activeTab();
      if (active) renderPage(active);
    }
  }

  async function uninstall(id) {
    if (busy) return;
    var tab = findTabById(id);
    var api = pluginApi();
    if (!tab || !api || typeof api.uninstall !== 'function') return;
    var approved = typeof BOBO.confirm === 'function'
      ? await BOBO.confirm({ title: t('Uninstall plugin'), message: t('This removes "{name}" from this device. Plugin workspace data is not modified.', { name: tab.detail.name }), confirmLabel: t('Uninstall'), cancelLabel: t('Cancel'), danger: true })
      : global.confirm(t('Uninstall "{name}"?', { name: tab.detail.name }));
    if (!approved) return;
    busy = true;
    renderPage(tab);
    try {
      await Promise.resolve(api.uninstall(id));
      closeById(id);
    } catch (error) {
      statusMessage(tab, genericError(), 'error');
    } finally {
      busy = false;
      var active = activeTab();
      if (active) renderPage(active);
    }
  }

  function onViewClick(event) {
    var control = event.target.closest('[data-plugin-details-action]');
    if (!control || !view().contains(control) || control.disabled) return;
    var id = safeId(control.dataset.pluginId);
    var action = control.dataset.pluginDetailsAction;
    if (!id || !action) return;
    if (action === 'refresh') refreshDetail(id, { activate: true });
    else if (action === 'uninstall') uninstall(id);
    else updatePlugin(id, action, control.dataset.permission || '');
  }

  function updateFromChanged(payload) {
    var supplied = payload && Array.isArray(payload.plugins) ? payload.plugins : null;
    if (!supplied) {
      tabs().slice().forEach(function(tab) { refreshDetail(tab.id); });
      return;
    }
    var byId = new Map();
    supplied.forEach(function(record) {
      var detail = normalizeDetail(record);
      if (detail) byId.set(detail.id, detail);
    });
    tabs().slice().forEach(function(tab) {
      var detail = byId.get(tab.id);
      if (!detail) {
        closeById(tab.id);
        return;
      }
      tab.detail = detail;
      if (S.activeTabPath === tab.key) renderPage(tab);
    });
    if (BOBO.workspace) BOBO.workspace.updateTabbar();
  }

  function providerTabs() {
    return tabs().map(function(tab) {
      return { key: tab.key, name: tab.detail.name, title: t('Plugin details') + ': ' + tab.detail.name, category: t('Extensions'), closeable: true, draggable: false };
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    if (!Array.isArray(S.pluginDetailTabs)) S.pluginDetailTabs = [];
    view();
    if (BOBO.workspace && BOBO.workspace.registerWorkbenchTabProvider) {
      BOBO.workspace.registerWorkbenchTabProvider('plugin-details', {
        getTabs: providerTabs,
        activate: function(key) { activate(findTabByKey(key)); },
        close: closeByKey,
        deactivate: deactivate,
        afterFileActivation: restoreUnderlyingView
      });
    }
    if (global.api && global.api.plugins && typeof global.api.plugins.onChanged === 'function') global.api.plugins.onChanged(updateFromChanged);
    global.addEventListener('bobo:language-changed', function() {
      var tab = activeTab();
      if (tab) renderPage(tab);
      if (BOBO.workspace) {
        BOBO.workspace.updateTabbar();
        BOBO.workspace.updateTitlebar();
      }
    });
    global.addEventListener('bobo:open-plugin-details', function(event) {
      var id = event && event.detail && event.detail.id;
      open(id);
    });
  }

  BOBO.pluginDetails = Object.freeze({ open: open });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
