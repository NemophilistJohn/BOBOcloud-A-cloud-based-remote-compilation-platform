// Cache Inventory v2 view for Server Storage.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state || {};
  var initialized = false;
  var visible = false;
  var unsubscribe = null;
  var projectNames = {};
  var filters = { scope: 'all', category: 'all' };
  var expandedProjects = Object.create(null);
  var expandedHistory = Object.create(null);
  var details = Object.create(null);

  function byId(id) { return global.document && document.getElementById(id); }
  function t(source, replacements) {
    if (BOBO.i18n && typeof BOBO.i18n.t === 'function') return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(bytes) {
    var value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return Math.round(value) + ' B';
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB';
    return (value / 1073741824).toFixed(2) + ' GB';
  }
  function locale() {
    var active = BOBO.i18n && BOBO.i18n.getActive ? BOBO.i18n.getActive() : 'en';
    return active === 'ja' ? 'ja-JP' : active === 'zh-CN' ? 'zh-CN' : 'en-US';
  }
  function formatDate(value) {
    var timestamp = value && value.lastUsedAtMs != null ? value.lastUsedAtMs : Number(value) || 0;
    if (!timestamp) return t('Never used');
    try {
      return new Intl.DateTimeFormat(locale(), {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (_) {
      return new Date(timestamp).toLocaleString();
    }
  }
  function icon(name) { return BOBO.icons && BOBO.icons[name] || ''; }
  function iconButton(action, iconName, label, attributes, disabled) {
    return '<button type="button" class="cache-v2-icon-btn" data-cache-action="' + esc(action) + '" ' + (attributes || '') +
      ' aria-label="' + esc(label) + '" title="' + esc(label) + '" data-tooltip="' + esc(label) + '"' +
      (disabled ? ' disabled' : '') + '>' + icon(iconName) + '</button>';
  }
  function stateLabel(entry) {
    var labels = {
      current: 'Current', ready: 'Available', superseded: 'Superseded',
      orphaned: 'Orphaned', retired: 'Retired'
    };
    return t(labels[entry.state] || 'Available');
  }
  function categoryLabel(category) {
    var labels = {
      dependencies: 'Dependencies', incremental: 'Incremental builds',
      results: 'Build results', toolchains: 'Toolchains'
    };
    if (BOBO.cacheModel && BOBO.cacheModel.isServiceCategory(category)) return category;
    return t(labels[category] || 'Other cache');
  }
  function categoryIcon(category) {
    if (category === 'dependencies' || category === 'toolchains') return 'package';
    if (category === 'results') return 'fileText';
    if (category === 'incremental') return 'history';
    return 'file';
  }
  function currentContext() {
    var root = String(S.workspaceRoot || '');
    var parts = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return {
      workspaceId: S.workspaceIdentity == null ? '' : String(S.workspaceIdentity),
      folderKey: root && BOBO.projectKey ? BOBO.projectKey(root) : '',
      workspaceName: parts.length ? parts[parts.length - 1] : '',
      runtimeId: String(S.selectedRuntime || '')
    };
  }
  function cacheRoot() { return byId('cache-tree'); }
  function isMutating(storeState, prefix) {
    return Object.keys(storeState.mutations || {}).some(function(key) { return !prefix || key.indexOf(prefix) === 0; });
  }
  function notify(kind, message) {
    if (BOBO.toast && typeof BOBO.toast[kind] === 'function') BOBO.toast[kind](message);
    else if (kind === 'error' && typeof global.alert === 'function') global.alert(message);
  }
  function canDelete(inventory, entry) {
    if (entry.writing) return false;
    if (inventory.capabilities && inventory.capabilities.delete === false) return false;
    return !entry.capabilities || entry.capabilities.delete !== false;
  }
  function detailValue(value) {
    return value ? '<code>' + esc(value) + '</code>' : '<span>' + esc(t('Not available')) + '</span>';
  }
  function renderEntryDetails(entry) {
    var rows = [
      [t('Created'), entry.createdAtMs ? formatDate(entry.createdAtMs) : t('Not available')],
      [t('Runtime fingerprint'), entry.runtimeFingerprint],
      [t('Toolchain fingerprint'), entry.toolchainFingerprint],
      [t('Dependency digest'), entry.dependencyDigest],
      [t('Content digest'), entry.contentDigest],
      [t('Build target'), entry.buildTarget],
      [t('Profile'), entry.profile],
      [t('Generation'), entry.generation]
    ].filter(function(row) { return row[1]; });
    if (!rows.length) return '<div class="cache-v2-detail-empty">' + esc(t('No additional cache details.')) + '</div>';
    return '<dl class="cache-v2-details-grid">' + rows.map(function(row) {
      return '<div><dt>' + esc(row[0]) + '</dt><dd>' + detailValue(row[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }
  function entryTitle(entry) {
    if (entry.category === 'dependencies') return entry.runtimeId || entry.language || t('Dependency set');
    if (entry.category === 'incremental') return entry.buildTarget || entry.runtimeId || t('Incremental build');
    if (entry.category === 'results') return entry.buildTarget || entry.runtimeId || t('Build result');
    if (entry.category === 'toolchains') return entry.runtimeId || entry.language || t('Toolchain');
    return entry.runtimeId || entry.buildTarget || t('Cache entry');
  }
  function entryDigest(entry) {
    var digest = entry.dependencyDigest || entry.contentDigest || entry.toolchainFingerprint || entry.runtimeFingerprint;
    return digest ? digest.slice(0, 12) : '';
  }
  function renderEntry(entry, inventory, storeState, context, serviceOnly) {
    var detailState = details[entry.id];
    var detailEntry = detailState && detailState.entry || entry;
    var detailOpen = Boolean(detailState && detailState.open);
    var detailPanelId = 'cache-v2-detail-' + entry.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    var deleting = Boolean(storeState.mutations['delete:' + entry.id]);
    var deleteAllowed = !serviceOnly && canDelete(inventory, entry);
    var deleteLabel = entry.writing ? t('Cache is being updated') : t('Delete cache entry');
    var manage = !serviceOnly && BOBO.cacheModel.isCurrentEnvironmentEntry(entry, context);
    var meta = [];
    if (entry.language) meta.push('<span>' + esc(entry.language) + '</span>');
    if (entry.runtimeId && entryTitle(entry) !== entry.runtimeId) meta.push('<span>' + esc(entry.runtimeId) + '</span>');
    if (entryDigest(entry)) meta.push('<code>' + esc(entryDigest(entry)) + '</code>');
    if (entry.profile) meta.push('<span>' + esc(entry.profile) + '</span>');

    var status = '<span class="cache-v2-state state-' + esc(entry.state) + '">' + esc(stateLabel(entry)) + '</span>';
    if (entry.writing) status += '<span class="cache-v2-activity writing">' + esc(t('Updating')) + '</span>';
    else if (entry.activeReaders > 0) status += '<span class="cache-v2-activity">' + esc(t('{count} readers', { count: entry.activeReaders })) + '</span>';

    var actions = iconButton('details', detailOpen ? 'eyeOff' : 'eye', detailOpen ? t('Hide cache details') : t('Show cache details'),
      'data-cache-id="' + esc(entry.id) + '" aria-expanded="' + (detailOpen ? 'true' : 'false') + '" aria-controls="' + esc(detailPanelId) + '"',
      Boolean(detailState && detailState.loading));
    if (manage) actions += iconButton('packages', 'package', t('Manage libraries'), 'data-cache-id="' + esc(entry.id) + '"');
    if (!serviceOnly) actions += iconButton('delete', 'trash', deleteLabel,
      'data-cache-id="' + esc(entry.id) + '"', deleting || !deleteAllowed);

    var detailHtml = '';
    if (detailOpen) {
      if (detailState.loading) detailHtml = '<div class="cache-v2-entry-detail" id="' + esc(detailPanelId) + '">' + esc(t('Loading...')) + '</div>';
      else if (detailState.error) detailHtml = '<div class="cache-v2-entry-detail error" id="' + esc(detailPanelId) + '">' + esc(detailState.error) + '</div>';
      else detailHtml = '<div class="cache-v2-entry-detail" id="' + esc(detailPanelId) + '">' + renderEntryDetails(detailEntry) + '</div>';
    }

    return '<div class="cache-v2-entry' + (entry.current ? ' is-current' : '') + (entry.busy ? ' is-busy' : '') + '" data-cache-entry="' + esc(entry.id) + '">' +
      '<div class="cache-v2-entry-main">' +
        '<span class="cache-v2-entry-identity"><strong>' + esc(entryTitle(entry)) + '</strong><small>' + (meta.join('') || esc(t('No cache metadata'))) + '</small></span>' +
        '<span class="cache-v2-entry-status">' + status + '</span>' +
        '<span class="cache-v2-entry-used"><small>' + esc(t('Last used')) + '</small><span>' + esc(formatDate(entry)) + '</span></span>' +
        '<span class="cache-v2-entry-size"><strong>' + fmt(entry.sizeBytes) + '</strong><small>' + esc(t('{count} files', { count: entry.files })) + '</small></span>' +
        '<span class="cache-v2-entry-actions">' + actions + '</span>' +
      '</div>' + detailHtml + '</div>';
  }
  function renderCategory(category, inventory, storeState, context, prefix, serviceOnly) {
    var historyId = prefix + '-history-' + category.category.replace(/[^a-zA-Z0-9_-]/g, '-');
    var historyOpen = Boolean(expandedHistory[historyId]);
    var primary = category.primary.map(function(entry) { return renderEntry(entry, inventory, storeState, context, serviceOnly); }).join('');
    var history = '';
    if (category.history.length) {
      history = '<button type="button" class="cache-v2-history-toggle" data-cache-action="history" data-history-id="' + esc(historyId) +
        '" aria-expanded="' + (historyOpen ? 'true' : 'false') + '" aria-controls="' + esc(historyId) + '">' +
        '<span class="cache-v2-chevron">' + icon('chevronRight') + '</span>' +
        '<span>' + esc(t('History ({count})', { count: category.history.length })) + '</span></button>' +
        '<div class="cache-v2-history' + (historyOpen ? ' open' : '') + '" id="' + esc(historyId) + '">' +
          category.history.map(function(entry) { return renderEntry(entry, inventory, storeState, context, serviceOnly); }).join('') + '</div>';
    }
    return '<section class="cache-v2-category" data-cache-category="' + esc(category.category) + '">' +
      '<header class="cache-v2-category-head"><span>' + icon(categoryIcon(category.category)) + '</span><strong>' + esc(categoryLabel(category.category)) +
      '</strong><small>' + esc(t('{count} entries', { count: category.entries.length })) + ' / ' + fmt(category.sizeBytes) + '</small></header>' +
      '<div class="cache-v2-category-body">' + primary + history + '</div></section>';
  }
  function projectDisplayName(project, context) {
    if (project.name) return project.name;
    if (project.current && context.workspaceName) return context.workspaceName;
    return t('Unattributed project cache');
  }
  function renderProject(project, index, inventory, storeState, context) {
    var expanded = Object.prototype.hasOwnProperty.call(expandedProjects, project.key) ? expandedProjects[project.key] : (project.current || index === 0);
    var panelId = 'cache-v2-project-' + index;
    var clearDisabled = project.busyCount > 0 || isMutating(storeState) || inventory.capabilities.clear === false;
    var clearLabel = project.busyCount ? t('Cache is in use') : t('Clear project cache');
    return '<section class="cache-v2-project' + (project.current ? ' is-current' : '') + '" data-cache-project="' + esc(project.key) + '">' +
      '<div class="cache-v2-project-head">' +
        '<button type="button" class="cache-v2-project-toggle" data-cache-action="project" data-project-key="' + esc(project.key) + '" aria-expanded="' +
          (expanded ? 'true' : 'false') + '" aria-controls="' + panelId + '">' +
          '<span class="cache-v2-chevron">' + icon('chevronRight') + '</span><span class="cache-v2-project-icon">' + icon('folder') + '</span>' +
          '<span class="cache-v2-project-name"><strong>' + esc(projectDisplayName(project, context)) + '</strong><small>' +
            esc(t('{count} cache entries', { count: project.entries.length })) + '</small></span>' +
          (project.current ? '<span class="cache-v2-current-project">' + esc(t('Current project')) + '</span>' : '') +
          '<span class="cache-v2-project-size">' + fmt(project.sizeBytes) + '</span>' +
        '</button>' +
        iconButton('clear-project', 'trash', clearLabel, 'data-workspace-id="' + esc(project.workspaceId) + '" data-project-name="' + esc(projectDisplayName(project, context)) + '"', clearDisabled || !project.workspaceId) +
      '</div>' +
      '<div class="cache-v2-project-body' + (expanded ? ' open' : '') + '" id="' + panelId + '">' +
        project.categories.map(function(category) { return renderCategory(category, inventory, storeState, context, 'project-' + index, false); }).join('') +
      '</div></section>';
  }
  function renderShared(categories, inventory, storeState, context) {
    if (!categories.length) return '';
    return '<section class="cache-v2-section cache-v2-shared"><header class="cache-v2-section-head"><span>' + icon('cloud') + '</span><strong>' +
      esc(t('Shared cache')) + '</strong><small>' + esc(t('{count} types', { count: categories.length })) + '</small></header>' +
      categories.map(function(category, index) { return renderCategory(category, inventory, storeState, context, 'shared-' + index, false); }).join('') + '</section>';
  }
  function renderServices(categories, inventory, storeState, context) {
    if (!categories.length) return '';
    return '<section class="cache-v2-section cache-v2-services"><header class="cache-v2-section-head"><span>' + icon('shield') + '</span><span><strong>' +
      esc(t('Service caches')) + '</strong><small>' + esc(t('Language and debug services are isolated from ordinary caches.')) + '</small></span></header>' +
      categories.map(function(category, index) { return renderCategory(category, inventory, storeState, context, 'service-' + index, true); }).join('') + '</section>';
  }
  function categoryOptions(inventory) {
    var names = Object.create(null);
    BOBO.cacheModel.CATEGORY_ORDER.forEach(function(category) { names[category] = true; });
    inventory.entries.forEach(function(entry) { if (!entry.service) names[entry.category] = true; });
    return Object.keys(names).sort(function(a, b) {
      var order = BOBO.cacheModel.CATEGORY_ORDER;
      var ai = order.indexOf(a); var bi = order.indexOf(b);
      ai = ai < 0 ? order.length : ai; bi = bi < 0 ? order.length : bi;
      return ai - bi || a.localeCompare(b);
    });
  }
  function normalTotals(grouped) {
    var categories = grouped.projects.reduce(function(all, project) { return all.concat(project.categories); }, []).concat(grouped.shared);
    return categories.reduce(function(total, category) {
      total.entries += category.entries.length;
      total.sizeBytes += category.sizeBytes;
      total.current += category.currentCount;
      total.history += category.history.length;
      total.busy += category.busyCount;
      return total;
    }, { entries: 0, sizeBytes: 0, current: 0, history: 0, busy: 0 });
  }
  function renderReady(storeState) {
    var inventory = storeState.inventory;
    var context = currentContext();
    var grouped = BOBO.cacheModel.groupInventory(inventory, { filters: filters, context: context, projectNames: projectNames });
    var totals = normalTotals(grouped);
    var quota = inventory.quotaBytes;
    var accountUsed = inventory.usedBytes;
    var managed = inventory.raw && inventory.raw.managed_bytes != null ? inventory.managedBytes : totals.sizeBytes;
    var percent = quota > 0 ? Math.min(100, Math.round(accountUsed / quota * 100)) : 0;
    var categories = categoryOptions(inventory);
    var scopeOptions = [
      ['all', t('All cache')], ['current', t('Current project')], ['shared', t('Shared cache')]
    ];
    if (inventory.entries.some(function(entry) { return entry.service; })) scopeOptions.push(['services', t('Service caches')]);
    var clearDisabled = filters.scope === 'services' || totals.entries === 0 || totals.busy > 0 || isMutating(storeState) || inventory.capabilities.clear === false;
    var clearLabel = filters.scope === 'services' ? t('Service caches are managed separately') : totals.busy > 0 ? t('Cache is in use') : t('Clear selected cache');
    var warning = '';
    if (inventory.scanTruncated) warning += '<div class="cache-v2-notice warning">' + esc(t('The cache scan was truncated. Totals may be incomplete.')) + '</div>';
    if (inventory.invalidEntries) warning += '<div class="cache-v2-notice warning">' + esc(t('{count} invalid cache entries were omitted.', { count: inventory.invalidEntries })) + '</div>';

    var html = '<div class="cache-v2-shell">' +
      '<div class="cache-v2-overview">' +
        '<div class="cache-v2-usage"><span><small>' + esc(t('Cache storage')) + '</small><strong>' + fmt(managed) + '</strong></span>' +
          '<div class="cache-v2-meter" role="progressbar" aria-label="' + esc(t('Account storage quota')) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + percent + '%"></span></div>' +
          '<small>' + esc(quota ? t('Account storage {used} / {quota}', { used: fmt(accountUsed), quota: fmt(quota) }) : t('Account storage {used}', { used: fmt(accountUsed) })) +
          (inventory.reservedBytes ? ' · ' + esc(t('{size} reserved', { size: fmt(inventory.reservedBytes) })) : '') +
          (inventory.reclaimableBytes ? ' · ' + esc(t('{size} reclaimable', { size: fmt(inventory.reclaimableBytes) })) : '') + '</small></div>' +
        '<div class="cache-v2-metrics"><span><strong>' + totals.entries + '</strong><small>' + esc(t('Entries')) + '</small></span>' +
          '<span><strong>' + totals.current + '</strong><small>' + esc(t('Current')) + '</small></span>' +
          '<span><strong>' + totals.history + '</strong><small>' + esc(t('History')) + '</small></span>' +
          '<span class="' + (totals.busy ? 'active' : '') + '"><strong>' + totals.busy + '</strong><small>' + esc(t('In use')) + '</small></span></div>' +
      '</div>' +
      '<div class="cache-v2-toolbar">' +
        '<label><span class="cache-v2-sr-only">' + esc(t('Cache scope')) + '</span><select id="cache-v2-scope" aria-label="' + esc(t('Cache scope')) + '">' +
          scopeOptions.map(function(option) { return '<option value="' + option[0] + '"' + (filters.scope === option[0] ? ' selected' : '') + '>' + esc(option[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label><span class="cache-v2-sr-only">' + esc(t('Cache type')) + '</span><select id="cache-v2-category" aria-label="' + esc(t('Cache type')) + '">' +
          '<option value="all">' + esc(t('All cache types')) + '</option>' + categories.map(function(category) {
            return '<option value="' + esc(category) + '"' + (filters.category === category ? ' selected' : '') + '>' + esc(categoryLabel(category)) + '</option>';
          }).join('') + '</select></label>' +
        '<span class="cache-v2-toolbar-spacer"></span>' +
        iconButton('refresh', 'history', t('Refresh cache inventory'), '', storeState.status === 'refreshing' || isMutating(storeState)) +
        iconButton('clear', 'trash', clearLabel, '', clearDisabled) +
      '</div>' + warning +
      '<div class="cache-v2-content">';

    if (grouped.projects.length) {
      html += '<section class="cache-v2-section"><header class="cache-v2-section-head"><span>' + icon('folderOpen') + '</span><strong>' + esc(t('Project caches')) +
        '</strong><small>' + esc(t('{count} projects', { count: grouped.projects.length })) + '</small></header>' +
        grouped.projects.map(function(project, index) { return renderProject(project, index, inventory, storeState, context); }).join('') + '</section>';
    }
    html += renderShared(grouped.shared, inventory, storeState, context);
    html += renderServices(grouped.services, inventory, storeState, context);
    if (!grouped.projects.length && !grouped.shared.length && !grouped.services.length) {
      html += '<div class="cache-v2-empty"><span>' + icon('package') + '</span><strong>' + esc(t('No matching cache entries.')) + '</strong><small>' +
        esc(t('Run or build this project to populate its cache.')) + '</small></div>';
    }
    return html + '</div></div>';
  }
  function render() {
    var root = cacheRoot();
    if (!root || !BOBO.cacheStore) return;
    var state = BOBO.cacheStore.getState();
    if ((state.status === 'loading' || state.status === 'idle') && !state.inventory) {
      root.innerHTML = '<div class="cache-v2-status"><span class="cache-v2-spinner" aria-hidden="true"></span><strong>' + esc(t('Loading cache inventory...')) + '</strong></div>';
      return;
    }
    if (state.status === 'error' && !state.inventory) {
      root.innerHTML = '<div class="cache-v2-status error"><strong>' + esc(t('Cache inventory is unavailable.')) + '</strong><small>' + esc(state.error && state.error.message || t('Failed to load')) + '</small>' +
        iconButton('refresh', 'history', t('Try again'), '', false) + '</div>';
      return;
    }
    if (!state.inventory) {
      root.innerHTML = '<div class="cache-v2-status"><strong>' + esc(t('No cache inventory.')) + '</strong></div>';
      return;
    }
    root.innerHTML = renderReady(state);
  }
  async function showDetails(cacheId) {
    var current = details[cacheId];
    if (current && current.open) {
      current.open = false;
      render();
      return;
    }
    details[cacheId] = { open: true, loading: true, entry: current && current.entry || null, error: '' };
    render();
    try {
      var entry = await BOBO.cacheStore.getEntry(cacheId);
      if (details[cacheId]) details[cacheId] = { open: true, loading: false, entry: entry, error: '' };
    } catch (error) {
      if (details[cacheId]) details[cacheId] = { open: true, loading: false, entry: null, error: error.message };
    }
    render();
  }
  async function deleteEntry(cacheId) {
    var inventory = BOBO.cacheStore.getState().inventory;
    var entry = inventory && inventory.entries.find(function(candidate) { return candidate.id === cacheId; });
    if (!entry || !canDelete(inventory, entry)) return;
    var message = t('Delete "{name}" from this cache?', { name: entryTitle(entry) }) + '\n' + t('The complete cache entry and its registration will be removed. This cannot be undone.');
    if (entry.activeReaders > 0) message += '\n' + t('{count} active readers may need to restart.', { count: entry.activeReaders });
    var confirmed = await BOBO.confirm({ title: t('Delete cache entry'), message: message, confirmLabel: t('Delete'), danger: true });
    if (!confirmed) return;
    try {
      await BOBO.cacheStore.deleteEntry(cacheId);
      delete details[cacheId];
      notify('success', t('Cache entry deleted.'));
    } catch (error) {
      notify('error', error.message || t('Failed to delete cache entry.'));
    }
  }
  function filteredClearRequest(workspaceId) {
    var request;
    if (workspaceId) request = { scope: 'workspace', workspaceId: workspaceId };
    else if (filters.scope === 'shared') request = { scope: 'shared' };
    else if (filters.scope === 'current') {
      var grouped = BOBO.cacheModel.groupInventory(BOBO.cacheStore.getState().inventory, { context: currentContext() });
      var currentProject = grouped.projects.find(function(project) { return project.current && project.workspaceId; });
      if (!currentProject) return null;
      request = { scope: 'workspace', workspaceId: currentProject.workspaceId };
    } else request = { scope: 'owner' };
    if (filters.category !== 'all') request.category = filters.category;
    return request;
  }
  async function clearCache(workspaceId, projectName) {
    var request = filteredClearRequest(workspaceId);
    if (!request) return;
    var target = projectName || (request.scope === 'shared' ? t('Shared cache') : request.scope === 'workspace' ? t('Current project') : t('All cache'));
    if (request.category) target += ' / ' + categoryLabel(request.category);
    var first = await BOBO.confirm({
      title: t('Clear selected cache'),
      message: t('Clear {target}?', { target: target }) + '\n' + t('Active cache operations must finish before removal.'),
      confirmLabel: t('Continue'), danger: true
    });
    if (!first) return;
    var second = await BOBO.confirm({
      title: t('Confirm permanent cache removal'),
      message: t('This removes cache files and their inventory records together. This cannot be undone.'),
      confirmLabel: t('Clear cache'), danger: true
    });
    if (!second) return;
    try {
      await BOBO.cacheStore.clearScope(request);
      details = Object.create(null);
      notify('success', t('Selected cache cleared.'));
    } catch (error) {
      notify('error', error.message || t('Failed to clear cache.'));
    }
  }
  function managePackages() {
    if (BOBO.projects && typeof BOBO.projects.close === 'function') BOBO.projects.close();
    if (BOBO.workbench && typeof BOBO.workbench.setPrimaryView === 'function') BOBO.workbench.setPrimaryView('environment');
    if (BOBO.packageCenter && typeof BOBO.packageCenter.open === 'function') BOBO.packageCenter.open({ mode: 'installed' });
  }
  function onClick(event) {
    var button = event.target.closest && event.target.closest('[data-cache-action]');
    if (!button || button.disabled) return;
    var action = button.dataset.cacheAction;
    if (action === 'refresh') BOBO.cacheStore.load({ force: true }).catch(function(error) { notify('error', error.message); });
    else if (action === 'project') {
      var key = button.dataset.projectKey;
      expandedProjects[key] = button.getAttribute('aria-expanded') !== 'true';
      render();
    } else if (action === 'history') {
      var id = button.dataset.historyId;
      expandedHistory[id] = button.getAttribute('aria-expanded') !== 'true';
      render();
    } else if (action === 'details') showDetails(button.dataset.cacheId);
    else if (action === 'delete') deleteEntry(button.dataset.cacheId);
    else if (action === 'clear') clearCache('', '');
    else if (action === 'clear-project') clearCache(button.dataset.workspaceId, button.dataset.projectName);
    else if (action === 'packages') managePackages();
  }
  function onChange(event) {
    if (event.target.id === 'cache-v2-scope') filters.scope = event.target.value;
    else if (event.target.id === 'cache-v2-category') filters.category = event.target.value;
    else return;
    render();
  }
  function init() {
    if (initialized) return;
    initialized = true;
    var root = cacheRoot();
    if (!root || !BOBO.cacheStore) return;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    unsubscribe = BOBO.cacheStore.subscribe(function() { render(); });
    global.addEventListener('bobo:language-changed', render);
  }
  function setVisible(value) {
    visible = Boolean(value);
    if (!initialized) init();
    if (BOBO.cacheStore) BOBO.cacheStore.setActive(visible);
  }
  function load(options) {
    if (!initialized) init();
    return BOBO.cacheStore ? BOBO.cacheStore.load(options || {}) : Promise.resolve(null);
  }
  function setProjectNames(names) {
    projectNames = Object.assign({}, names || {});
    if (visible) render();
  }
  function dispose() {
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    initialized = false;
  }

  BOBO.cacheCenter = {
    init: init,
    load: load,
    render: render,
    setVisible: setVisible,
    setProjectNames: setProjectNames,
    dispose: dispose,
    getFilters: function() { return Object.assign({}, filters); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
