// Extensions sidebar. Package parsing, storage and permission enforcement stay
// in the main process; this module receives only sanitized metadata.
import pluginSemver from '../shared/plugin-semver.js';

var compareSemver = pluginSemver.compareSemver;

(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  var elements = {};
  var bound = false;
  var subscribed = false;
  var commandRegistered = false;
  var busy = false;
  var refreshSequence = 0;
  var marketplaceRefreshSequence = 0;
  var activeView = 'marketplace';
  var lastPlugins = [];
  var lastMarketplace = [];
  var marketplaceSnapshot = null;
  var marketplaceError = null;

  function byId(id) { return document.getElementById(id); }

  function interpolate(value, params) {
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, key) {
      return params && params[key] != null ? String(params[key]) : match;
    });
  }

  function t(key, params) {
    try {
      return BOBO.i18n && typeof BOBO.i18n.t === 'function' ? BOBO.i18n.t(key, params) : interpolate(key, params);
    } catch (_error) {
      return interpolate(key, params);
    }
  }

  function pluginsApi() {
    var api = global.api && global.api.plugins;
    return api && typeof api === 'object' ? api : null;
  }

  function apiAvailable() {
    var api = pluginsApi();
    return Boolean(api && typeof api.list === 'function');
  }

  function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.plugins)) return value.plugins;
    if (value && Array.isArray(value.items)) return value.items;
    if (value && value.result && Array.isArray(value.result.plugins)) return value.result.plugins;
    return [];
  }

  function normalizePlugin(value, index) {
    value = value && typeof value === 'object' ? value : {};
    var manifest = value.manifest && typeof value.manifest === 'object' ? value.manifest : {};
    var id = String(value.id || manifest.id || 'plugin-' + index);
    var status = String(value.status || value.state || '');
    var integrity = value.integrity && typeof value.integrity === 'object' ? value.integrity : {};
    var enabled = value.enabled !== false && value.disabled !== true && status !== 'disabled' && status !== 'invalid' && status !== 'incompatible';
    var error = value.error || value.lastError || value.activationError || '';
    if (!error && status === 'incompatible') error = t('Plugin is incompatible with this BOBOCloud version.');
    if (!error && status === 'invalid') error = t('Plugin integrity check failed. Reinstall the package.');
    if (!error && integrity.valid === false && integrity.reason) error = String(integrity.reason);
    var builtIn = value.builtIn === true || value.builtin === true || value.source === 'builtin' || value.source === 'built-in';

    return {
      id: id,
      displayName: String(value.displayName || value.name || manifest.displayName || manifest.name || id),
      version: String(value.version || manifest.version || '0.0.0'),
      description: String(value.description || manifest.description || ''),
      enabled: enabled,
      error: String(error || ''),
      builtIn: builtIn,
      removable: value.removable !== false && value.canUninstall !== false && !builtIn,
      state: status
    };
  }

  function normalizePlugins(value) {
    return normalizeArray(value).map(normalizePlugin).filter(function(plugin, index, all) {
      return all.findIndex(function(candidate) { return candidate.id === plugin.id; }) === index;
    }).sort(function(left, right) {
      return left.displayName.localeCompare(right.displayName);
    });
  }

  function marketplaceApi() {
    var api = pluginsApi();
    var marketplace = api && api.marketplace;
    return marketplace && typeof marketplace === 'object' ? marketplace : null;
  }

  function marketplaceAvailable() {
    var marketplace = marketplaceApi();
    return Boolean(marketplace && typeof marketplace.list === 'function');
  }

  function boundedText(value, fallback, maximum) {
    var text = value == null ? '' : String(value);
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (!text) text = fallback || '';
    return text.slice(0, maximum || 1200);
  }

  function activeLocale() {
    try {
      return BOBO.i18n && typeof BOBO.i18n.getActive === 'function' ? String(BOBO.i18n.getActive() || 'en') : 'en';
    } catch (_error) {
      return 'en';
    }
  }

  function localizedText(value, fallback) {
    if (typeof value === 'string' || typeof value === 'number') return boundedText(value, fallback);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback || '';
    var locale = activeLocale();
    var primary = locale.split('-')[0];
    var candidates = [locale, primary, 'en', 'zh-CN', 'ja'];
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index];
      if (typeof value[candidate] === 'string' && value[candidate]) return boundedText(value[candidate], fallback);
    }
    var firstKey = Object.keys(value).find(function(key) { return typeof value[key] === 'string' && value[key]; });
    return firstKey ? boundedText(value[firstKey], fallback) : (fallback || '');
  }

  function sourceText(value) {
    if (typeof value === 'string' || typeof value === 'number') return boundedText(value, '', 240);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    var repository = boundedText(value.repository || value.name || value.id, '', 180);
    var ref = boundedText(value.ref || value.revision || value.tag, '', 80);
    if (repository && ref) return repository + ' @ ' + ref;
    return repository || ref;
  }

  function normalizeMarketplaceVersion(value, index) {
    value = value && typeof value === 'object' ? value : {};
    return {
      version: boundedText(value.version, '0.0.0', 80),
      publishedAt: boundedText(value.publishedAt, '', 80),
      engines: value.engines && typeof value.engines === 'object' ? value.engines : {},
      permissions: Array.isArray(value.permissions) ? value.permissions.map(function(permission) { return boundedText(permission, '', 160); }).filter(Boolean).slice(0, 30) : [],
      locales: Array.isArray(value.locales) ? value.locales.map(function(locale) { return boundedText(locale, '', 40); }).filter(Boolean).slice(0, 12) : [],
      size: Number.isFinite(Number(value.size)) ? Math.max(0, Number(value.size)) : null,
      installed: value.installed === true,
      installedVersion: boundedText(value.installedVersion, '', 80),
      installedStatus: boundedText(value.installedStatus, '', 80),
      compatible: value.compatible !== false,
      source: sourceText(value.source),
      index: index
    };
  }

  function normalizeMarketplace(snapshot) {
    snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    var packages = Array.isArray(snapshot.packages) ? snapshot.packages : [];
    var normalized = packages.map(function(value, index) {
      value = value && typeof value === 'object' ? value : {};
      var versions = Array.isArray(value.versions) ? value.versions.map(normalizeMarketplaceVersion).filter(function(version) { return version.version !== '0.0.0' || value.versions.length === 1; }) : [];
      var latestRaw = value.latest && typeof value.latest === 'object' ? value.latest.version : value.latest;
      var latest = boundedText(latestRaw || value.latestVersion, '', 80);
      var selected = versions.find(function(version) { return version.version === latest; }) || versions.find(function(version) { return version.compatible; }) || versions[0] || null;
      var id = boundedText(value.id, 'marketplace-package-' + index, 180);
      var displayName = localizedText(value.displayName || value.name || value.localizedName, id);
      var description = localizedText(value.description || value.summary || value.localizedDescription, '');
      var categories = Array.isArray(value.categories) ? value.categories.map(function(category) { return localizedText(category, ''); }).filter(Boolean).slice(0, 8) : [];
      var publisher = boundedText(value.publisher || value.owner || id.split('.')[0], '', 120);
      return {
        id: id,
        displayName: displayName,
        description: description,
        publisher: publisher,
        categories: categories,
        source: sourceText(value.source || value.registrySource),
        versions: versions,
        selected: selected,
        latest: latest || (selected && selected.version) || '',
        installed: value.installed === true,
        installedVersion: boundedText(value.installedVersion, '', 80),
        installedStatus: boundedText(value.installedStatus, '', 80),
        updateAvailable: value.updateAvailable === true
      };
    }).filter(function(entry, index, all) {
      return entry.id && all.findIndex(function(candidate) { return candidate.id === entry.id; }) === index;
    });
    normalized.sort(function(left, right) { return left.displayName.localeCompare(right.displayName); });
    return normalized;
  }

  function marketplaceSource(snapshot) {
    snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    var value = String(snapshot.provenance || snapshot.catalogState || snapshot.cacheState || snapshot.registryState || snapshot.source || '').toLocaleLowerCase();
    if (snapshot.offline === true || snapshot.cached === true || snapshot.stale === true || value === 'verified-cache' || value === 'cache' || value === 'offline' || value === 'stale') return 'cache';
    return 'network';
  }

  function cacheElements() {
    elements.activity = byId('activity-extensions');
    elements.install = byId('extensions-install');
    elements.openFolder = byId('extensions-open-folder');
    elements.refresh = byId('extensions-refresh');
    elements.search = byId('extensions-search-input');
    elements.marketplaceTab = byId('extensions-marketplace-tab');
    elements.installedTab = byId('extensions-installed-tab');
    elements.marketplaceView = byId('extensions-marketplace-view');
    elements.marketplaceList = byId('extensions-marketplace-list');
    elements.installedView = byId('extensions-installed-view');
    elements.list = byId('extensions-installed-list');
    elements.status = byId('extensions-status');
  }

  function appendText(parent, tagName, className, value) {
    var element = document.createElement(tagName);
    element.className = className || '';
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function actionIcon(action) {
    if (action === 'enable') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.45v11.1c0 .5.55.8.97.54l8.3-5.55a.65.65 0 0 0 0-1.08l-8.3-5.55A.65.65 0 0 0 4 2.45Z"/></svg>';
    }
    if (action === 'disable') {
      return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.75c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Zm6 0c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75h-2.5a.75.75 0 0 1-.75-.75V2.75Z"/></svg>';
    }
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function createActionButton(action, label, pluginId) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'extensions-item-action';
    button.dataset.pluginAction = action;
    button.dataset.pluginId = pluginId;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = busy;
    button.innerHTML = actionIcon(action);
    return button;
  }

  function stateLabel(plugin) {
    if (plugin.state === 'incompatible') return { text: t('Incompatible'), tone: 'error' };
    if (plugin.state === 'invalid') return { text: t('Integrity check failed'), tone: 'error' };
    if (plugin.error) return { text: t('Plugin error'), tone: 'error' };
    if (!plugin.enabled) return { text: t('Disabled'), tone: 'disabled' };
    return { text: t('Enabled'), tone: 'enabled' };
  }

  function setStatus(message, tone) {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.tone = tone || 'neutral';
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    [elements.install, elements.openFolder, elements.refresh].forEach(function(control) {
      if (control) control.disabled = busy || !apiAvailable();
    });
    if (elements.list) {
      elements.list.setAttribute('aria-busy', busy ? 'true' : 'false');
      Array.prototype.forEach.call(elements.list.querySelectorAll('[data-plugin-action]'), function(control) {
        control.disabled = busy;
      });
    }
    if (elements.marketplaceList) {
      elements.marketplaceList.setAttribute('aria-busy', busy ? 'true' : 'false');
      Array.prototype.forEach.call(elements.marketplaceList.querySelectorAll('[data-marketplace-action]'), function(control) {
        var action = control.dataset.marketplaceAction;
        control.disabled = busy || !marketplaceAvailable() || (action !== 'install' && action !== 'update' && action !== 'refresh');
      });
    }
  }

  function currentQuery() {
    return String(elements.search && elements.search.value || '').trim().toLocaleLowerCase();
  }

  function matchingPlugins() {
    var query = currentQuery();
    if (!query) return lastPlugins.slice();
    return lastPlugins.filter(function(plugin) {
      return [plugin.displayName, plugin.id, plugin.description, plugin.version].join('\n').toLocaleLowerCase().indexOf(query) >= 0;
    });
  }

  function matchingMarketplace() {
    var query = currentQuery();
    if (!query) return lastMarketplace.slice();
    return lastMarketplace.filter(function(entry) {
      var selected = entry.selected || {};
      return [
        entry.displayName,
        entry.id,
        entry.description,
        entry.publisher,
        entry.categories.join('\n'),
        entry.latest,
        selected.permissions && selected.permissions.join('\n'),
        selected.source
      ].join('\n').toLocaleLowerCase().indexOf(query) >= 0;
    });
  }

  function openPluginDetails(pluginId) {
    if (!pluginId) return;
    if (BOBO.pluginDetails && typeof BOBO.pluginDetails.open === 'function') {
      Promise.resolve(BOBO.pluginDetails.open(pluginId)).catch(function() {});
      return;
    }
    global.dispatchEvent(new CustomEvent('bobo:open-plugin-details', { detail: { id: String(pluginId) } }));
  }

  function renderPlugin(plugin) {
    var item = document.createElement('article');
    item.className = 'extensions-installed-item';
    item.dataset.pluginId = plugin.id;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.setAttribute('aria-label', t('Open details for {name}', { name: plugin.displayName }));

    var marker = appendText(item, 'span', 'extensions-item-marker', plugin.displayName.slice(0, 1).toUpperCase() || '+');
    marker.setAttribute('aria-hidden', 'true');

    var copy = document.createElement('div');
    copy.className = 'extensions-item-copy';
    appendText(copy, 'strong', 'extensions-item-name', plugin.displayName);
    appendText(copy, 'span', 'extensions-item-description', plugin.description || t('No description provided.'));
    var metadata = document.createElement('div');
    metadata.className = 'extensions-item-metadata';
    appendText(metadata, 'code', 'extensions-item-id', plugin.id);
    appendText(metadata, 'span', 'extensions-item-version', 'v' + plugin.version);
    if (plugin.builtIn) appendText(metadata, 'span', 'extensions-item-source', t('Built in'));
    copy.appendChild(metadata);
    item.appendChild(copy);

    var trailing = document.createElement('div');
    trailing.className = 'extensions-item-trailing';
    var state = stateLabel(plugin);
    var badge = appendText(trailing, 'span', 'extensions-item-state', state.text);
    badge.dataset.state = state.tone;
    var canToggle = plugin.state !== 'invalid' && plugin.state !== 'incompatible';
    if (canToggle) trailing.appendChild(createActionButton(plugin.enabled ? 'disable' : 'enable', plugin.enabled ? t('Disable plugin') : t('Enable plugin'), plugin.id));
    item.appendChild(trailing);

    if (plugin.error) {
      var error = appendText(item, 'span', 'extensions-item-error', plugin.error);
      error.setAttribute('role', 'alert');
    }
    return item;
  }

  function renderUnavailable() {
    if (!elements.list) return;
    elements.list.replaceChildren();
    var empty = document.createElement('div');
    empty.className = 'extensions-empty extensions-empty-error';
    empty.setAttribute('role', 'note');
    appendText(empty, 'strong', 'extensions-empty-title', t('Plugin management unavailable'));
    appendText(empty, 'span', 'extensions-empty-detail', t('This build does not expose the plugin host. Update BOBOCloud to install plugins.'));
    elements.list.appendChild(empty);
    setBusy(false);
    setStatus(t('Plugin host is unavailable.'), 'error');
  }

  function renderList(plugins) {
    lastPlugins = plugins.slice();
    if (!elements.list) return;
    var matches = matchingPlugins();
    elements.list.replaceChildren();
    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'extensions-empty';
      empty.setAttribute('role', 'note');
      appendText(empty, 'strong', 'extensions-empty-title', plugins.length ? t('No installed extensions match your search') : t('No plugins installed'));
      appendText(empty, 'span', 'extensions-empty-detail', plugins.length ? t('Clear the search or browse the Marketplace when a catalog is configured.') : t('Install a .boboplugin package to add an extension to this workbench.'));
      elements.list.appendChild(empty);
    } else {
      var fragment = document.createDocumentFragment();
      matches.forEach(function(plugin) { fragment.appendChild(renderPlugin(plugin)); });
      elements.list.appendChild(fragment);
    }
    setBusy(busy);
  }

  function marketplaceInstallState(entry) {
    var selected = entry && entry.selected;
    if (!selected) return { kind: 'unavailable', label: t('Unavailable'), tone: 'error', actionable: false };
    var installedPlugin = findPlugin(entry.id);
    var installedVersion = entry.installedVersion || selected.installedVersion || (installedPlugin && installedPlugin.version) || '';
    var isInstalled = Boolean(entry.installed || selected.installed || installedPlugin || installedVersion);
    var versionComparison = compareSemver(installedVersion, selected.version);
    if (isInstalled && versionComparison !== null && versionComparison >= 0) {
      return { kind: 'installed', label: t('Installed'), tone: 'enabled', actionable: false };
    }
    if (!selected.compatible) return { kind: 'incompatible', label: t('Incompatible'), tone: 'error', actionable: false };
    if (isInstalled || entry.updateAvailable) return { kind: 'update', label: t('Update'), tone: 'update', actionable: true };
    return { kind: 'install', label: t('Install'), tone: 'neutral', actionable: true };
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function engineSummary(engines) {
    if (!engines || typeof engines !== 'object') return '';
    return Object.keys(engines).sort().slice(0, 8).map(function(key) {
      return boundedText(key, '', 80) + ': ' + boundedText(engines[key], '', 120);
    }).filter(Boolean).join(', ');
  }

  function createMarketplaceAction(entry, state) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'extensions-marketplace-action';
    button.dataset.marketplaceAction = state.kind;
    button.dataset.packageId = entry.id;
    button.dataset.packageVersion = entry.selected && entry.selected.version || '';
    button.textContent = state.label;
    button.disabled = busy || !state.actionable || !marketplaceAvailable();
    button.setAttribute('aria-label', state.actionable
      ? t('{action} {name}', { action: state.label, name: entry.displayName })
      : t('{name} is {state}', { name: entry.displayName, state: state.label }));
    return button;
  }

  function appendMarketplaceDetail(definition, label, value) {
    if (!value) return;
    var row = document.createElement('div');
    row.className = 'extensions-marketplace-detail-row';
    appendText(row, 'dt', 'extensions-marketplace-detail-label', label);
    appendText(row, 'dd', 'extensions-marketplace-detail-value', value);
    definition.appendChild(row);
  }

  function renderMarketplaceCard(entry) {
    var selected = entry.selected || {};
    var state = marketplaceInstallState(entry);
    var card = document.createElement('article');
    card.className = 'extensions-marketplace-item';
    card.dataset.packageId = entry.id;
    card.setAttribute('role', 'listitem');

    var marker = appendText(card, 'span', 'extensions-marketplace-marker', entry.displayName.slice(0, 1).toUpperCase() || '+');
    marker.setAttribute('aria-hidden', 'true');

    var copy = document.createElement('div');
    copy.className = 'extensions-marketplace-copy';
    appendText(copy, 'strong', 'extensions-marketplace-name', entry.displayName);
    appendText(copy, 'span', 'extensions-marketplace-description', entry.description || t('No description provided.'));
    var metadata = document.createElement('div');
    metadata.className = 'extensions-marketplace-metadata';
    appendText(metadata, 'span', 'extensions-marketplace-publisher', t('by {publisher}', { publisher: entry.publisher || t('Unknown publisher') }));
    appendText(metadata, 'code', 'extensions-marketplace-id', entry.id);
    if (selected.version) appendText(metadata, 'span', 'extensions-marketplace-version', 'v' + selected.version);
    copy.appendChild(metadata);
    if (entry.categories.length) {
      var categories = document.createElement('div');
      categories.className = 'extensions-marketplace-categories';
      entry.categories.forEach(function(category) { appendText(categories, 'span', 'extensions-marketplace-category', category); });
      copy.appendChild(categories);
    }
    card.appendChild(copy);

    var trailing = document.createElement('div');
    trailing.className = 'extensions-marketplace-trailing';
    var badge = appendText(trailing, 'span', 'extensions-marketplace-state', state.label);
    badge.dataset.state = state.tone;
    trailing.appendChild(createMarketplaceAction(entry, state));
    card.appendChild(trailing);

    var details = document.createElement('details');
    details.className = 'extensions-marketplace-details';
    appendText(details, 'summary', 'extensions-marketplace-details-summary', t('Extension information'));
    var definition = document.createElement('dl');
    definition.className = 'extensions-marketplace-detail-list';
    appendMarketplaceDetail(definition, t('Identifier'), entry.id);
    appendMarketplaceDetail(definition, t('Publisher'), entry.publisher);
    appendMarketplaceDetail(definition, t('Version'), selected.version || entry.latest);
    appendMarketplaceDetail(definition, t('Engine'), engineSummary(selected.engines));
    appendMarketplaceDetail(definition, t('Permissions'), selected.permissions && selected.permissions.join(', '));
    appendMarketplaceDetail(definition, t('Languages'), selected.locales && selected.locales.join(', '));
    appendMarketplaceDetail(definition, t('Package size'), formatSize(selected.size));
    appendMarketplaceDetail(definition, t('Published'), selected.publishedAt);
    appendMarketplaceDetail(definition, t('Marketplace source'), selected.source || entry.source);
    details.appendChild(definition);
    card.appendChild(details);
    return card;
  }

  function renderMarketplaceMessage(kind, title, detail, retry) {
    var message = document.createElement('div');
    message.className = 'extensions-empty extensions-marketplace-empty' + (kind === 'error' ? ' extensions-empty-error' : '');
    message.setAttribute('role', kind === 'error' ? 'alert' : 'note');
    appendText(message, 'strong', 'extensions-empty-title', title);
    if (detail) appendText(message, 'span', 'extensions-empty-detail', detail);
    if (retry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'extensions-primary-action';
      button.dataset.marketplaceAction = 'refresh';
      button.textContent = t('Retry Marketplace');
      message.appendChild(button);
    }
    return message;
  }

  function renderMarketplace(entries, options) {
    options = options || {};
    if (Array.isArray(entries)) lastMarketplace = entries.slice();
    if (!elements.marketplaceList) return;
    var list = elements.marketplaceList;
    var matches = matchingMarketplace();
    list.replaceChildren();

    if (marketplaceSnapshot && marketplaceSource(marketplaceSnapshot) === 'cache') {
      var cacheNotice = document.createElement('div');
      cacheNotice.className = 'extensions-marketplace-notice';
      cacheNotice.dataset.state = 'cache';
      cacheNotice.setAttribute('role', 'status');
      appendText(cacheNotice, 'span', 'extensions-marketplace-notice-label', t('Using verified cached Marketplace catalog'));
      list.appendChild(cacheNotice);
    }
    if (marketplaceError && lastMarketplace.length) {
      var staleNotice = document.createElement('div');
      staleNotice.className = 'extensions-marketplace-notice';
      staleNotice.dataset.state = 'error';
      staleNotice.setAttribute('role', 'status');
      appendText(staleNotice, 'span', 'extensions-marketplace-notice-label', t('Could not refresh Marketplace. Showing the last verified catalog.'));
      list.appendChild(staleNotice);
    }

    if (!matches.length) {
      var hasSearch = Boolean(currentQuery());
      list.appendChild(renderMarketplaceMessage('empty',
        hasSearch ? t('No Marketplace extensions match your search') : t('No extensions are available from this Marketplace.'),
        hasSearch ? t('Clear the search or refresh the Marketplace catalog.') : t('Refresh Marketplace to check for newly published extensions.'),
        !hasSearch && Boolean(marketplaceError)));
    } else {
      var fragment = document.createDocumentFragment();
      matches.forEach(function(entry) { fragment.appendChild(renderMarketplaceCard(entry)); });
      list.appendChild(fragment);
    }
    list.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function renderMarketplaceUnavailable() {
    if (!elements.marketplaceList) return;
    elements.marketplaceList.replaceChildren(renderMarketplaceMessage('error',
      t('Marketplace unavailable'),
      t('This build does not expose the Marketplace service. Update BOBOCloud to browse verified extensions.'),
      false));
    elements.marketplaceList.setAttribute('aria-busy', 'false');
  }

  function setActiveView(view, options) {
    options = options || {};
    activeView = view === 'installed' ? 'installed' : 'marketplace';
    var installed = activeView === 'installed';
    if (elements.marketplaceTab) {
      elements.marketplaceTab.classList.toggle('active', !installed);
      elements.marketplaceTab.setAttribute('aria-selected', installed ? 'false' : 'true');
      elements.marketplaceTab.tabIndex = installed ? -1 : 0;
    }
    if (elements.installedTab) {
      elements.installedTab.classList.toggle('active', installed);
      elements.installedTab.setAttribute('aria-selected', installed ? 'true' : 'false');
      elements.installedTab.tabIndex = installed ? 0 : -1;
    }
    if (elements.marketplaceView) {
      elements.marketplaceView.classList.toggle('active', !installed);
      elements.marketplaceView.hidden = installed;
    }
    if (elements.installedView) {
      elements.installedView.classList.toggle('active', installed);
      elements.installedView.hidden = !installed;
    }
    if (installed) renderList(lastPlugins);
    else if (marketplaceAvailable()) renderMarketplace(lastMarketplace);
    else renderMarketplaceUnavailable();
    if (options.focus && elements.search) elements.search.focus();
  }

  function resultWasCancelled(result) {
    return result == null || result === false || result.canceled === true || result.cancelled === true;
  }

  function errorMessage(error) {
    var code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'plugins.manifest.api' || code === 'plugins.manifest.host') return t('Plugin is incompatible with this BOBOCloud version.');
    if (/^plugins\.(?:integrity|manifest\.integrity)/.test(code)) return t('Plugin integrity check failed. Reinstall the package.');
    if (/^plugins\.(?:package\.size|package\.fileSize|zip\.size)/.test(code)) return t('Plugin package exceeds the supported size limit.');
    if (/^plugins\.(?:notFound)/.test(code)) return t('Plugin is no longer installed.');
    if (/^plugins\.(?:entry|rpc\.plugin)/.test(code)) return t('Plugin source is not available.');
    if (/^plugins\.(?:package|zip|manifest|install\.source|install\.type|id\.path)/.test(code)) return t('Plugin package is invalid or unsafe.');
    return error && error.message ? String(error.message) : t('Unknown error');
  }

  function marketplaceErrorMessage(error) {
    var code = error && typeof error.code === 'string' ? error.code : '';
    if (/^plugins\.marketplace\.(?:network|timeout)$/.test(code)) return t('Could not reach the Marketplace. Check your network and retry.');
    if (/^plugins\.marketplace\.(?:body|registry)$/.test(code)) return t('The Marketplace catalog could not be verified. Try again later.');
    if (/^plugins\.marketplace\.integrity$/.test(code)) return t('The Marketplace package failed integrity verification.');
    if (/^plugins\.marketplace\.artifact$/.test(code)) return t('The Marketplace package could not be downloaded or verified.');
    if (/^plugins\.marketplace\.notFound$/.test(code)) return t('This Marketplace extension is no longer available.');
    if (/^plugins\.marketplace\.version$/.test(code)) return t('This Marketplace version is no longer available.');
    if (/^plugins\.marketplace\.incompatible$/.test(code)) return t('Plugin is incompatible with this BOBOCloud version.');
    return t('Marketplace request failed. Please retry.');
  }

  async function refresh(options) {
    options = options || {};
    cacheElements();
    if (!apiAvailable()) {
      renderUnavailable();
      return [];
    }
    var api = pluginsApi();
    var sequence = ++refreshSequence;
    if (!options.quiet) setStatus(t('Loading plugins...'), 'neutral');
    try {
      var result = await Promise.resolve(api.list());
      if (sequence !== refreshSequence) return lastPlugins.slice();
      renderList(normalizePlugins(result));
      if (!options.preserveStatus) setStatus(t('{count} plugins available', { count: lastPlugins.length }), 'neutral');
      return lastPlugins.slice();
    } catch (error) {
      if (sequence !== refreshSequence) return lastPlugins.slice();
      renderList([]);
      setStatus(t('Could not load plugins: {message}', { message: errorMessage(error) }), 'error');
      return [];
    }
  }

  async function refreshMarketplace(options) {
    options = options || {};
    cacheElements();
    if (!marketplaceAvailable()) {
      renderMarketplaceUnavailable();
      return [];
    }
    var api = marketplaceApi();
    var sequence = ++marketplaceRefreshSequence;
    var method = options.force && typeof api.refresh === 'function' ? 'refresh' : 'list';
    if (!options.quiet) setStatus(t('Loading Marketplace...'), 'neutral');
    if (!lastMarketplace.length && elements.marketplaceList) {
      elements.marketplaceList.replaceChildren(renderMarketplaceMessage('loading', t('Loading Marketplace...'), t('Fetching verified extension metadata...'), false));
      elements.marketplaceList.setAttribute('aria-busy', 'true');
    }
    try {
      var snapshot = await Promise.resolve(api[method]());
      if (sequence !== marketplaceRefreshSequence) return lastMarketplace.slice();
      marketplaceSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
      marketplaceError = null;
      var entries = normalizeMarketplace(marketplaceSnapshot);
      renderMarketplace(entries);
      if (!options.preserveStatus) {
        var source = marketplaceSource(marketplaceSnapshot);
        setStatus(source === 'cache'
          ? t('Marketplace is using a verified cached catalog.')
          : t('{count} extensions available in Marketplace', { count: entries.length }), source === 'cache' ? 'warning' : 'neutral');
      }
      return lastMarketplace.slice();
    } catch (error) {
      if (sequence !== marketplaceRefreshSequence) return lastMarketplace.slice();
      marketplaceError = error;
      if (lastMarketplace.length) {
        renderMarketplace(lastMarketplace);
      } else if (elements.marketplaceList) {
        elements.marketplaceList.replaceChildren(renderMarketplaceMessage('error', t('Could not load Marketplace'), marketplaceErrorMessage(error), true));
        elements.marketplaceList.setAttribute('aria-busy', 'false');
      }
      setStatus(t('Could not load Marketplace: {message}', { message: marketplaceErrorMessage(error) }), 'error');
      return lastMarketplace.slice();
    }
  }

  async function installMarketplace(entry) {
    var api = marketplaceApi();
    var state = marketplaceInstallState(entry);
    if (!api || typeof api.install !== 'function' || !state.actionable || !entry || !entry.selected) return;
    setBusy(true);
    setStatus(state.kind === 'update' ? t('Updating Marketplace extension...') : t('Installing Marketplace extension...'), 'neutral');
    try {
      await Promise.resolve(api.install(entry.id));
      await Promise.all([
        refresh({ quiet: true, preserveStatus: true }),
        refreshMarketplace({ quiet: true, preserveStatus: true })
      ]);
      setStatus(state.kind === 'update' ? t('Marketplace extension updated') : t('Marketplace extension installed'), 'success');
    } catch (error) {
      setStatus(t('Could not install Marketplace extension: {message}', { message: marketplaceErrorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    var api = pluginsApi();
    if (!api || typeof api.install !== 'function') return renderUnavailable();
    setBusy(true);
    setStatus(t('Selecting .boboplugin package...'), 'neutral');
    try {
      var result = await Promise.resolve(api.install());
      if (resultWasCancelled(result)) {
        setStatus(t('Plugin installation cancelled'), 'neutral');
        return;
      }
      setActiveView('installed');
      await refresh({ quiet: true, preserveStatus: true });
      setStatus(t('Plugin installed'), 'success');
    } catch (error) {
      setStatus(t('Could not install plugin: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    var api = pluginsApi();
    if (!api || typeof api.openFolder !== 'function') return renderUnavailable();
    setBusy(true);
    try {
      await Promise.resolve(api.openFolder());
      setStatus(t('Extensions folder opened'), 'success');
    } catch (error) {
      setStatus(t('Could not open extensions folder: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshAction() {
    var api = pluginsApi();
    if (!api || typeof api.refresh !== 'function') return Promise.all([refresh(), refreshMarketplace({ force: true })]);
    setBusy(true);
    setStatus(t('Refreshing extensions...'), 'neutral');
    try {
      await Promise.resolve(api.refresh());
      await Promise.all([
        refresh({ quiet: true, preserveStatus: true }),
        refreshMarketplace({ force: true, quiet: true, preserveStatus: true })
      ]);
      setStatus(t('Extensions refreshed'), 'success');
    } catch (error) {
      setStatus(t('Could not load plugins: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function findPlugin(id) {
    return lastPlugins.find(function(plugin) { return plugin.id === id; }) || null;
  }

  async function toggle(plugin, action) {
    var api = pluginsApi();
    var method = action === 'enable' ? 'enable' : 'disable';
    if (!api || typeof api[method] !== 'function') return renderUnavailable();
    setBusy(true);
    try {
      await Promise.resolve(api[method](plugin.id));
      await refresh({ quiet: true, preserveStatus: true });
      setStatus(action === 'enable' ? t('Plugin enabled') : t('Plugin disabled'), 'success');
    } catch (error) {
      setStatus(t('Could not update plugin: {message}', { message: errorMessage(error) }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function reveal(view) {
    cacheElements();
    if (BOBO.workbench && typeof BOBO.workbench.setPrimaryView === 'function') BOBO.workbench.setPrimaryView('extensions');
    setActiveView(view === 'marketplace' ? 'marketplace' : 'installed');
    setTimeout(function() {
      refresh({ quiet: true });
      refreshMarketplace({ quiet: true });
    }, 0);
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    if (elements.activity) elements.activity.addEventListener('click', function() {
      setActiveView(activeView);
      refresh({ quiet: true });
      refreshMarketplace({ quiet: true });
    });
    [elements.install].forEach(function(button) {
      if (button) button.addEventListener('click', install);
    });
    if (elements.openFolder) elements.openFolder.addEventListener('click', openFolder);
    if (elements.refresh) elements.refresh.addEventListener('click', refreshAction);
    [elements.marketplaceTab, elements.installedTab].forEach(function(tab) {
      if (!tab) return;
      tab.addEventListener('click', function() { setActiveView(tab.dataset.extensionView, { focus: false }); });
      tab.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setActiveView(event.key === 'ArrowLeft' ? 'marketplace' : 'installed', { focus: false });
        (event.key === 'ArrowLeft' ? elements.marketplaceTab : elements.installedTab).focus();
      });
    });
    if (elements.search) elements.search.addEventListener('input', function() {
      if (activeView === 'installed') renderList(lastPlugins);
      else renderMarketplace(lastMarketplace);
    });
    if (elements.list) {
      elements.list.addEventListener('click', function(event) {
        var actionButton = event.target.closest('[data-plugin-action]');
        if (actionButton && elements.list.contains(actionButton)) {
          event.stopPropagation();
          var plugin = findPlugin(actionButton.dataset.pluginId);
          if (plugin) toggle(plugin, actionButton.dataset.pluginAction);
          return;
        }
        var item = event.target.closest('.extensions-installed-item[data-plugin-id]');
        if (item && elements.list.contains(item)) openPluginDetails(item.dataset.pluginId);
      });
      elements.list.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var item = event.target.closest('.extensions-installed-item[data-plugin-id]');
        if (!item || event.target.closest('[data-plugin-action]')) return;
        event.preventDefault();
        openPluginDetails(item.dataset.pluginId);
      });
    }
    if (elements.marketplaceList) {
      elements.marketplaceList.addEventListener('click', function(event) {
        var button = event.target.closest('[data-marketplace-action]');
        if (!button || !elements.marketplaceList.contains(button)) return;
        var action = button.dataset.marketplaceAction;
        if (action === 'refresh') {
          refreshMarketplace({ force: true });
          return;
        }
        if (action !== 'install' && action !== 'update') return;
        var entry = lastMarketplace.find(function(candidate) { return candidate.id === button.dataset.packageId; });
        if (entry) installMarketplace(entry);
      });
    }
  }

  function subscribe() {
    if (subscribed) return;
    var api = pluginsApi();
    if (!api || typeof api.onChanged !== 'function') return;
    subscribed = true;
    api.onChanged(function(payload) {
      if (payload && (Array.isArray(payload.plugins) || Array.isArray(payload.items))) {
        renderList(normalizePlugins(payload));
        renderMarketplace(lastMarketplace);
        refreshMarketplace({ quiet: true, preserveStatus: true });
        setStatus(t('Plugins refreshed'), 'neutral');
      } else {
        refresh({ quiet: true });
        refreshMarketplace({ quiet: true, preserveStatus: true });
      }
    });
  }

  function registerCommands() {
    if (commandRegistered || !BOBO.commands || typeof BOBO.commands.register !== 'function') return;
    BOBO.commands.register('plugins.manage', t('Plugins: Manage Installed Plugins'), '', t('Extensions'), function() { reveal('installed'); });
    commandRegistered = true;
  }

  function init() {
    cacheElements();
    bindEvents();
    subscribe();
    if (document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true') registerCommands();
    else if (global.addEventListener) global.addEventListener('bobo:ready', registerCommands, { once: true });
    if (global.api && typeof global.api.onOpenPluginManager === 'function') global.api.onOpenPluginManager(function() { reveal('installed'); });
    if (global.addEventListener) {
      global.addEventListener('bobo:language-changed', function() {
        if (apiAvailable()) renderList(lastPlugins);
        else renderUnavailable();
        if (marketplaceAvailable()) renderMarketplace(marketplaceSnapshot ? normalizeMarketplace(marketplaceSnapshot) : lastMarketplace);
        else renderMarketplaceUnavailable();
      });
    }
    return Promise.all([refresh({ quiet: true }), refreshMarketplace({ quiet: true })]);
  }

  BOBO.pluginManagerUI = {
    init: init,
    open: reveal,
    refresh: refresh,
    refreshMarketplace: refreshMarketplace,
    getPlugins: function() { return lastPlugins.slice(); },
    getMarketplace: function() { return lastMarketplace.slice(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
