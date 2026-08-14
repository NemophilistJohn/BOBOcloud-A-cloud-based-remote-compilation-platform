// src/account-profile.js - Personal identity and compile activity center.
(function(global) {
  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var chosenAvatar = 'graphite';
  var initialName = '';
  var initialAvatar = 'graphite';
  var previousFocus = null;
  var activityDays = [];
  var activityOwner = '';
  var activityLoadingOwner = '';
  var activityRequestGeneration = 0;
  var profileSaveGeneration = 0;
  var profileDraftRevision = 0;
  var avatarLoadGeneration = 0;
  var profileSaving = false;
  var initialized = false;

  function $(id) { return document.getElementById(id); }
  function t(key, params) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(key, params);
    return String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, name) {
      return params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }
  function notify(message, type) {
    if (BOBO.toast && BOBO.toast[type || 'info']) BOBO.toast[type || 'info'](t(message));
  }
  function currentUser() { return S.auth && S.auth.user; }
  function currentOwner() {
    var user = currentUser();
    if (!user || !(S.auth && S.auth.token)) return '';
    return String(user.id || user.uid || user.username || '') + '|' + String(S.auth.token);
  }
  function isDirty() {
    return Boolean($('profile-name')) &&
      ($('profile-name').value.trim() !== initialName || chosenAvatar !== initialAvatar);
  }
  function markDraftChanged() {
    profileDraftRevision++;
    renderSummary();
    setStatus(isDirty() ? 'Unsaved changes' : '', false);
  }
  function setProfileSaving(value) {
    profileSaving = Boolean(value);
    var saveButton = $('profile-save');
    var closeButton = $('profile-close-x');
    var cancelButton = $('profile-cancel');
    if (saveButton) saveButton.disabled = profileSaving;
    if (closeButton) closeButton.disabled = profileSaving;
    if (cancelButton) cancelButton.disabled = profileSaving;
    var modal = $('profile-modal');
    if (modal) {
      if (profileSaving) modal.setAttribute('aria-busy', 'true');
      else modal.removeAttribute('aria-busy');
    }
  }
  function initials(value) {
    var parts = String(value || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function renderAvatar(element, avatar, name) {
    if (!element) return;
    element.className = element.id === 'profile-avatar-preview' ? 'profile-avatar-preview' : 'account-summary-avatar';
    element.textContent = '';
    if (String(avatar || '').indexOf('data:image/') === 0) {
      var image = document.createElement('img');
      image.src = avatar;
      image.alt = '';
      element.appendChild(image);
      return;
    }
    var preset = /^(ocean|forest|coral|violet|graphite|amber)$/.test(avatar || '') ? avatar : 'graphite';
    element.classList.add('avatar-' + preset);
    element.textContent = initials(name);
  }
  function setStatus(message, error) {
    var element = $('profile-save-status');
    element.textContent = message ? t(message) : '';
    element.classList.toggle('error', Boolean(error));
  }
  function setActivityStatus(message, error) {
    var element = $('account-activity-status');
    element.textContent = message ? t(message) : '';
    element.classList.toggle('error', Boolean(error));
  }
  function utcDate(date) {
    return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  }
  function utcMidnight(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  function addUTCDays(date, count) {
    var result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + count);
    return result;
  }
  function activeLocale() {
    var locale = BOBO.i18n && BOBO.i18n.getActive ? BOBO.i18n.getActive() : 'en';
    return locale === 'zh-CN' ? 'zh-CN' : locale === 'ja' ? 'ja-JP' : 'en-US';
  }
  function activityLevel(count) {
    if (!count) return 0;
    if (count <= 1) return 1;
    if (count <= 3) return 2;
    if (count <= 7) return 3;
    return 4;
  }

  function renderSummary() {
    var user = currentUser() || {};
    var draftName = $('profile-name').value || user.name || user.username || '';
    renderAvatar($('profile-avatar-preview'), chosenAvatar, draftName);
    renderAvatar($('account-summary-avatar'), chosenAvatar, draftName);
    $('account-summary-name').textContent = draftName || user.username || '';
    $('account-summary-username').textContent = user.username ? '@' + user.username : '';
    $('account-summary-uid').textContent = user.uid || '';
    var roleKey = user.role === 'root' ? 'Root administrator' : user.role === 'admin' ? 'Administrator' : 'Member';
    $('account-summary-role').textContent = t(roleKey);
    document.querySelectorAll('.profile-avatar-swatch').forEach(function(element) {
      element.classList.toggle('selected', element.dataset.avatar === chosenAvatar);
      element.setAttribute('aria-pressed', element.dataset.avatar === chosenAvatar ? 'true' : 'false');
    });
  }

  function renderProfile() {
    var user = currentUser() || {};
    $('profile-name').value = user.name || user.username || '';
    $('profile-uid').textContent = user.uid || '';
    $('account-info-username').textContent = user.username || t('Not available');
    $('account-info-email').textContent = user.email || t('Not available');
    $('account-info-created').textContent = user.created_at ? new Date(user.created_at).toLocaleDateString(activeLocale()) : t('Not available');
    chosenAvatar = user.avatar || 'graphite';
    initialName = $('profile-name').value.trim();
    initialAvatar = chosenAvatar;
    var presets = ['ocean', 'forest', 'coral', 'violet', 'graphite', 'amber'];
    var presetNames = {
      ocean: 'Ocean', forest: 'Forest', coral: 'Coral',
      violet: 'Violet', graphite: 'Graphite', amber: 'Amber'
    };
    $('profile-avatar-options').textContent = '';
    presets.forEach(function(preset) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-avatar-swatch avatar-' + preset;
      button.dataset.avatar = preset;
      var name = t(presetNames[preset]);
      button.title = t('Use {name} avatar', { name: name });
      button.setAttribute('aria-label', t('Use {name} avatar', { name: name }));
      $('profile-avatar-options').appendChild(button);
    });
    renderSummary();
  }

  function renderActivity() {
    var counts = Object.create(null);
    activityDays.forEach(function(day) { counts[day.date] = Number(day.count || 0); });
    var today = utcMidnight(new Date());
    var startOfWeek = addUTCDays(today, -today.getUTCDay());
    var start = addUTCDays(startOfWeek, -52 * 7);
    var heatmap = $('account-heatmap');
    var months = $('account-heatmap-months');
    heatmap.textContent = '';
    months.textContent = '';
    var lastMonth = -1;
    for (var column = 0; column < 53; column++) {
      var weekStart = addUTCDays(start, column * 7);
      if (weekStart.getUTCMonth() !== lastMonth) {
        lastMonth = weekStart.getUTCMonth();
        var label = document.createElement('span');
        label.style.gridColumn = String(column + 2);
        label.textContent = new Intl.DateTimeFormat(activeLocale(), { month: 'short', timeZone: 'UTC' }).format(weekStart);
        months.appendChild(label);
      }
      for (var row = 0; row < 7; row++) {
        var date = addUTCDays(weekStart, row);
        var key = utcDate(date);
        var count = counts[key] || 0;
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'account-heatmap-cell';
        cell.dataset.level = String(activityLevel(count));
        cell.dataset.date = key;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', t('{date}: {count} compile requests', { date: key, count: count }));
        cell.title = t('{date}: {count} compile requests', { date: key, count: count });
        if (date > today) {
          cell.classList.add('future');
          cell.tabIndex = -1;
          cell.setAttribute('aria-hidden', 'true');
        }
        heatmap.appendChild(cell);
      }
    }
    var todayKey = utcDate(today);
    var visibleStartKey = utcDate(start);
    var monthStart = utcDate(addUTCDays(today, -29));
    var todayCount = counts[todayKey] || 0;
    var monthCount = 0;
    var activeCount = 0;
    Object.keys(counts).forEach(function(date) {
      if (date >= monthStart && date <= todayKey) monthCount += counts[date];
      if (date >= visibleStartKey && date <= todayKey && counts[date] > 0) activeCount++;
    });
    $('account-activity-today').textContent = String(todayCount);
    $('account-activity-month').textContent = String(monthCount);
    $('account-activity-days').textContent = String(activeCount);
  }

  async function loadActivity() {
    var owner = currentOwner();
    if (!owner || owner !== activityOwner || activityLoadingOwner === owner) return;
    var generation = ++activityRequestGeneration;
    activityLoadingOwner = owner;
    setActivityStatus('Loading activity...', false);
    try {
      var result = await BOBO.sendToServer('getCompileActivity', {}, { quiet: true });
      if (generation !== activityRequestGeneration || owner !== activityOwner || owner !== currentOwner()) return;
      if (!result || !result.success) throw new Error(result && result.error || t('Activity is unavailable'));
      activityDays = result.data && Array.isArray(result.data.days) ? result.data.days : [];
      renderActivity();
      setActivityStatus('', false);
    } catch (error) {
      if (generation !== activityRequestGeneration || owner !== activityOwner || owner !== currentOwner()) return;
      activityDays = [];
      renderActivity();
      setActivityStatus('Activity is unavailable', true);
    } finally {
      if (generation === activityRequestGeneration) activityLoadingOwner = '';
    }
  }

  function switchTab(tab) {
    tab = tab === 'activity' ? 'activity' : 'profile';
    document.querySelectorAll('[data-account-tab]').forEach(function(button) {
      var active = button.dataset.accountTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-account-pane]').forEach(function(pane) {
      pane.classList.toggle('active', pane.dataset.accountPane === tab);
    });
    $('profile-save').style.visibility = tab === 'profile' ? '' : 'hidden';
    setStatus('', false);
    if (tab === 'activity') loadActivity();
  }

  function open(tab) {
    var user = currentUser();
    if (!user || !(S.auth && S.auth.token)) {
      if (BOBO.auth && BOBO.auth.openAuthModal) BOBO.auth.openAuthModal(t('Sign in to view your personal profile'));
      return;
    }
    var owner = currentOwner();
    if ($('profile-modal').classList.contains('open') && owner === activityOwner) {
      switchTab(tab || 'profile');
      return;
    }
    if (owner !== activityOwner) {
      activityOwner = owner;
      activityDays = [];
      activityLoadingOwner = '';
      activityRequestGeneration++;
      profileSaveGeneration++;
      profileDraftRevision = 0;
      avatarLoadGeneration++;
      setProfileSaving(false);
    }
    previousFocus = document.activeElement;
    renderProfile();
    renderActivity();
    switchTab(tab || 'profile');
    $('profile-modal').classList.add('open');
    setTimeout(function() { document.querySelector('[data-account-tab="' + (tab === 'activity' ? 'activity' : 'profile') + '"]').focus(); }, 30);
    loadActivity();
  }

  function close() {
    $('profile-modal').classList.remove('open');
    setStatus('', false);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  }

  async function requestClose() {
    if (profileSaving) return;
    if (!isDirty()) {
      close();
      return;
    }
    var discard = BOBO.confirm ? await BOBO.confirm({
      title: t('Discard profile changes?'),
      message: t('Your unsaved profile changes will be lost.'),
      confirmLabel: t('Discard changes'),
      cancelLabel: t('Keep editing'),
      danger: true
    }) : false;
    if (discard) close();
  }

  function reset() {
    activityRequestGeneration++;
    profileSaveGeneration++;
    profileDraftRevision = 0;
    avatarLoadGeneration++;
    activityDays = [];
    activityOwner = '';
    activityLoadingOwner = '';
    chosenAvatar = 'graphite';
    initialAvatar = 'graphite';
    initialName = '';
    setProfileSaving(false);
    if ($('profile-modal')) close();
  }

  function chooseAvatarFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      notify('Choose a PNG, JPEG, WebP or GIF image under 5 MB', 'error');
      return;
    }
    var owner = currentOwner();
    var generation = ++avatarLoadGeneration;
    var objectURL = URL.createObjectURL(file);
    var image = new Image();
    image.onload = function() {
      if (generation !== avatarLoadGeneration || owner !== currentOwner()) {
        URL.revokeObjectURL(objectURL);
        return;
      }
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
        markDraftChanged();
      } finally {
        URL.revokeObjectURL(objectURL);
      }
    };
    image.onerror = function() {
      URL.revokeObjectURL(objectURL);
      if (generation !== avatarLoadGeneration || owner !== currentOwner()) return;
      notify('The selected image could not be read', 'error');
    };
    image.src = objectURL;
  }

  async function save() {
    var button = $('profile-save');
    var owner = currentOwner();
    var generation = ++profileSaveGeneration;
    var savedRevision = profileDraftRevision;
    var submittedName = $('profile-name').value.trim();
    var submittedAvatar = chosenAvatar;
    setProfileSaving(true);
    setStatus('Saving...', false);
    try {
      var result = await BOBO.sendToServer('updateProfile', {
        name: submittedName, avatar: submittedAvatar
      }, { quiet: true });
      if (generation !== profileSaveGeneration || owner !== currentOwner()) return;
      if (!result || !result.success) throw new Error(result && result.error || t('Update failed'));
      S.auth.user = result.user;
      if (BOBO.auth && BOBO.auth.renderChip) BOBO.auth.renderChip();
      if (profileDraftRevision === savedRevision) {
        renderProfile();
        setStatus('Profile updated', false);
      } else {
        initialName = result.user.name || result.user.username || submittedName;
        initialAvatar = result.user.avatar || submittedAvatar;
        renderSummary();
        setStatus(isDirty() ? 'Unsaved changes' : 'Profile updated', false);
      }
      notify('Profile updated', 'success');
    } catch (error) {
      if (generation !== profileSaveGeneration || owner !== currentOwner()) return;
      setStatus(error.message || t('Update failed'), true);
    } finally {
      if (generation === profileSaveGeneration && owner === currentOwner()) setProfileSaving(false);
    }
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    var focusable = Array.from($('profile-modal').querySelectorAll('button:not([disabled]), input:not([disabled])')).filter(function(element) {
      return element.offsetParent !== null && element.style.visibility !== 'hidden';
    });
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    $('auth-menu-profile').onclick = function() {
      $('auth-menu').style.display = 'none';
      open('profile');
    };
    $('profile-close-x').onclick = requestClose;
    $('profile-cancel').onclick = requestClose;
    $('profile-save').onclick = save;
    $('profile-name').addEventListener('input', function() {
      markDraftChanged();
    });
    $('profile-avatar-options').onclick = function(event) {
      var button = event.target.closest('[data-avatar]');
      if (!button) return;
      avatarLoadGeneration++;
      chosenAvatar = button.dataset.avatar;
      markDraftChanged();
    };
    $('profile-avatar-upload').onclick = function() { $('profile-avatar-file').click(); };
    $('profile-avatar-file').onchange = function() { chooseAvatarFile(this.files && this.files[0]); this.value = ''; };
    $('profile-copy-uid').onclick = async function() {
      try { await navigator.clipboard.writeText($('profile-uid').textContent); notify('User ID copied', 'success'); }
      catch (error) { notify('Copy failed', 'error'); }
    };
    document.querySelectorAll('[data-account-tab]').forEach(function(button) {
      button.onclick = function() { switchTab(button.dataset.accountTab); };
    });
    $('profile-modal').onclick = function(event) { if (event.target === $('profile-modal')) requestClose(); };
    $('profile-modal').onkeydown = trapFocus;
    document.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape' || !$('profile-modal').classList.contains('open')) return;
      var confirmDialog = $('confirm-dialog');
      if (confirmDialog && confirmDialog.classList.contains('open')) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }, true);
    if (BOBO.collaboration) BOBO.collaboration.openProfile = open;
    if (BOBO.i18n && BOBO.i18n.onChange) {
      BOBO.i18n.onChange(function() {
        if (!$('profile-modal').classList.contains('open')) return;
        renderSummary();
        renderActivity();
      });
    }
  }

  BOBO.accountProfile = {
    init: init,
    open: open,
    close: requestClose,
    reset: reset,
    renderActivity: renderActivity
  };
})(window);
