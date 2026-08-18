// src/confirm-dialog.js - Custom confirm dialog replacing native confirm()
// Returns a Promise<boolean>: true = confirm, false = cancel.
// Usage: var ok = await BOBO.confirm({ title, message, confirmLabel, danger });
(function(global) {
  var BOBO = global.BOBO || {};

  var overlay = null;
  var titleEl = null;
  var messageEl = null;
  var confirmBtn = null;
  var cancelBtn = null;
  var resolveFn = null;
  var previouslyFocused = null;

  function ensureDOM() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'confirm-dialog';
    overlay.setAttribute('aria-hidden', 'true');

    var card = document.createElement('div');
    card.className = 'confirm-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'confirm-dialog-title');
    card.setAttribute('aria-describedby', 'confirm-dialog-message');

    var body = document.createElement('div');
    body.className = 'confirm-body';

    titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.id = 'confirm-dialog-title';

    messageEl = document.createElement('div');
    messageEl.className = 'confirm-message';
    messageEl.id = 'confirm-dialog-message';

    body.appendChild(titleEl);
    body.appendChild(messageEl);

    var foot = document.createElement('div');
    foot.className = 'confirm-foot';

    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-btn confirm-btn-ghost';
    cancelBtn.onclick = function() { close(false); };

    confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.onclick = function() { close(true); };

    foot.appendChild(cancelBtn);
    foot.appendChild(confirmBtn);

    card.appendChild(body);
    card.appendChild(foot);
    overlay.appendChild(card);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close(false);
    });
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        var focusable = [cancelBtn, confirmBtn];
        var current = document.activeElement;
        var index = focusable.indexOf(current);
        if (e.shiftKey && (index <= 0 || current !== cancelBtn)) {
          e.preventDefault();
          confirmBtn.focus();
        } else if (!e.shiftKey && (index === -1 || current === confirmBtn)) {
          e.preventDefault();
          cancelBtn.focus();
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });

    document.body.appendChild(overlay);
  }

  function close(result) {
    if (!overlay || !resolveFn) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    var fn = resolveFn;
    resolveFn = null;
    // Wait for the exit animation, then resolve
    setTimeout(function() {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      previouslyFocused = null;
      fn(result);
    }, 150);
  }

  function confirm(options) {
    ensureDOM();
    options = options || {};

    titleEl.textContent = options.title || 'Confirm';
    messageEl.textContent = options.message || '';

    confirmBtn.textContent = options.confirmLabel || 'Confirm';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';

    confirmBtn.className = 'confirm-btn ' +
      (options.danger ? 'confirm-btn-danger' : 'confirm-btn-primary');

    previouslyFocused = document.activeElement;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('open');
    setTimeout(function() { confirmBtn.focus(); }, 50);

    return new Promise(function(resolve) { resolveFn = resolve; });
  }

  BOBO.confirm = confirm;
})(window);
