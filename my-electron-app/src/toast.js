// src/toast.js - Lightweight toast notification system
// Usage: BOBO.toast.success('File saved'); BOBO.toast.error('Connection failed');
(function(global) {
  var BOBO = global.BOBO || {};

  var container = null;
  var TOAST_DURATION = 3500;

  function ensureContainer() {
    if (container) return;
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  function show(message, type) {
    ensureContainer();

    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'info');

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    if (BOBO.icons) {
      if (type === 'success') icon.innerHTML = BOBO.icons.check;
      else if (type === 'error') icon.innerHTML = BOBO.icons.close;
      else icon.innerHTML = BOBO.icons.cloud;
    }

    var msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(msg);
    container.appendChild(toast);

    var timer = setTimeout(function() { dismiss(toast); }, TOAST_DURATION);
    toast.addEventListener('click', function() {
      clearTimeout(timer);
      dismiss(toast);
    });
  }

  function dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add('removing');
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 150);
  }

  BOBO.toast = {
    success: function(msg) { show(msg, 'success'); },
    error: function(msg) { show(msg, 'error'); },
    info: function(msg) { show(msg, 'info'); }
  };
})(window);
