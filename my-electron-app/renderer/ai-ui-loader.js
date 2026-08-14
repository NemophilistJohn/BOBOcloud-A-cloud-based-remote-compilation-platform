// Compatibility loader for the lazy AI presentation bundle.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var loadPromise = null;
  var loaded = false;
  var chatInitPending = false;
  var settingsInitPending = false;

  function t(key) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key) : key;
  }

  function reportLoadFailure(error) {
    console.error('AI UI bundle:', error);
    if (BOBO.toast && BOBO.toast.error) BOBO.toast.error(t('Failed to load'));
  }

  function finishLoad(resolve, reject, script) {
    var chatPanel = BOBO.aiChatPanel;
    var settingsCenter = BOBO.aiSettingsCenter;
    if (chatPanel === chatProxy || settingsCenter === settingsProxy) {
      var registrationError = new Error('AI UI bundle did not register its public modules.');
      script.remove();
      reject(registrationError);
      return;
    }

    try {
      if (chatInitPending && chatPanel && chatPanel.init) chatPanel.init();
      if (settingsInitPending && settingsCenter && settingsCenter.init) settingsCenter.init();
      loaded = true;
      resolve({ chatPanel: chatPanel, settingsCenter: settingsCenter });
    } catch (error) {
      script.remove();
      reject(error);
    }
  }

  function ensureLoaded() {
    if (loaded) {
      return Promise.resolve({
        chatPanel: BOBO.aiChatPanel,
        settingsCenter: BOBO.aiSettingsCenter
      });
    }
    if (loadPromise) return loadPromise;

    var attempt = new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.src = './renderer-dist/bobo-ai-ui.js';
      script.async = true;
      script.dataset.boboAiUi = 'true';
      script.onload = function() { finishLoad(resolve, reject, script); };
      script.onerror = function() {
        script.remove();
        reject(new Error('AI UI bundle could not be loaded.'));
      };
      document.head.appendChild(script);
    });
    loadPromise = attempt.catch(function(error) {
      loadPromise = null;
      reportLoadFailure(error);
      throw error;
    });
    return loadPromise;
  }

  function invoke(kind, method, args) {
    return ensureLoaded().then(function() {
      var target = kind === 'chat' ? BOBO.aiChatPanel : BOBO.aiSettingsCenter;
      if (!target || target === chatProxy || target === settingsProxy || typeof target[method] !== 'function') {
        throw new Error('AI UI method is unavailable: ' + kind + '.' + method);
      }
      return target[method].apply(target, args);
    }).catch(function() { return undefined; });
  }

  var chatProxy = {
    init: function() { chatInitPending = true; },
    setVisible: function() { return invoke('chat', 'setVisible', arguments); },
    sendMessage: function() { return invoke('chat', 'sendMessage', arguments); },
    clearChat: function() { return invoke('chat', 'clearChat', arguments); },
    updateContextBar: function() { return invoke('chat', 'updateContextBar', arguments); },
    addReferencedFile: function() { return invoke('chat', 'addReferencedFile', arguments); },
    removeReferencedFile: function() { return invoke('chat', 'removeReferencedFile', arguments); },
    excludeAutoFileContext: function() { return invoke('chat', 'excludeAutoFileContext', arguments); },
    openFilePicker: function() { return invoke('chat', 'openFilePicker', arguments); },
    saveChatHistory: function() { return invoke('chat', 'saveChatHistory', arguments); }
  };

  var settingsProxy = {
    init: function() { settingsInitPending = true; },
    open: function() { return invoke('settings', 'open', arguments); },
    close: function() { return invoke('settings', 'close', arguments); },
    save: function() { return invoke('settings', 'save', arguments); },
    switchTab: function() { return invoke('settings', 'switchTab', arguments); },
    isDirty: function() { return false; },
    getDraft: function() { return null; }
  };

  BOBO.aiChatPanel = chatProxy;
  BOBO.aiSettingsCenter = settingsProxy;
  BOBO.aiUiLoader = {
    ensureLoaded: ensureLoaded,
    isLoaded: function() { return loaded; }
  };
})(window);
