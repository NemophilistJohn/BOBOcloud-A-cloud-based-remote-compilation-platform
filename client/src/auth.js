// src/auth.js — Cloud account: login/register UI, local timed credential,
// user chip + menu, change password, admin panel (users/invites/audit).
//
// 设计要点：
// - 本地凭证存于 userData/auth.json（由 main 按规范化端点隔离），未过期则启动免登
// - 多人模式未登录时：本地编辑完全可用，云功能（同步/运行/终端）被 401 拦截并引导登录
// - 单机模式（serverInfo authMode=single）：不显示任何账户 UI
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── 工具 ────
  function $(id) { return document.getElementById(id); }
  function t(key, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(key, params);
    return String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function show(el) { el.classList.add('show'); }
  function hide(el) { el.classList.remove('show'); }

  var TOKEN_EXPIRY_MARGIN_MS = 60 * 1000; // 距到期不足 1 分钟视为已过期

  // ──── 本地凭证（经 main 进程持久化到 userData/auth.json）────
  async function loadCredential() {
    try {
      var cred = await global.api.authGet();
      if (cred && cred.token && cred.expiresAt) return cred;
    } catch (e) { console.error('authGet:', e); }
    return null;
  }
  async function saveCredential(token, expiresAt, user) {
    try {
      await global.api.authSet({
        token: token,
        expiresAt: expiresAt,
        user: user
      });
    } catch (e) { console.error('authSet:', e); }
  }
  async function clearCredential() {
    try { await global.api.authClear(); } catch (e) { console.error('authClear:', e); }
  }

  function applyCredential(cred) {
    S.auth.token = cred.token;
    S.auth.expiresAt = cred.expiresAt;
    S.auth.user = cred.user;
  }
  function dropCredential() {
    if (BOBO.accountProfile && BOBO.accountProfile.reset) BOBO.accountProfile.reset();
    S.auth.token = '';
    S.auth.expiresAt = 0;
    S.auth.user = null;
  }
  function hasValidLocalCredential() {
    return !!(S.auth.token && S.auth.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS);
  }

  // ──── 登录/注册弹窗 ────
  var currentTab = 'login';

  function switchTab(tab) {
    currentTab = tab;
    $('auth-tab-login').classList.toggle('active', tab === 'login');
    $('auth-tab-register').classList.toggle('active', tab === 'register');
    $('auth-form-login').style.display = tab === 'login' ? '' : 'none';
    $('auth-form-register').style.display = tab === 'register' ? '' : 'none';
    $('auth-submit').textContent = tab === 'login' ? 'Login' : 'Register & login';
    clearMessages();
    var first = tab === 'login' ? $('auth-login-identity') : $('auth-reg-username');
    setTimeout(function() { first.focus(); }, 60);
  }

  function clearMessages() {
    hide($('auth-error')); hide($('auth-notice'));
  }

  // Register form never remembers previous input (login form does).
  // Called on each openAuthModal so a fresh open starts clean.
  function clearRegisterForm() {
    $('auth-reg-username').value = '';
    $('auth-reg-email').value = '';
    $('auth-reg-password').value = '';
    $('auth-reg-password2').value = '';
    $('auth-reg-invite').value = '';
  }
  function showError(msg) {
    hide($('auth-notice'));
    $('auth-error-text').textContent = msg;
    show($('auth-error'));
    // 重新触发抖动动画
    var el = $('auth-error');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  }
  function showNotice(msg) {
    hide($('auth-error'));
    $('auth-notice-text').textContent = msg;
    show($('auth-notice'));
  }

  function openAuthModal(noticeMsg) {
    if (S.auth.modalOpen) {
      if (noticeMsg) showNotice(noticeMsg);
      return;
    }
    S.auth.modalOpen = true;
    clearMessages();
    if (noticeMsg) showNotice(noticeMsg);
    $('auth-server-hint').textContent = S.serverSettings.ip
      ? ('Server: ' + S.serverSettings.ip) : 'No server configured - set it in Settings -> Server Settings first';
    $('auth-overlay').classList.add('open');
    clearRegisterForm(); // Register form never remembers previous input (login form does)
    switchTab('login');
  }

  function closeAuthModal() {
    S.auth.modalOpen = false;
    $('auth-overlay').classList.remove('open');
  }

  function setSubmitting(submitting) {
    var btn = $('auth-submit');
    btn.disabled = submitting;
    if (submitting) {
      btn.innerHTML = '<span class="auth-spinner"></span>Please wait…';
    } else {
      btn.textContent = currentTab === 'login' ? 'Login' : 'Register & login';
    }
  }

  async function submitLogin() {
    var identity = $('auth-login-identity').value.trim();
    var password = $('auth-login-password').value;
    if (!identity || !password) { showError('Please enter username/email and password'); return; }
    setSubmitting(true);
    try {
      var res = await BOBO.sendToServer('login', { identity: identity, password: password }, { quiet: true });
      if (!res || !res.success) {
        showError((res && res.error) || 'Login failed, please check network');
        return;
      }
      await onAuthSuccess(res);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRegister() {
    var username = $('auth-reg-username').value.trim();
    var email = $('auth-reg-email').value.trim();
    var password = $('auth-reg-password').value;
    var password2 = $('auth-reg-password2').value;
    var invite = $('auth-reg-invite').value.trim().toUpperCase();
    if (!username || !email || !password || !invite) { showError('Username, email, password and invite code are all required'); return; }
    if (password !== password2) { showError('Passwords do not match'); return; }
    setSubmitting(true);
    try {
      var res = await BOBO.sendToServer('register', {
        username: username, email: email, password: password, inviteCode: invite
      }, { quiet: true });
      if (!res || !res.success) {
        showError((res && res.error) || 'Registration failed, please check network');
        return;
      }
      await onAuthSuccess(res);
    } finally {
      setSubmitting(false);
    }
  }

  async function onAuthSuccess(res) {
    if ($('admin-modal') && $('admin-modal').classList.contains('open')) closeAdmin();
    if (BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      await BOBO.runner.invalidateRunIdentity();
    }
    var expiresAt = res.expiresAt ? new Date(res.expiresAt).getTime() : (Date.now() + 30 * 24 * 3600 * 1000);
    applyCredential({ token: res.token, expiresAt: expiresAt, user: res.user });
    await saveCredential(res.token, expiresAt, res.user);
    closeAuthModal();
    renderChip();
    if (BOBO.serverCapabilities && typeof BOBO.serverCapabilities.notify === 'function') {
      BOBO.serverCapabilities.notify('auth-success');
    }
    if (BOBO.lsp && BOBO.lsp.credentialsChanged) BOBO.lsp.credentialsChanged();
    BOBO.updateRunOutput('Logged in as ' + (res.user.username || res.user.id) +
      ' (role: ' + (res.user.role || 'member') + ')');
    // 登录后补齐运行时列表（此前 401 拿不到）
    if (BOBO.runtime && BOBO.runtime.fetchRuntimes) BOBO.runtime.fetchRuntimes();
  }

  // ──── 凭证过期 / 被吊销 ────
  async function handleAuthExpired() {
    if (S.auth.mode !== 'multi') return;
    if ($('admin-modal')) closeAdmin();
    var debugStopped = BOBO.dap && typeof BOBO.dap.abort === 'function'
      ? BOBO.dap.abort('auth-expired')
      : Promise.resolve();
    var terminalStopped = BOBO.terminal && typeof BOBO.terminal.close === 'function'
      ? BOBO.terminal.close('auth-expired')
      : Promise.resolve();
    if (BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      BOBO.runner.invalidateRunIdentity({ skipHttp: true });
    }
    await Promise.all([debugStopped, terminalStopped]);
    dropCredential();
    if (BOBO.lsp && typeof BOBO.lsp.identityChanged === 'function') BOBO.lsp.identityChanged();
    if (S.serverSettings.ip) clearCredential();
    renderChip();
    openAuthModal('Session expired or logged out elsewhere, please log in again');
  }

  // ──── 用户徽章与菜单 ────

  // 把当前认证状态推送到主进程，用于动态显示/隐藏顶部"管理"菜单。
  // 在 renderChip（所有认证状态变更的汇聚点）中调用，确保菜单与登录态同步。
  function notifyAuthState() {
    if (global.api && typeof global.api.authUpdateState === 'function') {
      var loggedIn = !!(S.auth.mode === 'multi' && S.auth.user && S.auth.token);
      var role = (S.auth.user && S.auth.user.role) || '';
      global.api.authUpdateState({ loggedIn: loggedIn, role: role });
    }
  }

  function renderChip() {
    notifyAuthState();
    var chip = $('auth-chip');
    if (S.auth.mode !== 'multi') {
      chip.style.display = 'none';
      closeMenu();
      return;
    }
    chip.style.display = '';
    var user = S.auth.user;
    if (user && S.auth.token) {
      chip.classList.remove('auth-chip-offline');
      var initial = (user.username || user.id || '?').charAt(0).toUpperCase();
	  var avatarClass = user.avatar && user.avatar.indexOf('data:image/') !== 0 ? ' avatar-' + esc(user.avatar) : '';
	  var avatarBody = user.avatar && user.avatar.indexOf('data:image/') === 0
		? '<img src="' + esc(user.avatar) + '" alt="">'
		: esc(initial);
      chip.innerHTML =
		'<span class="auth-chip-avatar' + avatarClass + '">' + avatarBody + '</span>' +
        '<span>' + esc(user.username || user.id) + '</span>' +
        '<span class="auth-chip-role">' + esc(user.role || 'member') + '</span>';
      chip.title = 'Cloud account: ' + (user.email || user.username || '');
    } else {
      chip.classList.add('auth-chip-offline');
      chip.innerHTML = '<span class="auth-chip-dot"></span><span>登录</span>';
      chip.title = '未登录 — 点击登录云编译账户（本地编辑不受影响）';
    }
  }

  function closeMenu() {
    var menu = $('auth-menu');
    if (menu) menu.style.display = 'none';
  }

  function toggleMenu() {
    var menu = $('auth-menu');
    if (!(S.auth.user && S.auth.token)) {
      openAuthModal();
      return;
    }
    if (menu.style.display === 'block') { closeMenu(); return; }
    $('auth-menu-name').textContent = S.auth.user.username || S.auth.user.id;
	$('auth-menu-email').textContent = (S.auth.user.uid ? S.auth.user.uid + ' · ' : '') + (S.auth.user.email || ('role: ' + (S.auth.user.role || 'member')));
    var isAdmin = (S.auth.user.role === 'admin' || S.auth.user.role === 'root');
    $('auth-menu-admin').style.display = isAdmin ? '' : 'none';
    // 定位在状态栏徽章上方
    var chip = $('auth-chip');
    var rect = chip.getBoundingClientRect();
    menu.style.display = 'block';
    var mw = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(rect.left, global.innerWidth - mw - 8)) + 'px';
    menu.style.bottom = (global.innerHeight - rect.top + 6) + 'px';
    menu.style.top = 'auto';
  }

  // 点击其它位置关闭菜单
  document.addEventListener('click', function(e) {
    var menu = $('auth-menu');
    if (!menu || menu.style.display !== 'block') return;
    if (menu.contains(e.target) || $('auth-chip').contains(e.target)) return;
    closeMenu();
  });

  // ──── 退出登录 ────
  async function doLogout() {
    closeMenu();
    closeAdmin();
    if (BOBO.workspace && BOBO.workspace.canLeaveWorkspace) {
      var allowed = await BOBO.workspace.canLeaveWorkspace({ reason: 'logout' });
      if (!allowed) return false;
    }
    if (BOBO.terminal && typeof BOBO.terminal.close === 'function') await BOBO.terminal.close('logout');
    if (BOBO.dap && typeof BOBO.dap.abort === 'function') await BOBO.dap.abort('logout');
	if (BOBO.collaboration && BOBO.collaboration.releaseForLogout) {
	  await BOBO.collaboration.releaseForLogout();
	}
    if (S.auth.token) {
      await BOBO.sendToServer('logout', {}, { quiet: true });
    }
    dropCredential();
    if (BOBO.lsp && typeof BOBO.lsp.identityChanged === 'function') BOBO.lsp.identityChanged();
    if (S.serverSettings.ip) await clearCredential();
    renderChip();
    // Close the open project folder so auto-sync doesn't push files to the
    // server under the wrong account after an account switch.
    if (BOBO.workspace && BOBO.workspace.closeWorkspace) {
      try { await BOBO.workspace.closeWorkspace({ approved: true, reason: 'logout' }); } catch (e) { console.error('closeWorkspace:', e); }
    }
	if (BOBO.collaboration && BOBO.collaboration.clearCurrent) BOBO.collaboration.clearCurrent();
    BOBO.updateRunOutput('Logged out. Local editing is unaffected; cloud compile requires login.');
    return true;
  }

  // ──── 修改密码 ────
  function openChpwd() {
    closeMenu();
    hide($('chpwd-error'));
    $('chpwd-old').value = ''; $('chpwd-new').value = ''; $('chpwd-new2').value = '';
    $('chpwd-modal').classList.add('open');
    setTimeout(function() { $('chpwd-old').focus(); }, 60);
  }
  function closeChpwd() { $('chpwd-modal').classList.remove('open'); }

  async function submitChpwd() {
    var oldP = $('chpwd-old').value, newP = $('chpwd-new').value, newP2 = $('chpwd-new2').value;
    var errEl = $('chpwd-error');
    function fail(msg) { $('chpwd-error-text').textContent = msg; show(errEl); }
    if (!newP || newP.length < 6) { fail('New password must be at least 6 chars'); return; }
    if (newP !== newP2) { fail('New passwords do not match'); return; }
    var res = await BOBO.sendToServer('changePassword', { oldPassword: oldP, newPassword: newP }, { quiet: true });
    if (!res || !res.success) { fail((res && res.error) || 'Change failed'); return; }
    closeChpwd();
    BOBO.updateRunOutput('Password changed. Other sessions have been logged out.');
  }

  // ──── 管理面板 ────
  var adminUsersLoadVersion = 0;
  var adminDialogSequence = 0;

  function adminAuthIdentity() {
    var user = S.auth.user || {};
    return [S.serverSettings.ip || '', S.auth.token || '', user.id || user.uid || ''].join('\n');
  }

  function openAdmin(tab) {
    closeMenu();
    $('admin-modal').classList.add('open');
    switchAdminTab(tab || 'users');
    // root 才能发管理员邀请
    $('invite-role-admin').style.display =
      (S.auth.user && S.auth.user.role === 'root') ? '' : 'none';
  }
  function closeAdmin() {
    adminUsersLoadVersion += 1;
    closeAdminActionMenus();
    $('admin-modal').classList.remove('open');
  }

  function switchAdminTab(name) {
    closeAdminActionMenus();
    var tabs = document.querySelectorAll('#admin-modal .admin-tab');
    tabs.forEach(function(tab) {
      var selected = tab.dataset.pane === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('#admin-modal .admin-pane').forEach(function(p) {
      p.classList.toggle('active', p.id === 'admin-pane-' + name);
    });
    if (name === 'users') loadUsers();
    if (name === 'invites') loadInvites();
    if (name === 'audit') loadAudit();
  }

  async function loadUsers() {
    var pane = $('admin-pane-users');
    var requestVersion = ++adminUsersLoadVersion;
    var requestIdentity = adminAuthIdentity();
    closeAdminActionMenus();
    pane.innerHTML = '<div class="admin-loading">' + esc(t('Loading...')) + '</div>';
    var res = await BOBO.sendToServer('listUsers', {}, { quiet: true });
    if (requestVersion !== adminUsersLoadVersion || requestIdentity !== adminAuthIdentity() || !$('admin-modal').classList.contains('open')) return;
    if (!res || !res.success) {
      pane.innerHTML = '<div class="admin-empty">' + esc((res && res.error) || t('Load failed')) + '</div>';
      return;
    }
    pane.__adminUsers = res.users || [];
    var myRole = S.auth.user ? S.auth.user.role : 'member';
    var html = '<table class="admin-table"><thead><tr>' +
      '<th>' + esc(t('Account')) + '</th><th>' + esc(t('Access')) + '</th><th>' + esc(t('Limits')) + '</th>' +
      '<th class="admin-created-column">' + esc(t('Created')) + '</th><th class="admin-actions-column">' + esc(t('Actions')) + '</th>' +
      '</tr></thead><tbody>';
    (res.users || []).forEach(function(u) {
      var roleBadge = '<span class="admin-role-badge admin-role-' + esc(u.role || 'member') + '">' +
        esc(adminRoleLabel(u.role)) + '</span>';
      var disabledTag = u.disabled ? '<span class="admin-disabled-tag">' + esc(t('Disabled')) + '</span>' : '';
      var created = u.created_at ? new Date(u.created_at).toLocaleDateString(adminLocale()) : '-';
      var diskQuota = u.disk_quota_mb > 0 ? (u.disk_quota_mb + ' MB') : t('Unlimited');
      html += '<tr>' +
        '<td><div class="admin-account-cell"><strong>' + esc(u.username || u.id) + '</strong>' +
          '<span>' + esc(u.email || u.id || '-') + '</span></div></td>' +
        '<td><div class="admin-access-cell">' + roleBadge + disabledTag + '</div></td>' +
        '<td><div class="admin-limits-cell">' +
          '<span>' + esc(t('{count} containers', { count: u.container_limit || 0 })) + '</span>' +
          '<span>' + esc(t('{count} requests/min', { count: u.rate_limit || 0 })) + '</span>' +
          '<span>' + esc(t('Disk: {quota}', { quota: diskQuota })) + '</span></div></td>' +
        '<td class="admin-created-column">' + esc(created) + '</td>' +
        '<td class="admin-actions-column"><div class="admin-row-actions" data-uid="' + esc(u.id) + '">' +
          buildUserActions(u, myRole, S.auth.user && (S.auth.user.id || S.auth.user.uid)) +
        '</div></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    pane.innerHTML = html;
    bindUserActions(pane);
  }

  function adminRoleLabel(role) {
    if (role === 'root') return t('Root');
    if (role === 'admin') return t('Admin');
    return t('Member');
  }

  function adminLocale() {
    var locale = BOBO.i18n && BOBO.i18n.getActive ? BOBO.i18n.getActive() : 'en';
    if (locale === 'ja') return 'ja-JP';
    return locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  }

  function buildUserActions(u, myRole, currentUserID) {
    var isRoot = u.role === 'root';
    var isCurrent = Boolean(currentUserID) && u.id === currentUserID;
    var canManage = (myRole === 'root') || (myRole === 'admin' && u.role === 'member');
    if (!canManage) return '<span class="admin-no-actions">-</span>';
    var items = [
      isCurrent
        ? '<button type="button" role="menuitem" data-act="change-password">' + esc(t('Change password')) + '</button>'
        : '<button type="button" role="menuitem" data-act="password">' + esc(t('Password')) + '</button>',
      '<button type="button" role="menuitem" data-act="quota">' + esc(t('Set quota')) + '</button>'
    ];
    if (!isRoot) {
      items.push(u.disabled
        ? '<button type="button" role="menuitem" data-act="enable">' + esc(t('Enable')) + '</button>'
        : '<button type="button" role="menuitem" class="warn" data-act="disable">' + esc(t('Disable')) + '</button>');
      if (myRole === 'root') {
        items.push(u.role === 'admin'
          ? '<button type="button" role="menuitem" data-act="demote">' + esc(t('Demote to member')) + '</button>'
          : '<button type="button" role="menuitem" data-act="promote">' + esc(t('Promote to admin')) + '</button>');
        items.push('<button type="button" role="menuitem" class="danger" data-act="delete">' + esc(t('Delete')) + '</button>');
      }
    }
    var icon = BOBO.icons && BOBO.icons.moreVertical ? BOBO.icons.moreVertical : '&#8942;';
    return '<button type="button" class="admin-actions-trigger" aria-haspopup="menu" aria-expanded="false" ' +
      'title="' + esc(t('Actions')) + '" aria-label="' + esc(t('Actions for {user}', { user: u.username || u.id })) + '">' + icon + '</button>' +
      '<div class="admin-action-menu" role="menu">' + items.join('') + '</div>';
  }

  function closeAdminActionMenus(except) {
    document.querySelectorAll('.admin-action-menu.open').forEach(function(menu) {
      if (menu === except) return;
      menu.classList.remove('open');
      var trigger = menu.parentElement && menu.parentElement.querySelector('.admin-actions-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function positionAdminActionMenu(trigger, menu) {
    menu.classList.add('open');
    menu.style.left = '0px';
    menu.style.top = '0px';
    var rect = trigger.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.right - menuRect.width, global.innerWidth - menuRect.width - 8));
    var top = rect.bottom + 4;
    if (top + menuRect.height > global.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function bindUserActions(pane) {
    var users = Object.create(null);
    (pane.__adminUsers || []).forEach(function(user) { users[user.id] = user; });
    pane.querySelectorAll('.admin-actions-trigger').forEach(function(trigger) {
      trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        var menu = trigger.parentElement.querySelector('.admin-action-menu');
        var opening = !menu.classList.contains('open');
        closeAdminActionMenus(opening ? menu : null);
        if (opening) {
          positionAdminActionMenu(trigger, menu);
          var firstItem = menu.querySelector('[role="menuitem"]');
          if (firstItem) firstItem.focus();
        }
        else menu.classList.remove('open');
        trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
      });
      var menu = trigger.parentElement.querySelector('.admin-action-menu');
      menu.addEventListener('keydown', function(e) {
        var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
        if (e.key === 'Escape') {
          e.preventDefault();
          closeAdminActionMenus();
          trigger.focus();
          return;
        }
        if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        var current = items.indexOf(document.activeElement);
        var next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowUp' ? (current <= 0 ? items.length - 1 : current - 1)
            : (current + 1) % items.length;
        items[next].focus();
      });
    });
    pane.querySelectorAll('.admin-action-menu button[data-act]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var row = btn.closest('.admin-row-actions');
        var uid = row.dataset.uid;
        var user = users[uid];
        var act = btn.dataset.act;
        closeAdminActionMenus();
        btn.disabled = true;
        try {
          if (act === 'change-password') {
            closeAdmin();
            openChpwd();
          } else if (act === 'disable' || act === 'enable') {
            var res = await BOBO.sendToServer('setUserDisabled',
              { userId: uid, disabled: act === 'disable' }, { quiet: true });
            if (!res || !res.success) { global.alert((res && res.error) || t('Operation failed')); return; }
            await loadUsers();
          } else if (act === 'password') {
            var secret = await openAdminPasswordDialog(user);
            if (secret == null) return;
            showGeneratedSecret(t('New password for {user}. It is shown only once.', { user: user.username || uid }), secret, $('admin-pane-users'), true);
          } else if (act === 'quota') {
            if (await openAdminQuotaDialog(user)) await loadUsers();
          } else if (act === 'promote' || act === 'demote') {
            var role = act === 'promote' ? 'admin' : 'member';
            var res3 = await BOBO.sendToServer('setUserRole', { userId: uid, role: role }, { quiet: true });
            if (!res3 || !res3.success) { global.alert((res3 && res3.error) || t('Operation failed')); return; }
            await loadUsers();
          } else if (act === 'delete') {
            var okDel = await BOBO.confirm({
              title: t('Delete user'),
              message: t('Delete user {user}?\nThis permanently deletes their files, cache, and containers.', { user: user.username || uid }),
              confirmLabel: t('Delete'),
              danger: true
            });
            if (!okDel) return;
            var res4 = await BOBO.sendToServer('deleteUser', { userId: uid }, { quiet: true });
            if (!res4 || !res4.success) { global.alert((res4 && res4.error) || t('Delete failed')); return; }
            await loadUsers();
          }
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function createAdminDialog(title, bodyHTML) {
    var overlay = document.createElement('div');
    var titleID = 'admin-dialog-title-' + (++adminDialogSequence);
    overlay.className = 'admin-dialog-overlay';
    overlay.__returnFocus = document.activeElement;
    overlay.innerHTML = '<div class="admin-dialog-card" role="dialog" aria-modal="true" aria-labelledby="' + titleID + '">' +
      '<div class="ss-head"><div class="ss-title" id="' + titleID + '">' + esc(title) + '</div>' +
      '<button type="button" class="close-btn admin-dialog-close" title="' + esc(t('Close')) + '" aria-label="' + esc(t('Close')) + '">&times;</button></div>' +
      bodyHTML + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('keydown', function(e) {
      if (e.key !== 'Tab') return;
      var focusable = Array.prototype.slice.call(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return overlay;
  }

  function removeAdminDialog(overlay) {
    var returnFocus = overlay.__returnFocus;
    overlay.remove();
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      requestAnimationFrame(function() { returnFocus.focus(); });
    }
  }

  function openAdminPasswordDialog(user) {
    return new Promise(function(resolve) {
      var overlay = createAdminDialog(t('Password for {user}', { user: user.username || user.id }),
        '<div class="ss-body admin-dialog-body">' +
          '<div class="admin-dialog-note">' + esc(t('The existing password cannot be viewed because only its secure hash is stored. Set a replacement or generate a random password.')) + '</div>' +
          '<label class="ss-label" for="admin-password-input">' + esc(t('Replacement password')) + '</label>' +
          '<div class="admin-password-row"><input id="admin-password-input" class="ss-input" type="password" autocomplete="new-password" minlength="6">' +
          '<button type="button" class="admin-icon-btn admin-password-reveal" title="' + esc(t('Show password')) + '" aria-label="' + esc(t('Show password')) + '">' +
          ((BOBO.icons && BOBO.icons.eye) || esc(t('Show'))) + '</button></div>' +
          '<div class="admin-dialog-error" role="alert"></div></div>' +
        '<div class="ss-foot"><button type="button" class="ss-btn ss-btn-ghost admin-dialog-cancel">' + esc(t('Cancel')) + '</button>' +
          '<button type="button" class="ss-btn ss-btn-ghost admin-password-generate">' + esc(t('Generate password')) + '</button>' +
          '<button type="button" class="ss-btn ss-btn-primary admin-password-save">' + esc(t('Set password')) + '</button></div>');
      var input = overlay.querySelector('#admin-password-input');
      var reveal = overlay.querySelector('.admin-password-reveal');
      var error = overlay.querySelector('.admin-dialog-error');
      var controls = overlay.querySelectorAll('button,input');
      var settled = false;
      var submitting = false;
      function close(value) {
        if (settled) return;
        settled = true;
        removeAdminDialog(overlay);
        resolve(value);
      }
      function setBusy(busy) { controls.forEach(function(control) { control.disabled = busy; }); }
      async function submit(generate) {
        if (settled || submitting) return;
        var password = input.value;
        if (!generate && password.length < 6) {
          error.textContent = t('Password must be at least 6 characters.');
          input.focus();
          return;
        }
        error.textContent = '';
        submitting = true;
        setBusy(true);
        var payload = { userId: user.id };
        if (!generate) payload.newPassword = password;
        var response;
        try {
          response = await BOBO.sendToServer('resetUserPassword', payload, { quiet: true });
        } catch (err) {
          error.textContent = (err && err.message) || t('Password update failed');
          submitting = false;
          setBusy(false);
          return;
        }
        if (!response || !response.success || !response.newPassword) {
          error.textContent = (response && response.error) || t('Password update failed');
          submitting = false;
          setBusy(false);
          return;
        }
        close(response.newPassword);
      }
      overlay.querySelector('.admin-dialog-close').addEventListener('click', function() { if (!submitting) close(null); });
      overlay.querySelector('.admin-dialog-cancel').addEventListener('click', function() { if (!submitting) close(null); });
      overlay.querySelector('.admin-password-generate').addEventListener('click', function() { submit(true); });
      overlay.querySelector('.admin-password-save').addEventListener('click', function() { submit(false); });
      reveal.addEventListener('click', function() {
        var visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        reveal.innerHTML = (BOBO.icons && BOBO.icons[visible ? 'eye' : 'eyeOff']) || esc(t(visible ? 'Show' : 'Hide'));
        var revealLabel = t(visible ? 'Show password' : 'Hide password');
        reveal.title = revealLabel;
        reveal.setAttribute('aria-label', revealLabel);
      });
      overlay.addEventListener('click', function(e) { if (e.target === overlay && !submitting) close(null); });
      overlay.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && !submitting) close(null);
        if (e.key === 'Enter' && e.target === input && !submitting) { e.preventDefault(); submit(false); }
      });
      requestAnimationFrame(function() { input.focus(); });
    });
  }

  function openAdminQuotaDialog(user) {
    return new Promise(function(resolve) {
      var overlay = createAdminDialog(t('Quota for {user}', { user: user.username || user.id }),
        '<div class="ss-body admin-dialog-body"><div class="admin-form-grid">' +
          '<label class="admin-form-field"><span>' + esc(t('Concurrent containers')) + '</span><input class="ss-input" data-field="containers" type="number" min="1" step="1" value="' + esc(user.container_limit || 1) + '"></label>' +
          '<label class="admin-form-field"><span>' + esc(t('Requests per minute')) + '</span><input class="ss-input" data-field="rate" type="number" min="1" step="1" value="' + esc(user.rate_limit || 1) + '"></label>' +
          '<label class="admin-form-field admin-form-field-wide"><span>' + esc(t('Disk quota (MB)')) + '</span><input class="ss-input" data-field="disk" type="number" min="0" step="1" value="' + esc(Math.max(0, user.disk_quota_mb || 0)) + '"><small>' + esc(t('Use 0 for unlimited disk storage.')) + '</small></label>' +
          '</div><div class="admin-dialog-error" role="alert"></div></div>' +
        '<div class="ss-foot"><button type="button" class="ss-btn ss-btn-ghost admin-dialog-cancel">' + esc(t('Cancel')) + '</button>' +
          '<button type="button" class="ss-btn ss-btn-primary admin-quota-save">' + esc(t('Save quota')) + '</button></div>');
      var error = overlay.querySelector('.admin-dialog-error');
      var settled = false;
      function close(value) {
        if (settled) return;
        settled = true;
        removeAdminDialog(overlay);
        resolve(value);
      }
      overlay.querySelector('.admin-dialog-close').addEventListener('click', function() { close(false); });
      overlay.querySelector('.admin-dialog-cancel').addEventListener('click', function() { close(false); });
      overlay.querySelector('.admin-quota-save').addEventListener('click', async function() {
        var containerLimit = Number(overlay.querySelector('[data-field="containers"]').value);
        var rateLimit = Number(overlay.querySelector('[data-field="rate"]').value);
        var diskQuotaMB = Number(overlay.querySelector('[data-field="disk"]').value);
        if (!Number.isInteger(containerLimit) || containerLimit < 1 || !Number.isInteger(rateLimit) || rateLimit < 1 || !Number.isInteger(diskQuotaMB) || diskQuotaMB < 0) {
          error.textContent = t('Enter valid whole-number quota values.');
          return;
        }
        overlay.querySelectorAll('button,input').forEach(function(control) { control.disabled = true; });
        var response;
        try {
          response = await BOBO.sendToServer('updateUserQuota', {
            userId: user.id, containerLimit: containerLimit, rateLimit: rateLimit, diskQuotaMB: diskQuotaMB
          }, { quiet: true });
        } catch (err) {
          error.textContent = (err && err.message) || t('Quota update failed');
          overlay.querySelectorAll('button,input').forEach(function(control) { control.disabled = false; });
          return;
        }
        if (!response || !response.success) {
          error.textContent = (response && response.error) || t('Quota update failed');
          overlay.querySelectorAll('button,input').forEach(function(control) { control.disabled = false; });
          return;
        }
        close(true);
      });
      overlay.addEventListener('click', function(e) { if (e.target === overlay) close(false); });
      overlay.addEventListener('keydown', function(e) { if (e.key === 'Escape') close(false); });
      requestAnimationFrame(function() { overlay.querySelector('[data-field="containers"]').focus(); });
    });
  }

  // 在面板顶部展示一次性密钥（重置密码/新邀请码）
  function showGeneratedSecret(label, secret, pane, hiddenInitially) {
    var old = pane.querySelector('.admin-new-invite');
    if (old) old.remove();
    var box = document.createElement('div');
    box.className = 'admin-new-invite';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">' + esc(label) + '</span>' +
      '<code>' + esc(hiddenInitially ? '************' : secret) + '</code>' +
      (hiddenInitially ? '<button type="button" class="admin-icon-btn admin-secret-reveal" title="' + esc(t('Show password')) + '" aria-label="' + esc(t('Show password')) + '">' + ((BOBO.icons && BOBO.icons.eye) || esc(t('Show'))) + '</button>' : '') +
      '<button type="button" class="admin-icon-btn admin-secret-copy" title="' + esc(t('Copy')) + '" aria-label="' + esc(t('Copy')) + '">' + ((BOBO.icons && BOBO.icons.copy) || esc(t('Copy'))) + '</button>';
    var reveal = box.querySelector('.admin-secret-reveal');
    if (reveal) reveal.addEventListener('click', function() {
      var visible = box.classList.toggle('secret-visible');
      box.querySelector('code').textContent = visible ? secret : '************';
      reveal.innerHTML = (BOBO.icons && BOBO.icons[visible ? 'eyeOff' : 'eye']) || esc(t(visible ? 'Hide' : 'Show'));
      var revealLabel = t(visible ? 'Hide password' : 'Show password');
      reveal.title = revealLabel;
      reveal.setAttribute('aria-label', revealLabel);
    });
    var copy = box.querySelector('.admin-secret-copy');
    copy.addEventListener('click', async function() {
      try {
        await navigator.clipboard.writeText(secret);
        copy.innerHTML = (BOBO.icons && BOBO.icons.check) || esc(t('Copied'));
        copy.title = t('Copied');
        copy.setAttribute('aria-label', t('Copied'));
      } catch (err) {
        copy.title = t('Copy failed');
        copy.setAttribute('aria-label', t('Copy failed'));
        global.alert(t('Copy failed'));
      }
    });
    pane.insertBefore(box, pane.firstChild);
  }

  async function loadInvites() {
    var list = $('invite-list');
    list.innerHTML = '<div class="admin-loading">Loading…</div>';
    var res = await BOBO.sendToServer('listInvites', {}, { quiet: true });
    if (!res || !res.success) {
      list.innerHTML = '<div class="admin-empty">' + esc((res && res.error) || 'Load failed') + '</div>';
      return;
    }
    var invites = res.invites || [];
    if (invites.length === 0) {
      list.innerHTML = '<div class="admin-empty">暂无邀请码 — 使用上方表单生成</div>';
      return;
    }
    invites.sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    var html = '<table class="admin-table"><thead><tr>' +
      '<th>邀请码</th><th>角色</th><th>使用</th><th>过期时间</th><th>创建者</th><th style="text-align:right">操作</th>' +
      '</tr></thead><tbody>';
    invites.forEach(function(inv) {
      var expired = new Date(inv.expires_at) < new Date();
      var usedUp = inv.max_uses > 0 && inv.used_count >= inv.max_uses;
      var status = expired ? '<span class="admin-disabled-tag">已过期</span>'
        : usedUp ? '<span class="admin-disabled-tag">已用完</span>' : '';
      html += '<tr>' +
        '<td><code style="font-family:monospace;color:var(--green)">' + esc(inv.code) + '</code> ' + status + '</td>' +
        '<td><span class="admin-role-badge admin-role-' + esc(inv.role) + '">' + esc(inv.role) + '</span></td>' +
        '<td style="color:var(--text-dim)">' + (inv.used_count || 0) + ' / ' + (inv.max_uses || 1) + '</td>' +
        '<td style="color:var(--text-dim)">' + new Date(inv.expires_at).toLocaleString() + '</td>' +
        '<td style="color:var(--text-dim)">' + esc(inv.created_by || '-') + '</td>' +
        '<td><div class="admin-row-actions"><button class="admin-mini-btn danger" data-code="' + esc(inv.code) + '">撤销</button></div></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    list.innerHTML = html;
    list.querySelectorAll('button[data-code]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        btn.disabled = true;
        await BOBO.sendToServer('revokeInvite', { inviteCode: btn.dataset.code }, { quiet: true });
        loadInvites();
      });
    });
  }

  async function createInvite() {
    var role = $('invite-role').value;
    var maxUses = parseInt($('invite-maxuses').value) || 1;
    var hours = parseInt($('invite-hours').value) || 168;
    var res = await BOBO.sendToServer('createInvite', {
      role: role, maxUses: maxUses, expiresInHours: hours
    }, { quiet: true });
    if (!res || !res.success) {
      global.alert((res && res.error) || '生成失败');
      return;
    }
    showGeneratedSecret('新邀请码（点击复制，发给新用户）', res.inviteCode, $('admin-pane-invites'));
    loadInvites();
  }

  async function loadAudit() {
    var pane = $('admin-pane-audit');
    pane.innerHTML = '<div class="admin-loading">加载中…</div>';
    var res = await BOBO.sendToServer('listAuditLog', { limit: 200 }, { quiet: true });
    if (!res || !res.success) {
      pane.innerHTML = '<div class="admin-empty">' + esc((res && res.error) || '加载失败') + '</div>';
      return;
    }
    var events = res.events || [];
    if (events.length === 0) {
      pane.innerHTML = '<div class="admin-empty">暂无审计事件</div>';
      return;
    }
    var html = '';
    events.forEach(function(e) {
      var time = e.time ? new Date(e.time).toLocaleString() : '';
      var detail = [e.target, e.detail, e.ip].filter(Boolean).join(' · ');
      html += '<div class="audit-row">' +
        '<span class="audit-dot ' + (e.success ? 'ok' : 'fail') + '"></span>' +
        '<span class="audit-action">' + esc(e.action) + '</span>' +
        '<span class="audit-who">' + esc(e.username || e.user_id || '-') + '</span>' +
        '<span class="audit-detail">' + esc(detail) + '</span>' +
        '<span class="audit-time">' + esc(time) + '</span>' +
      '</div>';
    });
    pane.innerHTML = html;
  }

  // ──── 初始化：探测模式 → 尝试免登 ────
  async function init() {
    // 读取服务器配置（auth 需要 ip；runner.loadServerSettings 也会读，值相同）
    try {
      S.serverSettings = await global.api.readServerSettings();
    } catch (e) { console.error('readServerSettings:', e); }
    bindUI();
    if (!S.serverSettings.ip) { renderChip(); return; }
    await detectModeAndAuth();
  }

  async function detectModeAndAuth() {
    var res = await BOBO.sendToServer('serverInfo', {}, { quiet: true });
    if (!res || !res.success) {
      // 服务器不可达：清除旧握手，避免服务器切换后沿用过期能力。
      S.auth.mode = 'unknown';
      if (BOBO.serverCapabilities && typeof BOBO.serverCapabilities.clear === 'function') {
        BOBO.serverCapabilities.clear('probe-failed');
      } else {
        S.serverCapabilities = null;
      }
      renderChip();
      return res || { success: false, error: 'Connection failed' };
    }
    var capabilities = BOBO.serverCapabilities && BOBO.serverCapabilities.applyServerInfo
      ? BOBO.serverCapabilities.applyServerInfo(res, 'server-info')
      : null;
    if (capabilities && capabilities.state === 'incompatible') {
      S.auth.mode = 'unknown';
      S.auth.serverVersion = '';
      renderChip();
      return {
        success: false,
        error: t('The server returned an invalid response. Check the server address and transport setting.'),
        errorCode: 'server_capabilities_incompatible'
      };
    }
    if (capabilities && BOBO.serverCapabilities.requiresSecureTransport &&
      BOBO.serverCapabilities.requiresSecureTransport(capabilities, S.serverSettings)) {
      if (typeof BOBO.serverCapabilities.clear === 'function') BOBO.serverCapabilities.clear('secure-transport-required');
      S.auth.mode = 'unknown';
      S.auth.serverVersion = '';
      renderChip();
      return {
        success: false,
        error: t('The server requires HTTPS, but secure transport is disabled in Server Settings.'),
        errorCode: 'secure_transport_required'
      };
    }
    S.auth.mode = res.authMode || 'single';
    S.auth.serverVersion = res.version || '';
    if (S.auth.mode !== 'multi') {
      dropCredential();
      renderChip();
      if (BOBO.serverCapabilities && typeof BOBO.serverCapabilities.notify === 'function') {
        BOBO.serverCapabilities.notify('auth-ready');
      }
      return res;
    }
    // 多人模式：尝试本地计时凭证免登
    var cred = await loadCredential();
    if (cred && cred.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
      applyCredential(cred);
      renderChip();
      // 后台校验（失败不打扰：401 才清除，网络错误保留）
      var who = await BOBO.sendToServer('whoami', {}, { quiet: true });
      if (who && who.success) {
        S.auth.user = who.user;
        saveCredential(S.auth.token, S.auth.expiresAt, who.user);
        renderChip();
        if (BOBO.serverCapabilities && typeof BOBO.serverCapabilities.notify === 'function') {
          BOBO.serverCapabilities.notify('auth-restored');
        }
        // 免登自动登录成功后补齐运行时列表（multi 模式下需要 token 才能拿到）
        if (BOBO.runtime && BOBO.runtime.fetchRuntimes) BOBO.runtime.fetchRuntimes();
      } else if (who && who.status === 401) {
        handleAuthExpired();
      }
      return res;
    }
    dropCredential();
    renderChip();
    openAuthModal();
    return res;
  }

  // 服务器设置变更后重新探测（由 app.js 保存设置后调用）
  async function onServerChanged(options) {
    closeAdmin();
    if (BOBO.terminal && typeof BOBO.terminal.close === 'function') await BOBO.terminal.close('server-change');
    if (BOBO.dap && typeof BOBO.dap.abort === 'function') await BOBO.dap.abort('server-change');
    if (!(options && options.runInvalidated) && BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      await BOBO.runner.invalidateRunIdentity();
    }
    dropCredential();
    S.auth.mode = 'unknown';
    if (BOBO.serverCapabilities && typeof BOBO.serverCapabilities.clear === 'function') {
      BOBO.serverCapabilities.clear('server-change');
    } else {
      S.serverCapabilities = null;
    }
    renderChip();
    var result = await detectModeAndAuth();
    if (BOBO.lsp && typeof BOBO.lsp.credentialsChanged === 'function') {
      await BOBO.lsp.credentialsChanged();
    }
    return result;
  }

  // ──── UI 事件绑定（幂等） ────
  var uiBound = false;
  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    $('auth-tab-login').addEventListener('click', function() { switchTab('login'); });
    $('auth-tab-register').addEventListener('click', function() { switchTab('register'); });
    $('auth-submit').addEventListener('click', function() {
      if (currentTab === 'login') submitLogin(); else submitRegister();
    });
    // 回车提交
    $('auth-overlay').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (currentTab === 'login') submitLogin(); else submitRegister();
      }
    });
    $('auth-skip').addEventListener('click', function() {
      closeAuthModal();
      BOBO.updateRunOutput('Skipped login — local editor only. Cloud compile requires login (click the status-bar button).');
      renderChip();
    });

    $('auth-chip').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleMenu();
    });
    $('auth-menu-logout').addEventListener('click', doLogout);
    $('auth-menu-chpwd').addEventListener('click', openChpwd);
    $('auth-menu-admin').addEventListener('click', function() { openAdmin('users'); });

    // 修改密码弹窗
    $('chpwd-cancel').addEventListener('click', closeChpwd);
    $('chpwd-close-x').addEventListener('click', closeChpwd);
    $('chpwd-save').addEventListener('click', submitChpwd);
    $('chpwd-modal').addEventListener('click', function(e) {
      if (e.target === $('chpwd-modal')) closeChpwd();
    });

    // 管理面板
    $('admin-close-x').addEventListener('click', closeAdmin);
    $('admin-modal').addEventListener('click', function(e) {
      if (!e.target.closest('.admin-row-actions')) closeAdminActionMenus();
      if (e.target === $('admin-modal')) closeAdmin();
    });
    $('admin-modal').querySelector('.admin-body').addEventListener('scroll', function() { closeAdminActionMenus(); });
    global.addEventListener('resize', function() { closeAdminActionMenus(); });
    document.querySelectorAll('#admin-modal .admin-tab').forEach(function(t) {
      t.addEventListener('click', function() { switchAdminTab(t.dataset.pane); });
      t.addEventListener('keydown', function(e) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        var tabs = Array.prototype.slice.call(document.querySelectorAll('#admin-modal .admin-tab'));
        var index = tabs.indexOf(t);
        var next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
          : e.key === 'ArrowLeft' ? (index <= 0 ? tabs.length - 1 : index - 1)
            : (index + 1) % tabs.length;
        tabs[next].focus();
        switchAdminTab(tabs[next].dataset.pane);
      });
    });
    global.addEventListener('bobo:language-changed', function() {
      if (!$('admin-modal').classList.contains('open')) return;
      var activeTab = $('admin-modal').querySelector('.admin-tab.active');
      switchAdminTab(activeTab ? activeTab.dataset.pane : 'users');
    });
    $('invite-create').addEventListener('click', createInvite);

    // 顶部菜单 Account → Login / Register（选了"暂不登录"后也可从这里进入）
    if (global.api && typeof global.api.onOpenAuthLogin === 'function') {
      global.api.onOpenAuthLogin(function() {
        if (S.auth.mode === 'multi') {
          if (S.auth.user && S.auth.token) {
            toggleMenu(); // 已登录 → 打开用户菜单
          } else {
            openAuthModal();
          }
        } else if (S.auth.mode === 'single') {
          BOBO.updateRunOutput(t('Server is in single-user mode — no login required.'));
        } else {
          BOBO.updateRunOutput(t('Unable to reach the configured server. Check Server Settings and try again.'));
        }
      });
    }
    // 顶部菜单 Account → Logout
    if (global.api && typeof global.api.onAuthLogoutRequest === 'function') {
      global.api.onAuthLogoutRequest(function() {
        if (S.auth.user && S.auth.token) doLogout();
      });
    }
    // 顶部"管理"菜单 -> 打开管理面板并切换到指定标签（仅管理员可见该菜单）
    if (global.api && typeof global.api.onOpenAdminPanel === 'function') {
      global.api.onOpenAdminPanel(function(data) {
        var tab = (data && data.tab) || 'users';
        var user = S.auth.user;
        if (user && S.auth.token && (user.role === 'admin' || user.role === 'root')) {
          openAdmin(tab);
        } else if (S.auth.mode === 'multi') {
          openAuthModal('该功能仅管理员可用，请先登录管理员账户');
        } else {
          BOBO.updateRunOutput('Admin panel requires multi-user mode.');
        }
      });
    }
  }

  BOBO.auth = {
    init: init,
    onServerChanged: onServerChanged,
    handleAuthExpired: handleAuthExpired,
    openAuthModal: openAuthModal,
    renderChip: renderChip
  };
})(window);
