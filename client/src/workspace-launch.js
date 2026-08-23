// src/workspace-launch.js - Capture workspace-open requests before the editor is ready.
(function(global) {
  var BOBO = global.BOBO = global.BOBO || {};
  var consumer = null;
  var pending = [];
  var draining = null;
  var requestPromise = null;
  var initialized = false;

  function setBusy(busy) {
    ['open-folder', 'empty-state-open'].forEach(function(id) {
      var button = document.getElementById(id);
      if (!button) return;
      button.disabled = Boolean(busy);
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  function report(error) {
    console.error('workspace launch:', error);
  }

  function updateBusy() {
    setBusy(Boolean(requestPromise || draining || pending.length));
  }

  function drain() {
    if (draining) return draining;
    if (typeof consumer !== 'function' || pending.length === 0) return Promise.resolve();
    draining = Promise.resolve().then(async function() {
      while (typeof consumer === 'function' && pending.length > 0) {
        await consumer(pending.shift());
      }
    }).catch(report).finally(function() {
      draining = null;
      updateBusy();
      if (typeof consumer === 'function' && pending.length > 0) drain();
    });
    updateBusy();
    return draining;
  }

  function accept(opened) {
    if (!opened) return Promise.resolve(false);
    pending.push(opened);
    updateBusy();
    return drain().then(function() { return true; });
  }

  function requestOpen(directoryPath) {
    if (requestPromise) return requestPromise;
    if (draining || pending.length) return drain().then(function() { return true; });
    if (!global.api || typeof global.api.pickWorkspace !== 'function') return Promise.resolve(false);
    setBusy(true);
    requestPromise = global.api.pickWorkspace(directoryPath)
      .then(accept)
      .catch(function(error) {
        report(error);
        return false;
      })
      .finally(function() {
        requestPromise = null;
        updateBusy();
      });
    return requestPromise;
  }

  function setConsumer(nextConsumer) {
    consumer = typeof nextConsumer === 'function' ? nextConsumer : null;
    updateBusy();
    return drain();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    ['open-folder', 'empty-state-open'].forEach(function(id) {
      var button = document.getElementById(id);
      if (!button) return;
      button.addEventListener('click', function() { requestOpen(); });
    });
    if (global.api && typeof global.api.onWorkspaceOpened === 'function') {
      global.api.onWorkspaceOpened(function(opened) { accept(opened); });
    }
  }

  BOBO.workspaceLaunch = {
    init: init,
    requestOpen: requestOpen,
    setConsumer: setConsumer,
    whenIdle: function() { return drain(); }
  };

  init();
})(window);
