// src/auth.js — Cloud account: login/register UI, local timed credential,
// user chip + menu, change password, admin panel (users/invites/audit).
//
// 设计要点：
// - 本地凭证存于 userData/auth.json（按服务器 IP 隔离），未过期则启动免登
// - 多人模式未登录时：本地编辑完全可用，云功能（同步/运行/终端）被 401 拦截并引导登录
// - 单机模式（serverInfo authMode=single）：不显示任何账户 UI
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── 工具 ────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function show(el) { el.classList.add('show'); }
  function hide(el) { el.classList.remove('show'); }

  // Electron 不支持 window.prompt()，用自定义弹窗替代
  function customPrompt(title, defaultValue) {
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.55);display:flex;justify-content:center;align-items:center';
      var card = document.createElement('div');
      card.className = 'ss-card';
      card.style.cssText = 'width:380px;max-width:92vw';
      card.innerHTML =
        '<div class="ss-head"><div class="ss-title">' + esc(title) + '</div></div>' +
        '<div class="ss-body" style="gap:10px"><div class="ss-field">' +
        '<input class="ss-input" type="text" inputmode="numeric" value="' + esc(String(defaultValue || '')) + '" style="font-size:15px" spellcheck="false">' +
        '</div></div>' +
        '<div class="ss-foot"><button class="ss-btn ss-btn-ghost cancel">Cancel</button>' +
        '<button class="ss-btn ss-btn-primary ok">OK</button></div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var input = card.querySelector('input');
      // 用 rAF 代替 setTimeout，确保在下一帧聚焦+选中文本
      requestAnimationFrame(function() {
        input.focus();
        input.select();
      });
      function close(val) { document.body.removeChild(overlay); resolve(val); }
      card.querySelector('.cancel').addEventListener('click', function() { close(null); });
      card.querySelector('.ok').addEventListener('click', function() { close(input.value); });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        if (e.key === 'Escape') { close(null); }
      });
      overlay.addEventListener('click', function(e) { if (e.target === overlay) close(null); });
    });
  }

  var TOKEN_EXPIRY_MARGIN_MS = 60 * 1000; // 距到期不足 1 分钟视为已过期

  // ──── 本地凭证（经 main 进程持久化到 userData/auth.json）────
  async function loadCredential(serverIp) {
    try {
      var cred = await global.api.authGet(serverIp);
      if (cred && cred.token && cred.expiresAt) return cred;
    } catch (e) { console.error('authGet:', e); }
    return null;
  }
  async function saveCredential(serverIp, token, expiresAt, user) {
    try {
      await global.api.authSet(serverIp, {
        token: token,
        expiresAt: expiresAt,
        user: user
      });
    } catch (e) { console.error('authSet:', e); }
  }
  async function clearCredential(serverIp) {
    try { await global.api.authClear(serverIp); } catch (e) { console.error('authClear:', e); }
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
    if (BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      await BOBO.runner.invalidateRunIdentity();
    }
    var expiresAt = res.expiresAt ? new Date(res.expiresAt).getTime() : (Date.now() + 30 * 24 * 3600 * 1000);
    applyCredential({ token: res.token, expiresAt: expiresAt, user: res.user });
    await saveCredential(S.serverSettings.ip, res.token, expiresAt, res.user);
    closeAuthModal();
    renderChip();
    if (BOBO.lsp && BOBO.lsp.credentialsChanged) BOBO.lsp.credentialsChanged();
    BOBO.updateRunOutput('Logged in as ' + (res.user.username || res.user.id) +
      ' (role: ' + (res.user.role || 'member') + ')');
    // 登录后补齐运行时列表（此前 401 拿不到）
    if (BOBO.runtime && BOBO.runtime.fetchRuntimes) BOBO.runtime.fetchRuntimes();
  }

  // ──── 凭证过期 / 被吊销 ────
  async function handleAuthExpired() {
    if (S.auth.mode !== 'multi') return;
    var debugStopped = BOBO.dap && typeof BOBO.dap.abort === 'function'
      ? BOBO.dap.abort('auth-expired')
      : Promise.resolve();
    if (BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      BOBO.runner.invalidateRunIdentity({ skipHttp: true });
    }
    await debugStopped;
    var ip = S.serverSettings.ip;
    dropCredential();
    if (BOBO.lsp && typeof BOBO.lsp.identityChanged === 'function') BOBO.lsp.identityChanged();
    if (ip) clearCredential(ip);
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
    if (BOBO.workspace && BOBO.workspace.canLeaveWorkspace) {
      var allowed = await BOBO.workspace.canLeaveWorkspace({ reason: 'logout' });
      if (!allowed) return false;
    }
    if (BOBO.dap && typeof BOBO.dap.abort === 'function') await BOBO.dap.abort('logout');
	if (BOBO.collaboration && BOBO.collaboration.releaseForLogout) {
	  await BOBO.collaboration.releaseForLogout();
	}
    if (S.auth.token) {
      await BOBO.sendToServer('logout', {}, { quiet: true });
    }
    var ip = S.serverSettings.ip;
    dropCredential();
    if (BOBO.lsp && typeof BOBO.lsp.identityChanged === 'function') BOBO.lsp.identityChanged();
    if (ip) await clearCredential(ip);
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
  function openAdmin(tab) {
    closeMenu();
    $('admin-modal').classList.add('open');
    switchAdminTab(tab || 'users');
    // root 才能发管理员邀请
    $('invite-role-admin').style.display =
      (S.auth.user && S.auth.user.role === 'root') ? '' : 'none';
  }
  function closeAdmin() { $('admin-modal').classList.remove('open'); }

  function switchAdminTab(name) {
    var tabs = document.querySelectorAll('#admin-modal .admin-tab');
    tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.pane === name); });
    document.querySelectorAll('#admin-modal .admin-pane').forEach(function(p) {
      p.classList.toggle('active', p.id === 'admin-pane-' + name);
    });
    if (name === 'users') loadUsers();
    if (name === 'invites') loadInvites();
    if (name === 'audit') loadAudit();
  }

  async function loadUsers() {
    var pane = $('admin-pane-users');
    pane.innerHTML = '<div class="admin-loading">Loading…</div>';
    var res = await BOBO.sendToServer('listUsers', {}, { quiet: true });
    if (!res || !res.success) {
      pane.innerHTML = '<div class="admin-empty">' + esc((res && res.error) || 'Load failed') + '</div>';
      return;
    }
    var myRole = S.auth.user ? S.auth.user.role : 'member';
    var html = '<table class="admin-table"><thead><tr>' +
      '<th>User</th><th>Email</th><th>Role</th><th>Quota</th><th>Disk</th><th>Created</th><th style="text-align:right">Actions</th>' +
      '</tr></thead><tbody>';
    (res.users || []).forEach(function(u) {
      var roleBadge = '<span class="admin-role-badge admin-role-' + esc(u.role || 'member') + '">' +
        esc(u.role || 'member') + '</span>';
      var disabledTag = u.disabled ? '<span class="admin-disabled-tag">Disabled</span>' : '';
      var created = u.created_at ? new Date(u.created_at).toLocaleDateString() : '-';
      var diskQuota = u.disk_quota_mb > 0 ? (u.disk_quota_mb + ' MB') : '∞';
      html += '<tr>' +
        '<td><strong>' + esc(u.username || u.id) + '</strong>' + disabledTag + '</td>' +
        '<td style="color:var(--text-dim)">' + esc(u.email || '-') + '</td>' +
        '<td>' + roleBadge + '</td>' +
        '<td style="color:var(--text-dim)">' + (u.container_limit || 0) + ' containers</td>' +
        '<td style="color:var(--text-dim)">' + diskQuota + '</td>' +
        '<td style="color:var(--text-dim)">' + created + '</td>' +
        '<td><div class="admin-row-actions" data-uid="' + esc(u.id) + '" data-role="' + esc(u.role || 'member') + '" data-disabled="' + (u.disabled ? '1' : '0') + '">' +
          buildUserActions(u, myRole) +
        '</div></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    pane.innerHTML = html;
    bindUserActions(pane);
  }

  function buildUserActions(u, myRole) {
    var isRoot = u.role === 'root';
    if (isRoot) return '<span style="color:var(--text-dim);font-size:11px">—</span>';
    var btns = [];
    // admin 只能管 member；root 能管所有人
    var canManage = (myRole === 'root') || (myRole === 'admin' && u.role === 'member');
    if (!canManage) return '<span style="color:var(--text-dim);font-size:11px">—</span>';
    btns.push('<button class="admin-mini-btn" data-act="reset">Reset password</button>');
    btns.push('<button class="admin-mini-btn" data-act="setdisk">Set disk quota</button>');
    btns.push(u.disabled
      ? '<button class="admin-mini-btn" data-act="enable">Enable</button>'
      : '<button class="admin-mini-btn warn" data-act="disable">Disable</button>');
    if (myRole === 'root') {
      btns.push(u.role === 'admin'
        ? '<button class="admin-mini-btn" data-act="demote">Demote to member</button>'
        : '<button class="admin-mini-btn" data-act="promote">Promote to admin</button>');
      btns.push('<button class="admin-mini-btn danger" data-act="delete">Delete</button>');
    }
    return btns.join('');
  }

  function bindUserActions(pane) {
    pane.querySelectorAll('.admin-row-actions button').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var row = btn.closest('.admin-row-actions');
        var uid = row.dataset.uid;
        var act = btn.dataset.act;
        btn.disabled = true;
        var cancelled = false;
        try {
          if (act === 'disable' || act === 'enable') {
            var res = await BOBO.sendToServer('setUserDisabled',
              { userId: uid, disabled: act === 'disable' }, { quiet: true });
            if (!res || !res.success) global.alert((res && res.error) || 'Operation failed');
          } else if (act === 'reset') {
            var res2 = await BOBO.sendToServer('resetUserPassword', { userId: uid }, { quiet: true });
            if (res2 && res2.success && res2.newPassword) {
              showGeneratedSecret('New password for ' + uid + ' (shown only once, deliver immediately)', res2.newPassword, $('admin-pane-users'));
            } else {
              global.alert((res2 && res2.error) || 'Reset failed');
            }
          } else if (act === 'setdisk') {
            var inputVal = await customPrompt('Set disk quota (MB) for ' + uid + ' (0 = unlimited)', '2048');
            if (inputVal === null) { cancelled = true; btn.disabled = false; return; }
            var mb = parseInt(inputVal, 10);
            if (isNaN(mb) || mb < 0) { global.alert('Invalid value'); btn.disabled = false; return; }
            var res5 = await BOBO.sendToServer('updateUserQuota', { userId: uid, diskQuotaMB: mb }, { quiet: true });
            if (!res5 || !res5.success) global.alert((res5 && res5.error) || 'Update failed');
            else BOBO.updateRunOutput('Disk quota for ' + uid + ' set to ' + (mb > 0 ? mb + ' MB' : 'unlimited'));
          } else if (act === 'promote' || act === 'demote') {
            var role = act === 'promote' ? 'admin' : 'member';
            var res3 = await BOBO.sendToServer('setUserRole', { userId: uid, role: role }, { quiet: true });
            if (!res3 || !res3.success) global.alert((res3 && res3.error) || 'Operation failed');
          } else if (act === 'delete') {
            var okDel = await BOBO.confirm({
              title: 'Delete user',
              message: 'Delete user ' + uid + '?\nThis will permanently delete their files, cache, and containers.',
              confirmLabel: 'Delete',
              danger: true
            });
            if (!okDel) { cancelled = true; btn.disabled = false; return; }
            var res4 = await BOBO.sendToServer('deleteUser', { userId: uid }, { quiet: true });
            if (!res4 || !res4.success) global.alert((res4 && res4.error) || 'Delete failed');
          }
        } finally {
          if (!cancelled) loadUsers();
        }
      });
    });
  }

  // 在面板顶部展示一次性密钥（重置密码/新邀请码）
  function showGeneratedSecret(label, secret, pane) {
    var old = pane.querySelector('.admin-new-invite');
    if (old) old.remove();
    var box = document.createElement('div');
    box.className = 'admin-new-invite';
    box.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">' + esc(label) + '</span>' +
      '<code>' + esc(secret) + '</code>' +
      '<button class="admin-copy-btn">Copy</button>';
    box.querySelector('.admin-copy-btn').addEventListener('click', function() {
      navigator.clipboard.writeText(secret);
      box.querySelector('.admin-copy-btn').textContent = 'Copied';
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
      // 服务器不可达：不改变已有状态；云功能调用时会自然报错
      S.auth.mode = 'unknown';
      renderChip();
      return res || { success: false, error: 'Connection failed' };
    }
    S.auth.mode = res.authMode || 'single';
    S.auth.serverVersion = res.version || '';
    if (S.auth.mode !== 'multi') {
      dropCredential();
      renderChip();
      return res;
    }
    // 多人模式：尝试本地计时凭证免登
    var cred = await loadCredential(S.serverSettings.ip);
    if (cred && cred.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
      applyCredential(cred);
      renderChip();
      // 后台校验（失败不打扰：401 才清除，网络错误保留）
      var who = await BOBO.sendToServer('whoami', {}, { quiet: true });
      if (who && who.success) {
        S.auth.user = who.user;
        saveCredential(S.serverSettings.ip, S.auth.token, S.auth.expiresAt, who.user);
        renderChip();
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
    if (BOBO.dap && typeof BOBO.dap.abort === 'function') await BOBO.dap.abort('server-change');
    if (!(options && options.runInvalidated) && BOBO.runner && typeof BOBO.runner.invalidateRunIdentity === 'function') {
      await BOBO.runner.invalidateRunIdentity();
    }
    dropCredential();
    S.auth.mode = 'unknown';
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
    $('auth-menu-admin').addEventListener('click', openAdmin);

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
      if (e.target === $('admin-modal')) closeAdmin();
    });
    document.querySelectorAll('#admin-modal .admin-tab').forEach(function(t) {
      t.addEventListener('click', function() { switchAdminTab(t.dataset.pane); });
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
        } else {
          BOBO.updateRunOutput('Server is in single-user mode — no login required.');
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
