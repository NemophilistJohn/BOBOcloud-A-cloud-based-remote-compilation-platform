// src/ai-agent-button.js - status light: chat entry and compact AI controls
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var S = BOBO.state;
  var button = null;
  var lights = [];
  var menu = null;

  function t(key, params) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key, params) : String(key);
  }

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  function toggleChat(open) {
    if (typeof open !== 'boolean') open = !S.ai.chatOpen;
    S.ai.chatOpen = open;
    if (BOBO.workbench && BOBO.workbench.setAuxiliaryVisible) BOBO.workbench.setAuxiliaryVisible(open, { skipContent: true });
    if (BOBO.aiChatPanel && BOBO.aiChatPanel.setVisible) BOBO.aiChatPanel.setVisible(open);
    if (BOBO.aiService) BOBO.aiService.saveSettings();
  }

  function updateTitle() {
    if (!button) return;
    var model = BOBO.aiService && BOBO.aiService.getProfileFor ? BOBO.aiService.getProfileFor('chat') : null;
    var status = BOBO.aiService && BOBO.aiService.getModelStatus ? BOBO.aiService.getModelStatus(model, 'chat') : { code: 'ai.error.noModel' };
    button.setAttribute('title', t('AI chat - {model} - {status}', { model: model ? model.name : t('No model'), status: t(status.code) }));
    button.setAttribute('aria-label', t('ai.statusButton.aria'));
  }

  function updateLEDs(status) {
    lights.forEach(function(light) { light.className = 'ai-led ai-led-' + light.dataset.led; });
    if (status === 'idle' && lights[2]) lights[2].classList.add('ai-led-active');
    if ((status === 'thinking' || status === 'testing') && lights[1]) lights[1].classList.add('ai-led-thinking');
    if (status === 'error' && lights[0]) lights[0].classList.add('ai-led-error');
    updateTitle();
  }

  function option(select, model, selected) {
    var item = document.createElement('option');
    item.value = model.id;
    item.textContent = model.name;
    item.selected = model.id === selected;
    select.appendChild(item);
  }

  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'context-menu ai-menu ai-status-menu';
    menu.setAttribute('role', 'menu');

    var heading = document.createElement('div');
    heading.className = 'ai-menu-header';
    heading.textContent = t('ai.quickSettings');
    menu.appendChild(heading);

    var row = document.createElement('label');
    row.className = 'ai-menu-row';
    var label = document.createElement('span');
    label.className = 'ai-menu-label';
    label.textContent = t('ai.chatModel');
    var select = document.createElement('select');
    select.className = 'ai-compact-select';
    var profiles = S.ai.chatProfiles || [];
    var none = document.createElement('option');
    none.value = '';
    none.textContent = t('ai.control.value.none');
    none.selected = !S.ai.chatProfileId;
    select.appendChild(none);
    if (!profiles.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('ai.control.noProfiles');
      select.appendChild(empty);
      select.disabled = true;
    }
    profiles.forEach(function(profile) { option(select, profile, S.ai.chatProfileId); });
    select.addEventListener('change', async function() {
      var desired = select.value;
      select.disabled = true;
      try {
        var result = await BOBO.aiService.setProfileFor('chat', desired);
        select.value = S.ai.chatProfileId || '';
        if (!result || result.success === false) {
          var errorKey = result && (result.code || result.error) || 'ai.error.settingsWrite';
          if (BOBO.toast && BOBO.toast.error) BOBO.toast.error(t(errorKey));
        }
      } finally {
        select.disabled = false;
      }
    });
    row.append(label, select);
    menu.appendChild(row);

    var completion = document.createElement('label');
    completion.className = 'ai-menu-row ai-menu-toggle';
    var completionText = document.createElement('span');
    completionText.textContent = t('ai.inline.enable');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(S.ai.inline && S.ai.inline.enabled);
    checkbox.addEventListener('change', async function() {
      var desired = checkbox.checked;
      checkbox.disabled = true;
      try {
        var result = await BOBO.aiInline.setEnabled(desired);
        checkbox.checked = Boolean(S.ai.inline && S.ai.inline.enabled);
        if (!result || result.success === false) {
          var errorKey = result && (result.code || result.error) || 'ai.error.settingsWrite';
          if (BOBO.toast && BOBO.toast.error) BOBO.toast.error(t(errorKey));
        }
      } finally {
        checkbox.disabled = false;
      }
    });
    completion.append(completionText, checkbox);
    menu.appendChild(completion);

    var settings = document.createElement('button');
    settings.className = 'ai-menu-settings';
    settings.textContent = t('ai.openSettings');
    settings.addEventListener('click', function() {
      closeMenu();
      if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open();
    });
    menu.appendChild(settings);
    document.body.appendChild(menu);

    var rect = button.getBoundingClientRect();
    menu.style.left = Math.max(6, rect.right - menu.offsetWidth) + 'px';
    menu.style.top = Math.max(6, rect.top - menu.offsetHeight - 6) + 'px';
    setTimeout(function() { document.addEventListener('pointerdown', closeOnOutside, true); }, 0);
  }

  function closeOnOutside(event) {
    if (menu && !menu.contains(event.target) && event.target !== button) {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      closeMenu();
    }
  }

  function createButton() {
    var right = document.querySelector('#statusbar .status-right');
    if (!right) return null;
    var separator = document.createElement('span');
    separator.className = 'status-sep';
    right.appendChild(separator);
    var element = document.createElement('button');
    element.type = 'button';
    element.className = 'status-item clickable ai-agent-btn';
    element.dataset.aiBtn = 'true';
    var label = document.createElement('span');
    label.className = 'ai-btn-label';
    label.textContent = 'AI';
    element.appendChild(label);
    ['red', 'yellow', 'green'].forEach(function(color) {
      var light = document.createElement('span');
      light.className = 'ai-led ai-led-' + color;
      light.dataset.led = color;
      light.setAttribute('aria-hidden', 'true');
      lights.push(light);
      element.appendChild(light);
    });
    element.addEventListener('click', function() { closeMenu(); toggleChat(); });
    element.addEventListener('contextmenu', function(event) { event.preventDefault(); openMenu(); });
    right.appendChild(element);
    return element;
  }

  function init() {
    button = createButton();
    updateLEDs(S.ai.status);
    if (global.api && global.api.onOpenAiSettings) {
      global.api.onOpenAiSettings(function() { if (BOBO.aiSettingsCenter) BOBO.aiSettingsCenter.open(); });
    }
    setTimeout(function() { if (S.ai.chatOpen) toggleChat(true); }, 300);
  }

  BOBO.aiAgentButton = {
    init: init,
    updateLEDs: updateLEDs,
    toggleChat: toggleChat,
    openMenu: openMenu,
    closeMenu: closeMenu
  };
})(window);
