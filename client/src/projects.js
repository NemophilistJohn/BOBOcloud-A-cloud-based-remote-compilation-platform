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
  var FREE_COLOR = 'rgba(255,255,255,0.06)';
  function resolveProjectDisplayName(project, names) {
    project = project || {};
    names = names || {};
    var serverName = project.name && project.name !== project.key ? project.name : '';
    return serverName || names[project.key] || project.key || '';
  }

  // ──── Modal ────
  var projectNamesLoadVersion = 0;
  var projectsLoadVersion = 0;
  var previouslyFocused = null;

  function projectViewIdentity() {
    var user = S.auth && S.auth.user ? S.auth.user : {};
    return [S.serverSettings.ip || '', S.auth.token || '', user.id || user.uid || ''].join('\n');
  }

  function projectsModalOpen() {
    return Boolean($('projects-modal') && $('projects-modal').classList.contains('open'));
  }

  function open(options) {
    options = options || {};
    // 清除可能残留的旧提示条幅
    var oldBanner = document.getElementById('quota-warn-banner');
    if (oldBanner) oldBanner.remove();
    previouslyFocused = document.activeElement;
    $('projects-modal').classList.add('open');
    $('projects-modal').setAttribute('aria-hidden', 'false');
    switchTab(options.tab || 'projects');
    loadAll();
    setTimeout(function() {
      var activeTab = document.querySelector('.projects-tab.active');
      if (activeTab) activeTab.focus();
    }, 0);
  }
  function close() {
    projectNamesLoadVersion += 1;
    projectsLoadVersion += 1;
    $('projects-modal').classList.remove('open');
    $('projects-modal').setAttribute('aria-hidden', 'true');
    if (BOBO.cacheCenter) BOBO.cacheCenter.setVisible(false);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    previouslyFocused = null;
  }

  function switchTab(name) {
    if (name !== 'projects' && name !== 'cache') return;
    document.querySelectorAll('.projects-tab').forEach(function(tab) {
      var active = tab.dataset.ptab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.projects-pane').forEach(function(pane) {
      var active = pane.id === 'projects-pane-' + name;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
    var card = document.querySelector('.projects-card');
    if (card) card.classList.toggle('cache-active', name === 'cache');
    if (BOBO.cacheCenter) BOBO.cacheCenter.setVisible(name === 'cache' && projectsModalOpen());
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
    if (BOBO.cacheCenter) BOBO.cacheCenter.setProjectNames(names);
    await Promise.all([
      loadProjects(),
      BOBO.cacheCenter ? BOBO.cacheCenter.load({ force: true }).catch(function() {}) : Promise.resolve()
    ]);
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

  // ──── UI binding ────
  var uiBound = false;
  function activeTabName() {
    var active = document.querySelector('.projects-tab.active');
    return active && active.dataset.ptab || 'projects';
  }

  function refreshActiveTab() {
    if (activeTabName() === 'cache' && BOBO.cacheCenter) {
      return BOBO.cacheCenter.load({ force: true }).catch(function() {});
    }
    return loadAll();
  }

  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    if (BOBO.cacheCenter) BOBO.cacheCenter.init();

    $('projects-close-x').addEventListener('click', close);
    $('projects-close').addEventListener('click', close);
    $('projects-refresh').addEventListener('click', refreshActiveTab);
    $('projects-modal').addEventListener('click', function(e) {
      if (e.target === $('projects-modal')) close();
    });
    document.querySelectorAll('.projects-tab').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(tab.dataset.ptab); });
      tab.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var next = tab.dataset.ptab === 'projects' ? 'cache' : 'projects';
        switchTab(next);
        var nextTab = document.querySelector('.projects-tab[data-ptab="' + next + '"]');
        if (nextTab) nextTab.focus();
      });
    });
    $('projects-modal').addEventListener('keydown', function(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    global.addEventListener('bobo:language-changed', function() {
      if (!projectsModalOpen()) return;
      if (activeTabName() === 'cache' && BOBO.cacheCenter) BOBO.cacheCenter.render();
      else loadProjects();
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
    close: close, loadProjects: loadAll, switchTab: switchTab
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      resolveProjectDisplayName: resolveProjectDisplayName
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
