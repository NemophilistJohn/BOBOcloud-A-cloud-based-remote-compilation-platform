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
  var CACHE_COLOR = '#5c6370';
  var FREE_COLOR = 'rgba(255,255,255,0.06)';

  // ──── Modal ────
  function open() {
    // 清除可能残留的旧提示条幅
    var oldBanner = document.getElementById('quota-warn-banner');
    if (oldBanner) oldBanner.remove();
    $('projects-modal').classList.add('open');
    loadAll();
  }
  function close() {
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
    // 读取本地项目名映射
    try { localProjectNames = await window.api.readProjectNames() || {}; } catch (e) { localProjectNames = {}; }
    await loadProjects();
    await loadCache();
  }

  // ──── Projects tab ────
  async function loadProjects() {
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
      // 优先用服务端返回的 name（.boboproject），其次用本地映射，最后回退到 key
      var displayName = p.name || localProjectNames[p.key] || p.key;
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
        '<td><button class="admin-mini-btn danger proj-del" data-key="' + esc(p.key) + '">Delete</button></td>' +
      '</tr>';
    }
    html += '</tbody></table>';
    listEl.innerHTML = html;

    // Bind delete
    listEl.querySelectorAll('.proj-del').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var key = btn.dataset.key;
        var ok = await BOBO.confirm({
          title: 'Delete project',
          message: '"' + key + '"\nThis cannot be undone.',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        btn.disabled = true; btn.textContent = '...';
        var r = await BOBO.sendToServer('deleteProject', { folderKey: key }, { quiet: true });
        if (r && r.success) loadAll();
        else { global.alert((r && r.error) || 'Delete failed'); btn.disabled = false; btn.textContent = 'Delete'; }
      });
    });
  }

  // ──── Cache tab ────
  async function loadCache() {
    var treeEl = $('cache-tree');
    treeEl.innerHTML = '<div class="cache-empty">Loading…</div>';

    var res = await BOBO.sendToServer('listCacheModules', {}, { quiet: true });
    if (!res || !res.success) {
      treeEl.innerHTML = '<div class="cache-empty">' + esc((res && res.error) || 'Failed to load') + '</div>';
      return;
    }

    var groups = res.cacheGroups || [];
    if (groups.length === 0) {
      treeEl.innerHTML = '<div class="cache-empty">No build cache found.<br>Run some code to populate cache.</div>';
      return;
    }

    // 总计
    var totalBytes = 0;
    groups.forEach(function(g) { totalBytes += (g.size_bytes || 0); });

    var html = '<div class="cache-total">' +
      '<span style="color:var(--text-dim)">Total cache: </span>' +
      '<strong style="color:var(--text)">' + fmt(totalBytes) + '</strong></div>';

    groups.forEach(function(g, gi) {
      var langColor = LANG_COLORS[g.language] || '#abb2bf';
      var modules = g.modules || [];
      var expanded = gi === 0; // 第一个默认展开

      html += '<div class="cache-group">';
      html += '<div class="cache-group-header" data-gi="' + gi + '">' +
        '<svg class="cache-arrow' + (expanded ? ' open' : '') + '" viewBox="0 0 16 16" fill="none">' +
        '<path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="cache-lang-dot" style="background:' + langColor + '"></span>' +
        '<span class="cache-lang-name">' + esc(t(g.label)) + '</span>' +
        '<span class="cache-lang-size">' + fmt(g.size_bytes || 0) + '</span>' +
        '<span class="cache-lang-count">' + modules.length + ' items</span>' +
        '</div>';

      html += '<div class="cache-modules' + (expanded ? ' open' : '') + '" id="cache-mods-' + gi + '">';
      if (modules.length === 0) {
        html += '<div class="cache-module-empty">No modules</div>';
      }
      modules.forEach(function(m) {
        html += '<div class="cache-module-row">' +
          '<span class="cache-mod-name">' + esc(t(m.name)) + '</span>' +
          '<span class="cache-mod-size">' + fmt(m.size_bytes || 0) + '</span>' +
          '<span class="cache-mod-files">' + (m.files || 0) + ' files</span>' +
          '<button class="cache-del" data-path="' + esc(m.path) + '" data-name="' + esc(m.name) + '">Delete</button>' +
        '</div>';
      });
      html += '</div></div>';
    });

    treeEl.innerHTML = html;

    // Bind expand/collapse
    treeEl.querySelectorAll('.cache-group-header').forEach(function(hdr) {
      hdr.addEventListener('click', function() {
        var gi = hdr.dataset.gi;
        var arrow = hdr.querySelector('.cache-arrow');
        var mods = $('cache-mods-' + gi);
        if (!mods) return;
        mods.classList.toggle('open');
        if (arrow) arrow.classList.toggle('open');
      });
    });

    // Bind delete
    treeEl.querySelectorAll('.cache-del').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var path = btn.dataset.path;
        var name = btn.dataset.name;
        var ok = await BOBO.confirm({
          title: 'Delete cache',
          message: '"' + name + '"\nThis removes the cached data.',
          confirmLabel: 'Delete',
          danger: true
        });
        if (!ok) return;
        btn.disabled = true; btn.textContent = '...';
        var r = await BOBO.sendToServer('deleteCacheModule', { cachePath: path }, { quiet: true });
        if (r && r.success) loadAll();
        else { global.alert((r && r.error) || 'Delete failed'); btn.disabled = false; btn.textContent = 'Delete'; }
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
})(window);
