// src/projects.js - Server project & cache management panel
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function $(id) { return document.getElementById(id); }
  function t(source, replacements) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source, replacements) : source;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 字节 → 人类可读
  function fmt(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  var PROJECT_COLORS = [
    '#61afef', '#98c379', '#e5c07b', '#c678dd',
    '#e06c75', '#56b6c2', '#d19a66', '#ff6b9d',
    '#7ee787', '#79c0ff', '#f0883e', '#a371f7'
  ];
  var LANG_COLORS = {
    python: '#61afef', go: '#56b6c2', rust: '#e06c75',
    java: '#e5c07b', analysis: '#c678dd', other: '#abb2bf'
  };
  var FREE_COLOR = 'rgba(255,255,255,0.06)';

  function cacheActivityRank(entry) {
    if (entry && entry.writing) return 2;
    return entry && entry.active ? 1 : 0;
  }

  function compareCacheEntries(a, b) {
    if (cacheActivityRank(a) !== cacheActivityRank(b)) return cacheActivityRank(b) - cacheActivityRank(a);
    if ((b.last_used || 0) !== (a.last_used || 0)) return (b.last_used || 0) - (a.last_used || 0);
    if ((b.size_bytes || 0) !== (a.size_bytes || 0)) return (b.size_bytes || 0) - (a.size_bytes || 0);
    return String(a.name || '').localeCompare(String(b.name || ''));
  }

  function resolveProjectDisplayName(project, names) {
    project = project || {};
    names = names || {};
    var serverName = project.name && project.name !== project.key ? project.name : '';
    return serverName || names[project.key] || project.key || '';
  }

  function organizeCacheGroups(cacheGroups) {
    var projectsByKey = Object.create(null);
    var projectOrder = [];
    var shared = [];
    var totalBytes = 0;
    var activeCount = 0;
    var writingCount = 0;
    var analysisCount = 0;
    var snapshotCount = 0;
    var itemCount = 0;

    (Array.isArray(cacheGroups) ? cacheGroups : []).forEach(function(group) {
      (Array.isArray(group.modules) ? group.modules : []).forEach(function(source) {
        var entry = Object.assign({}, source, {
          language: group.language || 'other',
          language_label: group.label || group.language || 'Other'
        });
        var size = Number(entry.size_bytes) || 0;
        totalBytes += Math.max(0, size);
        itemCount += 1;
        if (entry.writing || entry.active) activeCount += 1;
        if (entry.writing) writingCount += 1;
        else if (entry.active) analysisCount += 1;

        if (entry.kind !== 'project-dependency') {
          shared.push(entry);
          return;
        }

        snapshotCount += 1;
        var workspaceID = String(entry.workspace_id || '');
        var projectName = String(entry.project_name || entry.name || '');
        var key = workspaceID ? 'workspace:' + workspaceID : 'name:' + (projectName || '__unattributed__');
        var project = projectsByKey[key];
        if (!project) {
          project = projectsByKey[key] = {
            key: key,
            workspaceID: workspaceID,
            name: projectName,
            orphaned: Boolean(entry.orphaned || (!workspaceID && !projectName)),
            entries: [],
            sizeBytes: 0,
            activeCount: 0,
            writingCount: 0,
            analysisCount: 0,
            lastUsed: 0
          };
          projectOrder.push(project);
        }
        project.entries.push(entry);
        project.sizeBytes += Math.max(0, size);
        if (entry.writing || entry.active) project.activeCount += 1;
        if (entry.writing) project.writingCount += 1;
        else if (entry.active) project.analysisCount += 1;
        project.lastUsed = Math.max(project.lastUsed, Number(entry.last_used) || 0);
        project.orphaned = project.orphaned || Boolean(entry.orphaned);
      });
    });

    projectOrder.forEach(function(project) { project.entries.sort(compareCacheEntries); });
    projectOrder.sort(function(a, b) {
      if (Boolean(a.writingCount) !== Boolean(b.writingCount)) return a.writingCount ? -1 : 1;
      if (Boolean(a.activeCount) !== Boolean(b.activeCount)) return a.activeCount ? -1 : 1;
      if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
      if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    shared.sort(compareCacheEntries);

    return {
      projects: projectOrder,
      shared: shared,
      totalBytes: totalBytes,
      activeCount: activeCount,
      writingCount: writingCount,
      analysisCount: analysisCount,
      snapshotCount: snapshotCount,
      itemCount: itemCount
    };
  }

  // ──── Modal ────
  var projectNamesLoadVersion = 0;
  var projectsLoadVersion = 0;
  var cacheLoadVersion = 0;
  var cacheMutationPaths = Object.create(null);

  function projectViewIdentity() {
    var user = S.auth && S.auth.user ? S.auth.user : {};
    return [S.serverSettings.ip || '', S.auth.token || '', user.id || user.uid || ''].join('\n');
  }

  function projectsModalOpen() {
    return Boolean($('projects-modal') && $('projects-modal').classList.contains('open'));
  }

  function open() {
    // 清除可能残留的旧提示条幅
    var oldBanner = document.getElementById('quota-warn-banner');
    if (oldBanner) oldBanner.remove();
    $('projects-modal').classList.add('open');
    loadAll();
  }
  function close() {
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    cacheLoadVersion += 1;
    $('projects-modal').classList.remove('open');
  }

  function switchTab(name) {
    document.querySelectorAll('.projects-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.ptab === name);
    });
    document.querySelectorAll('.projects-pane').forEach(function(p) {
      p.classList.toggle('active', p.id === 'projects-pane-' + name);
    });
  }

  // ──── Load all data ────
  var localProjectNames = {}; // folderKey -> projectName 本地映射

  async function loadAll() {
    var requestVersion = ++projectNamesLoadVersion;
    var requestIdentity = projectViewIdentity();
    // 读取本地项目名映射
    var names;
    try { names = await window.api.readProjectNames() || {}; } catch (e) { names = {}; }
    if (requestVersion !== projectNamesLoadVersion || requestIdentity !== projectViewIdentity() || !projectsModalOpen()) return;
    localProjectNames = names;
    await Promise.all([loadProjects(), loadCache()]);
  }

  // ──── Projects tab ────
  async function loadProjects() {
    var requestVersion = ++projectsLoadVersion;
    var requestIdentity = projectViewIdentity();
    var summaryEl = $('projects-summary');
    var pieEl = $('quota-pie');
    var pieCenter = $('quota-pie-center');
    var pieText = $('quota-pie-text');
    var listEl = $('projects-list');

    summaryEl.textContent = 'Loading...';
    pieEl.style.background = '';
    pieCenter.textContent = '...';
    pieText.textContent = '';
    listEl.innerHTML = '<div class="projects-loading">Loading…</div>';

    var res = await BOBO.sendToServer('listProjects', {}, { quiet: true });
    if (requestVersion !== projectsLoadVersion || requestIdentity !== projectViewIdentity() || !projectsModalOpen()) return;
    if (!res || !res.success || !res.storageInfo) {
      var err = (res && res.error) || 'Failed to load';
      summaryEl.textContent = err;
      listEl.innerHTML = '<div class="projects-empty">' + esc(err) + '</div>';
      return;
    }

    var info = res.storageInfo;
    var totalUsed = info.total_used_bytes || 0;
    var quotaBytes = info.quota_bytes || 0;
    var persistBytes = info.persist_bytes || 0;
    var projectsTotal = info.projects_total_bytes || 0;
    var projects = info.projects || [];

    // 按大小降序
    projects.sort(function(a, b) {
      return (b.size_bytes || 0) - (a.size_bytes || 0);
    });
    projects.forEach(function(p, i) {
      p._color = PROJECT_COLORS[i % PROJECT_COLORS.length];
    });

    // 用当前工作区名称补充本地映射（无需等待同步）
    if (S.workspaceRoot) {
      var curName = S.workspaceRoot.split(/[/\\]/).pop();
      var curKey = BOBO.projectKey ? BOBO.projectKey(S.workspaceRoot) : '';
      if (curKey && curName && !localProjectNames[curKey]) {
        localProjectNames[curKey] = curName;
        try { window.api.saveProjectName(curKey, curName); } catch (e) {}
      }
    }

    // ── 顶部摘要 ──
    if (quotaBytes > 0) {
      var pct = Math.min(100, Math.round(totalUsed / quotaBytes * 100));
      var cls = pct >= 90 ? 'warn' : '';
      summaryEl.innerHTML =
        '<span class="storage-big ' + cls + '">' + fmt(totalUsed) + '</span>' +
        ' / ' + fmt(quotaBytes) +
        ' <span class="storage-pct ' + cls + '">(' + pct + '%)</span>' +
        '<div class="storage-bar">' +
          '<div class="storage-bar-fill ' + cls + '" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<div class="storage-sub">Projects ' + fmt(projectsTotal) +
        ' · Cache ' + fmt(persistBytes) +
        (quotaBytes > totalUsed ? ' · Free ' + fmt(quotaBytes - totalUsed) : '') +
        '</div>';
    } else {
      summaryEl.innerHTML =
        '<span class="storage-big">' + fmt(totalUsed) + '</span> used' +
        '<div class="storage-bar">' +
          '<div class="storage-bar-fill" style="width:100%"></div>' +
        '</div>' +
        '<div class="storage-sub">Projects ' + fmt(projectsTotal) +
        ' · Cache ' + fmt(persistBytes) + ' · No quota limit</div>';
    }

    // ── 饼图（分母 = 项目总大小，纯项目占比，无灰色）──
    if (projectsTotal > 0) {
      var segs = [];
      var cursor = 0;
      for (var i = 0; i < projects.length; i++) {
        var sz = projects[i].size_bytes || 0;
        if (sz <= 0) continue;
        var p = sz / projectsTotal * 100;
        segs.push(projects[i]._color + ' ' + cursor.toFixed(2) + '% ' + (cursor + p).toFixed(2) + '%');
        cursor += p;
      }
      // 最后一段强制到 100%，消除灰色间隙
      if (segs.length > 0) {
        var last = segs[segs.length - 1].split(' ');
        last[last.length - 1] = '100%';
        segs[segs.length - 1] = last.join(' ');
      }
      pieEl.style.background = 'conic-gradient(' + segs.join(', ') + ')';
      pieCenter.innerHTML = projects.length + '<span style="font-size:9px;opacity:0.6">proj</span>';
      pieText.innerHTML = '<div style="font-weight:600;color:var(--text)">' + fmt(projectsTotal) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim)">total project size</div>';
    } else {
      pieEl.style.background = 'conic-gradient(' + FREE_COLOR + ' 0% 100%)';
      pieCenter.textContent = '—';
      pieText.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">No project data</div>';
    }

    // ── 项目列表 ──
    if (projects.length === 0) {
      listEl.innerHTML = '<div class="projects-empty">No projects on server yet.</div>';
      return;
    }

    var html = '<table class="admin-table"><thead><tr>' +
      '<th>Project</th><th>Size</th><th>Files</th><th>Modified</th><th></th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      // A server fallback equal to the opaque key is not a display name. This
      // also lets older deployments recover from the client's durable mapping.
      var displayName = resolveProjectDisplayName(p, localProjectNames);
      var modTime = p.mod_time ? new Date(p.mod_time * 1000).toLocaleDateString() : '-';
      var pctStr = projectsTotal > 0 ? ((p.size_bytes || 0) / projectsTotal * 100).toFixed(1) + '%' : '';
      html += '<tr>' +
        '<td>' +
          '<span class="proj-dot" style="background:' + p._color + '"></span>' +
          '<code>' + esc(displayName) + '</code>' +
          (pctStr ? '<span class="proj-pct">' + pctStr + '</span>' : '') +
        '</td>' +
        '<td>' + fmt(p.size_bytes || 0) + '</td>' +
        '<td class="dim">' + (p.files || 0) + '</td>' +
        '<td class="dim">' + modTime + '</td>' +
        '<td><button class="admin-mini-btn danger proj-del" data-key="' + esc(p.key) + '" data-name="' + esc(displayName) + '">Delete</button></td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    listEl.innerHTML = html;

    // Bind delete
    listEl.querySelectorAll('.proj-del').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var key = btn.dataset.key;
        var displayName = btn.dataset.name || key;
        var ok = await BOBO.confirm({
          title: 'Delete project',
          message: '"' + displayName + '"\nThis cannot be undone.',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        projectsLoadVersion += 1;
        btn.disabled = true; btn.textContent = '...';
        try {
          var r = await BOBO.sendToServer('deleteProject', { folderKey: key }, { quiet: true });
          if (r && r.success) await loadAll();
          else { global.alert((r && r.error) || 'Delete failed'); btn.disabled = false; btn.textContent = 'Delete'; }
        } catch (err) {
          global.alert((err && err.message) || 'Delete failed');
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      });
    });
  }

  // ──── Cache tab ────
  var cacheExpansion = Object.create(null);

  function cacheMutationCount() {
    return Object.keys(cacheMutationPaths).length;
  }

  function syncCacheMutationControls(path) {
    var pending = cacheMutationCount() > 0;
    var refresh = $('projects-refresh');
    if (refresh) refresh.disabled = pending;
    if (!path || !$('cache-tree')) return;
    $('cache-tree').querySelectorAll('.cache-del,.cache-package-del').forEach(function(control) {
      if (control.dataset.path === path && cacheMutationPaths[path]) control.disabled = true;
    });
  }

  function beginCacheMutation(path) {
    if (!path || cacheMutationPaths[path]) return false;
    cacheMutationPaths[path] = true;
    cacheLoadVersion += 1;
    syncCacheMutationControls(path);
    return true;
  }

  function finishCacheMutation(path) {
    delete cacheMutationPaths[path];
    syncCacheMutationControls(path);
    return cacheMutationCount() === 0;
  }

  function cacheIcon(name, fallback) {
    return BOBO.icons && BOBO.icons[name] ? BOBO.icons[name] : (fallback || '');
  }

  function cacheLocale() {
    var locale = BOBO.i18n && BOBO.i18n.getActive ? BOBO.i18n.getActive() : 'en';
    if (locale === 'ja') return 'ja-JP';
    return locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  }

  function formatCacheDate(value) {
    var timestamp = Number(value) || 0;
    if (!timestamp) return t('Never used');
    try {
      return new Intl.DateTimeFormat(cacheLocale(), {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function cacheLanguageMeta(entry) {
    var label = t(entry.language_label || entry.language || 'Other');
    var color = LANG_COLORS[entry.language] || '#abb2bf';
    return '<span class="cache-runtime-language"><span class="cache-language-dot" style="background:' + color + '"></span>' + esc(label) + '</span>';
  }

  function cacheDeleteButton(entry, label) {
    var writing = Boolean(entry.writing);
    var serviceActive = Boolean(entry.active) && !writing;
    var title = writing ? t('Cache is being updated')
      : serviceActive ? t('Delete cache and stop service') : t('Delete cache');
    return '<button type="button" class="cache-del" data-path="' + esc(entry.path) + '" data-name="' + esc(label) +
      '" data-kind="' + esc(entry.kind || '') + '" data-active="' + (serviceActive ? 'true' : 'false') +
      '" data-writing="' + (writing ? 'true' : 'false') + '" title="' + esc(title) + '" aria-label="' + esc(title) + '"' +
      (writing ? ' disabled' : '') + '>' + cacheIcon('trash', esc(t('Delete'))) + '</button>';
  }

  function cachePackageDeleteButton(entry, packageInfo) {
    var disabled = Boolean(entry.writing) || !entry.inventory_exact || !entry.generation || !entry.inventory_revision;
    var title = entry.writing ? t('Cache is being updated')
      : disabled ? t('Inventory is not exact, so packages cannot be deleted safely.')
        : t('Delete package {name}', { name: packageInfo.name });
    return '<button type="button" class="cache-package-del" data-path="' + esc(entry.path) +
      '" data-package-name="' + esc(packageInfo.name) + '" data-package-version="' + esc(packageInfo.version) +
      '" data-generation="' + esc(entry.generation || '') + '" data-inventory-revision="' + esc(entry.inventory_revision || '') +
      '" data-active="' + (entry.active && !entry.writing ? 'true' : 'false') + '" title="' + esc(title) +
      '" aria-label="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>' + cacheIcon('trash', esc(t('Delete'))) + '</button>';
  }

  function renderCachePackages(entry) {
    if (entry.kind !== 'project-dependency') return '';
    var packages = Array.isArray(entry.packages) ? entry.packages.slice() : [];
    packages.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    var ready = entry.inventory_status === 'ready' && entry.inventory_exact;
    var heading = '<div class="cache-package-heading"><span>' + cacheIcon('package') + esc(t('Installed packages')) +
      '</span><strong>' + packages.length + '</strong></div>';
    if (!ready && packages.length === 0) {
      return '<div class="cache-package-section unavailable">' + heading +
        '<div class="cache-package-notice"><strong>' + esc(t('Package inventory unavailable')) + '</strong>' +
        (entry.inventory_detail ? '<small>' + esc(entry.inventory_detail) + '</small>' : '') + '</div></div>';
    }
    if (packages.length === 0) {
      return '<div class="cache-package-section">' + heading + '<div class="cache-package-notice">' + esc(t('No installed packages')) + '</div></div>';
    }
    var rows = packages.map(function(packageInfo) {
      var imports = Array.isArray(packageInfo.imports) ? packageInfo.imports.filter(Boolean) : [];
      return '<div class="cache-package-row" data-package="' + esc(packageInfo.name) + '">' +
        '<span class="cache-package-identity"><strong>' + esc(packageInfo.name) + '</strong>' +
          (imports.length ? '<small>' + esc(t('Imports: {names}', { names: imports.join(', ') })) + '</small>' : '') + '</span>' +
        '<code class="cache-package-version">' + esc(packageInfo.version || t('Unknown')) + '</code>' +
        '<span class="cache-package-storage"><strong>' + fmt(packageInfo.size_bytes || 0) + '</strong><small>' +
          esc(t('{count} files', { count: packageInfo.files || 0 })) + '</small></span>' +
        cachePackageDeleteButton(entry, packageInfo) + '</div>';
    }).join('');
    var readOnlyNotice = ready ? '' : '<div class="cache-package-notice"><strong>' + esc(t('Package inventory is read-only')) + '</strong>' +
      (entry.inventory_detail ? '<small>' + esc(entry.inventory_detail) + '</small>' : '') + '</div>';
    return '<div class="cache-package-section' + (ready ? '' : ' unavailable') + '">' + heading + readOnlyNotice + rows + '</div>';
  }

  function renderCacheEntry(entry, projectName) {
    var isProjectDependency = entry.kind === 'project-dependency';
    var digest = String(entry.digest || '');
    var digestSource = entry.digest_source ? t(entry.digest_source) : t('Unknown source');
    var runtime = entry.runtime_id || entry.language_label || entry.language || t('Unknown runtime');
    var identity;
    var deleteLabel;

    if (isProjectDependency) {
      identity = '<span class="cache-snapshot-title">' + cacheLanguageMeta(entry) + '<strong>' + esc(runtime) + '</strong></span>' +
        '<span class="cache-snapshot-digest"><span>' + esc(t('Digest')) + '</span> <code>' + esc(digest ? digest.slice(0, 12) : t('Not available')) + '</code>' +
        '<span class="cache-digest-source">' + esc(digestSource) + '</span></span>';
      deleteLabel = (projectName || entry.project_name || entry.name || t('Unattributed project cache')) + ' / ' + runtime +
        (digest ? ' / ' + digest.slice(0, 12) : '');
    } else {
      var kind = entry.kind === 'legacy-cache' ? t('Legacy shared download cache') : t('System cache');
      identity = '<span class="cache-snapshot-title"><strong>' + esc(t(entry.name || 'Cache')) + '</strong></span>' +
        '<span class="cache-snapshot-digest">' + cacheLanguageMeta(entry) + '<span>' + esc(kind) + '</span></span>';
      deleteLabel = t(entry.name || 'Cache');
    }

    var stateClass = entry.writing ? ' writing' : entry.active ? ' analysis' : '';
    var stateLabel = entry.writing ? t('Updating') : entry.active ? t('Service in use') : t('Available');
    return '<div class="cache-snapshot-block" data-cache-path="' + esc(entry.path) + '">' +
      '<div class="cache-snapshot-row">' +
        '<span class="cache-snapshot-identity">' + identity + '</span>' +
        '<span class="cache-snapshot-state' + stateClass + '"><span></span>' + esc(stateLabel) + '</span>' +
        '<span class="cache-snapshot-used">' + esc(formatCacheDate(entry.last_used)) + '</span>' +
        '<span class="cache-snapshot-storage"><strong>' + fmt(entry.size_bytes || 0) + '</strong><small>' + (entry.files || 0) + ' ' + esc(t('Files')) + '</small></span>' +
        cacheDeleteButton(entry, deleteLabel) +
      '</div>' + renderCachePackages(entry) +
    '</div>';
  }

  function renderCacheColumns() {
    return '<div class="cache-list-columns" aria-hidden="true">' +
      '<span>' + esc(t('Runtime and digest')) + '</span><span>' + esc(t('Status')) + '</span>' +
      '<span>' + esc(t('Last used')) + '</span><span>' + esc(t('Storage')) + '</span><span></span></div>';
  }

  function renderProjectCache(project, index) {
    var panelID = 'cache-project-' + index;
    var expanded = Object.prototype.hasOwnProperty.call(cacheExpansion, project.key)
      ? cacheExpansion[project.key]
      : (index === 0 || project.activeCount > 0);
    var projectName = project.name || t('Unattributed project cache');
	var details = project.entries.length === 1
	  ? t('1 snapshot')
	  : t('{count} snapshots', { count: project.entries.length });
    if (project.workspaceID) details += ' · ' + project.workspaceID.slice(0, 16);
    var status = project.writingCount > 0
      ? '<span class="cache-project-state writing">' + esc(t('Updating')) + '</span>'
      : project.analysisCount > 0
        ? '<span class="cache-project-state analysis">' + esc(t('Service in use')) + '</span>'
        : project.orphaned ? '<span class="cache-project-state warning">' + esc(t('Unattributed')) + '</span>' : '';

    return '<section class="cache-project-group">' +
      '<button type="button" class="cache-project-header" data-cache-project="' + index + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-controls="' + panelID + '">' +
        '<span class="cache-project-arrow">' + cacheIcon('chevronRight') + '</span>' +
        '<span class="cache-project-icon">' + cacheIcon('folder') + '</span>' +
        '<span class="cache-project-identity"><strong>' + esc(projectName) + '</strong><small>' + esc(details) + '</small></span>' +
        status + '<span class="cache-project-size">' + fmt(project.sizeBytes) + '</span>' +
      '</button>' +
      '<div class="cache-project-body' + (expanded ? ' open' : '') + '" id="' + panelID + '">' +
        project.entries.map(function(entry) { return renderCacheEntry(entry, projectName); }).join('') +
      '</div>' +
    '</section>';
  }

  async function loadCache() {
    if (cacheMutationCount() > 0) return;
    var requestVersion = ++cacheLoadVersion;
    var requestIdentity = projectViewIdentity();
    var treeEl = $('cache-tree');
    treeEl.innerHTML = '<div class="cache-empty">' + esc(t('Loading...')) + '</div>';

    var res = await BOBO.sendToServer('listCacheModules', {}, { quiet: true });
    if (requestVersion !== cacheLoadVersion || requestIdentity !== projectViewIdentity() || !projectsModalOpen() || cacheMutationCount() > 0) return;
    if (!res || !res.success) {
      treeEl.innerHTML = '<div class="cache-empty">' + esc((res && res.error) || t('Failed to load')) + '</div>';
      return;
    }

    var cache = organizeCacheGroups(res.cacheGroups || []);
    if (cache.itemCount === 0) {
      treeEl.innerHTML = '<div class="cache-empty"><strong>' + esc(t('No build cache found.')) + '</strong><span>' + esc(t('Run some code to populate cache.')) + '</span></div>';
      return;
    }

    var html = '<div class="cache-overview">' +
      '<span class="cache-overview-primary"><small>' + esc(t('Total cache')) + '</small><strong>' + fmt(cache.totalBytes) + '</strong></span>' +
      '<span class="cache-overview-metric"><strong>' + cache.projects.length + '</strong><small>' + esc(t('Projects')) + '</small></span>' +
      '<span class="cache-overview-metric"><strong>' + cache.snapshotCount + '</strong><small>' + esc(t('Dependency snapshots')) + '</small></span>' +
      '<span class="cache-overview-metric active"><strong>' + cache.activeCount + '</strong><small>' + esc(t('In use')) + '</small></span>' +
    '</div>';

    if (cache.projects.length > 0) {
      html += '<div class="cache-section-title"><span>' + esc(t('Project caches')) + '</span><small>' + cache.projects.length + ' ' + esc(t('Projects')) + '</small></div>' +
        renderCacheColumns() + cache.projects.map(renderProjectCache).join('');
    }
    if (cache.shared.length > 0) {
      html += '<div class="cache-section-title shared"><span>' + esc(t('Shared and system caches')) + '</span><small>' + cache.shared.length + ' ' + esc(t('Items')) + '</small></div>' +
        renderCacheColumns() + '<section class="cache-shared-list">' + cache.shared.map(function(entry) { return renderCacheEntry(entry, ''); }).join('') + '</section>';
    }

    treeEl.innerHTML = html;

    treeEl.querySelectorAll('.cache-project-header').forEach(function(header) {
      header.addEventListener('click', function() {
        var index = Number(header.dataset.cacheProject);
        var project = cache.projects[index];
        var body = $('cache-project-' + index);
        if (!project || !body) return;
        var expanded = header.getAttribute('aria-expanded') !== 'true';
        header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        body.classList.toggle('open', expanded);
        cacheExpansion[project.key] = expanded;
      });
    });

    treeEl.querySelectorAll('.cache-del').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var path = btn.dataset.path;
        var name = btn.dataset.name;
        var isProjectDependency = btn.dataset.kind === 'project-dependency';
        var serviceActive = btn.dataset.active === 'true' && btn.dataset.writing !== 'true';
        var message = '"' + name + '"\n' + t(isProjectDependency ? 'This removes only this project dependency snapshot.' : 'This removes the cached data.');
        if (serviceActive) message += '\n' + t('Deleting this cache will stop the service that is using it.');
        var ok = await BOBO.confirm({
          title: t('Delete cache'),
          message: message,
          confirmLabel: t('Delete'),
          danger: true
        });
        if (!ok) return;
        if (!beginCacheMutation(path)) return;
        btn.classList.add('busy');
        try {
          var r = await BOBO.sendToServer('deleteCacheModule', { cachePath: path }, { quiet: true });
          if (!r || !r.success) global.alert((r && r.error) || t('Delete failed'));
        } catch (err) {
          global.alert((err && err.message) || t('Delete failed'));
        } finally {
          btn.classList.remove('busy');
          if (finishCacheMutation(path)) await loadAll();
        }
      });
    });

    treeEl.querySelectorAll('.cache-package-del').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var name = btn.dataset.packageName;
        var version = btn.dataset.packageVersion;
        var message = '"' + name + ' ' + version + '"\n' + t('This removes only this package from the selected project dependency snapshot.');
        if (btn.dataset.active === 'true') message += '\n' + t('Deleting this cache will stop the service that is using it.');
        var ok = await BOBO.confirm({
          title: t('Delete package {name}', { name: name }),
          message: message,
          confirmLabel: t('Delete'),
          danger: true
        });
        if (!ok) return;
        var selectorPath = btn.dataset.path;
        if (!beginCacheMutation(selectorPath)) return;
        btn.classList.add('busy');
        try {
          var response = await BOBO.sendToServer('deleteCachePackage', {
            cachePath: selectorPath,
            cachePackageName: name,
            cachePackageVersion: version,
            cacheGeneration: btn.dataset.generation,
            cacheInventoryRevision: btn.dataset.inventoryRevision
          }, { quiet: true });
          if (response && response.success) {
            return;
          }
          global.alert((response && response.error) || t('Package deletion changed the dependency snapshot. Refresh and try again.'));
        } catch (err) {
          global.alert((err && err.message) || t('Package deletion changed the dependency snapshot. Refresh and try again.'));
        } finally {
          btn.classList.remove('busy');
          if (finishCacheMutation(selectorPath)) await loadAll();
        }
      });
    });
  }

  // ──── UI binding ────
  var uiBound = false;
  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    $('projects-close-x').addEventListener('click', close);
    $('projects-close').addEventListener('click', close);
    $('projects-refresh').addEventListener('click', loadAll);
    $('projects-modal').addEventListener('click', function(e) {
      if (e.target === $('projects-modal')) close();
    });
    document.querySelectorAll('.projects-tab').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(tab.dataset.ptab); });
    });
    global.addEventListener('bobo:language-changed', function() {
      if ($('projects-modal').classList.contains('open')) loadAll();
    });
    if (global.api && typeof global.api.onOpenServerProjects === 'function') {
      global.api.onOpenServerProjects(function() { open(); });
    }
  }

  function openWithQuotaError(errorMsg) {
    // 先清除旧条幅再打开
    var oldBanner = document.getElementById('quota-warn-banner');
    if (oldBanner) oldBanner.remove();
    open();
    if (errorMsg) {
      setTimeout(function() {
        // 再次清除，防 open() 中的 loadAll 产生竞态
        var existing = document.getElementById('quota-warn-banner');
        if (existing) existing.remove();
        var warn = document.createElement('div');
        warn.id = 'quota-warn-banner';
        warn.className = 'quota-warn-banner';
        warn.textContent = errorMsg;
        var card = document.querySelector('.projects-card');
        if (card) card.insertBefore(warn, card.children[1]);
      }, 400);
    }
  }

  BOBO.projects = {
    init: bindUI, open: open, openWithQuotaError: openWithQuotaError,
    close: close, loadProjects: loadAll
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      organizeCacheGroups: organizeCacheGroups,
      compareCacheEntries: compareCacheEntries,
      resolveProjectDisplayName: resolveProjectDisplayName
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
