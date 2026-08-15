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

  function loadLocalSettings() {
    // Theme selector
    var themeSelect = document.getElementById('settings-theme-select');
    if (themeSelect && window.themeManager) {
      var themes = window.themeManager.listThemes();
      themeSelect.innerHTML = '';
      for (var i = 0; i < themes.length; i++) {
        var opt = document.createElement('option');
        opt.value = themes[i].id;
        opt.textContent = themes[i].label;
        themeSelect.appendChild(opt);
      }
      themeSelect.value = window.themeManager.getCurrentTheme();
    }

    // Diagnostics
    var diagEnabled = document.getElementById('settings-diag-enabled');
    var diagMode = document.getElementById('settings-diag-mode');
    var ds = S.diagnosticsSettings;
    if (diagEnabled) diagEnabled.checked = !ds || ds.enabled !== false;
    if (diagMode) diagMode.value = (ds && ds.checkOn) ? ds.checkOn : 'type';
  }

  function saveLocalSettings() {
    // Theme
    var themeSelect = document.getElementById('settings-theme-select');
    if (themeSelect && window.themeManager) {
      window.themeManager.applyTheme(themeSelect.value);
      if (BOBO.toast) BOBO.toast.success('Theme: ' + themeSelect.options[themeSelect.selectedIndex].textContent);
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
    previousFocus = document.activeElement;
    loadLocalSettings();

    // Populate server fields if opening server tab
    if (tab === 'server') {
      // Trigger the existing population logic by dispatching the event
      // that app.js listens to. The app.js onOpenServerSettings handler
      // populates the server fields and shows the modal.
      // But since we're opening the settings modal, we need to populate
      // the fields ourselves.
      var ss = S.serverSettings || {};
      var el;
      el = document.getElementById('server-ip'); if (el) el.value = ss.ip || '';
      el = document.getElementById('server-user'); if (el) el.value = ss.user || '';
      el = document.getElementById('server-pass'); if (el) el.value = ss.pass || '';
      el = document.getElementById('server-apikey'); if (el) el.value = ss.apiKey || '';
	  el = document.getElementById('server-secure-transport'); if (el) el.checked = ss.secureTransport === true;
	  el = document.getElementById('server-http-port'); if (el) el.value = ss.httpPort || 3100;
	  el = document.getElementById('server-ws-port'); if (el) el.value = ss.wsPort || 3101;
	  el = document.getElementById('server-dap-child-port'); if (el) el.value = ss.dapChildWsPort || 3102;
	  el = document.getElementById('server-cert-fingerprint'); if (el) el.value = ss.certificateFingerprint || '';
      el = document.getElementById('rclone-path'); if (el) el.value = ss.rclonePath || '';
      var rcloneStatus = document.getElementById('rclone-status');
      if (rcloneStatus) {
        rcloneStatus.dataset.state = 'idle';
        rcloneStatus.textContent = BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t('Not checked') : 'Not checked';
        rcloneStatus.removeAttribute('title');
      }
      if (BOBO.rclone && BOBO.rclone.refreshStatus) {
        setTimeout(function() { BOBO.rclone.refreshStatus(ss.rclonePath || ''); }, 0);
      }
      var si = ss.syncInterval;
      el = document.getElementById('sync-interval');
      if (el) el.value = (!si) ? 30 : (si >= 1000 ? Math.round(si / 1000) : si);
    }

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
    open('server');
    setTimeout(function() {
      var input = document.getElementById('server-ip');
      if (input) input.focus();
    }, 40);
    return true;
  }

  function close() {
    if (firstRunOpen) return;
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
