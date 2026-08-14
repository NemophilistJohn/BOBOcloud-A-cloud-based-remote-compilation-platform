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

  function ensureDOM() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'confirm-dialog';

    var card = document.createElement('div');
    card.className = 'confirm-card';

    var body = document.createElement('div');
    body.className = 'confirm-body';

    titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';

    messageEl = document.createElement('div');
    messageEl.className = 'confirm-message';

    body.appendChild(titleEl);
    body.appendChild(messageEl);

    var foot = document.createElement('div');
    foot.className = 'confirm-foot';

    cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-btn confirm-btn-ghost';
    cancelBtn.onclick = function() { close(false); };

    confirmBtn = document.createElement('button');
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
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });

    document.body.appendChild(overlay);
  }

  function close(result) {
    if (!overlay || !resolveFn) return;
    overlay.classList.remove('open');
    var fn = resolveFn;
    resolveFn = null;
    // Wait for the exit animation, then resolve
    setTimeout(function() { fn(result); }, 150);
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

    overlay.classList.add('open');
    setTimeout(function() { confirmBtn.focus(); }, 50);

    return new Promise(function(resolve) { resolveFn = resolve; });
  }

  BOBO.confirm = confirm;
})(window);
