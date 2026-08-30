// Server Settings rclone selector. Executable discovery and trust decisions
// remain in Electron main; this module only renders opaque candidate IDs.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var initialized = false;
  var menuOpen = false;
  var scanEpoch = 0;
  var statusEpoch = 0;
  var scanResult = null;
  var selection = { source: 'bundled', path: '', version: null };
  var lastStatus = { kind: 'unchecked', value: null };

  function t(source, replacements) {
    if (BOBO.i18n && BOBO.i18n.t) return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function elements() {
    return {
      root: document.getElementById('rclone-selector'),
      trigger: document.getElementById('rclone-path'),
      title: document.getElementById('rclone-select-title'),
      meta: document.getElementById('rclone-select-meta'),
      options: document.getElementById('rclone-options'),
      status: document.getElementById('rclone-status')
    };
  }

  function selectionTitle(value) {
    return value && value.source === 'system'
      ? t('System PATH rclone')
      : t('App bundled rclone (Recommended)');
  }

  function renderSelection() {
    var el = elements();
    if (!el.trigger) return;
    el.title.textContent = selectionTitle(selection);
    el.meta.textContent = selection && selection.source === 'system'
      ? selection.path || t('Unverified external executable')
      : t('Managed by BOBOCLOUD');
    el.trigger.title = selection && selection.source === 'system' ? selection.path || '' : '';
  }

  function setStatus(state, message, title) {
    var status = elements().status;
    if (!status) return;
    status.dataset.state = state;
    status.textContent = message;
    if (title) status.title = title;
    else status.removeAttribute('title');
  }

  function renderVersion(result, remember) {
    if (remember !== false) lastStatus = { kind: 'version', value: result };
    if (result && result.available) {
      setStatus('available', t('{source} rclone available: {version}', {
        source: result.source === 'system' ? t('System PATH') : t('Bundled'),
        version: result.version || t('unknown version')
      }), result.path || '');
      return;
    }
    setStatus('unavailable', t('rclone unavailable: {error}', {
      error: result && result.error || t('unknown error')
    }), result && result.path || '');
  }

  function renderConfigurationError(error, remember) {
    if (remember !== false) lastStatus = { kind: 'configuration-error', value: error };
    setStatus('warning', t('rclone is available, but server configuration failed: {error}', {
      error: error || t('unknown error')
    }), error || '');
  }

  function renderLastStatus() {
    if (lastStatus.kind === 'version') renderVersion(lastStatus.value, false);
    else if (lastStatus.kind === 'configuration-error') renderConfigurationError(lastStatus.value, false);
    else if (lastStatus.kind === 'selection-error') setStatus('unavailable', t('Could not select rclone: {error}', { error: lastStatus.value }));
    else if (lastStatus.kind === 'checking') setStatus('checking', t('Checking rclone...'));
    else if (lastStatus.kind === 'activating') setStatus('checking', t('Validating and activating rclone...'));
    else setStatus('checking', t('Not checked'));
  }

  function optionButton(candidate) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'rclone-option';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', candidate.selected ? 'true' : 'false');
    button.tabIndex = candidate.selected ? 0 : -1;
    button.dataset.candidateId = candidate.id;

    var icon = document.createElement('span');
    icon.className = 'rclone-option-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = candidate.source === 'bundled'
      ? '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Zm0 2.3 5.2 2.9L12 11.1 6.8 8.2 12 5.3Zm-5.5 4.6 4.4 2.5v5.7l-4.4-2.5V9.9Zm6.6 8.2v-5.7l4.4-2.5v5.7l-4.4 2.5Z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4V5Zm2 2v7h12V7H6Zm2 2h2v2H8V9Zm-4 9h16v2H4v-2Z"/></svg>';
    button.appendChild(icon);

    var copy = document.createElement('span');
    copy.className = 'rclone-option-copy';
    var title = document.createElement('span');
    title.className = 'rclone-option-title';
    title.textContent = candidate.source === 'bundled'
      ? t('App bundled rclone (Recommended)')
      : candidate.path;
    copy.appendChild(title);
    var meta = document.createElement('span');
    meta.className = 'rclone-option-meta';
    meta.textContent = candidate.source === 'bundled'
      ? t('Managed by BOBOCLOUD')
      : t('Unverified external executable');
    copy.appendChild(meta);
    button.appendChild(copy);

    if (candidate.selected) {
      var check = document.createElement('span');
      check.className = 'rclone-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
      button.appendChild(check);
    }
    return button;
  }

  function renderOptions(result) {
    var container = elements().options;
    if (!container) return;
    container.textContent = '';
    var candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
    candidates.forEach(function(candidate) { container.appendChild(optionButton(candidate)); });
    if (!candidates.some(function(candidate) { return candidate.source === 'system'; })) {
      var empty = document.createElement('div');
      empty.className = 'rclone-options-empty';
      empty.textContent = t('No additional rclone installations found');
      container.appendChild(empty);
    }
    positionMenu();
  }

  function positionMenu() {
    if (!menuOpen) return;
    var el = elements();
    if (!el.root || !el.trigger || !el.options) return;
    var body = el.root.closest('.settings-body');
    var triggerRect = el.trigger.getBoundingClientRect();
    var boundary = body ? body.getBoundingClientRect() : { top: 0, bottom: global.innerHeight };
    var spaceBelow = Math.max(0, boundary.bottom - triggerRect.bottom - 7);
    var spaceAbove = Math.max(0, triggerRect.top - boundary.top - 7);
    var openUp = spaceBelow < 150 && spaceAbove > spaceBelow;
    el.root.classList.toggle('open-up', openUp);
    var available = openUp ? spaceAbove : spaceBelow;
    el.root.style.setProperty('--rclone-options-max-height', Math.max(72, Math.min(230, available)) + 'px');
  }

  function closeMenu(restoreFocus) {
    var el = elements();
    menuOpen = false;
    scanEpoch += 1;
    if (el.root) el.root.classList.remove('open');
    if (el.trigger) {
      el.trigger.setAttribute('aria-expanded', 'false');
      el.trigger.removeAttribute('aria-busy');
    }
    if (el.options) el.options.hidden = true;
    if (restoreFocus && el.trigger) el.trigger.focus();
  }

  async function openMenu(focusOption) {
    var el = elements();
    if (!el.trigger || !el.options || menuOpen) return;
    menuOpen = true;
    var epoch = ++scanEpoch;
    el.root.classList.add('open');
    el.trigger.setAttribute('aria-expanded', 'true');
    el.trigger.setAttribute('aria-busy', 'true');
    el.options.hidden = false;
    el.options.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'rclone-options-loading';
    loading.textContent = t('Scanning rclone installations...');
    el.options.appendChild(loading);
    positionMenu();
    try {
      var result = await BOBO.rclone.listBinaries();
      if (!menuOpen || epoch !== scanEpoch) return;
      scanResult = result;
      if (result.selection) selection = result.selection;
      renderSelection();
      renderOptions(result);
      if (focusOption) {
        var selected = el.options.querySelector('[role="option"][aria-selected="true"]') || el.options.querySelector('[role="option"]');
        if (selected) selected.focus();
      }
    } catch (error) {
      if (!menuOpen || epoch !== scanEpoch) return;
      el.options.textContent = '';
      var failure = document.createElement('div');
      failure.className = 'rclone-options-error';
      failure.textContent = t('Could not scan system PATH: {error}', { error: error.message });
      el.options.appendChild(failure);
    } finally {
      if (menuOpen && epoch === scanEpoch) el.trigger.removeAttribute('aria-busy');
    }
  }

  async function chooseCandidate(candidateId) {
    if (!scanResult || !candidateId) return;
    var operation = ++statusEpoch;
    var previousStatus = lastStatus;
    lastStatus = { kind: 'activating', value: null };
    renderLastStatus();
    var trigger = elements().trigger;
    if (trigger) trigger.setAttribute('aria-busy', 'true');
    var buttons = Array.prototype.slice.call(elements().options.querySelectorAll('[role="option"]'));
    buttons.forEach(function(button) { button.disabled = true; });
    try {
      var result = await BOBO.rclone.selectBinary(scanResult.scanId, candidateId);
      if (operation !== statusEpoch) return;
      if (!result || result.cancelled) {
        lastStatus = previousStatus;
        closeMenu(true);
        renderSelection();
        renderLastStatus();
        return;
      }
      selection = result.selection || selection;
      closeMenu(true);
      renderSelection();
      if (result.configurationError) renderConfigurationError(result.configurationError);
      else if (result.version) renderVersion(result.version);
      else await refreshStatus();
    } catch (error) {
      if (operation !== statusEpoch) return;
      closeMenu(true);
      lastStatus = { kind: 'selection-error', value: error.message };
      setStatus('unavailable', t('Could not select rclone: {error}', { error: error.message }));
    } finally {
      if (operation === statusEpoch && trigger) trigger.removeAttribute('aria-busy');
    }
  }

  async function refreshStatus() {
    var operation = ++statusEpoch;
    lastStatus = { kind: 'checking', value: null };
    renderLastStatus();
    try {
      var result = await BOBO.rclone.checkVersion();
      if (operation !== statusEpoch) return null;
      if (result && result.source) {
        selection = Object.assign({}, selection, {
          source: result.source,
          path: result.path || selection.path,
          version: result.version || null
        });
        renderSelection();
      }
      renderVersion(result);
      return result;
    } catch (error) {
      if (operation !== statusEpoch) return null;
      renderVersion({ available: false, error: error.message });
      return null;
    }
  }

  async function openSettings() {
    var operation = ++statusEpoch;
    closeMenu(false);
    try {
      var current = await BOBO.rclone.getSelection();
      if (operation !== statusEpoch) return;
      selection = current || selection;
      renderSelection();
    } catch (error) {
      if (operation !== statusEpoch) return;
      lastStatus = { kind: 'version', value: { available: false, error: error.message } };
      setStatus('unavailable', t('rclone unavailable: {error}', { error: error.message }));
      return;
    }
    await refreshStatus();
  }

  function deactivate() {
    statusEpoch += 1;
    closeMenu(false);
  }

  function moveOptionFocus(current, direction) {
    var options = Array.prototype.slice.call(elements().options.querySelectorAll('[role="option"]:not(:disabled)'));
    if (!options.length) return;
    var index = options.indexOf(current);
    var next = index < 0 ? 0 : (index + direction + options.length) % options.length;
    options.forEach(function(option, optionIndex) { option.tabIndex = optionIndex === next ? 0 : -1; });
    options[next].focus();
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    var el = elements();
    if (!el.trigger || !el.options) return;
    renderSelection();
    el.trigger.addEventListener('click', function() {
      if (menuOpen) closeMenu(false);
      else openMenu(false);
    });
    el.trigger.addEventListener('keydown', function(event) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!menuOpen) openMenu(true);
        else {
          var first = el.options.querySelector('[role="option"][aria-selected="true"]') || el.options.querySelector('[role="option"]');
          if (first) first.focus();
        }
      } else if (event.key === 'Escape') {
        closeMenu(false);
      }
    });
    el.options.addEventListener('click', function(event) {
      var option = event.target.closest('[data-candidate-id]');
      if (option) chooseCandidate(option.dataset.candidateId);
    });
    el.options.addEventListener('keydown', function(event) {
      var option = event.target.closest('[data-candidate-id]');
      if (!option) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveOptionFocus(option, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseCandidate(option.dataset.candidateId);
      } else if (event.key === 'Escape') {
        closeMenu(false);
        el.trigger.focus();
      }
    });
    document.addEventListener('pointerdown', function(event) {
      if (menuOpen && el.root && !el.root.contains(event.target)) closeMenu(false);
    });
    global.addEventListener('resize', positionMenu);
    var settingsBody = el.root.closest('.settings-body');
    if (settingsBody) settingsBody.addEventListener('scroll', function() { closeMenu(false); }, { passive: true });
    if (BOBO.i18n && BOBO.i18n.onChange) {
      BOBO.i18n.onChange(function() {
        renderSelection();
        if (menuOpen && scanResult) renderOptions(scanResult);
        renderLastStatus();
      });
    }
  }

  BOBO.rcloneSettings = {
    initialize: initialize,
    open: openSettings,
    close: deactivate,
    refreshStatus: refreshStatus
  };
  BOBO.rclone.refreshStatus = refreshStatus;
})(window);
