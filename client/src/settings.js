// src/settings.js - Unified Settings Center with Local/Server tabs
// Local: theme, diagnostics - saved client-side
// Server: connection, auth, sync - saved and connects to server
(function(global) {
  var BOBO = global.BOBO || {};
  var S = BOBO.state;

  var modal = null;
  var activeTab = 'local';
  var previousFocus = null;
  var firstRunOpen = false;
  var serverPaneLoaded = false;

  function isVisible(element) {
    if (!element || !global.getComputedStyle) return false;
    var style = global.getComputedStyle(element);
    var bounds = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 &&
      bounds.width > 16 && bounds.height > 16;
  }

  function releaseBrokenFirstRunModal() {
    finishFirstRun();
    if (!modal) return;
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
  }

  function verifyFirstRunModal() {
    global.setTimeout(function() {
      if (!firstRunOpen || !modal) return;
      var card = modal.querySelector('.settings-card');
      if (isVisible(modal) && isVisible(card)) return;
      console.error('Server setup guide could not render; returning control to the workbench.');
      releaseBrokenFirstRunModal();
    }, 160);
  }

  function t(key, params) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key, params) : String(key);
  }

  function ensureDOM() {
    if (modal) return;
    modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Tab switching
    var tabs = modal.querySelectorAll('.settings-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function(tab) {
        tab.addEventListener('click', function() { switchTab(tab.getAttribute('data-stab')); });
        tab.addEventListener('keydown', function(event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          var items = Array.prototype.slice.call(modal.querySelectorAll('.settings-tab'));
          var index = items.indexOf(tab);
          var next = items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
          next.focus();
          switchTab(next.getAttribute('data-stab'));
        });
      })(tabs[i]);
    }

    // Close handlers
    var closeX = document.getElementById('settings-close-x');
    if (closeX) closeX.addEventListener('click', close);
    var closeBtn = document.getElementById('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var closeWorkbench = document.getElementById('settings-close-workbench');
    if (closeWorkbench) closeWorkbench.addEventListener('click', close);
    var closeLsp = document.getElementById('settings-close-lsp');
    if (closeLsp) closeLsp.addEventListener('click', close);
    var closeLanguage = document.getElementById('settings-close-language');
    if (closeLanguage) closeLanguage.addEventListener('click', close);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) close();
    });
    modal.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // Local save (theme + diagnostics)
    var saveLocal = document.getElementById('settings-save-local');
    if (saveLocal) saveLocal.addEventListener('click', saveLocalSettings);

    // Server save (delegates to existing server-save handler)
    // The server-save button already has its handler in app.js,
    // so we just need to close the modal after save.
  }

  function activateServerPane() {
    if (!serverPaneLoaded) {
      var ss = S.serverSettings || {};
      var values = {
        'server-ip': ss.ip || '',
        'server-user': ss.user || '',
        'server-pass': ss.pass || '',
        'server-apikey': ss.apiKey || '',
        'server-http-port': ss.httpPort || 3100,
        'server-ws-port': ss.wsPort || 3101,
        'server-dap-child-port': ss.dapChildWsPort || 3102,
        'server-cert-fingerprint': ss.certificateFingerprint || '',
        'sync-interval': !ss.syncInterval ? 30 : (ss.syncInterval >= 1000 ? Math.round(ss.syncInterval / 1000) : ss.syncInterval)
      };
      Object.keys(values).forEach(function(id) {
        var control = document.getElementById(id);
        if (control) control.value = values[id];
      });
      var secure = document.getElementById('server-secure-transport');
      if (secure) secure.checked = ss.secureTransport === true;
      serverPaneLoaded = true;
    }
    if (BOBO.rcloneSettings) setTimeout(function() { BOBO.rcloneSettings.open(); }, 0);
  }

  function switchTab(tab) {
    activeTab = tab;
    var tabs = modal.querySelectorAll('.settings-tab');
    var panes = modal.querySelectorAll('.settings-pane');
    var feet = modal.querySelectorAll('.settings-foot');
    for (var i = 0; i < tabs.length; i++) {
      var selected = tabs[i].getAttribute('data-stab') === tab;
      tabs[i].classList.toggle('active', selected);
      tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      tabs[i].tabIndex = selected ? 0 : -1;
    }
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('active', panes[j].getAttribute('data-spane') === tab);
    }
    for (var k = 0; k < feet.length; k++) {
      feet[k].classList.toggle('active', feet[k].getAttribute('data-sfoot') === tab);
    }
    var body = modal.querySelector('.settings-body');
    if (body) body.scrollTop = 0;
    if (tab === 'workbench' && BOBO.workbench) BOBO.workbench.refreshControls();
    if (tab === 'language' && BOBO.languagePacksPanel) BOBO.languagePacksPanel.refresh();
    if (tab === 'lsp' && BOBO.lsp) BOBO.lsp.renderStatus();
    if (tab === 'server') activateServerPane();
    else if (BOBO.rcloneSettings) BOBO.rcloneSettings.close();
  }

  function fillModelSelect(select, selectedId) {
    if (!select) return;
    select.innerHTML = '';
    if (!S.ai.models.length) {
      var empty = document.createElement('option');
      empty.textContent = t('No model');
      empty.value = '';
      select.appendChild(empty);
      return;
    }
    S.ai.models.forEach(function(model) {
      var option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      option.selected = model.id === selectedId;
      select.appendChild(option);
    });
  }

  function statusLabel(model, purpose) {
    var status = BOBO.aiService.getModelStatus(model, purpose);
    return { status: status, text: t(status.code) };
  }

  function renderAiSettings() {
    if (!BOBO.aiService || !S.ai) return;
    fillModelSelect(document.getElementById('ai-chat-model-select'), S.ai.chatModel);
    fillModelSelect(document.getElementById('ai-inline-model-select'), S.ai.inlineModel);
    var enabled = document.getElementById('ai-inline-enabled');
    if (enabled) enabled.checked = S.ai.inlineEnabled;
    var debounce = document.getElementById('ai-inline-debounce');
    if (debounce) debounce.value = String(S.ai.inlineDebounceMs || 450);
    var output = document.getElementById('ai-inline-debounce-output');
    if (output) output.textContent = (S.ai.inlineDebounceMs || 450) + ' ms';
    var promptValues = {
      'ai-chat-system-prompt': S.ai.chatSystemPrompt || '',
      'ai-inline-instruction': S.ai.inlineInstruction || '',
      'ai-inline-prefix-chars': S.ai.inlinePrefixChars || 6000,
      'ai-inline-suffix-chars': Number.isFinite(S.ai.inlineSuffixChars) ? S.ai.inlineSuffixChars : 2500,
      'ai-inline-max-tokens': S.ai.inlineMaxTokens || 160
    };
    Object.keys(promptValues).forEach(function(id) { var control = document.getElementById(id); if (control) control.value = String(promptValues[id]); });
    var chat = statusLabel(BOBO.aiService.getModelFor('chat'), 'chat');
    var inlineModel = BOBO.aiService.getModelFor('inline');
    var inline = statusLabel(inlineModel, 'inline');
    var instruction = document.getElementById('ai-inline-instruction');
    var instructionMode = document.getElementById('ai-inline-instruction-mode');
    var instructionAvailable = !inlineModel || inlineModel.inlineMode !== 'fim';
    if (instruction) instruction.disabled = !instructionAvailable;
    if (instructionMode) instructionMode.textContent = t('ai.inlineMode.chat');
    var state = document.getElementById('ai-settings-state');
    if (state) {
      var ready = chat.status.state === 'ready' && (!S.ai.inlineEnabled || inline.status.state === 'ready');
      state.dataset.state = ready ? 'ready' : 'unconfigured';
      state.textContent = ready ? t('ai.status.ready') : t('ai.status.configurationRequired');
    }
    renderAiModelList();
  }

  function renderAiModelList() {
    var list = document.getElementById('ai-model-list');
    if (!list) return;
    list.innerHTML = '';
    (S.ai.models || []).forEach(function(model) {
      var card = document.createElement('article');
      card.className = 'ai-model-card';
      var header = document.createElement('header');
      var identity = document.createElement('div');
      var name = document.createElement('strong'); name.textContent = model.name;
      var meta = document.createElement('small'); meta.textContent = model.provider + ' · ' + model.modelId;
      identity.append(name, meta);
      var badge = document.createElement('span'); badge.className = 'ai-model-badge'; badge.textContent = model.isPreset ? t('PRESET') : t('ai.custom');
      header.append(identity, badge);
      var facts = document.createElement('dl');
      var chatFact = document.createElement('div'); var chatTerm = document.createElement('dt'); var chatValue = document.createElement('dd');
      chatTerm.textContent = t('ai.chatEndpoint'); chatValue.textContent = model.endpoint || t('ai.value.notSet'); chatFact.append(chatTerm, chatValue);
      var inlineFact = document.createElement('div'); var inlineTerm = document.createElement('dt'); var inlineValue = document.createElement('dd');
      inlineTerm.textContent = t('ai.inlineEndpoint'); inlineValue.textContent = model.inlineEndpoint || model.endpoint || t('ai.value.notSet'); inlineFact.append(inlineTerm, inlineValue);
      facts.append(chatFact, inlineFact);
      var status = document.createElement('div'); status.className = 'ai-model-status'; status.textContent = statusLabel(model, 'chat').text;
      var actions = document.createElement('div'); actions.className = 'ai-model-actions';
      var test = document.createElement('button'); test.className = 'ss-btn ss-btn-ghost'; test.textContent = t('Test Connection');
      test.addEventListener('click', async function() {
        test.disabled = true; status.dataset.state = 'testing'; status.textContent = t('ai.status.testing');
        var result = await BOBO.aiService.testModelConnection(model, 'chat');
        status.dataset.state = result.success ? 'ready' : 'error';
        status.textContent = result.success ? t('ai.status.connected') : t(result.code || 'ai.error.connectionFailed');
        test.disabled = false;
      });
      var edit = document.createElement('button'); edit.className = 'ss-btn ss-btn-ghost'; edit.textContent = t('Edit Model'); edit.addEventListener('click', function() { editAiModel(model); });
      actions.append(test, edit);
      if (!model.isPreset) {
        var remove = document.createElement('button'); remove.className = 'ss-btn ss-btn-danger'; remove.textContent = t('Delete model');
        remove.addEventListener('click', async function() { await BOBO.aiService.removeModel(model.id); renderAiSettings(); }); actions.appendChild(remove);
      }
      card.append(header, facts, status, actions); list.appendChild(card);
    });
  }

  function createAiField(labelKey, value, options) {
    options = options || {};
    var label = document.createElement('label'); label.className = 'ai-model-field';
    var caption = document.createElement('span'); caption.textContent = t(labelKey);
    var input = document.createElement(options.select ? 'select' : 'input'); input.className = 'ss-input'; input.value = value || '';
    if (options.type) input.type = options.type;
    if (options.readOnly) input.readOnly = true;
    if (options.select) options.select.forEach(function(entry) { var option = document.createElement('option'); option.value = entry.value; option.textContent = t(entry.label); option.selected = option.value === value; input.appendChild(option); });
    label.append(caption, input); return { root: label, input: input };
  }

  function editAiModel(model) {
    var overlay = document.createElement('div'); overlay.className = 'ai-editor-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    var card = document.createElement('form'); card.className = 'ai-editor-card';
    var title = document.createElement('h2'); title.textContent = t(model ? 'Edit Model' : 'Add Custom Model');
    var locked = Boolean(model && model.isPreset);
    var name = createAiField('Model Name', model && model.name, { readOnly: locked });
    var provider = createAiField('ai.provider', model && model.provider || 'openai-compatible', { readOnly: locked });
    var chatEndpoint = createAiField('ai.chatEndpoint', model && model.endpoint, { readOnly: locked });
    var chatModel = createAiField('ai.chatModelId', model && model.modelId, { readOnly: locked });
    var inlineMode = createAiField('ai.inlineMode', model && model.inlineMode || 'chat', { select: [{ value: 'chat', label: 'ai.inlineMode.chat' }, { value: 'fim', label: 'ai.inlineMode.fim' }] });
    if (locked) inlineMode.input.disabled = true;
    var inlineEndpoint = createAiField('ai.inlineEndpoint', model && model.inlineEndpoint, { readOnly: locked });
    var inlineModel = createAiField('ai.inlineModelId', model && model.inlineModelId, { readOnly: locked });
    var key = createAiField('API Key', model && model.apiKey, { type: 'password' }); key.input.autocomplete = 'off';
    var message = document.createElement('div'); message.className = 'ai-editor-message'; message.setAttribute('role', 'status');
    var actions = document.createElement('div'); actions.className = 'ai-editor-actions';
    var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ss-btn ss-btn-ghost'; cancel.textContent = t('Cancel'); cancel.addEventListener('click', function() { overlay.remove(); });
    var save = document.createElement('button'); save.type = 'submit'; save.className = 'ss-btn ss-btn-primary'; save.textContent = t('Save Changes'); actions.append(cancel, save);
    card.append(title, name.root, provider.root, chatEndpoint.root, chatModel.root, inlineMode.root, inlineEndpoint.root, inlineModel.root, key.root, message, actions);
    card.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!name.input.value.trim() || !chatEndpoint.input.value.trim() || !chatModel.input.value.trim()) { message.textContent = t('ai.error.requiredFields'); return; }
      var values = { id: model ? model.id : 'custom-' + Date.now(), name: name.input.value.trim(), provider: provider.input.value.trim(), endpoint: chatEndpoint.input.value.trim(), modelId: chatModel.input.value.trim(), apiKey: key.input.value.trim(), inlineMode: inlineMode.input.value, inlineEndpoint: inlineEndpoint.input.value.trim(), inlineModelId: inlineModel.input.value.trim(), isPreset: locked };
      if (model) await BOBO.aiService.updateModel(model.id, values); else await BOBO.aiService.addModel(values);
      overlay.remove(); renderAiSettings();
    });
    overlay.appendChild(card); overlay.addEventListener('click', function(event) { if (event.target === overlay) overlay.remove(); }); document.body.appendChild(overlay); name.input.focus();
  }

  function renderThemeChoices() {
    var list = document.getElementById('settings-theme-list');
    if (!list || !window.themeManager) return;
    var themes = window.themeManager.listThemes();
    var currentTheme = window.themeManager.getCurrentTheme();
    list.innerHTML = '';

    for (var i = 0; i < themes.length; i += 1) {
      var theme = themes[i];
      var row = document.createElement('label');
      row.className = 'theme-choice';
      row.setAttribute('data-theme-id', theme.id);

      var name = document.createElement('span');
      name.className = 'theme-choice-name';
      if (BOBO.i18n && BOBO.i18n.bindText) BOBO.i18n.bindText(name, theme.label);
      else name.textContent = t(theme.label);

      var swatches = document.createElement('span');
      swatches.className = 'theme-choice-swatches';
      swatches.setAttribute('aria-hidden', 'true');
      for (var colorIndex = 0; colorIndex < theme.colors.length; colorIndex += 1) {
        var swatch = document.createElement('span');
        swatch.className = 'theme-choice-swatch';
        swatch.style.backgroundColor = theme.colors[colorIndex];
        swatches.appendChild(swatch);
      }

      var radio = document.createElement('input');
      radio.className = 'theme-choice-radio';
      radio.type = 'radio';
      radio.name = 'settings-theme';
      radio.value = theme.id;
      radio.checked = theme.id === currentTheme;
      if (BOBO.i18n && BOBO.i18n.bindAttribute) BOBO.i18n.bindAttribute(radio, 'aria-label', theme.label);
      else radio.setAttribute('aria-label', t(theme.label));

      row.appendChild(name);
      row.appendChild(swatches);
      row.appendChild(radio);
      list.appendChild(row);
    }
  }

  function loadLocalSettings() {
    renderThemeChoices();

    // Diagnostics
    var diagEnabled = document.getElementById('settings-diag-enabled');
    var diagMode = document.getElementById('settings-diag-mode');
    var ds = S.diagnosticsSettings;
    if (diagEnabled) diagEnabled.checked = !ds || ds.enabled !== false;
    if (diagMode) diagMode.value = (ds && ds.checkOn) ? ds.checkOn : 'type';
  }

  function saveLocalSettings() {
    // Theme
    var selectedTheme = document.querySelector('input[name="settings-theme"]:checked');
    if (selectedTheme && window.themeManager) {
      var themes = window.themeManager.listThemes();
      var theme = themes.find(function(item) { return item.id === selectedTheme.value; });
      window.themeManager.applyTheme(selectedTheme.value);
      if (BOBO.toast && theme) BOBO.toast.success(t('Theme: {name}', { name: t(theme.label) }));
    }

    // Diagnostics
    var diagEnabled = document.getElementById('settings-diag-enabled');
    var diagMode = document.getElementById('settings-diag-mode');
    if (diagEnabled || diagMode) {
      if (!S.diagnosticsSettings) S.diagnosticsSettings = {};
      if (diagEnabled) S.diagnosticsSettings.enabled = diagEnabled.checked;
      if (diagMode) S.diagnosticsSettings.checkOn = diagMode.value;
      if (global.api && global.api.writeDiagnosticsSettings) {
        global.api.writeDiagnosticsSettings(S.diagnosticsSettings);
      }
      if (BOBO.editorCore && BOBO.editorCore.recheckAll) BOBO.editorCore.recheckAll();
    }

    close();
  }

  function open(tab) {
    if (tab === 'ai') {
      if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open();
      return;
    }
    ensureDOM();
    if (!modal) return;
    modal.style.pointerEvents = '';
    previousFocus = document.activeElement;
    serverPaneLoaded = false;
    loadLocalSettings();

    switchTab(tab || 'local');
    if (BOBO.workbench) BOBO.workbench.refreshControls();
    modal.style.display = 'flex';
    var selectedTab = modal.querySelector('.settings-tab.active');
    if (selectedTab) setTimeout(function() { selectedTab.focus(); }, 30);
  }

  function openFirstRun() {
    ensureDOM();
    if (!modal || !(S.serverSettings && S.serverSettings.firstRunRequired)) return false;
    firstRunOpen = true;
    modal.classList.add('server-first-run');
    var intro = document.getElementById('server-first-run-intro');
    var skip = document.getElementById('server-skip-first-run');
    if (intro) intro.hidden = false;
    if (skip) skip.hidden = false;
    try {
      open('server');
    } catch (error) {
      console.error('Server setup guide could not open:', error);
      releaseBrokenFirstRunModal();
      return false;
    }
    verifyFirstRunModal();
    setTimeout(function() {
      var input = document.getElementById('server-ip');
      if (input) input.focus();
    }, 40);
    return true;
  }

  function close() {
    if (firstRunOpen) return;
    if (BOBO.rcloneSettings) BOBO.rcloneSettings.close();
    serverPaneLoaded = false;
    if (modal) modal.style.display = 'none';
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  }

  function finishFirstRun() {
    firstRunOpen = false;
    if (modal) modal.classList.remove('server-first-run');
    var intro = document.getElementById('server-first-run-intro');
    var skip = document.getElementById('server-skip-first-run');
    if (intro) intro.hidden = true;
    if (skip) skip.hidden = true;
  }

  BOBO.settings = {
    init: ensureDOM,
    open: open,
    close: close,
    openFirstRun: openFirstRun,
    finishFirstRun: finishFirstRun,
    isFirstRunOpen: function() { return firstRunOpen; }
  };
})(window);
