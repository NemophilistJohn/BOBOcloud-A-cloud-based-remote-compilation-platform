// src/collaboration.js - Team identity, cloud mappings, Git workflow and cache UI.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;
  var selectedTeamId = '';
  var selectedDetail = null;
  var actionConfirm = null;
  var chosenAvatar = 'ocean';
  var lockRefreshTimer = null;
  var hubReturnFocus = null;
  var selectedInvites = null;
  var selectedCacheInfo = null;
  var workbenchCacheInfo = null;
  var lockRefreshInFlight = false;
  var heldFileLocks = Object.create(null);
  var blockedFileLocks = Object.create(null);
  var fileLockRequests = Object.create(null);
  var FILE_LOCK_TTL_MINUTES = 2;
  var FILE_LOCK_HEARTBEAT_MS = 30 * 1000;

  function $(id) { return document.getElementById(id); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function t(key, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(key, params);
    return String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }
  function bindText(element, key, params, options) {
    if (!element) return element;
    if (BOBO.i18n && BOBO.i18n.bindText) return BOBO.i18n.bindText(element, key, params, options);
    options = options || {};
    element.textContent = String(options.prefix || '') + t(key, params) + String(options.suffix || '');
    return element;
  }
  function bindAttribute(element, attribute, key, params) {
    if (!element) return element;
    if (BOBO.i18n && BOBO.i18n.bindAttribute) return BOBO.i18n.bindAttribute(element, attribute, key, params);
    element.setAttribute(attribute, t(key, params));
    return element;
  }
  function setRawText(element, value) {
    if (!element) return;
    if (BOBO.i18n && BOBO.i18n.unbind) BOBO.i18n.unbind(element);
    element.textContent = value;
  }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function initials(value) {
    var parts = String(value || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function avatarMarkup(user, className) {
    var avatar = user && user.avatar || 'graphite';
    var name = user && (user.name || user.username || user.uid) || '?';
    if (avatar.indexOf('data:image/') === 0) {
      return '<span class="' + className + '"><img src="' + esc(avatar) + '" alt=""></span>';
    }
    return '<span class="' + className + ' avatar-' + esc(avatar) + '">' + esc(initials(name)) + '</span>';
  }
  function notify(message, type) {
    if (BOBO.toast && BOBO.toast[type || 'info']) BOBO.toast[type || 'info'](t(message));
  }
  function legacyCollaborationErrorCode(message) {
    message = String(message || '').toLowerCase();
    if (message.indexOf('commit is pending') >= 0 || message.indexOf('non-fast-forward') >= 0 || message.indexOf('push was rejected') >= 0) return 'push_conflict';
    if (message.indexOf('remote changes conflict') >= 0 || message.indexOf('conflict files') >= 0) return 'merge_conflict';
    if (message.indexOf('no changes to commit') >= 0) return 'no_changes';
    if (message.indexOf('being edited by') >= 0) return 'lock_held';
    return '';
  }
  function lockMinutesRemaining(lock) {
    var expires = lock && Date.parse(lock.expires_at || lock.expiresAt || '');
    if (!Number.isFinite(expires)) return 0;
    return Math.max(0, Math.ceil((expires - Date.now()) / 60000));
  }
  function lockSecondsRemaining(lock) {
    var expires = lock && Date.parse(lock.expires_at || lock.expiresAt || '');
    if (!Number.isFinite(expires)) return 0;
    return Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  }
  function lockTimeLabel(lock) {
    var seconds = lockSecondsRemaining(lock);
    if (!seconds) return t('expired');
    if (seconds < 60) return t('{seconds}s remaining', { seconds: seconds });
    return t('{minutes}m {seconds}s remaining', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  }
  function heldLockKey(filePath) {
    return String(filePath || '').replace(/\\/g, '/').toLowerCase();
  }
  function clientIsForeground() {
    if (document.hidden === true) return false;
    return typeof document.hasFocus !== 'function' || document.hasFocus();
  }
  function setCollaborationReadOnly(readOnly) {
    var locked = readOnly === true || S.workspaceTransitionLocked === true;
    if (S.editor && typeof S.editor.updateOptions === 'function') S.editor.updateOptions({ readOnly: locked });
    if (S.splitEditor && typeof S.splitEditor.updateOptions === 'function') S.splitEditor.updateOptions({ readOnly: true });
    if (S.splitEditor && S.splitEditor.rightEditor && typeof S.splitEditor.rightEditor.updateOptions === 'function') {
      S.splitEditor.rightEditor.updateOptions({ readOnly: locked });
    }
  }
  function renderActiveLockStatus() {
    var badge = $('team-project-badge');
    if (!badge || !S.collaboration.current) return;
    if (!relativeCurrentPath(S.activeTabPath)) {
      var inactiveStatus = badge.querySelector('.team-lock-status');
      if (inactiveStatus) setRawText(inactiveStatus, '');
      setCollaborationReadOnly(false);
      return;
    }
    var key = heldLockKey(S.activeTabPath);
    var held = heldFileLocks[key];
    var blocked = blockedFileLocks[key];
    var status = badge.querySelector('.team-lock-status');
    if (!status) return;
    if (blocked) {
      var lock = blocked.lock || {};
      var owner = lock.user_name || lock.userName;
      status.className = 'team-lock-status is-readonly';
      if (owner) {
        setRawText(status, t('Read-only · {owner} · {remaining}', { owner: owner, remaining: lockTimeLabel(lock) }));
      } else {
        bindText(status, 'Read-only · reconnecting');
      }
      setCollaborationReadOnly(true);
      return;
    }
    if (held) {
      status.className = 'team-lock-status is-editing';
      setRawText(status, t('Editing · {remaining}', { remaining: lockTimeLabel(held) }));
      setCollaborationReadOnly(false);
      return;
    }
    status.className = 'team-lock-status';
    bindText(status, 'Lock pending');
    setCollaborationReadOnly(true);
  }
  function collaborationErrorMessage(error) {
    var code = error && (error.code || legacyCollaborationErrorCode(error.rawMessage || error.message));
    var details = error && error.details || {};
    if (code === 'push_conflict') {
      return t('Another teammate updated this branch while your commit was being published. Your cloud commit is still saved. Wait a moment, then choose Commit & push again.');
    }
    if (code === 'merge_conflict') {
      var count = Number(details.conflictCount || 0);
      return count > 0
        ? t('{count} files conflict with newer cloud changes. Open the conflict panel, resolve them, then complete the merge.', { count: count })
        : t('Your changes conflict with newer cloud changes. Open the conflict panel, resolve the files, then complete the merge.');
    }
    if (code === 'no_changes') {
      return t('No changes are ready to commit. Edit or upload a file first.');
    }
    if (code === 'lock_held') {
      var lock = details.lock || {};
      var user = lock.user_name || lock.userName || t('another teammate');
      var file = lock.path || t('This file');
      var minutes = lockMinutesRemaining(lock);
      if (minutes > 0) {
        return t('{file} is being edited by {user}. The file is read-only until their lock expires in about {minutes} minutes.', { file: file, user: user, minutes: minutes });
      }
      return t('{file} is being edited by {user}. The file is read-only while their lock is active.', { file: file, user: user });
    }
    if (code === 'lock_stale') {
      return t('This file lock was replaced by a newer editing session. Refresh the team view; the newer lock was not released.');
    }
    return t(error && error.rawMessage || error && error.message || 'Request failed');
  }
  async function api(action, data) {
    var result = await BOBO.sendToServer(action, data || {}, { quiet: true });
    if (!result || !result.success) {
      var error = new Error(result && result.error || t('Request failed'));
      error.rawMessage = error.message;
      error.code = result && result.errorCode || legacyCollaborationErrorCode(error.message);
      error.details = result && result.details || {};
      error.status = result && result.status;
      error.message = collaborationErrorMessage(error);
      throw error;
    }
    return result.data;
  }
  function formatBytes(bytes) {
    bytes = Number(bytes || 0);
    if (bytes < 1000) return bytes + ' B';
    if (bytes < 1e6) return (bytes / 1000).toFixed(1) + ' KB';
    if (bytes < 1e9) return (bytes / 1e6).toFixed(1) + ' MB';
    return (bytes / 1e9).toFixed(2) + ' GB';
  }
  function currentUser() { return S.auth && S.auth.user; }
  function requireLogin() {
    if (!(S.auth && S.auth.user && S.auth.token)) {
      if (BOBO.auth) BOBO.auth.openAuthModal(t('Sign in to use team workspaces'));
      return false;
    }
    return true;
  }

  // ─── Profile ───────────────────────────────────────────────
  function renderProfileAvatar() {
    var user = Object.assign({}, currentUser() || {}, { avatar: chosenAvatar, name: $('profile-name').value });
    $('profile-avatar-preview').outerHTML = avatarMarkup(user, 'profile-avatar-preview').replace('<span ', '<span id="profile-avatar-preview" ');
    document.querySelectorAll('.profile-avatar-swatch').forEach(function(el) {
      el.classList.toggle('selected', el.getAttribute('data-avatar') === chosenAvatar);
    });
  }
  function openProfile() {
    if (!requireLogin()) return;
    var user = currentUser();
    $('profile-name').value = user.name || user.username || '';
    $('profile-uid').textContent = user.uid || '';
    chosenAvatar = user.avatar || 'graphite';
    var presets = ['ocean', 'forest', 'coral', 'violet', 'graphite', 'amber'];
    $('profile-avatar-options').innerHTML = presets.map(function(preset) {
      return '<button class="profile-avatar-swatch avatar-' + preset + '" data-avatar="' + preset + '" title="' + preset + '"></button>';
    }).join('');
    renderProfileAvatar();
    $('profile-modal').classList.add('open');
  }
  function closeProfile() { $('profile-modal').classList.remove('open'); }
  function chooseAvatarFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      notify('Choose a PNG, JPEG, WebP or GIF image under 5 MB', 'error');
      return;
    }
    var objectURL = URL.createObjectURL(file);
    var image = new Image();
    image.onload = function() {
      try {
        var size = 128;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var context = canvas.getContext('2d');
        context.fillStyle = '#1c222b';
        context.fillRect(0, 0, size, size);
        var scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
        var width = image.naturalWidth * scale;
        var height = image.naturalHeight * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        chosenAvatar = canvas.toDataURL('image/jpeg', 0.82);
        renderProfileAvatar();
      } finally {
        URL.revokeObjectURL(objectURL);
      }
    };
    image.onerror = function() {
      URL.revokeObjectURL(objectURL);
      notify('The selected image could not be read', 'error');
    };
    image.src = objectURL;
  }
  async function saveProfile() {
    try {
      var result = await BOBO.sendToServer('updateProfile', { name: $('profile-name').value.trim(), avatar: chosenAvatar }, { quiet: true });
      if (!result || !result.success) throw new Error(result && result.error || 'Update failed');
      S.auth.user = result.user;
      if (BOBO.auth) BOBO.auth.renderChip();
      closeProfile();
      notify('Profile updated', 'success');
    } catch (err) { notify(err.message, 'error'); }
  }

  // ─── Reusable action dialog ────────────────────────────────
  function closeAction() {
    $('collab-action-modal').classList.remove('open');
    actionConfirm = null;
  }
  function setActionStatus(message, error) {
    var el = $('collab-action-status');
    if (!el) return;
    setRawText(el, message || '');
    el.classList.toggle('error', !!error);
  }
  function setActionStatusKey(key, params, error) {
    var el = $('collab-action-status');
    if (!el) return;
    bindText(el, key, params);
    el.classList.toggle('error', !!error);
  }
  function openAction(title, bodyHTML, confirmText, onConfirm, titleParams) {
    bindText($('collab-action-title'), title, titleParams);
    $('collab-action-body').innerHTML = bodyHTML + '<div id="collab-action-status" class="collab-action-status"></div>';
    bindText($('collab-action-confirm'), confirmText || 'Continue');
    $('collab-action-confirm').disabled = false;
    actionConfirm = onConfirm;
    $('collab-action-modal').classList.add('open');
    var first = $('collab-action-body').querySelector('input,select,textarea');
    if (first) setTimeout(function() { first.focus(); }, 30);
  }
  async function runActionConfirm() {
    if (!actionConfirm) return;
    var btn = $('collab-action-confirm');
    btn.disabled = true;
    setActionStatusKey('Working...', null, false);
    try {
      var shouldClose = await actionConfirm();
      if (shouldClose !== false) closeAction();
    } catch (err) {
      setActionStatus(collaborationErrorMessage(err), true);
    } finally {
      btn.disabled = false;
    }
  }
  function inputField(id, label, value, type) {
    return '<div class="collab-action-field"><label for="' + id + '" data-i18n="' + esc(label) + '">' + esc(t(label)) + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"></div>';
  }
  function textareaField(id, label, value) {
    return '<div class="collab-action-field"><label for="' + id + '" data-i18n="' + esc(label) + '">' + esc(t(label)) + '</label><textarea id="' + id + '" rows="4">' + esc(value || '') + '</textarea></div>';
  }
  function selectField(id, label, options, selected) {
    return '<div class="collab-action-field"><label for="' + id + '" data-i18n="' + esc(label) + '">' + esc(t(label)) + '</label><select id="' + id + '">' + options.map(function(opt) {
      var value = typeof opt === 'string' ? opt : opt.value;
      var text = typeof opt === 'string' ? opt : t(opt.label);
      var i18nKey = typeof opt === 'string' ? '' : ' data-i18n="' + esc(opt.label) + '"';
      return '<option value="' + esc(value) + '"' + i18nKey + (value === selected ? ' selected' : '') + '>' + esc(text) + '</option>';
    }).join('') + '</select></div>';
  }

  // ─── Team center ───────────────────────────────────────────
  async function openHub() {
    if (!requireLogin()) return;
    hubReturnFocus = document.activeElement;
    var modal = $('collab-modal');
    modal.classList.add('open');
    S.collaboration.modalOpen = true;
    $('collab-account-id').textContent = (currentUser().name || currentUser().username) + ' · ' + (currentUser().uid || '');
    setTimeout(function() { modal.focus(); }, 0);
    await loadTeams();
  }
  function closeHub() {
    $('collab-modal').classList.remove('open');
    S.collaboration.modalOpen = false;
    var fallback = $('team-hub-btn');
    if (!fallback || !fallback.getClientRects().length) fallback = $('activity-team');
    var target = hubReturnFocus && hubReturnFocus.isConnected && hubReturnFocus.getClientRects().length ? hubReturnFocus : fallback;
    hubReturnFocus = null;
    if (target && typeof target.focus === 'function') target.focus();
  }

  async function loadTeams(preferTeamId) {
    $('collab-team-list').innerHTML = '<div class="collab-empty" data-i18n="Loading...">' + esc(t('Loading...')) + '</div>';
    try {
      S.collaboration.teams = await api('listTeams');
      renderTeamList();
      var next = preferTeamId || selectedTeamId || (S.collaboration.teams[0] && S.collaboration.teams[0].id);
      if (next) await selectTeam(next);
      else renderNoTeam();
    } catch (err) {
      $('collab-team-list').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
    }
  }
  function renderTeamList() {
    var teams = S.collaboration.teams || [];
    if (!teams.length) { $('collab-team-list').innerHTML = '<div class="collab-empty" data-i18n="No teams yet">' + esc(t('No teams yet')) + '</div>'; return; }
    $('collab-team-list').innerHTML = teams.map(function(team, index) {
      return '<button class="collab-team-item' + (team.id === selectedTeamId ? ' active' : '') + '" data-team-id="' + esc(team.id) + '" data-team-index="' + index + '">' +
        '<span class="team-list-avatar">' + esc(initials(team.name)) + '</span><span><strong>' + esc(team.name) + '</strong><small></small></span></button>';
    }).join('');
    Array.prototype.forEach.call($('collab-team-list').querySelectorAll('[data-team-index]'), function(row) {
      var team = teams[Number(row.getAttribute('data-team-index'))];
      bindText(row.querySelector('small'), '{members} members · {projects} projects', { members: team.member_count, projects: team.project_count });
    });
  }
  function renderNoTeam() {
    selectedTeamId = '';
    selectedDetail = null;
    bindText($('collab-team-name'), 'Create or join a team');
    setRawText($('collab-team-description'), '');
    setRawText($('collab-admin-badge'), '');
    $('collab-project-list').innerHTML = '<div class="collab-empty"></div>';
    bindText($('collab-project-list').querySelector('.collab-empty'), 'No team selected');
    $('collab-member-list').innerHTML = '';
    $('collab-invite-list').innerHTML = '';
    $('collab-cache-view').innerHTML = '';
  }
  async function selectTeam(teamId) {
    selectedTeamId = teamId;
    renderTeamList();
    try {
      selectedDetail = await api('getTeam', { teamId: teamId });
      renderSelectedTeam();
    } catch (err) { notify(err.message, 'error'); }
  }
  function renderSelectedTeam() {
    var detail = selectedDetail;
    if (!detail) return;
    var team = detail.team;
    var isAdmin = team.admin_user_id === currentUser().id;
    setRawText($('collab-team-name'), team.name);
    if (team.description) setRawText($('collab-team-description'), team.description);
    else bindText($('collab-team-description'), 'Team cloud projects');
    bindText($('collab-admin-badge'), isAdmin ? 'TEAM ADMINISTRATOR' : 'TEAM MEMBER');
    detail.projects = asArray(detail.projects);
    detail.members = asArray(detail.members);
    bindText($('collab-project-count'), '{count} cloud projects', { count: detail.projects.length });
    $('collab-new-invite').style.display = isAdmin ? '' : 'none';
    renderProjects(detail.projects, isAdmin);
    renderMembers(detail.members, isAdmin);
    if (isAdmin) loadInvites();
    else $('collab-invite-list').innerHTML = '<div class="collab-empty" data-i18n="Only the team administrator manages invitations">' + esc(t('Only the team administrator manages invitations')) + '</div>';
    loadTeamCache();
  }
  function renderProjects(projects, isAdmin) {
    if (!projects.length) { $('collab-project-list').innerHTML = '<div class="collab-empty" data-i18n="No team projects">' + esc(t('No team projects')) + '</div>'; return; }
    $('collab-project-list').innerHTML = projects.map(function(project) {
      var remove = isAdmin ? '<button class="icon-command collab-delete-project" data-project-id="' + esc(project.id) + '" title="' + esc(t('Delete project')) + '" aria-label="' + esc(t('Delete project')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : '';
      return '<article class="collab-project-card"><div><span class="team-tag">TEAM</span><h3>' + esc(project.name) + '</h3></div><p' + (project.description ? '' : ' data-i18n="No description"') + '>' + esc(project.description || t('No description')) + '</p><div class="project-actions"><span class="project-meta">' + esc(t('default: {branch}', { branch: project.default_branch })) + '</span><span class="project-command-group">' + remove + '<button class="ss-btn ss-btn-primary collab-open-project" data-project-id="' + esc(project.id) + '" data-i18n="Open">' + esc(t('Open')) + '</button></span></div></article>';
    }).join('');
  }
  function renderMembers(members, isAdmin) {
    $('collab-member-list').innerHTML = members.map(function(member) {
      return '<div class="collab-list-row">' + avatarMarkup(member, 'member-avatar') + '<div><div class="collab-row-primary">' + esc(member.name || member.username) + (member.is_admin ? ' · ' + esc(t('Administrator')) : '') + '</div><div class="collab-row-secondary">' + esc(member.uid) + ' · @' + esc(member.username) + '</div></div>' +
        (isAdmin && !member.is_admin ? '<button class="ss-btn ss-btn-ghost collab-remove-member" data-user-id="' + esc(member.user_id) + '" data-i18n="Remove">' + esc(t('Remove')) + '</button>' : '<span></span>') + '</div>';
    }).join('');
  }
  async function loadInvites() {
    try {
      var invites = asArray(await api('listTeamInvites', { teamId: selectedTeamId }));
      selectedInvites = invites;
      renderInvites(invites);
    } catch (err) { $('collab-invite-list').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>'; }
  }
  function renderInvites(invites) {
      if (!invites.length) { $('collab-invite-list').innerHTML = '<div class="collab-empty" data-i18n="No active invitations">' + esc(t('No active invitations')) + '</div>'; return; }
      $('collab-invite-list').innerHTML = invites.map(function(invite, index) {
        var state = invite.revoked ? t('revoked') : (new Date(invite.expires_at) < new Date() ? t('expired') : t('{used}/{maximum} used', { used: invite.used_count, maximum: invite.max_uses }));
        var inactive = invite.revoked || new Date(invite.expires_at) < new Date() || (invite.max_uses > 0 && invite.used_count >= invite.max_uses);
        var action = inactive
          ? '<button class="ss-btn ss-btn-ghost collab-delete-invite" data-code="' + esc(invite.code) + '" data-i18n="Delete">' + esc(t('Delete')) + '</button>'
          : '<button class="ss-btn ss-btn-ghost collab-revoke-invite" data-code="' + esc(invite.code) + '" data-i18n="Revoke">' + esc(t('Revoke')) + '</button>';
        return '<div class="collab-list-row" data-invite-index="' + index + '"><span class="member-avatar avatar-amber">#</span><div><div class="collab-row-primary"><code>' + esc(invite.code) + '</code></div><div class="collab-row-secondary invite-status">' + esc(t('{state} · expires {date}', { state: state, date: new Date(invite.expires_at).toLocaleString() })) + '</div></div>' + action + '</div>';
      }).join('');
      Array.prototype.forEach.call($('collab-invite-list').querySelectorAll('[data-invite-index]'), function(row) {
        var invite = invites[Number(row.getAttribute('data-invite-index'))];
        var state = invite.revoked ? t('revoked') : (new Date(invite.expires_at) < new Date() ? t('expired') : t('{used}/{maximum} used', { used: invite.used_count, maximum: invite.max_uses }));
        bindText(row.querySelector('.invite-status'), '{state} · expires {date}', { state: state, date: new Date(invite.expires_at).toLocaleString() });
      });
  }
  async function loadTeamCache() {
    if (!selectedTeamId) return;
    try { selectedCacheInfo = await api('getTeamCacheInfo', { teamId: selectedTeamId }); renderCache(selectedCacheInfo, $('collab-cache-view'), true); }
    catch (err) { $('collab-cache-view').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>'; }
  }
  function renderCache(info, target, detailed) {
    if (!info) { target.innerHTML = '<div class="collab-empty" data-i18n="Cache is unavailable">' + esc(t('Cache is unavailable')) + '</div>'; return; }
    var namespaces = asArray(info.namespaces);
    var percent = info.quota_bytes ? Math.min(100, info.total_bytes / info.quota_bytes * 100) : 0;
    var admin = selectedDetail && selectedDetail.team.admin_user_id === currentUser().id;
    var html = '<div class="cache-summary"><div class="cache-stat"><strong>' + formatBytes(info.total_bytes) + '</strong><span>' + esc(t('TOTAL USED')) + '</span></div><div class="cache-stat"><strong>' + formatBytes(info.shared_bytes) + '</strong><span>' + esc(t('SHARED DEPENDENCIES')) + '</span></div><div class="cache-stat"><strong>' + formatBytes(info.target_bytes) + '</strong><span>' + esc(t('INCREMENTAL TARGETS')) + '</span></div><div class="cache-stat"><strong>' + formatBytes(info.quota_bytes) + '</strong><span>' + esc(t('TEAM LIMIT')) + '</span></div></div>' +
      '<div class="cache-meter"><span style="width:' + percent.toFixed(1) + '%"></span></div><div class="collab-row-secondary">' + esc(t('{percent}% used · inactive namespaces are removed least-recently-used first', { percent: percent.toFixed(1) })) + '</div>';
    if (detailed) {
      html += '<div class="collab-pane-toolbar"><span>' + esc(t('{count} build namespaces', { count: namespaces.length })) + '</span>' + (admin ? '<span><button class="ss-btn ss-btn-ghost cache-clear-shared">' + esc(t('Clear shared')) + '</button> <button class="ss-btn ss-btn-ghost cache-clear-all">' + esc(t('Clear all')) + '</button></span>' : '') + '</div>';
	  html += namespaces.map(function(ns) {
		return '<div class="cache-namespace"><span>' + esc(ns.branch) + ' · ' + esc(ns.runtime) + ' · ' + esc(ns.language) + '</span><span>' + formatBytes(ns.size_bytes) + '</span><span class="' + (ns.active ? 'cache-active' : '') + '">' + (ns.active ? esc(t('building')) : new Date(ns.last_used).toLocaleDateString()) + '</span>' + (admin && !ns.active ? '<button class="team-tool-btn cache-clear-namespace" data-namespace="' + esc(ns.key) + '">' + esc(t('Clear')) + '</button>' : '') + '</div>';
      }).join('');
    }
    target.innerHTML = html;
  }

  function newTeam() {
    openAction('Create team', inputField('action-team-name', 'Team name') + textareaField('action-team-description', 'Description') + inputField('action-team-quota', 'Build cache quota (MB)', '4096', 'number'), 'Create', async function() {
      var team = await api('createTeam', { name: $('action-team-name').value, description: $('action-team-description').value, cacheQuotaMB: Number($('action-team-quota').value) });
      await loadTeams(team.id); notify('Team created', 'success'); return true;
    });
  }
  function joinTeam() {
    openAction('Join team', inputField('action-invite-code', 'Invitation code'), 'Join', async function() {
      var team = await api('joinTeam', { inviteCode: $('action-invite-code').value });
      await loadTeams(team.id); notify('Joined team', 'success'); return true;
    });
  }
  function newProject() {
    if (!selectedTeamId) return;
    openAction('Create cloud project', inputField('action-project-name', 'Project name') + textareaField('action-project-description', 'Description'), 'Create', async function() {
      await api('createTeamProject', { teamId: selectedTeamId, name: $('action-project-name').value, description: $('action-project-description').value });
      await selectTeam(selectedTeamId); notify('Cloud project created', 'success'); return true;
    });
  }
  function deleteProject(project) {
    openAction('Delete {name}', inputField('action-delete-project-name', 'Type project name to confirm'), 'Delete permanently', async function() {
      if ($('action-delete-project-name').value !== project.name) throw new Error(t('Project name does not match'));
      var current = S.collaboration.current;
      var closesCurrentWorkspace = current && current.teamId === project.team_id && current.projectId === project.id;
      var leaveApproved = false;
      if (closesCurrentWorkspace && BOBO.workspace && BOBO.workspace.canLeaveWorkspace) {
        leaveApproved = await BOBO.workspace.canLeaveWorkspace({ reason: 'project-deleted' });
        if (!leaveApproved) return false;
      }
      try {
        await api('deleteTeamProject', { teamId: project.team_id, projectId: project.id });
        removeProjectMappings(project.team_id, project.id);
        if (closesCurrentWorkspace) {
          if (BOBO.workspace && BOBO.workspace.closeWorkspace) {
            await BOBO.workspace.closeWorkspace({ approved: true, reason: 'project-deleted' });
          }
          clearCurrent();
        }
      } catch (error) {
        if (leaveApproved && BOBO.workspace && BOBO.workspace.abortWorkspaceLeave) {
          BOBO.workspace.abortWorkspaceLeave();
        }
        throw error;
      }
      await selectTeam(project.team_id);
      notify('Team project deleted', 'success');
      return true;
    }, { name: project.name });
  }
  function newInvite() {
    openAction('Generate invitation', inputField('action-invite-uses', 'Maximum uses', '1', 'number') + inputField('action-invite-hours', 'Valid for hours', '168', 'number'), 'Generate', async function() {
      var invite = await api('createTeamInvite', { teamId: selectedTeamId, maxUses: Number($('action-invite-uses').value), expiresInHours: Number($('action-invite-hours').value) });
      await loadInvites();
      try { await navigator.clipboard.writeText(invite.code); } catch (e) {}
      notify(t('Invitation copied: {code}', { code: invite.code }), 'success'); return true;
    });
  }

  // ─── Cloud project mappings ────────────────────────────────
  function mappingKey(teamId, projectId, branch) {
    return ['bobo-team-map-v1', S.serverSettings.ip || 'server', currentUser().uid || currentUser().id, teamId, projectId, branch].join(':');
  }
  function readMapping(teamId, projectId, branch) {
    try { return localStorage.getItem(mappingKey(teamId, projectId, branch)) || ''; } catch (e) { return ''; }
  }
  function writeMapping(teamId, projectId, branch, path) {
    try { localStorage.setItem(mappingKey(teamId, projectId, branch), path); } catch (e) {}
  }
  function removeProjectMappings(teamId, projectId) {
    try {
      var prefix = ['bobo-team-map-v1', S.serverSettings.ip || 'server', currentUser().uid || currentUser().id, teamId, projectId].join(':') + ':';
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf(prefix) === 0) localStorage.removeItem(key);
      }
    } catch (e) {}
  }

  async function refreshApprovedWorkspace(rootPath) {
    var tree = await window.api.refreshWorkspace();
    var identity = await window.api.getWorkspaceIdentity();
    if (!tree || !identity || identity.rootPath !== rootPath ||
        !(await BOBO.workspace.applyWorkspace(rootPath, tree, identity.workspaceIdentity, null, { approved: true }))) {
      throw new Error(t('Pull failed'));
    }
  }

  async function openProject(project, preferredBranch) {
    openAction('Open {name}', '<div class="collab-open-loading" data-i18n="Loading cloud branches...">' + esc(t('Loading cloud branches...')) + '</div>', 'Open project', null, { name: project.name });
    $('collab-action-confirm').disabled = true;
    var branches;
    try {
      branches = await api('listTeamBranches', { teamId: project.team_id, projectId: project.id });
    } catch (err) {
      $('collab-action-body').innerHTML = '<div class="collab-open-error"><strong data-i18n="Could not load this project">' + esc(t('Could not load this project')) + '</strong><span>' + esc(err.message) + '</span></div><div id="collab-action-status" class="collab-action-status"></div>';
      bindText($('collab-action-confirm'), 'Retry');
      $('collab-action-confirm').disabled = false;
      actionConfirm = async function() { await openProject(project, preferredBranch); return false; };
      return;
    }
    if (!Array.isArray(branches)) {
      throw new Error(t('The server returned an invalid branch list'));
    }
    var names = branches.map(function(b) { return b && b.name; }).filter(Boolean);
    if (!names.length) {
      throw new Error(t('This project has no cloud branches'));
    }
    var branch = preferredBranch || project.default_branch || names[0];
    if (names.indexOf(branch) < 0) branch = names[0];
    var existing = readMapping(project.team_id, project.id, branch);
    var body = selectField('action-open-branch', 'Cloud branch', names, branch) +
      '<div class="collab-action-field"><label data-i18n="Local mapping">' + esc(t('Local mapping')) + '</label><div id="action-mapping-path" class="mapping-path">' + esc(existing || t('Not selected')) + '</div><button id="action-choose-mapping" class="ss-btn ss-btn-ghost" type="button" data-i18n="Choose directory">' + esc(t('Choose directory')) + '</button></div>' +
      selectField('action-open-mode', 'Open mode', existing ? [{value:'local',label:'Open local changes'}, {value:'pull',label:'Reset from cloud (discard local changes)'}] : [{value:'pull',label:'Initial pull from cloud'}], existing ? 'local' : 'pull');
    openAction('Open {name}', body, 'Open project', async function() {
      var selectedBranch = $('action-open-branch').value;
	  var storedPath = readMapping(project.team_id, project.id, selectedBranch);
	  var mappingElement = $('action-mapping-path');
	  var localPath = mappingElement.getAttribute('data-path') || storedPath;
      if (!localPath) throw new Error(t('Choose a local mapping directory'));
      var pathInfo = await window.api.localPathInfo(localPath, mappingElement.getAttribute('data-grant') || '');
      if (!pathInfo.exists || !pathInfo.directory) throw new Error(t('Local mapping directory is unavailable'));
	  if (!pathInfo.grantId) throw new Error(t('Choose the local mapping directory again to authorize synchronization'));
	  var isFirst = !storedPath || storedPath !== localPath;
      if (isFirst && !pathInfo.empty) throw new Error(t('The first mapping must use an empty directory'));
	  var mode = isFirst ? 'pull' : $('action-open-mode').value;
      var replacesCurrentWorkspace = (isFirst || mode === 'pull') && S.workspaceRoot === localPath;
      var leaveApproved = false;
      if (replacesCurrentWorkspace) {
        if (!BOBO.workspace || !BOBO.workspace.canLeaveWorkspace) return false;
        leaveApproved = await BOBO.workspace.canLeaveWorkspace({ reason: 'team-pull', targetRoot: localPath });
        if (!leaveApproved) return false;
      }
      try {
        var prepared = await api('prepareTeamProject', { teamId: project.team_id, projectId: project.id, branch: selectedBranch, reset: mode === 'pull' });
        if (isFirst || mode === 'pull') {
          setActionStatusKey('Pulling cloud branch...', null, false);
          var result = await BOBO.rclone.pull({ dest: localPath, localGrant: pathInfo.grantId, remotePath: prepared.remote_path, onProgress: function(line) { setActionStatus(line, false); } });
          if (!result.success) throw new Error(result.error && result.error.message || t('Pull failed'));
        }
	    var teamName = project.team_name || (selectedDetail && selectedDetail.team && selectedDetail.team.name) || (S.collaboration.current && S.collaboration.current.teamName) || 'Team';
        var nextCurrent = { teamId: project.team_id, teamName: teamName, projectId: project.id, projectName: project.name, branch: selectedBranch, remotePath: prepared.remote_path, localPath: localPath };
	    await window.api.writeTeamMapping({ localPath: localPath, localGrant: pathInfo.grantId, mapping: nextCurrent });
        if (replacesCurrentWorkspace) {
          await refreshApprovedWorkspace(localPath);
        } else {
          var opened = await window.api.pickWorkspace(localPath);
          if (!opened || !(await BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken))) return false;
        }
	    writeMapping(project.team_id, project.id, selectedBranch, localPath);
        S.collaboration.current = nextCurrent;
        updateTeamChrome();
        closeHub();
        notify(t('Team project opened on {branch}', { branch: selectedBranch }), 'success');
        return true;
      } catch (error) {
        if (leaveApproved && BOBO.workspace && BOBO.workspace.abortWorkspaceLeave) BOBO.workspace.abortWorkspaceLeave();
        throw error;
      }
    }, { name: project.name });
    var initialPath = $('action-mapping-path');
    if (existing) setRawText(initialPath, existing);
    else bindText(initialPath, 'Not selected');
    initialPath.setAttribute('data-path', existing || '');
    initialPath.setAttribute('data-grant', '');
    function updateMappingForBranch() {
      var selected = $('action-open-branch').value;
      var mapped = readMapping(project.team_id, project.id, selected);
      var pathEl = $('action-mapping-path');
      if (mapped) setRawText(pathEl, mapped);
      else bindText(pathEl, 'Not selected');
      pathEl.setAttribute('data-path', mapped || '');
      pathEl.setAttribute('data-grant', '');
      $('action-open-mode').innerHTML = mapped ? '<option value="local" data-i18n="Open local changes">' + esc(t('Open local changes')) + '</option><option value="pull" data-i18n="Reset from cloud (discard local changes)">' + esc(t('Reset from cloud (discard local changes)')) + '</option>' : '<option value="pull" data-i18n="Initial pull from cloud">' + esc(t('Initial pull from cloud')) + '</option>';
    }
    $('action-open-branch').addEventListener('change', updateMappingForBranch);
    $('action-choose-mapping').addEventListener('click', async function() {
      var chosen = await window.api.pickLocalMapping();
      if (!chosen) return;
      var selected = $('action-open-branch').value;
      var first = !readMapping(project.team_id, project.id, selected);
      if (first && !chosen.empty) { setActionStatusKey('Choose an empty directory for the initial pull', null, true); return; }
      setRawText($('action-mapping-path'), chosen.path);
      $('action-mapping-path').setAttribute('data-path', chosen.path);
	  $('action-mapping-path').setAttribute('data-grant', chosen.grantId || '');
	  $('action-open-mode').innerHTML = '<option value="pull" data-i18n="Initial pull from cloud">' + esc(t('Initial pull from cloud')) + '</option>';
      setActionStatus('', false);
    });
  }

  function updateTeamChrome() {
    var current = S.collaboration && S.collaboration.current;
    var badge = $('team-project-badge');
    var tab = $('team-panel-tab');
    if (!current) {
      badge.style.display = 'none'; tab.style.display = 'none'; $('team-workbench').innerHTML = '';
      setCollaborationReadOnly(false);
      if (S.activePanel === 'team' && BOBO.switchToPanel) BOBO.switchToPanel('output');
      if (BOBO.workbench) BOBO.workbench.refreshContext();
      return;
    }
    badge.style.display = 'inline-flex';
    badge.innerHTML = '<span class="team-tag">TEAM</span><span>' + esc(current.projectName) + '</span><span class="branch">' + esc(current.branch) + '</span><span class="team-lock-status"></span>';
    tab.style.display = '';
    badge.onclick = function() { BOBO.switchToPanel('team'); };
    if (BOBO.workbench) BOBO.workbench.refreshContext();
    if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('team');
    refreshWorkbench();
    startLockRefresh();
    renderActiveLockStatus();
  }

	function clearCurrent() {
	  var previous = S.collaboration.current;
	  if (previous) releaseHeldFileLocks(previous);
	  S.collaboration.current = null;
	  if (lockRefreshTimer) { clearInterval(lockRefreshTimer); lockRefreshTimer = null; }
	  updateTeamChrome();
	  if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('team');
	}

	function restoreMapping(mapping, localPath) {
	  if (!mapping) { clearCurrent(); return; }
	  if (S.collaboration.current) releaseHeldFileLocks(S.collaboration.current);
	  S.collaboration.current = {
		teamId: mapping.teamId, teamName: mapping.teamName || 'Team', projectId: mapping.projectId,
		projectName: mapping.projectName || 'Cloud project', branch: mapping.branch,
		remotePath: mapping.remotePath || '', localPath: localPath || mapping.localPath || ''
	  };
	  updateTeamChrome();
	}

  // ─── Team workbench ────────────────────────────────────────
  async function refreshWorkbench() {
    var current = S.collaboration.current;
    if (!current) return;
    var root = $('team-workbench');
    root.innerHTML = '<div class="collab-empty" data-i18n="Loading team state...">' + esc(t('Loading team state...')) + '</div>';
    try {
      var results = await Promise.all([
        api('listTeamBranches', { teamId: current.teamId, projectId: current.projectId }),
        api('teamProjectHistory', { teamId: current.teamId, projectId: current.projectId, limit: 40 }),
        api('listTeamFileLocks', { teamId: current.teamId, projectId: current.projectId }),
        api('getTeamCacheInfo', { teamId: current.teamId }),
        api('listTeamConflicts', { teamId: current.teamId, projectId: current.projectId, branch: current.branch })
      ]);
      renderWorkbench(asArray(results[0]), asArray(results[1]), asArray(results[2]), results[3], asArray(results[4]));
    } catch (err) { root.innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>'; }
  }
  function renderWorkbench(branches, history, locks, cache, conflicts) {
    branches = asArray(branches);
    history = asArray(history);
    locks = asArray(locks);
    conflicts = asArray(conflicts);
    workbenchCacheInfo = cache;
    var current = S.collaboration.current;
    var branchOptions = branches.map(function(b) { return '<option value="' + esc(b.name) + '"' + (b.name === current.branch ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('');
    var commits = renderCommitTree(history);
    var me = currentUser();
    var lockRows = locks.map(function(lock) {
      var mine = !!(me && lock.user_id === me.id);
      var minutes = lockMinutesRemaining(lock);
      var owner = mine ? t('You') : (lock.user_name || t('another teammate'));
      var timing = minutes > 0 ? t('{owner} · {minutes} min remaining', { owner: owner, minutes: minutes }) : t('{owner} · expiring now', { owner: owner });
      var expires = lock.expires_at ? new Date(lock.expires_at).toLocaleString() : '';
      return '<div class="commit-row team-lock-row' + (mine ? ' is-mine' : '') + '" title="' + esc(expires ? t('Advisory lock expires {date}', { date: expires }) : t('Advisory file lock')) + '"><span class="commit-hash team-lock-label">' + esc(t(mine ? 'YOURS' : 'LOCK')) + '</span><span class="team-lock-path">' + esc(lock.path) + '</span><span class="team-lock-owner">' + esc(timing) + '</span></div>';
    }).join('') || '<div class="collab-row-secondary" data-i18n="No active advisory locks">' + esc(t('No active advisory locks')) + '</div>';
    var conflictHTML = conflicts.length ? conflicts.map(function(file) {
      return '<button class="team-tool-btn team-open-conflict" data-conflict-path="' + esc(file.path) + '">' + esc(file.path) + '</button>';
    }).join(' ') : '<span class="collab-row-secondary" data-i18n="No unresolved conflicts">' + esc(t('No unresolved conflicts')) + '</span>';
    $('team-workbench').innerHTML = '<div class="team-workbench-toolbar"><span class="team-workbench-title">' + esc(current.teamName + ' / ' + current.projectName) + '</span><div class="team-branch-control"><select id="team-branch-select" aria-label="' + esc(t('Current branch')) + '">' + branchOptions + '</select><button class="team-tool-btn" id="team-open-branch" data-i18n="Open">' + esc(t('Open')) + '</button></div><button class="team-tool-btn" id="team-pull" title="' + esc(t('Replace local files with the cloud branch')) + '" data-i18n="Pull">' + esc(t('Pull')) + '</button><button class="team-tool-btn team-upload-btn" id="team-upload" title="' + esc(t('Upload local files to your private cloud worktree')) + '" data-i18n="Upload">' + esc(t('Upload')) + '</button><button class="team-tool-btn team-commit-btn" id="team-commit" title="' + esc(t('Upload, commit and push changes to the shared branch')) + '" data-i18n="Commit &amp; push">' + esc(t('Commit & push')) + '</button><details class="team-more-tools"><summary title="' + esc(t('More team actions')) + '" aria-label="' + esc(t('More team actions')) + '">&#8943;</summary><div class="team-more-menu"><button class="team-tool-btn" id="team-new-branch" data-i18n="New branch">' + esc(t('New branch')) + '</button><button class="team-tool-btn" id="team-compare" data-i18n="Compare branches">' + esc(t('Compare branches')) + '</button><button class="team-tool-btn" id="team-merge" data-i18n="Merge branches">' + esc(t('Merge branches')) + '</button><button class="team-tool-btn" id="team-refresh" data-i18n="Refresh">' + esc(t('Refresh')) + '</button></div></details></div>' +
      '<div class="team-workbench-grid"><section class="team-workbench-section"><div class="team-section-title" data-i18n="BRANCH ITERATION TREE">' + esc(t('BRANCH ITERATION TREE')) + '</div>' + commits + '<div class="team-section-title" style="margin-top:12px" data-i18n="ADVISORY FILE LOCKS">' + esc(t('ADVISORY FILE LOCKS')) + '</div>' + lockRows + '</section><section class="team-workbench-section"><div class="team-section-title" data-i18n="CONFLICTS">' + esc(t('CONFLICTS')) + '</div><div id="team-conflict-list">' + conflictHTML + '</div><div id="team-conflict-editor"></div><div class="team-section-title" style="margin-top:12px" data-i18n="COMPARE">' + esc(t('COMPARE')) + '</div><pre id="team-diff-output" class="team-diff-output"></pre><div class="team-section-title" style="margin-top:12px" data-i18n="BUILD CACHE">' + esc(t('BUILD CACHE')) + '</div><div id="team-cache-compact"></div></section></div>';
    bindAttribute($('team-branch-select'), 'aria-label', 'Current branch');
    bindAttribute($('team-pull'), 'title', 'Replace local files with the cloud branch');
    bindAttribute($('team-upload'), 'title', 'Upload local files to your private cloud worktree');
    bindAttribute($('team-commit'), 'title', 'Upload, commit and push changes to the shared branch');
    var more = $('team-workbench').querySelector('.team-more-tools summary');
    bindAttribute(more, 'title', 'More team actions');
    bindAttribute(more, 'aria-label', 'More team actions');
    Array.prototype.forEach.call($('team-workbench').querySelectorAll('.team-lock-label'), function(label) {
      bindText(label, 'LOCK');
    });
    renderCache(cache, $('team-cache-compact'), false);
    bindWorkbench(branches, conflicts);
  }
  function renderCommitTree(history) {
    history = asArray(history);
    if (!history.length) return '<div class="collab-empty" data-i18n="No commits">' + esc(t('No commits')) + '</div>';
    var lanes = [];
    return history.map(function(commit) {
      var lane = lanes.indexOf(commit.id);
      if (lane < 0) { lane = lanes.length; lanes.push(commit.id); }
      lane = Math.min(lane, 5);
      var parents = Array.isArray(commit.parents) ? commit.parents : [];
      lanes.splice(lane, 1);
      for (var i = parents.length - 1; i >= 0; i--) {
        if (lanes.indexOf(parents[i]) < 0) lanes.splice(lane, 0, parents[i]);
      }
      var visibleLanes = Math.max(1, Math.min(6, Math.max(lanes.length, lane + 1)));
      var width = visibleLanes * 10 + 2;
      var lines = '';
      for (var n = 0; n < visibleLanes; n++) {
        var x = n * 10 + 6;
        lines += '<path d="M' + x + ' 0V24" />';
      }
      for (var p = 0; p < parents.length; p++) {
        var parentLane = Math.min(Math.max(0, lanes.indexOf(parents[p])), 5);
        lines += '<path class="branch-link" d="M' + (lane * 10 + 6) + ' 12L' + (parentLane * 10 + 6) + ' 24" />';
      }
      var graph = '<svg class="commit-graph" width="' + width + '" height="24" viewBox="0 0 ' + width + ' 24" aria-hidden="true">' + lines + '<circle cx="' + (lane * 10 + 6) + '" cy="12" r="3.2" /></svg>';
      var refs = commit.refs ? '<small class="commit-refs">' + esc(commit.refs.replace(/HEAD -> /g, '')) + '</small>' : '';
      var author = esc(commit.author || '') + (commit.author_uid ? ' · ' + esc(commit.author_uid) : '');
      return '<div class="commit-row"><span class="commit-id-cell">' + graph + '<span class="commit-hash">' + esc(commit.id.slice(0,8)) + '</span></span><span class="commit-message">' + esc(commit.message) + refs + '</span><span class="commit-author" title="' + author + '">' + author + '<small>' + new Date(commit.created_at).toLocaleDateString() + '</small></span></div>';
    }).join('');
  }
  function currentProjectRecord() {
    var c = S.collaboration.current;
    return { id: c.projectId, team_id: c.teamId, name: c.projectName, default_branch: 'main' };
  }
  function bindWorkbench(branches, conflicts) {
    $('team-refresh').onclick = refreshWorkbench;
    $('team-project-badge').onclick = function() { BOBO.switchToPanel('team'); };
    $('team-open-branch').onclick = function() { openProject(currentProjectRecord(), $('team-branch-select').value); };
    $('team-pull').onclick = manualPull;
    $('team-upload').onclick = uploadChanges;
    $('team-commit').onclick = commitChanges;
    $('team-new-branch').onclick = function() { newBranch(branches); };
    $('team-compare').onclick = function() { compareBranches(branches); };
    $('team-merge').onclick = function() { mergeBranches(branches); };
    document.querySelectorAll('.team-open-conflict').forEach(function(btn) {
      btn.onclick = function() {
        var file = conflicts.find(function(x) { return x.path === btn.getAttribute('data-conflict-path'); });
        renderConflictEditor(file);
      };
    });
  }
  function manualPull() {
    var current = S.collaboration.current;
    openAction('Pull cloud branch', '<div class="collab-action-status" data-i18n="The cloud branch will replace differing files in this local mapping.">' + esc(t('The cloud branch will replace differing files in this local mapping.')) + '</div>', 'Pull', async function() {
      var leaveApproved = false;
      if (BOBO.workspace && BOBO.workspace.canLeaveWorkspace) {
        leaveApproved = await BOBO.workspace.canLeaveWorkspace({ reason: 'team-pull', targetRoot: current.localPath });
        if (!leaveApproved) return false;
      }
      try {
        var prepared = await api('prepareTeamProject', { teamId: current.teamId, projectId: current.projectId, branch: current.branch, reset: true });
        var result = await BOBO.rclone.pull({ dest: current.localPath, remotePath: prepared.remote_path, onProgress: function(line) { setActionStatus(line, false); } });
        if (!result.success) throw new Error(result.error && result.error.message || t('Pull failed'));
        await refreshApprovedWorkspace(current.localPath);
        notify('Cloud branch pulled', 'success'); return true;
      } catch (error) {
        if (leaveApproved && BOBO.workspace && BOBO.workspace.abortWorkspaceLeave) BOBO.workspace.abortWorkspaceLeave();
        throw error;
      }
    });
  }
  async function uploadChanges() {
    var button = $('team-upload');
    if (button) { button.disabled = true; bindText(button, 'Uploading...'); }
    try {
      var synced = await BOBO.runner.uploadWorkspace();
      if (!synced) throw new Error(t('Local files could not be synchronized. Check the Output panel for details.'));
      notify('Uploaded to your private cloud worktree. Commit & push to publish these changes.', 'success');
      await refreshWorkbench();
      return true;
    } catch (err) {
      notify(err.message, 'error');
      return false;
    } finally {
      if (button && button.isConnected) { button.disabled = false; bindText(button, 'Upload'); }
    }
  }
  function commitChanges() {
    openAction('Commit team changes', inputField('action-commit-message', 'Commit message'), 'Commit and push', async function() {
      setActionStatusKey('Uploading local changes...', null, false);
      var synced = await BOBO.runner.uploadWorkspace(); if (!synced) throw new Error(t('Local files could not be synchronized'));
      var c = S.collaboration.current;
      setActionStatusKey('Publishing commit to {branch}...', { branch: c.branch }, false);
      await api('commitTeamChanges', { teamId: c.teamId, projectId: c.projectId, branch: c.branch, commitMessage: $('action-commit-message').value });
      setActionStatusKey('Refreshing team history...', null, false);
      await refreshWorkbench(); notify('Changes committed and pushed', 'success'); return true;
    });
  }
  function newBranch(branches) {
    var names = branches.map(function(b){return b.name;});
    openAction('Create branch', inputField('action-branch-name','Branch name') + selectField('action-branch-from','Start from',names,S.collaboration.current.branch),'Create',async function(){var c=S.collaboration.current;await api('createTeamBranch',{teamId:c.teamId,projectId:c.projectId,branch:$('action-branch-name').value,sourceBranch:$('action-branch-from').value});await refreshWorkbench();notify('Branch created','success');return true;});
  }
  function compareBranches(branches) {
    var names=branches.map(function(b){return b.name;});var c=S.collaboration.current;
    openAction('Compare branches',selectField('action-compare-from','From',names,c.branch)+selectField('action-compare-to','To',names,names.find(function(n){return n!==c.branch;})||c.branch),'Compare',async function(){var diff=await api('compareTeamBranches',{teamId:c.teamId,projectId:c.projectId,sourceBranch:$('action-compare-from').value,targetBranch:$('action-compare-to').value});closeAction();BOBO.switchToPanel('team');$('team-diff-output').textContent=(diff.stats?diff.stats+'\n\n':'')+diff.patch;return false;});
  }
  function mergeBranches(branches) {
    var names=branches.map(function(b){return b.name;});var c=S.collaboration.current;
    openAction('Merge branches',selectField('action-merge-source','Source',names,names.find(function(n){return n!==c.branch;})||c.branch)+selectField('action-merge-target','Target',names,c.branch),'Merge',async function(){var result=await api('mergeTeamBranch',{teamId:c.teamId,projectId:c.projectId,sourceBranch:$('action-merge-source').value,targetBranch:$('action-merge-target').value});await refreshWorkbench();if(result.conflicts&&result.conflicts.length)notify(t('{count} conflicts require resolution',{count:result.conflicts.length}),'error');else notify('Branches merged and pushed','success');return true;});
  }
  function renderConflictEditor(file) {
    if (!file) return;
    $('team-conflict-editor').innerHTML = '<div class="conflict-columns"><div class="conflict-version"><label data-i18n="BASE">' + esc(t('BASE')) + '</label><pre>' + esc(file.base) + '</pre></div><div class="conflict-version"><label data-i18n="OURS">' + esc(t('OURS')) + '</label><pre>' + esc(file.ours) + '</pre></div><div class="conflict-version"><label data-i18n="THEIRS">' + esc(t('THEIRS')) + '</label><pre>' + esc(file.theirs) + '</pre></div></div><textarea id="team-conflict-content" class="conflict-editor">' + esc(file.ours) + '</textarea><button id="team-save-resolution" class="team-tool-btn" data-i18n="Mark resolved">' + esc(t('Mark resolved')) + '</button> <button id="team-complete-merge" class="team-tool-btn" data-i18n="Complete merge">' + esc(t('Complete merge')) + '</button>';
    $('team-save-resolution').onclick = async function(){try{var c=S.collaboration.current;await api('resolveTeamConflict',{teamId:c.teamId,projectId:c.projectId,branch:c.branch,filePath:file.path,content:$('team-conflict-content').value});notify('Conflict marked resolved','success');await refreshWorkbench();}catch(err){notify(err.message,'error');}};
    $('team-complete-merge').onclick = function(){openAction('Complete merge',inputField('action-merge-message','Commit message','Resolve merge conflicts'),'Commit and push',async function(){var c=S.collaboration.current;await api('completeTeamMerge',{teamId:c.teamId,projectId:c.projectId,branch:c.branch,commitMessage:$('action-merge-message').value});await refreshWorkbench();notify('Merge completed','success');return true;});};
  }

  // Advisory locks are a courtesy signal. Git remains the source of truth and
  // locks expire automatically if a client disappears.
  function relativeCurrentPath(filePath) {
    if (!S.workspaceRoot || !filePath) return '';
    var root = String(S.workspaceRoot).replace(/\\/g, '/').replace(/\/$/, '');
    var candidate = String(filePath).replace(/\\/g, '/');
    var rootCompare = root.toLowerCase();
    var candidateCompare = candidate.toLowerCase();
    if (candidateCompare.indexOf(rootCompare + '/') !== 0) return '';
    return candidate.substring(root.length + 1);
  }
  async function onFileOpened(filePath, options) {
    options = options || {};
    var c=S.collaboration.current;if(!c)return;var rel=relativeCurrentPath(filePath);if(!rel)return;
    var key = heldLockKey(filePath);
    if (fileLockRequests[key]) return fileLockRequests[key].promise;
    var previous = heldFileLocks[key] || blockedFileLocks[key];
    var sameContext = previous && previous.teamId === c.teamId && previous.projectId === c.projectId && previous.branch === c.branch && previous.path === rel;
    var request = { teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, cancelled: false, promise: null };
    request.promise = (async function() {
      try {
        var lock = await api('acquireTeamFileLock',{teamId:c.teamId,projectId:c.projectId,branch:c.branch,filePath:rel,lockLeaseId:sameContext ? previous.leaseId : undefined,ttlMinutes:FILE_LOCK_TTL_MINUTES});
        var returnedLeaseID = lock && (lock.lease_id || lock.leaseId) || '';
        if (request.cancelled) {
          await api('releaseTeamFileLock', { teamId: c.teamId, projectId: c.projectId, branch: c.branch, filePath: rel, lockLeaseId: returnedLeaseID || undefined }).catch(function() {});
          return null;
        }
        heldFileLocks[key] = { filePath: filePath, teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, leaseId: returnedLeaseID, expires_at: lock && (lock.expires_at || lock.expiresAt) || '' };
        delete blockedFileLocks[key];
        if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
        return lock;
      } catch(err) {
        delete heldFileLocks[key];
        if (!request.cancelled) blockedFileLocks[key] = { filePath: filePath, teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, leaseId: sameContext ? previous.leaseId : '', lock: err && err.details && err.details.lock || null, errorCode: err && err.code || '' };
        if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
        if(!request.cancelled && !options.silent)notify(collaborationErrorMessage(err),'info');
        return null;
      } finally {
        if (fileLockRequests[key] === request) delete fileLockRequests[key];
      }
    })();
    fileLockRequests[key] = request;
    return request.promise;
  }
  async function onFileClosed(filePath) {
    var key = heldLockKey(filePath);
    var held = heldFileLocks[key];
    if (fileLockRequests[key]) fileLockRequests[key].cancelled = true;
    var c=S.collaboration.current;
    var rel=held ? held.path : relativeCurrentPath(filePath);
    if (!held) {
      delete blockedFileLocks[key];
      if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
      return;
    }
    delete heldFileLocks[key];
    delete blockedFileLocks[key];
    if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
    try{await api('releaseTeamFileLock',{teamId:held ? held.teamId : c.teamId,projectId:held ? held.projectId : c.projectId,branch:held ? held.branch : c.branch,filePath:rel,lockLeaseId:held && held.leaseId || undefined});}catch(e){}
  }
  function openTeamFilePaths() {
    var activeKey = heldLockKey(S.activeTabPath);
    return asArray(S.tabs).filter(function(tab) {
      return tab && tab.path && (heldLockKey(tab.path) === activeKey || tab.dirty === true);
    }).map(function(tab) { return tab.path; }).filter(function(filePath) {
      return !!relativeCurrentPath(filePath);
    });
  }
  function expireLocalLeases() {
    var now = Date.now();
    Object.keys(heldFileLocks).forEach(function(key) {
      var held = heldFileLocks[key];
      var expires = Date.parse(held.expires_at || held.expiresAt || '');
      if (!Number.isFinite(expires) || expires > now) return;
      delete heldFileLocks[key];
      blockedFileLocks[key] = { filePath: held.filePath, teamId: held.teamId, projectId: held.projectId, branch: held.branch, path: held.path, lock: null, errorCode: 'lease_expired' };
    });
    renderActiveLockStatus();
  }
  async function renewOpenFileLocks() {
    expireLocalLeases();
    if (lockRefreshInFlight || !S.collaboration.current || !clientIsForeground()) return;
    lockRefreshInFlight = true;
    try {
      var paths = openTeamFilePaths();
      await Promise.all(paths.map(function(filePath) { return onFileOpened(filePath, { silent: true }); }));
    } finally {
      lockRefreshInFlight = false;
    }
  }
  function releaseHeldFileLocks(project) {
    Object.keys(fileLockRequests).forEach(function(key) {
      var request = fileLockRequests[key];
      if (!project || (request.teamId === project.teamId && request.projectId === project.projectId && request.branch === project.branch)) request.cancelled = true;
    });
    Object.keys(heldFileLocks).forEach(function(key) {
      var held = heldFileLocks[key];
      if (project && (held.teamId !== project.teamId || held.projectId !== project.projectId || held.branch !== project.branch)) return;
      delete heldFileLocks[key];
      delete blockedFileLocks[key];
      api('releaseTeamFileLock', { teamId: held.teamId, projectId: held.projectId, branch: held.branch, filePath: held.path, lockLeaseId: held.leaseId || undefined }).catch(function() {});
    });
    Object.keys(blockedFileLocks).forEach(function(key) {
      var blocked = blockedFileLocks[key];
      if (!project || (blocked.teamId === project.teamId && blocked.projectId === project.projectId && blocked.branch === project.branch)) delete blockedFileLocks[key];
    });
  }
  async function releaseForLogout() {
    var pending = Object.keys(fileLockRequests).map(function(key) {
      fileLockRequests[key].cancelled = true;
      return fileLockRequests[key].promise.catch(function() {});
    });
    var requests = Object.keys(heldFileLocks).map(function(key) {
      var held = heldFileLocks[key];
      delete heldFileLocks[key];
      delete blockedFileLocks[key];
      return api('releaseTeamFileLock', { teamId: held.teamId, projectId: held.projectId, branch: held.branch, filePath: held.path, lockLeaseId: held.leaseId || undefined }).catch(function() {});
    });
    Object.keys(blockedFileLocks).forEach(function(key) { delete blockedFileLocks[key]; });
    await Promise.all(pending.concat(requests));
  }
  function onFileActivated(filePath) {
    if (!S.collaboration.current || !relativeCurrentPath(filePath)) {
      setCollaborationReadOnly(false);
      return;
    }
    var activeKey = heldLockKey(filePath);
    Object.keys(heldFileLocks).forEach(function(key) {
      if (key === activeKey) return;
      var held = heldFileLocks[key];
      var tab = asArray(S.tabs).find(function(candidate) { return candidate && heldLockKey(candidate.path) === key; });
      if (tab && tab.dirty === true) return;
      delete heldFileLocks[key];
      delete blockedFileLocks[key];
      api('releaseTeamFileLock', { teamId: held.teamId, projectId: held.projectId, branch: held.branch, filePath: held.path, lockLeaseId: held.leaseId || undefined }).catch(function() {});
    });
    Object.keys(fileLockRequests).forEach(function(key) {
      if (key === activeKey) return;
      var tab = asArray(S.tabs).find(function(candidate) { return candidate && heldLockKey(candidate.path) === key; });
      if (!tab || tab.dirty !== true) fileLockRequests[key].cancelled = true;
    });
    renderActiveLockStatus();
    if (clientIsForeground()) onFileOpened(filePath, { silent: true });
  }
  function isActiveFileReadOnly() {
    return !!blockedFileLocks[heldLockKey(S.activeTabPath)];
  }
  function startLockRefresh() {
    if(lockRefreshTimer)clearInterval(lockRefreshTimer);
    renewOpenFileLocks();
    lockRefreshTimer=setInterval(renewOpenFileLocks,FILE_LOCK_HEARTBEAT_MS);
  }

  async function clearCache(scope, namespaceKey, projectId) {
    if(!selectedTeamId)return;
	try{await api('clearTeamCache',{teamId:selectedTeamId,cacheScope:scope,namespaceKey:namespaceKey||undefined,projectId:projectId||undefined});await loadTeamCache();if(S.collaboration.current&&S.collaboration.current.teamId===selectedTeamId)await refreshWorkbench();notify('Team cache cleared','success');}catch(err){notify(err.message,'error');}
  }

  global.addEventListener('bobo:language-changed', function() {
    if (S.collaboration && S.collaboration.modalOpen) {
      renderTeamList();
      if (selectedDetail) {
        var team = selectedDetail.team;
        var isAdmin = team.admin_user_id === currentUser().id;
        renderProjects(asArray(selectedDetail.projects), isAdmin);
        renderMembers(asArray(selectedDetail.members), isAdmin);
        if (isAdmin && selectedInvites) renderInvites(selectedInvites);
        if (selectedCacheInfo) renderCache(selectedCacheInfo, $('collab-cache-view'), true);
      }
      else renderNoTeam();
    }
    var compactCache = $('team-cache-compact');
    if (compactCache && workbenchCacheInfo) renderCache(workbenchCacheInfo, compactCache, false);
    renderActiveLockStatus();
  });

	function teamSettings() {
	  if (!selectedDetail) return;
	  var team=selectedDetail.team;var isAdmin=team.admin_user_id===currentUser().id;
	  if(!isAdmin){
		openAction('Leave team','<div class="collab-action-status" data-i18n="Your team worktrees and active file locks will be removed from the server.">' + esc(t('Your team worktrees and active file locks will be removed from the server.')) + '</div>','Leave',async function(){await api('leaveTeam',{teamId:team.id});await loadTeams();notify('Left team','success');return true;});return;
	  }
	  openAction('Team settings',inputField('action-team-settings-name','Team name',team.name)+textareaField('action-team-settings-description','Description',team.description||'')+inputField('action-team-settings-quota','Build cache quota (MB)',String(team.cache_quota_mb),'number')+inputField('action-team-settings-retention','Retention days',String(team.cache_retention_days||30),'number')+'<button id="action-delete-team" class="ss-btn ss-btn-ghost" type="button" data-i18n="Delete team">' + esc(t('Delete team')) + '</button>','Save',async function(){await api('updateTeam',{teamId:team.id,name:$('action-team-settings-name').value,description:$('action-team-settings-description').value,cacheQuotaMB:Number($('action-team-settings-quota').value),cacheRetentionDays:Number($('action-team-settings-retention').value)});await loadTeams(team.id);notify('Team settings saved','success');return true;});
	  $('action-delete-team').onclick=function(){openAction('Delete team',inputField('action-delete-team-name','Type team name to confirm'),'Delete permanently',async function(){if($('action-delete-team-name').value!==team.name)throw new Error(t('Team name does not match'));await api('deleteTeam',{teamId:team.id});await loadTeams();notify('Team deleted','success');return true;});};
	}

  function init() {
    $('team-hub-btn').onclick = openHub;
    $('collab-close').onclick = closeHub;
    $('collab-modal').onclick = function(event) { if (event.target === $('collab-modal')) closeHub(); };
    $('collab-modal').onkeydown = function(event) { if (event.key === 'Escape') { event.preventDefault(); closeHub(); } };
    $('collab-new-team').onclick = newTeam;
    $('collab-join').onclick = joinTeam;
    $('collab-new-project').onclick = newProject;
    $('collab-new-invite').onclick = newInvite;
	$('collab-team-settings').onclick = teamSettings;
	$('auth-menu-teams').onclick = function(){ $('auth-menu').style.display='none'; openHub(); };
    if (!BOBO.accountProfile) {
      $('auth-menu-profile').onclick = function(){ $('auth-menu').style.display='none'; openProfile(); };
      $('profile-close-x').onclick = closeProfile;
      $('profile-cancel').onclick = closeProfile;
      $('profile-save').onclick = saveProfile;
      $('profile-name').addEventListener('input', renderProfileAvatar);
      $('profile-avatar-options').onclick = function(e){var btn=e.target.closest('[data-avatar]');if(btn){chosenAvatar=btn.getAttribute('data-avatar');renderProfileAvatar();}};
      $('profile-avatar-upload').onclick = function(){ $('profile-avatar-file').click(); };
      $('profile-avatar-file').onchange = function(){ chooseAvatarFile(this.files && this.files[0]); this.value=''; };
      $('profile-copy-uid').onclick = async function(){try{await navigator.clipboard.writeText($('profile-uid').textContent);notify('User ID copied','success');}catch(e){notify('Copy failed','error');}};
    }
    $('collab-action-close').onclick=closeAction;$('collab-action-cancel').onclick=closeAction;$('collab-action-confirm').onclick=runActionConfirm;
    $('collab-team-list').onclick=function(e){var item=e.target.closest('[data-team-id]');if(item)selectTeam(item.getAttribute('data-team-id'));};
    $('collab-project-list').onclick=function(e){
      if(!selectedDetail)return;
      var remove=e.target.closest('.collab-delete-project');
      var open=e.target.closest('.collab-open-project');
      var button=remove||open;
      if(!button)return;
      var project=selectedDetail.projects.find(function(p){return p.id===button.getAttribute('data-project-id');});
      if(!project)return;
      if(remove){deleteProject(project);return;}
      button.disabled=true;
      var label=button.textContent;
      bindText(button, 'Loading...');
      openProject(project).catch(function(err){
        setActionStatus(err.message,true);
        $('collab-action-confirm').disabled=true;
        notify(err.message,'error');
      }).finally(function(){button.disabled=false;bindText(button,'Open');});
    };
    $('collab-member-list').onclick=async function(e){var btn=e.target.closest('.collab-remove-member');if(!btn)return;try{await api('removeTeamMember',{teamId:selectedTeamId,userId:btn.getAttribute('data-user-id')});await selectTeam(selectedTeamId);notify('Member removed','success');}catch(err){notify(err.message,'error');}};
    $('collab-invite-list').onclick=async function(e){var remove=e.target.closest('.collab-delete-invite');var revoke=e.target.closest('.collab-revoke-invite');var btn=remove||revoke;if(!btn)return;try{await api(remove?'deleteTeamInvite':'revokeTeamInvite',{teamId:selectedTeamId,inviteCode:btn.getAttribute('data-code')});await loadInvites();}catch(err){notify(err.message,'error');}};
    document.querySelectorAll('.collab-tabs button').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('.collab-tabs button').forEach(function(x){x.classList.remove('active');});document.querySelectorAll('.collab-pane').forEach(function(x){x.classList.remove('active');});tab.classList.add('active');$('collab-pane-'+tab.getAttribute('data-collab-tab')).classList.add('active');};});
	$('collab-cache-view').onclick=function(e){var ns=e.target.closest('.cache-clear-namespace');if(ns)clearCache('namespace',ns.getAttribute('data-namespace'));if(e.target.closest('.cache-clear-shared'))clearCache('shared');if(e.target.closest('.cache-clear-all'))clearCache('all');};
    global.addEventListener('focus', function() { renewOpenFileLocks(); renderActiveLockStatus(); });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) { renewOpenFileLocks(); renderActiveLockStatus(); }
    });
  }

	BOBO.collaboration = { init:init, openHub:openHub, openProfile:openProfile, clearCurrent:clearCurrent, restoreMapping:restoreMapping, updateTeamChrome:updateTeamChrome, refreshWorkbench:refreshWorkbench, uploadCurrent:uploadChanges, onFileOpened:onFileOpened, onFileClosed:onFileClosed, onFileActivated:onFileActivated, isActiveFileReadOnly:isActiveFileReadOnly, releaseForLogout:releaseForLogout };
})(window);
