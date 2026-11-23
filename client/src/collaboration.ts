// @ts-nocheck
// src/collaboration.ts - Team identity, cloud mappings, Git workflow and cache UI.
//
// The historical DOM implementation is kept intact inside an injected,
// lifecycle-owned service.  Native file/workspace capabilities enter only
// through the private collaboration host projection supplied by the adapter.
import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  CollaborationDependencies,
  CollaborationFacade,
  CollaborationService
} from '../types/collaboration';

export const COLLABORATION_SERVICE_ID = 'workbench.collaboration' as const;

export function createCollaborationService(
  dependencies: CollaborationDependencies
): CollaborationService {
  'use strict';

  var global = dependencies.eventTarget;
  var document = dependencies.document;
  var S = dependencies.state;
  var storage = dependencies.storage;
  var clipboard = dependencies.clipboard;
  var createImage = dependencies.createImage;
  var createObjectURL = dependencies.createObjectURL;
  var revokeObjectURL = dependencies.revokeObjectURL;
  var disposed = false;
  var lifecycleEpoch = 0;
  var lifecycle = new DisposableStore();
  var ownedTimers = new Set();
  var ownedIntervals = new Set();
  var ownedHandlers = [];
  var activeAvatarLoads = new Set();

  function isCurrent(epoch) { return !disposed && epoch === lifecycleEpoch; }
  function setTimeout(callback, delay) {
    var timer = null;
    var fired = false;
    var wrapped = function() {
      fired = true;
      if (timer !== null) ownedTimers.delete(timer);
      if (!disposed) callback();
    };
    timer = dependencies.setTimer(wrapped, delay);
    if (!fired && timer !== undefined && timer !== null) ownedTimers.add(timer);
    return timer;
  }
  function clearTimeout(timer) {
    if (timer === undefined || timer === null) return;
    ownedTimers.delete(timer);
    try { dependencies.clearTimer(timer); } catch (_) {}
  }
  function setInterval(callback, delay) {
    var timer = dependencies.setInterval(function() { if (!disposed) callback(); }, delay);
    if (timer !== undefined && timer !== null) ownedIntervals.add(timer);
    return timer;
  }
  function clearInterval(timer) {
    if (timer === undefined || timer === null) return;
    ownedIntervals.delete(timer);
    try { dependencies.clearInterval(timer); } catch (_) {}
  }
  function listen(target, type, listener, options, track) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
    lifecycle.add(toDisposable(function() {
      try { target.removeEventListener(type, listener, options); } catch (_) {}
    }));
  }
  function assignHandler(element, property, handler, track) {
    if (!element) return;
    if (track === false) {
      element[property] = handler;
      lifecycle.add(toDisposable(function() {
        try { if (element[property] === handler) element[property] = null; } catch (_) {}
      }));
      return;
    }
    var previous = element[property];
    for (var i = ownedHandlers.length - 1; i >= 0; i--) {
      var tracked = ownedHandlers[i];
      if (tracked.element !== element || tracked.property !== property) continue;
      tracked.handler = handler;
      element[property] = handler;
      return;
    }
    element[property] = handler;
    ownedHandlers.push({ element: element, property: property, previous: previous, handler: handler });
  }

  // Dynamic getters preserve legacy sibling replacement semantics while the
  // service itself receives only narrow typed ports.
  var BOBO = {};
  Object.defineProperties(BOBO, {
    state: { enumerable: true, get: function() { return S; } },
    i18n: { enumerable: true, get: function() { return dependencies.getI18n(); } },
    toast: { enumerable: true, get: function() { return dependencies.getToast(); } },
    auth: { enumerable: true, get: function() { return dependencies.getAuth(); } },
    accountProfile: { enumerable: true, get: function() { return dependencies.getAccountProfile(); } },
    workspace: { enumerable: true, get: function() { return dependencies.getWorkspace(); } },
    rclone: { enumerable: true, get: function() { return dependencies.getRclone(); } },
    runner: { enumerable: true, get: function() { return dependencies.getRunner(); } },
    workbench: { enumerable: true, get: function() { return dependencies.getWorkbench(); } },
    environmentActivity: { enumerable: true, get: function() { return dependencies.getEnvironmentActivity(); } },
    switchToPanel: { enumerable: true, get: function() { return dependencies.getSwitchToPanel(); } },
    sendToServer: { enumerable: true, get: function() { return dependencies.sendToServer; } }
  });
  var selectedTeamId = '';
  var selectedDetail = null;
  var teamTabs = new Map();
  var currentTeamRequest = null;
  var pendingTeamViewRestore = null;
  var TEAM_TAB_PREFIX = 'team-page:';
  var sidebarMode = 'friends';
  var friendsVisible = false;
  var sidebarIdentity = '';
  var teamListRequest = 0;
  var detailRequest = 0;
  var expandedProjects = new Map();
  var actionConfirm = null;
  var actionRevision = 0;
  var chosenAvatar = 'ocean';
  var lockRefreshTimer = null;
  var lockBroadcastTimer = null;
  var lockCountdownTimer = null;
  var lockBroadcastRequest = null;
  var selectedCacheInfo = null;
  var selectedTeamActivity = null;
  var conflictSession = null;
  var conflictDiffEditor = null;
  var conflictResultEditor = null;
  var conflictModels = [];
  var lockRefreshInFlight = false;
  var initialized = false;
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
    if (disposed) return;
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
    if (disposed) return;
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
    if (disposed) return;
    var user = Object.assign({}, currentUser() || {}, { avatar: chosenAvatar, name: $('profile-name').value });
    $('profile-avatar-preview').outerHTML = avatarMarkup(user, 'profile-avatar-preview').replace('<span ', '<span id="profile-avatar-preview" ');
    document.querySelectorAll('.profile-avatar-swatch').forEach(function(el) {
      el.classList.toggle('selected', el.getAttribute('data-avatar') === chosenAvatar);
    });
  }
  function openProfile() {
    if (disposed) return;
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
  function closeProfile() { if (!disposed) $('profile-modal').classList.remove('open'); }
  function chooseAvatarFile(file) {
    if (disposed || !file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      notify('Choose a PNG, JPEG, WebP or GIF image under 5 MB', 'error');
      return;
    }
    if (!createObjectURL || !revokeObjectURL || !createImage) {
      notify('The selected image could not be read', 'error');
      return;
    }
    var objectURL;
    var image;
    try {
      objectURL = createObjectURL(file);
      image = createImage();
    } catch (_) {
      try { if (objectURL && revokeObjectURL) revokeObjectURL(objectURL); } catch (__) {}
      notify('The selected image could not be read', 'error');
      return;
    }
    var avatarLoad = { objectURL: objectURL, image: image, epoch: lifecycleEpoch, released: false };
    activeAvatarLoads.add(avatarLoad);
    function releaseAvatarLoad() {
      if (avatarLoad.released) return;
      avatarLoad.released = true;
      activeAvatarLoads.delete(avatarLoad);
      try { if (revokeObjectURL) revokeObjectURL(objectURL); } catch (_) {}
      try { image.onload = null; image.onerror = null; } catch (_) {}
    }
    image.onload = function() {
      if (!isCurrent(avatarLoad.epoch)) { releaseAvatarLoad(); return; }
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
        releaseAvatarLoad();
      }
    };
    image.onerror = function() {
      if (!isCurrent(avatarLoad.epoch)) { releaseAvatarLoad(); return; }
      releaseAvatarLoad();
      notify('The selected image could not be read', 'error');
    };
    image.src = objectURL;
  }
  async function saveProfile() {
    if (disposed) return;
    var epoch = lifecycleEpoch;
    try {
      var result = await BOBO.sendToServer('updateProfile', { name: $('profile-name').value.trim(), avatar: chosenAvatar }, { quiet: true });
      if (!isCurrent(epoch)) return;
      if (!result || !result.success) throw new Error(result && result.error || 'Update failed');
      S.auth.user = result.user;
      if (BOBO.auth) BOBO.auth.renderChip();
      closeProfile();
      notify('Profile updated', 'success');
    } catch (err) { if (isCurrent(epoch)) notify(err.message, 'error'); }
  }

  // ─── Reusable action dialog ────────────────────────────────
  function closeAction() {
    if (disposed) return;
    actionRevision++;
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
    if (disposed) return;
    actionRevision++;
    bindText($('collab-action-title'), title, titleParams);
    $('collab-action-body').innerHTML = bodyHTML + '<div id="collab-action-status" class="collab-action-status"></div>';
    bindText($('collab-action-confirm'), confirmText || 'Continue');
    bindText($('collab-action-cancel'), 'Cancel');
    $('collab-action-confirm').disabled = false;
    $('collab-action-cancel').disabled = false;
    $('collab-action-close').disabled = false;
    actionConfirm = onConfirm;
    $('collab-action-modal').classList.add('open');
    var first = $('collab-action-body').querySelector('input,select,textarea');
    if (first) setTimeout(function() { first.focus(); }, 30);
  }
  async function runActionConfirm() {
    if (disposed || !actionConfirm) return;
    var epoch = lifecycleEpoch;
    var revision = actionRevision;
    var btn = $('collab-action-confirm');
    btn.disabled = true;
    $('collab-action-cancel').disabled = true;
    $('collab-action-close').disabled = true;
    setActionStatusKey('Working...', null, false);
    try {
      var shouldClose = await actionConfirm();
      if (!isCurrent(epoch) || revision !== actionRevision) return;
      if (shouldClose !== false) closeAction();
    } catch (err) {
      if (isCurrent(epoch) && revision === actionRevision) setActionStatus(collaborationErrorMessage(err), true);
    } finally {
      if (isCurrent(epoch) && revision === actionRevision) {
        btn.disabled = false;
        $('collab-action-cancel').disabled = false;
        $('collab-action-close').disabled = false;
      }
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
  function getSidebarIdentity() {
    return currentUser() && S.auth.token ? JSON.stringify([S.serverSettings?.ip, S.serverSettings?.port, currentUser().id, S.auth.token]) : '';
  }
  function resetSidebar(identity) {
    sidebarIdentity = identity;
    teamListRequest++;
    detailRequest++;
    expandedProjects.clear();
    resetTeamPages();
    S.collaboration.teams = [];
    if ($('collab-team-list')) $('collab-team-list').innerHTML = '';
    if ($('collab-team-detail')) renderNoTeam();
  }
  function setFriendsVisible(visible) {
    if (friendsVisible === visible) return;
    friendsVisible = visible;
    if (typeof global.Event === 'function') global.dispatchEvent(new global.Event(visible ? 'bobo:social-friends-visible' : 'bobo:social-friends-hidden'));
  }
  async function openHub(mode) {
    if (disposed) return;
    if (mode === 'teams' || mode === 'friends') sidebarMode = mode;
    BOBO.workbench?.setPrimaryView?.('team');
    await showSidebarMode(sidebarMode);
  }
  async function showSidebarMode(mode) {
    if (disposed || !$('collab-teams')) return;
    var identity = getSidebarIdentity();
    if (sidebarIdentity !== identity) resetSidebar(identity);
    sidebarMode = mode;
    var friends = mode === 'friends';
    $('collab-mode-friends').setAttribute('aria-pressed', String(friends));
    $('collab-mode-teams').setAttribute('aria-pressed', String(!friends));
    $('collab-friends').hidden = !friends;
    $('collab-teams').hidden = friends;
    $('collab-teams-login').hidden = Boolean(identity);
    $('collab-teams-content').hidden = !identity;
    setFriendsVisible(friends);
    if (!friends && identity) await loadTeams();
  }

  async function loadTeams(preferTeamId, expectedEpoch) {
    var epoch = expectedEpoch === undefined ? lifecycleEpoch : expectedEpoch;
    var identity = getSidebarIdentity();
    if (!isCurrent(epoch) || !identity) return;
    var request = ++teamListRequest;
    if (!S.collaboration.teams?.length) $('collab-team-list').innerHTML = '<div class="collab-empty" data-i18n="Loading...">' + esc(t('Loading...')) + '</div>';
    try {
      var teams = asArray(await api('listTeams'));
      if (!isCurrent(epoch) || request !== teamListRequest || identity !== getSidebarIdentity()) return;
      S.collaboration.teams = teams.sort(function(a, b) { return Number(Boolean(b.is_admin)) - Number(Boolean(a.is_admin)) || String(a.name).localeCompare(String(b.name)); });
      for (var id of expandedProjects.keys()) if (!teams.some(function(team) { return team.id === id; })) expandedProjects.delete(id);
      for (var tab of Array.from(teamTabs.values())) {
        var team = teams.find(function(item) { return item.id === tab.id; });
        if (!team) closeTeamPage(tab.key);
        else tab.name = team.name;
      }
      renderTeamList();
      var next = preferTeamId;
      if (!teams.some(function(team) { return team.id === next; })) next = '';
      if (next) await selectTeam(next, epoch);
      BOBO.workspace?.updateTabbar?.();
      BOBO.workspace?.updateTitlebar?.();
    } catch (err) {
      if (isCurrent(epoch) && request === teamListRequest && identity === getSidebarIdentity()) {
        $('collab-team-list').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
      }
    }
  }
  function expandedMarkup(expansion) {
    if (expansion.error) return '<div class="collab-empty">' + esc(expansion.error) + '</div>';
    if (!expansion.projects) return '<div class="collab-empty" data-i18n="Loading...">' + esc(t('Loading...')) + '</div>';
    if (!expansion.projects.length) return '<div class="collab-empty" data-i18n="No team projects">' + esc(t('No team projects')) + '</div>';
    return expansion.projects.map(function(project) {
      return '<button type="button" class="collab-expanded-project" data-expanded-project="' + esc(project.id) + '" title="' + esc(project.name) + '"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1.8 4.5h5l1.2 1.3h6.2v6.4H1.8z" stroke-linejoin="round"/></svg><span dir="auto">' + esc(project.name) + '</span></button>';
    }).join('');
  }
  function teamRow(teamId) {
    return Array.from($('collab-team-list').querySelectorAll('[data-team-row]')).find(function(row) { return row.dataset.teamRow === teamId; });
  }
  async function toggleTeamProjects(teamId) {
    var expansion = expandedProjects.get(teamId);
    var row = teamRow(teamId);
    if (!row) return;
    if (expansion) expandedProjects.delete(teamId);
    else expandedProjects.set(teamId, expansion = {});
    updateExpandedRow(row, expandedProjects.get(teamId));
    if (!expandedProjects.has(teamId)) return;
    var epoch = lifecycleEpoch;
    var identity = getSidebarIdentity();
    try {
      expansion.projects = asArray(await api('listTeamProjects', { teamId: teamId }));
    } catch (err) { expansion.error = err.message; }
    if (isCurrent(epoch) && identity === getSidebarIdentity() && expandedProjects.get(teamId) === expansion) {
      var currentRow = teamRow(teamId);
      if (currentRow) updateExpandedRow(currentRow, expansion);
    }
  }
  function updateExpandedRow(row, expansion) {
    row.querySelector('[data-team-expand]').setAttribute('aria-expanded', String(Boolean(expansion)));
    var projects = row.querySelector('.collab-expanded-projects');
    projects.hidden = !expansion;
    projects.innerHTML = expansion ? expandedMarkup(expansion) : '';
  }
  function renderTeamList() {
    var teams = S.collaboration.teams || [];
    var list = $('collab-team-list');
    if (!teams.length) { list.innerHTML = '<div class="collab-empty" data-i18n="No teams yet">' + esc(t('No teams yet')) + '</div>'; return; }
    list.innerHTML = teams.map(function(team, index) {
      return '<div class="collab-team-row" data-team-row="' + esc(team.id) + '" data-team-index="' + index + '"><div class="collab-team-row-head">' +
        '<button type="button" class="icon-command collab-team-expand" data-team-expand aria-controls="collab-expanded-' + index + '"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button>' +
        '<button type="button" class="collab-team-item" data-team-id="' + esc(team.id) + '" title="' + esc(team.name) + '" aria-pressed="' + String(team.id === selectedTeamId) + '">' +
        '<span class="team-list-avatar">' + esc(initials(team.name)) + '</span><span><strong dir="auto">' + esc(team.name) + '</strong><small></small></span></button></div><div id="collab-expanded-' + index + '" class="collab-expanded-projects"></div></div>';
    }).join('');
    list.querySelectorAll('[data-team-index]').forEach(function(row) {
      var team = teams[Number(row.getAttribute('data-team-index'))];
      bindText(row.querySelector('small'), '{members} members · {projects} projects', { members: team.member_count, projects: team.project_count });
      var expand = row.querySelector('[data-team-expand]');
      bindAttribute(expand, 'aria-label', 'Projects in {team}', { team: team.name });
      bindAttribute(expand, 'title', 'Projects in {team}', { team: team.name });
      updateExpandedRow(row, expandedProjects.get(team.id));
    });
  }
  function renderNoTeam() {
	  selectedTeamId = '';
    selectedDetail = selectedCacheInfo = selectedTeamActivity = null;
    $('collab-team-detail').hidden = true;
    $('collab-project-list').innerHTML = '';
    $('collab-member-list').innerHTML = '';
    $('collab-cache-view').innerHTML = '';
    $('team-member-activity').innerHTML = '';
    $('team-project-activity').innerHTML = '';
    $('collab-team-list').querySelectorAll('[data-team-id]').forEach(function(row) { row.setAttribute('aria-pressed', 'false'); });
  }

  function teamKey(teamId) { return TEAM_TAB_PREFIX + encodeURIComponent(teamId); }
  function teamPageChrome() {
    BOBO.workspace?.updateTabbar?.();
    BOBO.workspace?.updateTitlebar?.();
    BOBO.workspace?.updateEmptyState?.();
  }
  function teamProviderTabs() {
    return Array.from(teamTabs.values()).map(function(tab) {
      return { key: tab.key, name: tab.name, title: t('Team workspace') + ': ' + tab.name, category: t('Teams'), closeable: true, draggable: true };
    });
  }
  function deactivateTeamPage() {
    if (S.currentViewMode !== 'team-page') return;
    var tab = teamTabs.get(S.activeTabPath);
    if (tab?.previousView) pendingTeamViewRestore = tab.previousView;
    $('collab-team-page').hidden = true;
    var container = $('container');
    if (container) container.style.display = '';
    S.currentViewMode = 'single';
  }
  function closeTeamPage(key) {
    var tab = teamTabs.get(key);
    if (!tab) return false;
    var active = S.activeTabPath === key;
    if (active) deactivateTeamPage();
    teamTabs.delete(key);
    if (active) {
      detailRequest++;
      renderNoTeam();
      var previous = tab.previousKey;
      if (!(S.tabs.some(function(file) { return file.path === previous; }) || teamTabs.has(previous) || BOBO.workspace?.getWorkbenchTab?.(previous))) {
        previous = Array.from(teamTabs.keys()).pop() || S.tabs[S.tabs.length - 1]?.path;
      }
      S.activeTabPath = null;
      if (previous) BOBO.workspace?.activateTab?.(previous);
    }
    teamPageChrome();
    return true;
  }
  function resetTeamPages() {
    var active = teamTabs.get(S.activeTabPath);
    if (active) {
      deactivateTeamPage();
      S.activeTabPath = null;
    }
    teamTabs.clear();
    if (active) {
      var previous = active.previousKey;
      if (!(S.tabs.some(function(file) { return file.path === previous; }) || BOBO.workspace?.getWorkbenchTab?.(previous))) previous = S.tabs[S.tabs.length - 1]?.path;
      if (previous) BOBO.workspace?.activateTab?.(previous);
    }
    teamPageChrome();
  }
  function activateTeamPage(key) {
    var tab = teamTabs.get(key);
    if (disposed || !tab || !getSidebarIdentity()) return false;
    if (S.activeTabPath && S.activeTabPath !== key) tab.previousKey = S.activeTabPath;
    var fileTab = S.tabs.find(function(file) { return file.path === S.activeTabPath; });
    if (fileTab) tab.previousView = {
      path: fileTab.path, mode: S.currentViewMode,
      diffOriginalPath: S.diffOriginalPath, diffModifiedPath: S.diffModifiedPath
    };
    $('split-container')?.classList.remove('active');
    $('diff-container')?.classList.remove('active');
    $('image-preview')?.classList.add('hidden');
    dependencies.getDocumentViews?.()?.hideAll({ restoreEditor: false });
    var container = $('container');
    if (container) container.style.display = 'none';
    S.activeTabPath = key;
    S.currentViewMode = 'team-page';
    $('collab-team-page').hidden = false;
    selectTeamPane(tab.pane || 'members');
    currentTeamRequest = loadTeamDetail(tab.id);
    teamPageChrome();
    return true;
  }
  function restoreTeamUnderlyingView(fileTab) {
    var snapshot = pendingTeamViewRestore;
    pendingTeamViewRestore = null;
    if (!snapshot || snapshot.path !== fileTab.path) return;
    if (snapshot.mode === 'split') dependencies.getViews?.()?.openSplit?.();
    else if (snapshot.mode === 'diff') dependencies.getViews?.()?.openDiff?.(snapshot.diffOriginalPath, snapshot.diffModifiedPath);
  }
  function selectTeamPane(name) {
    document.querySelectorAll('#collab-team-detail [data-collab-tab]').forEach(function(tab) {
      var active = tab.getAttribute('data-collab-tab') === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
      $(tab.getAttribute('aria-controls')).hidden = !active;
    });
    var page = teamTabs.get(S.activeTabPath);
    if (page) page.pane = name;
  }
  async function selectTeam(teamId, expectedEpoch) {
    var epoch = expectedEpoch === undefined ? lifecycleEpoch : expectedEpoch;
    if (!isCurrent(epoch)) return;
    var team = (S.collaboration.teams || []).find(function(item) { return item.id === teamId; });
    if (!team) return;
    var key = teamKey(teamId);
    if (!teamTabs.has(key)) teamTabs.set(key, { id: teamId, key: key, name: team.name, pane: 'members' });
    if (BOBO.workspace?.activateTab) BOBO.workspace.activateTab(key);
    else activateTeamPage(key);
    await currentTeamRequest;
  }
  async function loadTeamDetail(teamId, expectedEpoch) {
    var epoch = expectedEpoch === undefined ? lifecycleEpoch : expectedEpoch;
    if (!isCurrent(epoch)) return;
    var identity = getSidebarIdentity();
    var request = ++detailRequest;
    var changed = selectedTeamId !== teamId || !selectedDetail;
    selectedTeamId = teamId;
    $('collab-team-page-status').hidden = false;
    bindText($('collab-team-page-status'), 'Loading...');
    if (changed) {
      selectedDetail = selectedCacheInfo = selectedTeamActivity = null;
      $('collab-team-detail').hidden = true;
    }
    $('collab-team-list').querySelectorAll('[data-team-id]').forEach(function(row) { row.setAttribute('aria-pressed', String(row.dataset.teamId === teamId)); });
    try {
      var detail = await api('getTeam', { teamId: teamId });
      if (!isCurrent(epoch) || request !== detailRequest || selectedTeamId !== teamId || identity !== getSidebarIdentity()) return;
      selectedDetail = detail;
      $('collab-team-page-status').hidden = true;
      $('collab-cache-view').innerHTML = '<div class="collab-empty" data-i18n="Loading cache allocation...">' + esc(t('Loading cache allocation...')) + '</div>';
      $('team-member-activity').innerHTML = '<div class="collab-empty" data-i18n="Loading activity...">' + esc(t('Loading activity...')) + '</div>';
      $('team-project-activity').innerHTML = '<div class="collab-empty" data-i18n="Loading activity...">' + esc(t('Loading activity...')) + '</div>';
      renderSelectedTeam();
      void loadTeamCache();
      void loadTeamActivity();
      if (expandedProjects.has(teamId)) {
        var expansion = { projects: asArray(detail.projects) };
        expandedProjects.set(teamId, expansion);
        var row = teamRow(teamId);
        if (row) updateExpandedRow(row, expansion);
      }
    } catch (err) {
      if (isCurrent(epoch) && request === detailRequest && identity === getSidebarIdentity()) {
        setRawText($('collab-team-page-status'), err.message);
        $('collab-team-page-status').hidden = false;
        notify(err.message, 'error');
      }
    }
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
    bindText($('team-member-count'), '{count} members', { count: detail.members.length });
    $('collab-team-settings').hidden = !isAdmin;
    $('collab-leave-team').hidden = isAdmin;
    renderProjects(detail.projects, isAdmin);
    renderMembers(detail.members, isAdmin);
    renderMemberActivity(selectedTeamActivity);
    renderProjectActivity(selectedTeamActivity);
    renderTeamCache(selectedCacheInfo, detail.projects, isAdmin);
    $('collab-team-detail').hidden = false;
  }
  function renderProjects(projects, isAdmin) {
    var teamId = selectedTeamId;
    var cacheByProject = projectCacheSizes(selectedCacheInfo);
    var colors = teamProjectColors(projects);
    var cards = projects.map(function(project, index) {
      var color = colors[index];
      var usage = cacheByProject[project.id] || 0;
      var namespaces = projectCacheNamespaces(selectedCacheInfo, project.id);
      var remove = isAdmin ? '<button class="icon-command collab-delete-project" data-project-id="' + esc(project.id) + '" title="' + esc(t('Delete project')) + '" aria-label="' + esc(t('Delete project')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : '';
      var details = namespaces.length ? '<details class="team-project-cache-details"><summary data-i18n="Cache breakdown">' + esc(t('Cache breakdown')) + '</summary>' + namespaces.map(function(ns) {
        return '<div class="team-project-cache-row"><span>' + esc(ns.cache_kind + ' · ' + ns.branch + ' · ' + ns.runtime + ' · ' + ns.language) + '</span><span>' + formatBytes(ns.size_bytes) + '</span>' + (isAdmin && ns.clearable && !ns.active ? '<button type="button" class="team-tool-btn cache-clear-namespace" data-namespace="' + esc(ns.key) + '" data-i18n="Clear">' + esc(t('Clear')) + '</button>' : '') + '</div>';
      }).join('') + '</details>' : '';
      return '<article class="team-project-card" style="--project-accent:' + color + '"><h4 dir="auto">' + esc(project.name) + '</h4><p>' + esc(project.description || t('No description')) + '</p><div class="team-project-card-meta"><span>' + esc(t('default: {branch}', { branch: project.default_branch })) + '</span><span class="team-project-card-cache">' + formatBytes(usage) + '</span></div>' + details + '<div class="team-project-card-actions">' + remove + '<button class="ss-btn ss-btn-primary collab-open-project" data-project-id="' + esc(project.id) + '" data-i18n="Open">' + esc(t('Open')) + '</button></div></article>';
    });
    if (isAdmin) cards.push('<button type="button" class="team-project-add" id="team-create-project" title="' + esc(t('Create cloud project')) + '" aria-label="' + esc(t('Create cloud project')) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>');
    $('collab-project-list').innerHTML = cards.join('') || '<div class="collab-empty" data-i18n="No team projects">' + esc(t('No team projects')) + '</div>';
    assignHandler($('team-create-project'), 'onclick', function() { newProject(teamId); }, false);
  }
  function renderMembers(members, isAdmin) {
    members = asArray(members).slice().sort(function(left, right) {
      if (!!left.is_admin !== !!right.is_admin) return left.is_admin ? -1 : 1;
      return String(left.uid || '').localeCompare(String(right.uid || ''));
    });
    var totals = Object.create(null);
    asArray(selectedTeamActivity && selectedTeamActivity.members).forEach(function(member) { totals[member.user_id] = member.total; });
    var cards = members.map(function(member) {
      var role = member.is_admin ? t('Administrator') : t('Team member');
      var total = Number(totals[member.user_id] || 0);
      var remove = isAdmin && !member.is_admin ? '<button type="button" class="team-tool-btn collab-remove-member" data-user-id="' + esc(member.user_id) + '" data-i18n="Remove">' + esc(t('Remove')) + '</button>' : '';
      var display = avatarMarkup(member, 'team-member-avatar');
      return '<div class="team-member-card" tabindex="0" aria-label="' + esc(t('{uid}, {role}, {count} commits', { uid: member.uid, role: role, count: total })) + '">' + display + '<span class="team-member-uid" title="' + esc(member.uid) + '">' + esc(member.uid) + '</span><span class="team-member-tooltip" role="tooltip"><strong>' + esc(member.name || member.username || member.uid) + '</strong><span>' + esc(member.uid) + '</span><span>' + esc(role) + ' · ' + esc(t('{count} commits', { count: total })) + '</span>' + remove + '</span></div>';
    });
    if (isAdmin) cards.push('<button type="button" class="team-member-card team-add-member-card" id="team-add-member" aria-label="' + esc(t('Invite team members')) + '"><span class="team-add-member"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><span class="team-member-uid">' + esc(t('Invite')) + '</span></button>');
    $('collab-member-list').innerHTML = cards.join('');
    assignHandler($('team-add-member'), 'onclick', openInviteUsers, false);
  }
  async function loadTeamActivity() {
    var epoch = lifecycleEpoch;
    var teamId = selectedTeamId;
    var identity = getSidebarIdentity();
    var request = detailRequest;
    if (!isCurrent(epoch) || !teamId) return;
    try {
      var activity = await api('teamActivity', { teamId: teamId });
      if (!isCurrent(epoch) || request !== detailRequest || identity !== getSidebarIdentity()) return;
      selectedTeamActivity = activity;
      renderMembers(asArray(selectedDetail && selectedDetail.members), selectedDetail && selectedDetail.team.admin_user_id === currentUser().id);
      renderMemberActivity(activity);
      renderProjectActivity(activity);
    } catch (err) {
      if (isCurrent(epoch) && request === detailRequest && identity === getSidebarIdentity()) {
        $('team-member-activity').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
        $('team-project-activity').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
      }
    }
  }
  async function loadTeamCache() {
    var epoch = lifecycleEpoch;
    var teamId = selectedTeamId;
    var identity = getSidebarIdentity();
    var request = detailRequest;
    if (!isCurrent(epoch) || !teamId) return;
    try {
      var info = await api('getTeamCacheInfo', { teamId: teamId });
      if (!isCurrent(epoch) || request !== detailRequest || identity !== getSidebarIdentity()) return;
      selectedCacheInfo = info;
      var projects = asArray(selectedDetail && selectedDetail.projects);
      var isAdmin = selectedDetail && selectedDetail.team.admin_user_id === currentUser().id;
      renderTeamCache(selectedCacheInfo, projects, isAdmin);
      renderProjects(projects, !!isAdmin);
    } catch (err) {
      if (isCurrent(epoch) && request === detailRequest && identity === getSidebarIdentity()) $('collab-cache-view').innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
    }
  }
  function teamProjectColors(projects) {
    return asArray(projects).map(function(_, index) { return teamSeriesColor(index); });
  }
  function projectCacheNamespaces(info, projectId) {
    if (!info) return [];
    var namespaces = asArray(info.namespaces).filter(function(item) { return item.project_id === projectId; }).map(function(item) { return Object.assign({}, item, { cache_kind: t('Build target'), clearable: true }); })
      .concat(asArray(info.dependencies).filter(function(item) { return item.project_id === projectId; }).map(function(item) { return Object.assign({}, item, { cache_kind: t('Dependencies') }); }));
    var knownBytes = namespaces.reduce(function(total, item) { return total + Math.max(0, Number(item.size_bytes || 0)); }, 0);
    var totalBytes = projectCacheSizes(info)[projectId] || 0;
    if (totalBytes > knownBytes) namespaces.push({ branch: '', runtime: '', language: '', size_bytes: totalBytes - knownBytes, cache_kind: t('Scratch workspaces'), active: false, clearable: false });
    return namespaces;
  }
  function projectCacheSizes(info) {
    var sizes = Object.create(null);
    if (!info) return sizes;
    if (Array.isArray(info.project_usage)) {
      info.project_usage.forEach(function(item) { if (item.project_id) sizes[item.project_id] = Math.max(0, Number(item.size_bytes || 0)); });
      return sizes;
    }
    asArray(info.namespaces).concat(asArray(info.dependencies)).forEach(function(item) {
      if (!item.project_id) return;
      sizes[item.project_id] = (sizes[item.project_id] || 0) + Math.max(0, Number(item.size_bytes || 0));
    });
    return sizes;
  }
  function renderTeamCache(info, projects, isAdmin) {
    var target = $('collab-cache-view');
    if (!info) { target.innerHTML = '<div class="collab-empty" data-i18n="Cache is unavailable">' + esc(t('Cache is unavailable')) + '</div>'; return; }
    var sizes = projectCacheSizes(info);
    var colors = teamProjectColors(projects);
    var allocations = asArray(projects).map(function(project, index) {
      return { name: project.name, size: sizes[project.id] || 0, color: colors[index] };
    }).filter(function(item) { return item.size > 0; });
    var allocated = allocations.reduce(function(total, item) { return total + item.size; }, 0);
    var totalBytes = Math.max(0, Number(info.total_bytes || 0));
    var percent = info.quota_bytes ? Math.min(100, totalBytes / Number(info.quota_bytes) * 100) : 0;
    var circumference = 2 * Math.PI * 32;
    var offset = 0;
    var segments = allocations.map(function(item) {
      var length = allocated > 0 ? item.size / allocated * circumference : 0;
      var segment = '<circle class="team-cache-segment" cx="40" cy="40" r="32" pathLength="' + circumference.toFixed(2) + '" stroke="' + item.color + '" stroke-dasharray="' + length.toFixed(2) + ' ' + circumference.toFixed(2) + '" stroke-dashoffset="-' + offset.toFixed(2) + '"><title>' + esc(item.name + ' · ' + formatBytes(item.size)) + '</title></circle>';
      offset += length;
      return segment;
    }).join('');
    var donut = '<div class="team-cache-donut-wrap"><svg class="team-cache-donut" viewBox="0 0 80 80" role="img" aria-label="' + esc(t('Project cache allocation, {size}', { size: formatBytes(allocated) })) + '"><circle class="team-cache-donut-track" cx="40" cy="40" r="32"></circle>' + segments + '</svg><div class="team-cache-donut-center"><strong>' + formatBytes(totalBytes) + '</strong><span>' + esc(t('TOTAL USED')) + '</span></div></div>';
    var summary = '<div class="team-cache-summary"><div class="team-cache-summary-item"><strong>' + formatBytes(info.quota_bytes) + '</strong><span>' + esc(t('TEAM LIMIT')) + '</span></div><div class="team-cache-summary-item"><strong>' + percent.toFixed(1) + '%</strong><span>' + esc(t('QUOTA USED')) + '</span></div><div class="team-cache-summary-item"><strong>' + formatBytes(info.shared_bytes) + '</strong><span>' + esc(t('SHARED DEPENDENCIES')) + '</span></div><div class="team-cache-summary-item"><strong>' + formatBytes(info.target_bytes) + '</strong><span>' + esc(t('INCREMENTAL TARGETS')) + '</span></div><div class="team-cache-summary-item"><strong>' + formatBytes(info.dependency_bytes) + '</strong><span>' + esc(t('PROJECT DEPENDENCIES')) + '</span></div><div class="team-cache-summary-item"><strong>' + formatBytes(info.scratch_bytes) + '</strong><span>' + esc(t('SCRATCH WORKSPACES')) + '</span></div>' +
      (isAdmin ? '<div class="team-cache-summary-actions"><button type="button" class="team-tool-btn cache-clear-shared" data-i18n="Clear shared">' + esc(t('Clear shared')) + '</button><button type="button" class="team-tool-btn cache-clear-all" data-i18n="Clear all">' + esc(t('Clear all')) + '</button></div>' : '') + '</div>';
    target.innerHTML = '<div class="team-cache-overview">' + donut + summary + '</div>';
  }
  function teamSeriesColor(index) {
    var palette = ['var(--brand)', 'color-mix(in oklab, var(--green) 65%, var(--text-secondary))', 'var(--orange)', 'var(--purple)', 'var(--red)', 'var(--blue)'];
    return palette[index % palette.length];
  }
  function renderMemberActivity(activity) {
    var target = $('team-member-activity');
    if (!activity || !Number(activity.days)) { target.innerHTML = '<div class="collab-empty" data-i18n="Activity is unavailable">' + esc(t('Activity is unavailable')) + '</div>'; return; }
    var members = asArray(activity.members);
    var days = Math.min(200, Number(activity.days));
    const width = 800, height = 150;
    const peak = members.reduce((high, member) => Math.max(high, ...asArray(member.daily).slice(0, days).map(Number)), 1);
    const ticks = [...new Set([peak, Math.floor(peak / 2), 0])];
    const grid = ticks.map(value => {
      const y = height * (1 - value / peak);
      return `<line class="team-activity-gridline" x1="0" x2="${width}" y1="${y}" y2="${y}"/>`;
    }).join('');
    const axis = ticks.map(value => `<span class="team-activity-y" style="top:${100 * (1 - value / peak)}%">${value}</span>`).join('');
    const series = members.map((member, index) => {
      const daily = asArray(member.daily);
      const points = Array.from({ length: days }, (_, i) => {
        const x = width * i / Math.max(1, days - 1);
        const y = height * (1 - Math.max(0, Number(daily[i]) || 0) / peak);
        return x.toFixed(2) + ' ' + y.toFixed(2);
      });
      const line = 'M' + points.join(' L');
      const id = 'team-trend-fill-' + index;
      return `<g style="color:${teamSeriesColor(index)}"><defs><linearGradient id="${id}" x2="0%" y2="100%"><stop stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity=".015"/></linearGradient></defs>
        <path fill="url(#${id})" d="${line} L${days > 1 ? width : 0} ${height} L0 ${height} Z"/>
        <path class="team-activity-series" stroke="currentColor" d="${line}"><title>${esc(member.uid + ' · ' + member.total)}</title></path></g>`;
    }).join('');
    const start = Date.parse(activity.start_date + 'T00:00:00Z');
    const dates = [...new Set([0, .25, .5, .75, 1].map(fraction => Math.round(fraction * (days - 1))))].map(index => {
      const date = new Date(start + index * 86400000);
      return '<span>' + esc(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })) + '</span>';
    }).join('');
    const legend = members.map((member, index) =>
      `<span class="team-activity-legend-item"><i class="team-activity-swatch" style="background:${teamSeriesColor(index)}"></i>${esc(member.uid)} <b>${Number(member.total) || 0}</b></span>`
    ).join('');
    target.innerHTML = `<div class="team-activity-chart"><div class="team-activity-plot">${axis}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('Daily commits by team member'))}" preserveAspectRatio="none">${grid}${series}</svg></div><div class="team-activity-dates">${dates}</div><div class="team-activity-legend">${legend}</div></div>`;
  }
  function renderProjectActivity(activity) {
    var target = $('team-project-activity');
    var start = new Date(activity?.start_date + 'T00:00:00Z');
    if (!activity || !Number(activity.days) || !Number.isFinite(start.getTime())) { target.innerHTML = '<div class="collab-empty" data-i18n="Activity is unavailable">' + esc(t('Activity is unavailable')) + '</div>'; return; }
    var projects = asArray(selectedDetail && selectedDetail.projects);
    var byId = Object.create(null);
    asArray(activity.projects).forEach(function(project) { byId[project.project_id] = project; });
    var colors = teamProjectColors(projects);
    var daily = Array.from({ length: Math.min(200, Number(activity.days)) }, function(_, index) {
      var choice = null;
      var total = 0;
      projects.forEach(function(project, projectIndex) {
        var count = Number(byId[project.id]?.daily?.[index]) || 0;
        total += count;
        if (count > 0 && (!choice || count > choice.count)) choice = { count: count, project: project, color: colors[projectIndex] };
      });
      return choice && { ...choice, total };
    });
    var max = Math.max(1, ...daily.map(function(day) { return day ? day.total : 0; }));
    var padding = start.getUTCDay();
    var cells = [];
    var monthLabels = [];
    for (var p = 0; p < padding; p++) cells.push('<span class="team-heatmap-cell is-empty" aria-hidden="true"></span>');
    daily.forEach(function(day, index) {
      var date = new Date(start.getTime() + index * 86400000);
      var label = date.toISOString().slice(0, 10);
      if (!index || date.getUTCDate() === 1) {
        monthLabels.push('<span style="grid-column:' + (1 + Math.floor((index + padding) / 7)) + '">' + esc(date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })) + '</span>');
      }
      if (!day) cells.push('<span class="team-heatmap-cell" title="' + label + ' · ' + esc(t('No commits')) + '" data-date="' + label + '"></span>');
      else {
        var mix = 24 + Math.ceil(day.total / max * 4) * 16;
        cells.push('<span class="team-heatmap-cell" title="' + esc(label + ' · ' + t('{count} commits', { count: day.total }) + ' · ' + day.project.name + ' (' + day.count + ')') + '" data-date="' + label + '" style="background:color-mix(in srgb,' + day.color + ' ' + mix + '%,var(--team-heatmap-empty))"></span>');
      }
    });
    var months = monthLabels.join('');
    target.innerHTML = '<div class="team-heatmap-scroll"><div class="team-heatmap-months">' + months + '</div><div class="team-heatmap" role="grid" aria-label="' + esc(t('Team project commit activity')) + '">' + cells.join('') + '</div><div class="team-heatmap-caption"><span data-i18n="Each square is one day; color shows the project with most commits.">' + esc(t('Each square is one day; color shows the project with most commits.')) + '</span><span class="team-heatmap-legend"><span data-i18n="Less">' + esc(t('Less')) + '</span><i></i><i style="background:color-mix(in srgb,var(--text-secondary) 35%,var(--team-heatmap-empty))"></i><i style="background:color-mix(in srgb,var(--text-secondary) 70%,var(--team-heatmap-empty))"></i><i style="background:color-mix(in srgb,var(--text-secondary) 88%,var(--team-heatmap-empty))"></i><span data-i18n="More">' + esc(t('More')) + '</span></span></div></div>';
  }

  function newTeam() {
    openAction('Create team', inputField('action-team-name', 'Team name') + textareaField('action-team-description', 'Description') + inputField('action-team-quota', 'Build cache quota (MB)', '4096', 'number'), 'Create', async function() {
      var team = await api('createTeam', { name: $('action-team-name').value, description: $('action-team-description').value, cacheQuotaMB: Number($('action-team-quota').value) });
      await loadTeams(team.id); notify('Team created', 'success'); return true;
    });
  }
  function newProject(teamId) {
    teamId = teamId || selectedTeamId;
    if (!teamId) return;
    openAction('Create cloud project', inputField('action-project-name', 'Project name') + textareaField('action-project-description', 'Description'), 'Create', async function() {
      await api('createTeamProject', { teamId: teamId, name: $('action-project-name').value, description: $('action-project-description').value });
      await refreshTeamDetail(teamId); notify('Cloud project created', 'success'); return true;
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
      await refreshTeamDetail(project.team_id);
      notify('Team project deleted', 'success');
      return true;
    }, { name: project.name });
  }
  async function refreshTeamDetail(teamId) {
    if (disposed) return;
    if (!selectedTeamId || selectedTeamId === teamId) {
      await loadTeamDetail(teamId);
      return;
    }
    var expansion = expandedProjects.get(teamId);
    if (!expansion) return;
    var identity = getSidebarIdentity();
    var projects = asArray(await api('listTeamProjects', { teamId: teamId }));
    if (disposed || identity !== getSidebarIdentity() || expandedProjects.get(teamId) !== expansion) return;
    expansion.projects = projects;
    var row = teamRow(teamId);
    if (row) updateExpandedRow(row, expansion);
  }
  async function openInviteUsers() {
    var teamId = selectedTeamId;
    var detail = selectedDetail;
    if (!teamId || !detail || detail.team.admin_user_id !== currentUser().id) return;
    var epoch = lifecycleEpoch;
    var identity = getSidebarIdentity();
    var revision = actionRevision;
    var activeTabPath = S.activeTabPath;
    function isInviteContextCurrent() {
      return isCurrent(epoch) && teamId === selectedTeamId && activeTabPath === S.activeTabPath && identity === getSidebarIdentity();
    }
    try {
      var contacts = asArray(await api('listFriends', {}));
      if (!isInviteContextCurrent() || actionRevision !== revision) return;
      var existing = new Set(asArray(selectedDetail?.members).map(function(member) { return member.uid; }));
      contacts = contacts.filter(function(contact) { return contact && contact.uid && !existing.has(contact.uid); });
      var list = contacts.length ? '<div class="team-invite-options">' + contacts.map(function(contact) {
        var avatar = contact.avatar && String(contact.avatar).indexOf('data:image/') === 0
          ? '<span class="team-invite-option-avatar"><img src="' + esc(contact.avatar) + '" alt=""></span>'
          : '<span class="team-invite-option-avatar avatar-' + esc(contact.avatar || 'graphite') + '">' + esc(initials(contact.name || contact.uid)) + '</span>';
        return '<label class="team-invite-option">' + avatar + '<span class="team-invite-option-meta"><strong>' + esc(contact.name || contact.uid) + '</strong><small>' + esc(contact.uid) + '</small></span><input type="checkbox" value="' + esc(contact.uid) + '" aria-label="' + esc(t('Invite {uid}', { uid: contact.uid })) + '"></label>';
      }).join('') + '</div>' : '<div class="collab-empty" data-i18n="No eligible users">' + esc(t('No eligible users')) + '</div>';
      openAction('Invite team members', list, 'Invite', async function() {
        var selected = Array.from($('collab-action-body').querySelectorAll<HTMLInputElement>('.team-invite-option input:checked'));
        if (!selected.length) throw new Error(t('Select at least one user'));
        var sendingRevision = actionRevision;
        var sent = 0;
        for (var input of selected) {
          if (!isInviteContextCurrent() || actionRevision !== sendingRevision) return true;
          try {
            await api('sendInbox', { recipientId: input.value, kind: 'invite', teamId: teamId });
          } catch (error) {
            if (error.code !== 'social_duplicate_invite') continue;
          }
          sent++;
          input.closest('label')?.remove();
        }
        if (!isInviteContextCurrent() || actionRevision !== sendingRevision) return true;
        var failed = selected.length - sent;
        if (failed) throw new Error(t('{sent} invitations delivered · {failed} failed', { sent: sent, failed: failed }));
        notify(t('{sent} invitations sent', { sent: sent }), 'success');
        return true;
      });
    } catch (error) {
      if (!isInviteContextCurrent() || actionRevision !== revision) return;
      notify(error.message, 'error');
    }
  }

  // ─── Cloud project mappings ────────────────────────────────
  function mappingKey(teamId, projectId, branch) {
    return ['bobo-team-map-v1', S.serverSettings.ip || 'server', currentUser().uid || currentUser().id, teamId, projectId, branch].join(':');
  }
  function readMapping(teamId, projectId, branch) {
    try { return storage ? storage.getItem(mappingKey(teamId, projectId, branch)) || '' : ''; } catch (e) { return ''; }
  }
  function writeMapping(teamId, projectId, branch, path) {
    try { if (storage) storage.setItem(mappingKey(teamId, projectId, branch), path); } catch (e) {}
  }
  function removeProjectMappings(teamId, projectId) {
    try {
      var prefix = ['bobo-team-map-v1', S.serverSettings.ip || 'server', currentUser().uid || currentUser().id, teamId, projectId].join(':') + ':';
      if (!storage) return;
      for (var i = storage.length - 1; i >= 0; i--) {
        var key = storage.key(i);
        if (key && key.indexOf(prefix) === 0) storage.removeItem(key);
      }
    } catch (e) {}
  }

  async function refreshApprovedWorkspace(rootPath) {
    if (disposed) return false;
    var epoch = lifecycleEpoch;
    var tree = await dependencies.host.refreshWorkspace();
    var identity = await dependencies.host.getWorkspaceIdentity();
    if (!isCurrent(epoch)) return false;
    if (!tree || !identity || identity.rootPath !== rootPath) {
      throw new Error(t('Pull failed'));
    }
    var applied = await BOBO.workspace.applyWorkspace(rootPath, tree, identity.workspaceIdentity, null, { approved: true });
    if (!isCurrent(epoch)) return false;
    if (!applied) throw new Error(t('Pull failed'));
    return true;
  }

  function confirmOpenProject(project, team) {
    var params = { project: project.name, team: team.name };
    openAction('Open {project} from {team} in the workspace?', '', 'Yes', function() {
      return openProject(Object.assign({}, project, { team_id: team.id, team_name: team.name })).then(function() { return false; });
    }, params);
    bindText($('collab-action-cancel'), 'No');
    $('collab-action-cancel').focus();
  }

  async function openProject(project, preferredBranch) {
    if (disposed) return false;
    var epoch = lifecycleEpoch;
    var identity = getSidebarIdentity();
    openAction('Open {name}', '<div class="collab-open-loading" data-i18n="Loading cloud branches...">' + esc(t('Loading cloud branches...')) + '</div>', 'Open project', null, { name: project.name });
    var revision = actionRevision;
    $('collab-action-confirm').disabled = true;
    var branches;
    try {
      branches = await api('listTeamBranches', { teamId: project.team_id, projectId: project.id });
    } catch (err) {
      if (!isCurrent(epoch) || revision !== actionRevision || identity !== getSidebarIdentity()) return false;
      $('collab-action-body').innerHTML = '<div class="collab-open-error"><strong data-i18n="Could not load this project">' + esc(t('Could not load this project')) + '</strong><span>' + esc(err.message) + '</span></div><div id="collab-action-status" class="collab-action-status"></div>';
      bindText($('collab-action-confirm'), 'Retry');
      $('collab-action-confirm').disabled = false;
      actionConfirm = async function() { await openProject(project, preferredBranch); return false; };
      return;
    }
    if (!isCurrent(epoch) || revision !== actionRevision || identity !== getSidebarIdentity()) return false;
    if (!Array.isArray(branches)) {
      setActionStatusKey('The server returned an invalid branch list', null, true);
      return false;
    }
    var names = branches.map(function(b) { return b && b.name; }).filter(Boolean);
    if (!names.length) {
      setActionStatusKey('This project has no cloud branches', null, true);
      return false;
    }
    var branch = preferredBranch || project.default_branch || names[0];
    if (names.indexOf(branch) < 0) branch = names[0];
    var existing = readMapping(project.team_id, project.id, branch);
    var body = selectField('action-open-branch', 'Cloud branch', names, branch) +
      '<div class="collab-action-field"><label data-i18n="Local mapping">' + esc(t('Local mapping')) + '</label><div id="action-mapping-path" class="mapping-path">' + esc(existing || t('Not selected')) + '</div><button id="action-choose-mapping" class="ss-btn ss-btn-ghost" type="button" data-i18n="Choose directory">' + esc(t('Choose directory')) + '</button></div>' +
      selectField('action-open-mode', 'Open mode', existing ? [{value:'local',label:'Open local changes'}, {value:'pull',label:'Reset from cloud (discard local changes)'}] : [{value:'pull',label:'Initial pull from cloud'}], existing ? 'local' : 'pull');
    openAction('Open {name}', body, 'Open project', async function() {
      if (!isCurrent(epoch) || identity !== getSidebarIdentity()) return false;
      var selectedBranch = $('action-open-branch').value;
	  var storedPath = readMapping(project.team_id, project.id, selectedBranch);
	  var mappingElement = $('action-mapping-path');
	  var localPath = mappingElement.getAttribute('data-path') || storedPath;
      if (!localPath) throw new Error(t('Choose a local mapping directory'));
      var pathInfo = await dependencies.host.localPathInfo(localPath, mappingElement.getAttribute('data-grant') || '');
      if (!isCurrent(epoch)) return false;
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
      if (!isCurrent(epoch)) return false;
      try {
        var prepared;
        if (isFirst || mode === 'pull') {
          setActionStatusKey('Pulling cloud branch...', null, false);
          prepared = await BOBO.rclone.prepareTeamPull({
            teamId: project.team_id,
            projectId: project.id,
            branch: selectedBranch,
            reset: true
           }, { dest: localPath, localGrant: pathInfo.grantId });
           if (!isCurrent(epoch)) return false;
           if (!prepared || !prepared.success) throw new Error(prepared && prepared.error || t('Pull failed'));
           var result = await BOBO.rclone.pull({ dest: localPath, localGrant: pathInfo.grantId, remoteGrantId: prepared.remoteGrantId, onProgress: function(line) { setActionStatus(line, false); } });
           if (!isCurrent(epoch)) return false;
           if (!result.success) throw new Error(result.error && result.error.message || t('Pull failed'));
        } else {
          await api('prepareTeamProject', { teamId: project.team_id, projectId: project.id, branch: selectedBranch, reset: false });
        }
	      if (!isCurrent(epoch)) return false;
	    var teamName = project.team_name || (selectedDetail && selectedDetail.team && selectedDetail.team.name) || (S.collaboration.current && S.collaboration.current.teamName) || 'Team';
        var nextCurrent = { teamId: project.team_id, teamName: teamName, projectId: project.id, projectName: project.name, branch: selectedBranch, localPath: localPath };
    await dependencies.host.writeTeamMapping({ localPath: localPath, localGrant: pathInfo.grantId, mapping: nextCurrent });
        if (!isCurrent(epoch)) return false;
        if (replacesCurrentWorkspace) {
          await refreshApprovedWorkspace(localPath);
        } else {
          var opened = await dependencies.host.pickWorkspace(localPath);
          if (!opened || !(await BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken))) return false;
        }
	      if (!isCurrent(epoch)) return false;
	    writeMapping(project.team_id, project.id, selectedBranch, localPath);
        S.collaboration.current = nextCurrent;
        updateTeamChrome();
        BOBO.switchToPanel?.('team');
        BOBO.workbench?.setPrimaryView?.('explorer');
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
      if (disposed) return;
      var selected = $('action-open-branch').value;
      var mapped = readMapping(project.team_id, project.id, selected);
      var pathEl = $('action-mapping-path');
      if (mapped) setRawText(pathEl, mapped);
      else bindText(pathEl, 'Not selected');
      pathEl.setAttribute('data-path', mapped || '');
      pathEl.setAttribute('data-grant', '');
      $('action-open-mode').innerHTML = mapped ? '<option value="local" data-i18n="Open local changes">' + esc(t('Open local changes')) + '</option><option value="pull" data-i18n="Reset from cloud (discard local changes)">' + esc(t('Reset from cloud (discard local changes)')) + '</option>' : '<option value="pull" data-i18n="Initial pull from cloud">' + esc(t('Initial pull from cloud')) + '</option>';
    }
    listen($('action-open-branch'), 'change', updateMappingForBranch, undefined, false);
    listen($('action-choose-mapping'), 'click', async function() {
      if (disposed) return;
      var chosen = await dependencies.host.pickLocalMapping();
      if (disposed) return;
      if (!chosen) return;
      var selected = $('action-open-branch').value;
      var first = !readMapping(project.team_id, project.id, selected);
      if (first && !chosen.empty) { setActionStatusKey('Choose an empty directory for the initial pull', null, true); return; }
      setRawText($('action-mapping-path'), chosen.path);
      $('action-mapping-path').setAttribute('data-path', chosen.path);
	  $('action-mapping-path').setAttribute('data-grant', chosen.grantId || '');
	  $('action-open-mode').innerHTML = '<option value="pull" data-i18n="Initial pull from cloud">' + esc(t('Initial pull from cloud')) + '</option>';
      setActionStatus('', false);
    }, undefined, false);
  }

  function updateTeamChrome() {
    if (disposed) return;
    var current = S.collaboration && S.collaboration.current;
    if (conflictSession && (!current || conflictSession.teamId !== current.teamId || conflictSession.projectId !== current.projectId || conflictSession.branch !== current.branch)) {
      closeConflictSession();
      conflictSession = null;
    }
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
    assignHandler(badge, 'onclick', function() { BOBO.switchToPanel('team'); });
    if (BOBO.workbench) BOBO.workbench.refreshContext();
    if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('team');
    refreshWorkbench();
    startLockRefresh();
    renderActiveLockStatus();
  }

	function clearCurrent() {
	  if (disposed) return;
	  var previous = S.collaboration.current;
	  if (previous) releaseHeldFileLocks(previous);
	  S.collaboration.current = null;
      if (lockRefreshTimer) { clearInterval(lockRefreshTimer); lockRefreshTimer = null; }
      if (lockBroadcastTimer) { clearInterval(lockBroadcastTimer); lockBroadcastTimer = null; }
      if (lockCountdownTimer) { clearInterval(lockCountdownTimer); lockCountdownTimer = null; }
	  updateTeamChrome();
	  if (BOBO.environmentActivity) BOBO.environmentActivity.contextChanged('team');
	}

	function restoreMapping(mapping, localPath) {
	  if (disposed) return;
	  if (!mapping) { clearCurrent(); return; }
	  if (S.collaboration.current) releaseHeldFileLocks(S.collaboration.current);
	  S.collaboration.current = {
		teamId: mapping.teamId, teamName: mapping.teamName || 'Team', projectId: mapping.projectId,
		projectName: mapping.projectName || 'Cloud project', branch: mapping.branch,
		localPath: localPath || mapping.localPath || ''
	  };
	  updateTeamChrome();
	}

  // ─── Team workbench ────────────────────────────────────────
  async function refreshWorkbench() {
    if (disposed) return;
    var current = S.collaboration.current;
    if (!current) return;
    var epoch = lifecycleEpoch;
    var root = $('team-workbench');
    root.innerHTML = '<div class="collab-empty" data-i18n="Loading team state...">' + esc(t('Loading team state...')) + '</div>';
    try {
      var results = await Promise.all([
        api('listTeamBranches', { teamId: current.teamId, projectId: current.projectId }),
        api('teamProjectHistory', { teamId: current.teamId, projectId: current.projectId, limit: 40 }),
        api('listTeamFileLocks', { teamId: current.teamId, projectId: current.projectId }),
        api('listTeamConflicts', { teamId: current.teamId, projectId: current.projectId, branch: current.branch })
      ]);
      if (!isCurrent(epoch) || S.collaboration.current !== current) return;
      var conflicts = asArray(results[3]);
      renderWorkbench(asArray(results[0]), asArray(results[1]), asArray(results[2]), conflicts);
      if (conflictSession && conflictSession.teamId === current.teamId && conflictSession.projectId === current.projectId && conflictSession.branch === current.branch) {
        updateConflictSession(conflicts);
      }
      return conflicts;
    } catch (err) {
      if (isCurrent(epoch) && S.collaboration.current === current) root.innerHTML = '<div class="collab-empty">' + esc(err.message) + '</div>';
    }
  }
  function renderWorkbench(branches, history, locks, conflicts) {
    branches = asArray(branches);
    history = asArray(history);
    locks = asArray(locks);
    conflicts = asArray(conflicts);
    var current = S.collaboration.current;
    var branchOptions = branches.map(function(b) { return '<option value="' + esc(b.name) + '"' + (b.name === current.branch ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('');
    var commits = renderCommitTree(history);
    var conflictHTML = conflicts.length ? conflicts.map(function(file) {
      return '<button class="team-tool-btn team-open-conflict" data-conflict-path="' + esc(file.path) + '">' + esc(file.path) + '</button>';
    }).join(' ') : '<span class="collab-row-secondary" data-i18n="No unresolved conflicts">' + esc(t('No unresolved conflicts')) + '</span>';
    $('team-workbench').innerHTML = '<div class="team-workbench-toolbar"><span class="team-workbench-title">' + esc(current.teamName + ' / ' + current.projectName) + '</span><div class="team-branch-control"><select id="team-branch-select" aria-label="' + esc(t('Current branch')) + '">' + branchOptions + '</select><button class="team-tool-btn" id="team-open-branch" data-i18n="Open">' + esc(t('Open')) + '</button></div><button class="team-tool-btn" id="team-pull" title="' + esc(t('Replace local files with the cloud branch')) + '" data-i18n="Pull">' + esc(t('Pull')) + '</button><button class="team-tool-btn team-upload-btn" id="team-upload" title="' + esc(t('Upload local files to your private cloud worktree')) + '" data-i18n="Upload">' + esc(t('Upload')) + '</button><button class="team-tool-btn team-commit-btn" id="team-commit" title="' + esc(t('Upload, commit and push changes to the shared branch')) + '" data-i18n="Commit &amp; push">' + esc(t('Commit & push')) + '</button></div>' +
      '<div class="team-workbench-grid"><section class="team-workbench-section"><div class="team-section-title" data-i18n="BRANCH ITERATION TREE">' + esc(t('BRANCH ITERATION TREE')) + '</div>' + commits + '</section><div class="team-workbench-right"><section class="team-conflict-section"><header class="team-conflict-heading"><span class="team-section-title" data-i18n="CONFLICT MERGE">' + esc(t('CONFLICT MERGE')) + '</span><span class="team-conflict-count">' + esc(t('{count} conflicts', { count: conflicts.length })) + '</span></header><div class="team-conflict-actions"><button class="team-tool-btn" id="team-new-branch" data-i18n="New branch">' + esc(t('New branch')) + '</button><button class="team-tool-btn" id="team-compare" data-i18n="Compare branches">' + esc(t('Compare branches')) + '</button><button class="team-tool-btn" id="team-merge" data-i18n="Merge branches">' + esc(t('Merge branches')) + '</button><button class="team-tool-btn" id="team-refresh" title="' + esc(t('Refresh')) + '" aria-label="' + esc(t('Refresh')) + '"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7a6 6 0 1 0 1 5M16 3v4h-4"/></svg></button></div><div id="team-conflict-list">' + conflictHTML + '</div><div id="team-conflict-editor"></div><div id="team-diff-output" class="team-diff-output"></div></section><section class="team-lock-section"><header class="team-lock-heading"><span class="team-section-title" data-i18n="FILE LOCKS">' + esc(t('FILE LOCKS')) + '</span><span class="team-conflict-count" data-i18n="Live team edits">' + esc(t('Live team edits')) + '</span></header><div id="team-lock-list" class="team-lock-list"></div></section></div></div>';
    bindAttribute($('team-branch-select'), 'aria-label', 'Current branch');
    bindAttribute($('team-pull'), 'title', 'Replace local files with the cloud branch');
    bindAttribute($('team-upload'), 'title', 'Upload local files to your private cloud worktree');
    bindAttribute($('team-commit'), 'title', 'Upload, commit and push changes to the shared branch');
    renderTeamLocks(locks);
    bindWorkbench(branches, conflicts);
  }
  function renderTeamLocks(locks) {
    var target = $('team-lock-list');
    if (!target) return;
    var me = currentUser();
    target.innerHTML = asArray(locks).map(function(lock) {
      var mine = !!(me && lock.user_id === me.id);
      var owner = mine ? t('You') : (lock.user_name || lock.user_uid || t('another teammate'));
      var expires = lock.expires_at || lock.expiresAt || '';
      return '<div class="team-lock-broadcast' + (mine ? ' is-mine' : '') + '"><span class="team-lock-broadcast-path" title="' + esc(lock.path) + '">' + esc(lock.path) + '</span><span class="team-lock-broadcast-time" data-lock-countdown data-lock-expires="' + esc(expires) + '"></span><span class="team-lock-broadcast-meta">' + esc(owner + ' · ' + (lock.branch || '')) + '</span><span class="team-lock-broadcast-meta">' + esc(lock.user_uid || '') + '</span></div>';
    }).join('') || '<div class="collab-row-secondary" data-i18n="No active advisory locks">' + esc(t('No active advisory locks')) + '</div>';
    updateLockCountdowns();
  }
  function updateLockCountdowns() {
    var list = $('team-lock-list');
    if (!list || S.activePanel !== 'team' || document.hidden) return;
    var rows = list.querySelectorAll('[data-lock-countdown]');
    if (!rows.length) return;
    rows.forEach(function(label) {
      var expires = label.getAttribute('data-lock-expires');
      var remaining = lockSecondsRemaining({ expires_at: expires });
      if (!remaining) label.closest('.team-lock-broadcast')?.remove();
      else setRawText(label, lockTimeLabel({ expires_at: expires }));
    });
    if (!list.childElementCount) list.innerHTML = '<span class="collab-row-secondary" data-i18n="No active advisory locks">' + esc(t('No active advisory locks')) + '</span>';
  }
  async function refreshLockBroadcast() {
    var current = S.collaboration.current;
    if (disposed || document.hidden || !current || lockBroadcastRequest === current || S.activePanel !== 'team' || !$('panel-team')?.classList.contains('active')) return;
    var identity = getSidebarIdentity();
    lockBroadcastRequest = current;
    try {
      var locks = await api('listTeamFileLocks', { teamId: current.teamId, projectId: current.projectId });
      if (disposed || identity !== getSidebarIdentity() || S.collaboration.current !== current) return;
      renderTeamLocks(locks);
    } catch (_) {
      // Keep the last snapshot and let its leases expire locally.
    } finally {
      if (lockBroadcastRequest === current) lockBroadcastRequest = null;
    }
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
    assignHandler($('team-refresh'), 'onclick', refreshWorkbench, false);
    assignHandler($('team-project-badge'), 'onclick', function() { BOBO.switchToPanel('team'); });
    assignHandler($('team-open-branch'), 'onclick', function() { openProject(currentProjectRecord(), $('team-branch-select').value); }, false);
    assignHandler($('team-pull'), 'onclick', manualPull, false);
    assignHandler($('team-upload'), 'onclick', uploadChanges, false);
    assignHandler($('team-commit'), 'onclick', commitChanges, false);
    assignHandler($('team-new-branch'), 'onclick', function() { newBranch(branches); }, false);
    assignHandler($('team-compare'), 'onclick', function() { compareBranches(branches); }, false);
    assignHandler($('team-merge'), 'onclick', function() { mergeBranches(branches); }, false);
    document.querySelectorAll('.team-open-conflict').forEach(function(btn) {
      assignHandler(btn, 'onclick', function() {
        var file = conflicts.find(function(x) { return x.path === btn.getAttribute('data-conflict-path'); });
        openConflictSession(file, conflicts);
      }, false);
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
        var prepared = await BOBO.rclone.prepareTeamPull({
          teamId: current.teamId,
          projectId: current.projectId,
          branch: current.branch,
          reset: true
        }, { dest: current.localPath });
        if (!prepared || !prepared.success) throw new Error(prepared && prepared.error || t('Pull failed'));
        var result = await BOBO.rclone.pull({ dest: current.localPath, remoteGrantId: prepared.remoteGrantId, onProgress: function(line) { setActionStatus(line, false); } });
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
    if (disposed) return false;
    var epoch = lifecycleEpoch;
    var button = $('team-upload');
    if (button) { button.disabled = true; bindText(button, 'Uploading...'); }
    try {
      var synced = await BOBO.runner.uploadWorkspace();
      if (!isCurrent(epoch)) return false;
      if (!synced) throw new Error(t('Local files could not be synchronized. Check the Output panel for details.'));
      notify('Uploaded to your private cloud worktree. Commit & push to publish these changes.', 'success');
      await refreshWorkbench();
      if (!isCurrent(epoch)) return false;
      return true;
    } catch (err) {
      if (isCurrent(epoch)) notify(err.message, 'error');
      return false;
    } finally {
      if (!disposed && button && button.isConnected) { button.disabled = false; bindText(button, 'Upload'); }
    }
  }
  function commitChanges() {
    openAction('Commit team changes', inputField('action-commit-message', 'Commit message'), 'Commit and push', async function() {
      setActionStatusKey('Uploading local changes...', null, false);
      var synced = await BOBO.runner.uploadWorkspace(); if (!synced) throw new Error(t('Local files could not be synchronized'));
      var c = S.collaboration.current;
      setActionStatusKey('Publishing commit to {branch}...', { branch: c.branch }, false);
      try {
        await api('commitTeamChanges', { teamId: c.teamId, projectId: c.projectId, branch: c.branch, commitMessage: $('action-commit-message').value });
      } catch (error) {
        if (error && (error.code === 'merge_conflict' || legacyCollaborationErrorCode(error.rawMessage || error.message) === 'merge_conflict')) {
          var conflicts = asArray(await api('listTeamConflicts', { teamId: c.teamId, projectId: c.projectId, branch: c.branch }));
          if (conflicts.length) {
            closeAction();
            openConflictSession(conflicts[0], conflicts, c.branch);
            return false;
          }
        }
        throw error;
      }
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
    openAction('Merge branches',selectField('action-merge-source','Source',names,names.find(function(n){return n!==c.branch;})||c.branch)+selectField('action-merge-target','Target',names,c.branch),'Merge',async function(){var source=$('action-merge-source').value;var target=$('action-merge-target').value;var result=await api('mergeTeamBranch',{teamId:c.teamId,projectId:c.projectId,sourceBranch:source,targetBranch:target});await refreshWorkbench();if(result.conflicts&&result.conflicts.length){var conflicts=asArray(await api('listTeamConflicts',{teamId:c.teamId,projectId:c.projectId,branch:target}));if(conflicts.length){closeAction();openConflictSession(conflicts[0],conflicts,target);}notify(t('{count} conflicts require resolution',{count:result.conflicts.length}),'error');}else notify('Branches merged and pushed','success');return true;});
  }
  function disposeConflictEditors() {
    try { if (conflictDiffEditor) { conflictDiffEditor.setModel(null); conflictDiffEditor.dispose(); } } catch (_) {}
    try { if (conflictResultEditor) { conflictResultEditor.setModel(null); conflictResultEditor.dispose(); } } catch (_) {}
    conflictModels.forEach(function(model) { try { model.dispose(); } catch (_) {} });
    conflictDiffEditor = null;
    conflictResultEditor = null;
    conflictModels = [];
  }
  function conflictLanguage(path) {
    var ext = String(path || '').split('.').pop().toLowerCase();
    var languages = { c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'cpp', hpp: 'cpp', html: 'html', java: 'java', js: 'javascript', json: 'json', jsx: 'javascript', md: 'markdown', mjs: 'javascript', py: 'python', rs: 'rust', sh: 'shell', sql: 'sql', ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml' };
    return languages[ext] || 'plaintext';
  }
  function saveConflictDraft() {
    if (!conflictSession || !conflictSession.filePath) return;
    var value = conflictResultEditor && conflictResultEditor.getModel()
      ? conflictResultEditor.getModel().getValue()
      : $('team-conflict-content') && $('team-conflict-content').value;
    if (value !== undefined && value !== null) conflictSession.drafts[conflictSession.filePath] = value;
  }
  function currentConflictResult() {
    if (conflictResultEditor && conflictResultEditor.getModel()) return conflictResultEditor.getModel().getValue();
    var fallback = $('team-conflict-content');
    if (fallback) return fallback.value;
    if (conflictSession && conflictSession.filePath && Object.prototype.hasOwnProperty.call(conflictSession.drafts, conflictSession.filePath)) return conflictSession.drafts[conflictSession.filePath];
    return conflictSession && conflictSession.file ? conflictSession.file.ours : '';
  }
  function setConflictResult(value) {
    if (conflictResultEditor && conflictResultEditor.getModel()) {
      conflictResultEditor.getModel().setValue(value);
    } else {
      var fallback = $('team-conflict-content');
      if (fallback) fallback.value = value;
    }
    if (conflictSession && conflictSession.filePath) conflictSession.drafts[conflictSession.filePath] = value;
  }
  function conflictResolutionReady() {
    return !!(conflictSession && conflictSession.file && (conflictSession.canResolve || conflictSession.versionChoice));
  }
  function renderConflictFileList() {
    var list = $('team-conflict-files');
    if (!list || !conflictSession) return;
    list.innerHTML = conflictSession.files.map(function(file) {
      var selected = file.path === conflictSession.filePath;
      return '<button type="button" class="conflict-file-item' + (selected ? ' is-active' : '') + '" data-conflict-session-path="' + esc(file.path) + '" aria-current="' + (selected ? 'page' : 'false') + '"><span class="conflict-file-mark" aria-hidden="true"></span><span class="conflict-file-path" title="' + esc(file.path) + '">' + esc(file.path) + '</span><span class="conflict-file-state" data-i18n="Unresolved">' + esc(t('Unresolved')) + '</span></button>';
    }).join('') || '<div class="conflict-file-empty" data-i18n="All conflicts resolved">' + esc(t('All conflicts resolved')) + '</div>';
    var total = Math.max(conflictSession.total, conflictSession.resolvedCount + conflictSession.files.length);
    var progress = $('team-conflict-progress');
    if (progress) setRawText(progress, t('{resolved} of {total} resolved', { resolved: total - conflictSession.files.length, total: total }));
    var complete = $('team-complete-merge');
    if (complete) complete.disabled = conflictSession.files.length > 0;
  }
  function renderConflictFile(file) {
    disposeConflictEditors();
    conflictSession.file = file || null;
    var content = $('team-conflict-content-area');
    if (!content) return;
    if (!file) {
      content.innerHTML = '<div class="conflict-merge-ready"><span class="conflict-ready-mark" aria-hidden="true">&#10003;</span><h2 data-i18n="All conflicts resolved">' + esc(t('All conflicts resolved')) + '</h2><span data-i18n="Complete merge when you are ready to publish the resolved files.">' + esc(t('Complete merge when you are ready to publish the resolved files.')) + '</span></div>';
      return;
    }
    var truncatedMarker = '\n... content truncated ...';
    var tooLarge = [file.base, file.ours, file.theirs].some(function(value) { return String(value || '').indexOf(truncatedMarker) >= 0; });
    var binary = [file.base, file.ours, file.theirs].some(function(value) { return String(value || '').indexOf('\u0000') >= 0; });
    conflictSession.versionChoice = null;
    var draft = Object.prototype.hasOwnProperty.call(conflictSession.drafts, file.path) ? conflictSession.drafts[file.path] : file.ours;
    var language = conflictLanguage(file.path);
    var versionActions = '<div class="conflict-result-heading"><strong data-i18n="Merge result">' + esc(t('Merge result')) + '</strong><div><button type="button" class="team-tool-btn" id="team-conflict-use-current" aria-pressed="false" data-i18n="Use current version">' + esc(t('Use current version')) + '</button><button type="button" class="team-tool-btn" id="team-conflict-use-incoming" aria-pressed="false" data-i18n="Use incoming version">' + esc(t('Use incoming version')) + '</button></div></div>';
    content.innerHTML = '<div class="conflict-session-file-head"><div><span class="conflict-session-path" dir="auto">' + esc(file.path) + '</span><span class="conflict-session-language">' + esc(language) + '</span></div><details class="conflict-base-details"><summary data-i18n="Base version">' + esc(t('Base version')) + '</summary><pre>' + esc(file.base) + '</pre></details></div>' +
      (tooLarge ? '<div class="conflict-limitation" role="status">' + esc(t('This file is too large to resolve in this view.')) + '</div>' + versionActions : binary ? '<div class="conflict-limitation" role="status">' + esc(t('Binary conflict: choose a version to resolve it.')) + '</div>' + versionActions :
      '<div class="conflict-diff-labels"><span data-i18n="Current branch version">' + esc(t('Current branch version')) + '</span><span data-i18n="Incoming branch version">' + esc(t('Incoming branch version')) + '</span></div><div id="team-conflict-diff" class="conflict-diff-editor" aria-label="' + esc(t('Conflict comparison')) + '"></div>' + versionActions + '<div id="team-conflict-result" class="conflict-result-editor" aria-label="' + esc(t('Merge result')) + '"></div><textarea id="team-conflict-content" class="conflict-editor-fallback" spellcheck="false" aria-label="' + esc(t('Merge result')) + '">' + esc(draft) + '</textarea>');
    var languageLabel = $('team-conflict-language');
    if (languageLabel) setRawText(languageLabel, language);
    var editorApi = !binary && !tooLarge && dependencies.getMonaco && dependencies.getMonaco()?.editor;
    conflictSession.canResolve = !tooLarge && !binary;
    if (editorApi) {
      try {
        var diffNode = $('team-conflict-diff');
        var resultNode = $('team-conflict-result');
        var theme = S.editor && typeof S.editor.getOption === 'function' ? S.editor.getOption(dependencies.getMonaco().editor.EditorOption?.theme) : 'vs-dark';
        var currentModel = editorApi.createModel(file.ours, language);
        var incomingModel = editorApi.createModel(file.theirs, language);
        var resultModel = editorApi.createModel(draft, language);
        conflictModels = [currentModel, incomingModel, resultModel];
        conflictDiffEditor = editorApi.createDiffEditor(diffNode, {
          automaticLayout: true,
          theme: theme || 'vs-dark',
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          minimap: { enabled: false },
          diffWordWrap: 'on',
          ignoreTrimWhitespace: false,
          scrollBeyondLastLine: false,
          renderOverviewRuler: false
        });
        conflictDiffEditor.setModel({ original: currentModel, modified: incomingModel });
        conflictResultEditor = editorApi.create(resultNode, {
          model: resultModel,
          automaticLayout: true,
          theme: theme || 'vs-dark',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 12
        });
        $('team-conflict-content').hidden = true;
      } catch (_) {
        disposeConflictEditors();
        if ($('team-conflict-diff')) $('team-conflict-diff').textContent = file.ours + '\n' + file.theirs;
        if ($('team-conflict-content')) $('team-conflict-content').hidden = false;
      }
    } else if (!binary && !tooLarge) {
      $('team-conflict-diff').textContent = file.ours + '\n' + file.theirs;
      $('team-conflict-content').hidden = false;
    }
    assignHandler($('team-conflict-use-current'), 'onclick', function() {
      if (binary || tooLarge) conflictSession.versionChoice = 'current'; else setConflictResult(file.ours);
      var currentButton = $('team-conflict-use-current');
      var incomingButton = $('team-conflict-use-incoming');
      if (currentButton) currentButton.setAttribute('aria-pressed', 'true');
      if (incomingButton) incomingButton.setAttribute('aria-pressed', 'false');
      var action = $('team-save-resolution'); if (action) action.disabled = !conflictResolutionReady();
    }, false);
    assignHandler($('team-conflict-use-incoming'), 'onclick', function() {
      if (binary || tooLarge) conflictSession.versionChoice = 'incoming'; else setConflictResult(file.theirs);
      var currentButton = $('team-conflict-use-current');
      var incomingButton = $('team-conflict-use-incoming');
      if (currentButton) currentButton.setAttribute('aria-pressed', 'false');
      if (incomingButton) incomingButton.setAttribute('aria-pressed', 'true');
      var action = $('team-save-resolution'); if (action) action.disabled = !conflictResolutionReady();
    }, false);
    var resolveButton = $('team-save-resolution');
    resolveButton.disabled = !conflictResolutionReady();
    assignHandler(resolveButton, 'onclick', async function() {
      if (disposed || !conflictSession || !conflictSession.file) return;
      var button = $('team-save-resolution');
      button.disabled = true;
      try {
        var session = conflictSession;
        var path = session.file.path;
        var resolution = session.versionChoice || 'manual';
        var result = resolution === 'manual' ? currentConflictResult() : '';
        await api('resolveTeamConflict', { teamId: session.teamId, projectId: session.projectId, branch: session.branch, filePath: path, content: result, resolution: resolution });
        if (disposed) return;
        if (conflictSession !== session) {
          var active = S.collaboration.current;
          if (active && active.teamId === session.teamId && active.projectId === session.projectId && active.branch === session.branch) await refreshWorkbench();
          return;
        }
        delete session.drafts[path];
        session.resolvedCount++;
        notify('Conflict marked resolved', 'success');
        var remaining = asArray(await api('listTeamConflicts', {
          teamId: session.teamId,
          projectId: session.projectId,
          branch: session.branch
        }));
        if (disposed || conflictSession !== session) return;
        updateConflictSession(remaining);
        await refreshWorkbench();
      } catch (err) {
        if (!disposed) notify(err.message, 'error');
      } finally {
        if (button && button.isConnected) button.disabled = !conflictResolutionReady();
      }
    }, false);
  }
  function openConflictSession(file, files, branch) {
    if (disposed || !file) return;
    var current = S.collaboration.current;
    if (!current) return;
    branch = branch || current.branch;
    if (!conflictSession || conflictSession.teamId !== current.teamId || conflictSession.projectId !== current.projectId || conflictSession.branch !== branch) {
      closeConflictSession();
      conflictSession = {
        teamId: current.teamId, projectId: current.projectId, branch: branch,
        teamName: current.teamName, projectName: current.projectName,
        files: [], filePath: '', file: null, drafts: Object.create(null), total: 0, resolvedCount: 0, versionChoice: null
      };
    }
    saveConflictDraft();
    conflictSession.files = asArray(files);
    conflictSession.total = Math.max(conflictSession.total, conflictSession.files.length + conflictSession.resolvedCount);
    conflictSession.filePath = file.path;
    $('collab-conflict-page').hidden = false;
    $('collab-conflict-session').innerHTML = '<div class="conflict-session-card"><header class="conflict-session-header"><button type="button" class="conflict-session-back" id="team-conflict-back" title="' + esc(t('Back to team workspace')) + '" aria-label="' + esc(t('Back to team workspace')) + '"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="conflict-session-title"><span data-i18n="Conflict resolution">' + esc(t('Conflict resolution')) + '</span><strong>' + esc(conflictSession.teamName + ' / ' + conflictSession.projectName) + '</strong><small>' + esc(t('Branch {branch}', { branch: conflictSession.branch })) + '</small></div><div class="conflict-session-progress" id="team-conflict-progress"></div></header><div class="conflict-session-body"><nav id="team-conflict-files" class="conflict-file-list" aria-label="' + esc(t('Unresolved files')) + '"></nav><section class="conflict-session-main"><div id="team-conflict-content-area" class="conflict-session-content"></div></section></div><footer class="conflict-session-footer"><span class="conflict-session-status" id="team-conflict-language"></span><div class="conflict-session-actions"><button type="button" class="team-tool-btn" id="team-save-resolution" data-i18n="Mark resolved">' + esc(t('Mark resolved')) + '</button><button type="button" class="team-tool-btn team-conflict-complete" id="team-complete-merge" data-i18n="Complete merge">' + esc(t('Complete merge')) + '</button></div></footer></div>';
    assignHandler($('team-conflict-back'), 'onclick', closeConflictSession, false);
    assignHandler($('team-complete-merge'), 'onclick', function() {
      if (disposed) return;
      openAction('Complete merge', inputField('action-merge-message', 'Commit message', 'Resolve merge conflicts'), 'Commit and push', async function() {
        if (disposed) return false;
        var session = conflictSession;
        if (!session) return false;
        await api('completeTeamMerge', { teamId: session.teamId, projectId: session.projectId, branch: session.branch, commitMessage: $('action-merge-message').value });
        if (disposed) return false;
        if (conflictSession === session) {
          conflictSession = null;
          closeConflictSession();
        }
        await refreshWorkbench();
        notify('Merge completed', 'success');
        return true;
      });
    }, false);
    renderConflictFileList();
    renderConflictFile(file);
    assignHandler($('team-conflict-files'), 'onclick', function(event) {
        var button = event.target.closest('[data-conflict-session-path]');
        if (!button) return;
        var next = conflictSession.files.find(function(item) { return item.path === button.getAttribute('data-conflict-session-path'); });
        if (!next || next.path === conflictSession.filePath) return;
        saveConflictDraft();
        conflictSession.filePath = next.path;
        renderConflictFileList();
        renderConflictFile(next);
      }, false);
  }
  function updateConflictSession(files) {
    if (!conflictSession || $('collab-conflict-page').hidden) return;
    conflictSession.files = asArray(files);
    conflictSession.total = Math.max(conflictSession.total, conflictSession.files.length + conflictSession.resolvedCount);
    var current = conflictSession.files.find(function(file) { return file.path === conflictSession.filePath; });
    if (current) {
      conflictSession.file = current;
      renderConflictFileList();
      return;
    }
    disposeConflictEditors();
    if (conflictSession.files.length) {
      conflictSession.filePath = conflictSession.files[0].path;
      renderConflictFileList();
      renderConflictFile(conflictSession.files[0]);
    } else {
      conflictSession.filePath = '';
      renderConflictFileList();
      renderConflictFile(null);
    }
    var resolveButton = $('team-save-resolution');
    if (resolveButton) resolveButton.disabled = !conflictResolutionReady();
  }
  function closeConflictSession() {
    saveConflictDraft();
    disposeConflictEditors();
    var page = $('collab-conflict-page');
    if (page) page.hidden = true;
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
    if (disposed) return null;
    options = options || {};
    var c=S.collaboration.current;if(!c)return;var rel=relativeCurrentPath(filePath);if(!rel)return;
    var key = heldLockKey(filePath);
    if (fileLockRequests[key]) return fileLockRequests[key].promise;
    var previous = heldFileLocks[key] || blockedFileLocks[key];
    var sameContext = previous && previous.teamId === c.teamId && previous.projectId === c.projectId && previous.branch === c.branch && previous.path === rel;
    var requestEpoch = lifecycleEpoch;
    var request = { teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, cancelled: false, epoch: requestEpoch, promise: null };
    function ownsRequest() {
      return isCurrent(requestEpoch) && fileLockRequests[key] === request;
    }
    request.promise = (async function() {
      try {
        var lock = await api('acquireTeamFileLock',{teamId:c.teamId,projectId:c.projectId,branch:c.branch,filePath:rel,lockLeaseId:sameContext ? previous.leaseId : undefined,ttlMinutes:FILE_LOCK_TTL_MINUTES});
        var returnedLeaseID = lock && (lock.lease_id || lock.leaseId) || '';
        if (request.cancelled || !ownsRequest()) {
          await api('releaseTeamFileLock', { teamId: c.teamId, projectId: c.projectId, branch: c.branch, filePath: rel, lockLeaseId: returnedLeaseID || undefined }).catch(function() {});
          return null;
        }
        heldFileLocks[key] = { filePath: filePath, teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, leaseId: returnedLeaseID, expires_at: lock && (lock.expires_at || lock.expiresAt) || '' };
        delete blockedFileLocks[key];
        if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
        return lock;
      } catch(err) {
        if (ownsRequest()) {
          delete heldFileLocks[key];
          if (!request.cancelled) blockedFileLocks[key] = { filePath: filePath, teamId: c.teamId, projectId: c.projectId, branch: c.branch, path: rel, leaseId: sameContext ? previous.leaseId : '', lock: err && err.details && err.details.lock || null, errorCode: err && err.code || '' };
          if (heldLockKey(S.activeTabPath) === key) renderActiveLockStatus();
          if(!request.cancelled && !options.silent)notify(collaborationErrorMessage(err),'info');
        }
        return null;
      } finally {
        if (fileLockRequests[key] === request) delete fileLockRequests[key];
      }
    })();
    fileLockRequests[key] = request;
    return request.promise;
  }
  async function onFileClosed(filePath) {
    if (disposed) return;
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
    if (disposed) return;
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
    if (disposed) return;
    var epoch = lifecycleEpoch;
    expireLocalLeases();
    if (lockRefreshInFlight || !S.collaboration.current || !clientIsForeground()) return;
    lockRefreshInFlight = true;
    try {
      var paths = openTeamFilePaths();
      await Promise.all(paths.map(function(filePath) { return onFileOpened(filePath, { silent: true }); }));
    } finally {
      if (epoch === lifecycleEpoch) lockRefreshInFlight = false;
    }
  }
  function releaseHeldFileLocks(project) {
    if (disposed) return;
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
    if (disposed) return;
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
    if (disposed) return;
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
    if (disposed) return false;
    return !!blockedFileLocks[heldLockKey(S.activeTabPath)];
  }
  function startLockRefresh() {
    if (disposed) return;
    if (lockRefreshTimer) clearInterval(lockRefreshTimer);
    if (lockBroadcastTimer) clearInterval(lockBroadcastTimer);
    if (lockCountdownTimer) clearInterval(lockCountdownTimer);
    renewOpenFileLocks();
    lockRefreshTimer = setInterval(renewOpenFileLocks, FILE_LOCK_HEARTBEAT_MS);
    lockBroadcastTimer = setInterval(refreshLockBroadcast, FILE_LOCK_HEARTBEAT_MS);
    lockCountdownTimer = setInterval(updateLockCountdowns, 1000);
  }

  async function clearCache(scope, namespaceKey, projectId) {
    if(disposed || !selectedTeamId)return;
    var epoch = lifecycleEpoch;
    var teamId = selectedTeamId;
	try{await api('clearTeamCache',{teamId:teamId,cacheScope:scope,namespaceKey:namespaceKey||undefined,projectId:projectId||undefined});if(!isCurrent(epoch)||selectedTeamId!==teamId)return;await loadTeamCache();if(!isCurrent(epoch)||selectedTeamId!==teamId)return;if(S.collaboration.current&&S.collaboration.current.teamId===teamId)await refreshWorkbench();if(isCurrent(epoch))notify('Team cache cleared','success');}catch(err){if(isCurrent(epoch))notify(err.message,'error');}
  }

  function handleLanguageChanged() {
    if (disposed) return;
    if (sidebarIdentity !== getSidebarIdentity()) resetSidebar(getSidebarIdentity());
    renderTeamList();
    if (selectedDetail) {
      var team = selectedDetail.team;
      var isAdmin = team.admin_user_id === currentUser().id;
      renderProjects(asArray(selectedDetail.projects), isAdmin);
      renderMembers(asArray(selectedDetail.members), isAdmin);
      renderMemberActivity(selectedTeamActivity);
      renderProjectActivity(selectedTeamActivity);
      if (selectedCacheInfo) renderTeamCache(selectedCacheInfo, asArray(selectedDetail.projects), isAdmin);
    }
    if (conflictSession && !$('collab-conflict-page').hidden && conflictSession.file) {
      var selectedConflict = conflictSession.files.find(function(file) { return file.path === conflictSession.filePath; });
      if (selectedConflict) openConflictSession(selectedConflict, conflictSession.files, conflictSession.branch);
    }
    teamPageChrome();
    renderActiveLockStatus();
  }

	function teamSettings() {
	  if (disposed) return;
	  if (!selectedDetail) return;
	  var team=selectedDetail.team;
	  if (team.admin_user_id !== currentUser().id) return;
	  openAction('Team settings',inputField('action-team-settings-name','Team name',team.name)+textareaField('action-team-settings-description','Description',team.description||'')+inputField('action-team-settings-quota','Build cache quota (MB)',String(team.cache_quota_mb),'number')+inputField('action-team-settings-retention','Retention days',String(team.cache_retention_days||30),'number')+'<button id="action-delete-team" class="ss-btn ss-btn-ghost" type="button" data-i18n="Delete team">' + esc(t('Delete team')) + '</button>','Save',async function(){await api('updateTeam',{teamId:team.id,name:$('action-team-settings-name').value,description:$('action-team-settings-description').value,cacheQuotaMB:Number($('action-team-settings-quota').value),cacheRetentionDays:Number($('action-team-settings-retention').value)});await loadTeams();if (S.activeTabPath===teamKey(team.id)) await refreshTeamDetail(team.id);notify('Team settings saved','success');return true;});
	  assignHandler($('action-delete-team'), 'onclick', function(){if(disposed)return;openAction('Delete team',inputField('action-delete-team-name','Type team name to confirm'),'Delete permanently',async function(){if(disposed)return false;if($('action-delete-team-name').value!==team.name)throw new Error(t('Team name does not match'));await api('deleteTeam',{teamId:team.id});if(disposed)return false;await loadTeams();notify('Team deleted','success');return true;});}, false);
	}

  function leaveTeam() {
    if (disposed || !selectedTeamId) return;
    var team = selectedDetail && selectedDetail.team;
    if (!team) return;
    openAction('Leave team', '<div class="collab-action-status" data-i18n="Your team worktrees and active file locks will be removed from the server.">' + esc(t('Your team worktrees and active file locks will be removed from the server.')) + '</div>', 'Leave team', async function() {
      await api('leaveTeam', { teamId: team.id });
      if (disposed) return false;
      expandedProjects.delete(team.id);
      await loadTeams();
      notify('Left team', 'success');
      return true;
    });
  }

  function init() {
    if (initialized) return;
    if (disposed) {
      lifecycle = new DisposableStore();
      ownedTimers = new Set();
      ownedIntervals = new Set();
      ownedHandlers = [];
      disposed = false;
    }
    lifecycleEpoch++;
    initialized = true;
    if (BOBO.workspace?.registerWorkbenchTabProvider) lifecycle.add(BOBO.workspace.registerWorkbenchTabProvider('team-pages', {
      getTabs: teamProviderTabs,
      activate: activateTeamPage,
      close: closeTeamPage,
      deactivate: deactivateTeamPage,
      afterFileActivation: restoreTeamUnderlyingView
    }));
    listen(global, 'bobo:language-changed', handleLanguageChanged);
    listen(global, 'bobo:workbench-changed', function(event) {
      if (event.detail) setFriendsVisible(sidebarMode === 'friends' && event.detail.activity === 'team' && event.detail.primaryVisible && !event.detail.focusMode);
    });
    listen(global, 'bobo:auth-changed', function() {
      var identity = getSidebarIdentity();
      if (identity === sidebarIdentity) return;
      if (sidebarIdentity && $('collab-action-modal')) closeAction();
      resetSidebar(identity);
      if (document.querySelector?.('[data-sidebar-view="team"].active')) void showSidebarMode(sidebarMode);
    });
    assignHandler($('collab-mode-friends'), 'onclick', function() { void showSidebarMode('friends'); });
    assignHandler($('collab-mode-teams'), 'onclick', function() { void showSidebarMode('teams'); });
    assignHandler($('collab-teams-sign-in'), 'onclick', function() {
      if (BOBO.auth) BOBO.auth.openAuthModal(t('Sign in to use team workspaces'));
    });
    assignHandler($('collab-new-team'), 'onclick', newTeam);
	assignHandler($('collab-team-settings'), 'onclick', teamSettings);
	assignHandler($('auth-menu-teams'), 'onclick', function(){ $('auth-menu').style.display='none'; void openHub('teams'); });
    if (!BOBO.accountProfile) {
      assignHandler($('auth-menu-profile'), 'onclick', function(){ $('auth-menu').style.display='none'; openProfile(); });
      assignHandler($('profile-close-x'), 'onclick', closeProfile);
      assignHandler($('profile-cancel'), 'onclick', closeProfile);
      assignHandler($('profile-save'), 'onclick', saveProfile);
      listen($('profile-name'), 'input', renderProfileAvatar);
      assignHandler($('profile-avatar-options'), 'onclick', function(e){var btn=e.target.closest('[data-avatar]');if(btn){chosenAvatar=btn.getAttribute('data-avatar');renderProfileAvatar();}});
      assignHandler($('profile-avatar-upload'), 'onclick', function(){ $('profile-avatar-file').click(); });
      assignHandler($('profile-avatar-file'), 'onchange', function(){ chooseAvatarFile(this.files && this.files[0]); this.value=''; });
	      assignHandler($('profile-copy-uid'), 'onclick', async function(){try{if (!clipboard) throw new Error('Clipboard unavailable');await clipboard.writeText($('profile-uid').textContent);notify('User ID copied','success');}catch(e){notify('Copy failed','error');}});
    }
    assignHandler($('collab-action-close'), 'onclick', closeAction); assignHandler($('collab-action-cancel'), 'onclick', closeAction); assignHandler($('collab-action-confirm'), 'onclick', runActionConfirm);
    listen($('collab-action-modal'), 'keydown', function(event) {
      if (event.key === 'Escape' && !($('collab-action-confirm').disabled && actionConfirm)) {
        event.preventDefault();
        closeAction();
      }
    });
    assignHandler($('collab-team-list'), 'onclick', function(e){
      var row = e.target.closest('[data-team-row]');
      if (!row) return;
      var team = (S.collaboration.teams || [])[Number(row.getAttribute('data-team-index'))];
      if (!team) return;
      var expand = e.target.closest('[data-team-expand]');
      var item = e.target.closest('[data-team-id]');
      var project = e.target.closest('[data-expanded-project]');
      if (expand) { e.preventDefault(); void toggleTeamProjects(team.id); return; }
      if (project) {
        var expansion = expandedProjects.get(team.id);
        var selected = expansion && asArray(expansion.projects).find(function(p) { return p.id === project.getAttribute('data-expanded-project'); });
        if (selected) confirmOpenProject(selected, team);
        return;
      }
      if (item) void selectTeam(team.id);
    });
    assignHandler($('collab-project-list'), 'onclick', function(e){
      if (disposed) return;
      if(!selectedDetail)return;
      var namespace = e.target.closest('.cache-clear-namespace');
      if (namespace) { void clearCache('namespace', namespace.getAttribute('data-namespace')); return; }
      var remove=e.target.closest('.collab-delete-project');
      var open=e.target.closest('.collab-open-project');
      var button=remove||open;
      if(!button)return;
      var project=selectedDetail.projects.find(function(p){return p.id===button.getAttribute('data-project-id');});
      if(!project)return;
      if(remove){deleteProject(project);return;}
      button.disabled=true;
      bindText(button, 'Loading...');
      openProject(project).catch(function(err){
        if (disposed) return;
        setActionStatus(err.message,true);
        $('collab-action-confirm').disabled=true;
        notify(err.message,'error');
      }).finally(function(){if(!disposed && button.isConnected){button.disabled=false;bindText(button,'Open');}});
    });
    assignHandler($('collab-member-list'), 'onclick', async function(e){if(disposed)return;var btn=e.target.closest('.collab-remove-member');if(!btn)return;var teamId=selectedTeamId;try{await api('removeTeamMember',{teamId:teamId,userId:btn.getAttribute('data-user-id')});if(disposed)return;if(selectedTeamId===teamId)await loadTeamDetail(teamId);notify('Member removed','success');}catch(err){if(!disposed)notify(err.message,'error');}});
    var detailTabs = document.querySelectorAll('#collab-team-detail [data-collab-tab]');
    detailTabs.forEach(function(tab) {
      assignHandler(tab, 'onclick', function() {
        if (disposed) return;
        selectTeamPane(tab.getAttribute('data-collab-tab'));
      });
    });
    assignHandler($('collab-leave-team'), 'onclick', leaveTeam);
	assignHandler($('collab-cache-view'), 'onclick', function(e){if(disposed)return;var ns=e.target.closest('.cache-clear-namespace');if(ns)clearCache('namespace',ns.getAttribute('data-namespace'));if(e.target.closest('.cache-clear-shared'))clearCache('shared');if(e.target.closest('.cache-clear-all'))clearCache('all');});
    listen(global, 'focus', function() { renewOpenFileLocks(); renderActiveLockStatus(); });
    listen(document, 'visibilitychange', function() {
      if (!document.hidden) { renewOpenFileLocks(); renderActiveLockStatus(); }
    });
    if (document.querySelector?.('[data-sidebar-view="team"].active')) void showSidebarMode(sidebarMode);
  }

  var facade: CollaborationFacade = {
    init: init,
    openHub: openHub,
    openProfile: openProfile,
    clearCurrent: clearCurrent,
    restoreMapping: restoreMapping,
    updateTeamChrome: updateTeamChrome,
    refreshWorkbench: refreshWorkbench,
    uploadCurrent: uploadChanges,
    onFileOpened: onFileOpened,
    onFileClosed: onFileClosed,
    onFileActivated: onFileActivated,
    isActiveFileReadOnly: isActiveFileReadOnly,
    releaseForLogout: releaseForLogout
  };

  function dispose() {
    if (disposed && !initialized) return;
    disposed = true;
    initialized = false;
    lifecycleEpoch++;
    actionConfirm = null;
    closeConflictSession();
    conflictSession = null;
    resetTeamPages();
    try {
      var actionModal = $('collab-action-modal');
      if (actionModal) actionModal.classList.remove('open');
      setCollaborationReadOnly(false);
    } catch (_) {}
    if (lockRefreshTimer !== null) clearInterval(lockRefreshTimer);
    lockRefreshTimer = null;
    if (lockBroadcastTimer !== null) clearInterval(lockBroadcastTimer);
    lockBroadcastTimer = null;
    if (lockCountdownTimer !== null) clearInterval(lockCountdownTimer);
    lockCountdownTimer = null;
    lockRefreshInFlight = false;
    ownedTimers.forEach(function(timer) { try { dependencies.clearTimer(timer); } catch (_) {} });
    ownedTimers.clear();
    ownedIntervals.forEach(function(timer) { try { dependencies.clearInterval(timer); } catch (_) {} });
    ownedIntervals.clear();
    activeAvatarLoads.forEach(function(load) {
      try { load.image.onload = null; load.image.onerror = null; } catch (_) {}
      try { if (revokeObjectURL) revokeObjectURL(load.objectURL); } catch (_) {}
      load.released = true;
    });
    activeAvatarLoads.clear();
    Object.keys(fileLockRequests).forEach(function(key) {
      fileLockRequests[key].cancelled = true;
      delete fileLockRequests[key];
    });
    Object.keys(heldFileLocks).forEach(function(key) {
      var held = heldFileLocks[key];
      try {
        Promise.resolve(dependencies.sendToServer('releaseTeamFileLock', {
          teamId: held.teamId, projectId: held.projectId, branch: held.branch,
          filePath: held.path, lockLeaseId: held.leaseId || undefined
        }, { quiet: true })).catch(function() {});
      } catch (_) {}
      delete heldFileLocks[key];
    });
    Object.keys(blockedFileLocks).forEach(function(key) { delete blockedFileLocks[key]; });
    ownedHandlers.forEach(function(entry) {
      try {
        if (entry.element[entry.property] === entry.handler) entry.element[entry.property] = entry.previous || null;
      } catch (_) {}
    });
    ownedHandlers = [];
    lifecycle.dispose();
    var workbenchRoot = $('team-workbench');
    if (workbenchRoot) workbenchRoot.innerHTML = '';
    var actionBody = $('collab-action-body');
    if (actionBody) actionBody.innerHTML = '';
    var conflictEditor = $('team-conflict-editor');
    if (conflictEditor) conflictEditor.innerHTML = '';
    var conflictPage = $('collab-conflict-session');
    if (conflictPage) conflictPage.innerHTML = '';
    var badge = $('team-project-badge');
    if (badge) {
      badge.innerHTML = '';
      badge.style.display = 'none';
    }
    var panelTab = $('team-panel-tab');
    if (panelTab) panelTab.style.display = 'none';
    var ownsProfileFallback = false;
    try { ownsProfileFallback = !dependencies.getAccountProfile(); } catch (_) { ownsProfileFallback = true; }
    if (ownsProfileFallback) {
      var avatarOptions = $('profile-avatar-options');
      if (avatarOptions) avatarOptions.innerHTML = '';
    }
    selectedTeamId = '';
    selectedDetail = null;
    selectedCacheInfo = null;
    selectedTeamActivity = null;
    expandedProjects.clear();
    sidebarIdentity = '';
    setFriendsVisible(false);
  }

  var service = Object.assign({}, facade);
  Object.defineProperty(service, 'disposed', {
    enumerable: true,
    configurable: false,
    get: function() { return disposed; }
  });
  service.dispose = dispose;
  return Object.freeze(service);
}
