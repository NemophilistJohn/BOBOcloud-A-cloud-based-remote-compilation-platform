// Cache inventory v2 normalization and grouping.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  var SCHEMA_VERSION = 2;
  var CATEGORY_ORDER = ['dependencies', 'incremental', 'results', 'toolchains'];
  var HISTORY_STATES = Object.freeze({ superseded: true, orphaned: true, retired: true });
  var SERVICE_CATEGORY_PATTERN = /(^|[-_.])(lsp|dap|analysis|debug)([-_.]|$)/i;

  function finiteNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function text(value) {
    return value == null ? '' : String(value);
  }

  function timestamp(value) {
    if (!value) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    var parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeCapabilities(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.assign({}, value);
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = text(raw.id).trim();
    var category = text(raw.category).trim().toLowerCase();
    if (!id || !category) return null;

    var state = text(raw.state || 'ready').trim().toLowerCase();
    var activeReaders = Math.max(0, Math.floor(finiteNumber(raw.active_readers)));
    var writing = raw.writing === true;
    var entry = {
      schema: Number(raw.schema || SCHEMA_VERSION),
      id: id,
      category: category,
      state: state,
      workspaceId: text(raw.workspace_id),
      workspaceName: text(raw.workspace_name),
      runtimeId: text(raw.runtime_id),
      runtimeFingerprint: text(raw.runtime_fingerprint),
      toolchainFingerprint: text(raw.toolchain_fingerprint),
      language: text(raw.language).toLowerCase(),
      dependencyDigest: text(raw.dependency_digest),
      contentDigest: text(raw.content_digest),
      sourcePolicyDigest: text(raw.source_policy_digest),
      buildTarget: text(raw.build_target),
      profile: text(raw.profile),
      generation: text(raw.generation),
      sizeBytes: finiteNumber(raw.size_bytes),
      files: Math.max(0, Math.floor(finiteNumber(raw.files))),
      createdAt: text(raw.created_at),
      createdAtMs: timestamp(raw.created_at),
      lastUsedAt: text(raw.last_used_at),
      lastUsedAtMs: timestamp(raw.last_used_at),
      activeReaders: activeReaders,
      writing: writing,
      lifecycle: raw.lifecycle == null ? null : raw.lifecycle,
      capabilities: normalizeCapabilities(raw.capabilities),
      raw: raw
    };
    entry.current = state === 'current';
    entry.history = Boolean(HISTORY_STATES[state]);
    entry.busy = writing || activeReaders > 0;
    entry.service = isServiceCategory(category);
    return entry;
  }

  function normalizeInventory(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw protocolError('Cache inventory is missing.');
    }
    if (Number(raw.schema) !== SCHEMA_VERSION) {
      throw protocolError('Unsupported cache inventory schema.');
    }

    var invalidEntries = 0;
    var entries = [];
    (Array.isArray(raw.entries) ? raw.entries : []).forEach(function(source) {
      var entry = normalizeEntry(source);
      if (entry) entries.push(entry);
      else invalidEntries += 1;
    });

    return {
      schema: SCHEMA_VERSION,
      ownerKind: text(raw.owner_kind),
      ownerId: text(raw.owner_id),
      quotaBytes: finiteNumber(raw.quota_bytes),
      usedBytes: finiteNumber(raw.used_bytes),
      managedBytes: finiteNumber(raw.managed_bytes),
      managedFiles: Math.max(0, Math.floor(finiteNumber(raw.managed_files))),
      reclaimableBytes: finiteNumber(raw.reclaimable_bytes),
      reservedBytes: finiteNumber(raw.reserved_bytes),
      quotaFiles: Math.max(0, Math.floor(finiteNumber(raw.quota_files))),
      usedFiles: Math.max(0, Math.floor(finiteNumber(raw.used_files))),
      reservedFiles: Math.max(0, Math.floor(finiteNumber(raw.reserved_files))),
      scanTruncated: raw.scan_truncated === true,
      generatedAt: text(raw.generated_at),
      generatedAtMs: timestamp(raw.generated_at),
      revision: raw.revision == null ? '' : text(raw.revision),
      lifecycle: raw.lifecycle == null ? null : raw.lifecycle,
      capabilities: normalizeCapabilities(raw.capabilities),
      invalidEntries: invalidEntries,
      entries: entries,
      raw: raw
    };
  }

  function protocolError(message) {
    var error = new Error(message);
    error.code = 'cache_inventory_protocol_error';
    return error;
  }

  function isServiceCategory(category) {
    return SERVICE_CATEGORY_PATTERN.test(text(category));
  }

  function categoryRank(category) {
    var index = CATEGORY_ORDER.indexOf(category);
    return index < 0 ? CATEGORY_ORDER.length : index;
  }

  function entryActivityRank(entry) {
    if (entry.writing) return 4;
    if (entry.activeReaders > 0) return 3;
    if (entry.current) return 2;
    if (!entry.history) return 1;
    return 0;
  }

  function compareEntries(a, b) {
    var activity = entryActivityRank(b) - entryActivityRank(a);
    if (activity) return activity;
    var used = b.lastUsedAtMs - a.lastUsedAtMs;
    if (used) return used;
    var size = b.sizeBytes - a.sizeBytes;
    if (size) return size;
    return a.id.localeCompare(b.id);
  }

  function compareCategories(a, b) {
    var rank = categoryRank(a.category) - categoryRank(b.category);
    return rank || a.category.localeCompare(b.category);
  }

  function workspaceMatches(entry, context) {
    context = context || {};
    var workspaceId = text(entry && entry.workspaceId);
    if (!workspaceId) return false;
    var candidates = [context.workspaceId, context.folderKey]
      .map(text)
      .filter(Boolean);
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (workspaceId === candidate || workspaceId.endsWith('\u0000' + candidate) || workspaceId.endsWith(':' + candidate)) return true;
    }
    return false;
  }

  function isCurrentEnvironmentEntry(entry, context) {
    if (!entry || entry.category !== 'dependencies' || !entry.current) return false;
    if (!workspaceMatches(entry, context)) return false;
    var runtimeId = text(context && context.runtimeId);
    return Boolean(runtimeId && entry.runtimeId === runtimeId);
  }

  function newCategory(category) {
    return {
      category: category,
      entries: [],
      primary: [],
      history: [],
      sizeBytes: 0,
      files: 0,
      busyCount: 0,
      currentCount: 0
    };
  }

  function addToCategory(category, entry) {
    category.entries.push(entry);
    category.sizeBytes += entry.sizeBytes;
    category.files += entry.files;
    if (entry.busy) category.busyCount += 1;
    if (entry.current) category.currentCount += 1;
    if (entry.history) category.history.push(entry);
    else category.primary.push(entry);
  }

  function finalizeCategories(categoryMap) {
    return Object.keys(categoryMap).map(function(categoryName) {
      var category = categoryMap[categoryName];
      category.entries.sort(compareEntries);
      category.primary.sort(compareEntries);
      category.history.sort(compareEntries);
      return category;
    }).sort(compareCategories);
  }

  function projectKey(entry) {
    if (entry.workspaceId) return 'workspace:' + entry.workspaceId;
    return 'unattributed:' + (entry.workspaceName || entry.id);
  }

  function addProjectEntry(projectsByKey, entry, context, projectNames) {
    var key = projectKey(entry);
    var project = projectsByKey[key];
    if (!project) {
      var mappedName = entry.workspaceId && projectNames && projectNames[entry.workspaceId];
      project = projectsByKey[key] = {
        key: key,
        workspaceId: entry.workspaceId,
        name: entry.workspaceName || mappedName || '',
        current: workspaceMatches(entry, context),
        categoriesByName: Object.create(null),
        categories: [],
        entries: [],
        sizeBytes: 0,
        files: 0,
        busyCount: 0,
        currentCount: 0,
        historyCount: 0,
        lastUsedAtMs: 0
      };
    }
    if (!project.name && entry.workspaceName) project.name = entry.workspaceName;
    project.entries.push(entry);
    project.sizeBytes += entry.sizeBytes;
    project.files += entry.files;
    if (entry.busy) project.busyCount += 1;
    if (entry.current) project.currentCount += 1;
    if (entry.history) project.historyCount += 1;
    project.lastUsedAtMs = Math.max(project.lastUsedAtMs, entry.lastUsedAtMs);
    var category = project.categoriesByName[entry.category];
    if (!category) category = project.categoriesByName[entry.category] = newCategory(entry.category);
    addToCategory(category, entry);
  }

  function compareProjects(a, b) {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (Boolean(a.busyCount) !== Boolean(b.busyCount)) return a.busyCount ? -1 : 1;
    if (Boolean(a.currentCount) !== Boolean(b.currentCount)) return a.currentCount ? -1 : 1;
    if (b.lastUsedAtMs !== a.lastUsedAtMs) return b.lastUsedAtMs - a.lastUsedAtMs;
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return (a.name || a.workspaceId).localeCompare(b.name || b.workspaceId);
  }

  function includeEntry(entry, filters, context) {
    filters = filters || {};
    if (filters.category && filters.category !== 'all' && entry.category !== filters.category) return false;
    if (filters.scope === 'current' && !workspaceMatches(entry, context)) return false;
    if (filters.scope === 'projects' && (!entry.workspaceId && !entry.workspaceName || entry.service)) return false;
    if (filters.scope === 'shared' && (entry.workspaceId || entry.workspaceName || entry.service)) return false;
    if (filters.scope === 'services' && !entry.service) return false;
    return true;
  }

  function groupInventory(inventory, options) {
    options = options || {};
    var filters = options.filters || {};
    var context = options.context || {};
    var projectNames = options.projectNames || {};
    var projectsByKey = Object.create(null);
    var sharedByCategory = Object.create(null);
    var servicesByCategory = Object.create(null);
    var totals = {
      entries: 0,
      current: 0,
      available: 0,
      history: 0,
      busy: 0,
      writing: 0,
      sizeBytes: 0,
      files: 0
    };

    (inventory && Array.isArray(inventory.entries) ? inventory.entries : []).forEach(function(entry) {
      if (!includeEntry(entry, filters, context)) return;
      totals.entries += 1;
      totals.sizeBytes += entry.sizeBytes;
      totals.files += entry.files;
      if (entry.current) totals.current += 1;
      else if (entry.history) totals.history += 1;
      else totals.available += 1;
      if (entry.busy) totals.busy += 1;
      if (entry.writing) totals.writing += 1;

      if (entry.service) {
        if (!servicesByCategory[entry.category]) servicesByCategory[entry.category] = newCategory(entry.category);
        addToCategory(servicesByCategory[entry.category], entry);
      } else if (entry.workspaceId || entry.workspaceName) {
        addProjectEntry(projectsByKey, entry, context, projectNames);
      } else {
        if (!sharedByCategory[entry.category]) sharedByCategory[entry.category] = newCategory(entry.category);
        addToCategory(sharedByCategory[entry.category], entry);
      }
    });

    var projects = Object.keys(projectsByKey).map(function(key) {
      var project = projectsByKey[key];
      project.categories = finalizeCategories(project.categoriesByName);
      delete project.categoriesByName;
      project.entries.sort(compareEntries);
      return project;
    }).sort(compareProjects);

    return {
      projects: projects,
      shared: finalizeCategories(sharedByCategory),
      services: finalizeCategories(servicesByCategory),
      totals: totals
    };
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    CATEGORY_ORDER: CATEGORY_ORDER.slice(),
    HISTORY_STATES: HISTORY_STATES,
    normalizeEntry: normalizeEntry,
    normalizeInventory: normalizeInventory,
    groupInventory: groupInventory,
    compareEntries: compareEntries,
    workspaceMatches: workspaceMatches,
    isCurrentEnvironmentEntry: isCurrentEnvironmentEntry,
    isServiceCategory: isServiceCategory
  };

  BOBO.cacheModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
