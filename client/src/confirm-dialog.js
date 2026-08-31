// src/confirm-dialog.js - Custom confirm dialog replacing native confirm()
// Returns a Promise<boolean> by default. Set returnDetails to receive
// { confirmed, checkboxChecked } when an optional checkboxLabel is supplied.
// Usage: var ok = await BOBO.confirm({ title, message, confirmLabel, danger });
(function(global) {
  var BOBO = global.BOBO || {};

  var overlay = null;
  var titleEl = null;
  var messageEl = null;
  var optionEl = null;
  var optionInput = null;
  var optionText = null;
  var confirmBtn = null;
  var cancelBtn = null;
  var activeRequest = null;
  var pendingRequests = [];
  var closing = false;

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

    optionEl = document.createElement('label');
    optionEl.className = 'confirm-option';
    optionEl.hidden = true;
    optionInput = document.createElement('input');
    optionInput.type = 'checkbox';
    optionText = document.createElement('span');
    optionEl.appendChild(optionInput);
    optionEl.appendChild(optionText);

    body.appendChild(titleEl);
    body.appendChild(messageEl);
    body.appendChild(optionEl);

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
        var focusable = optionEl.hidden ? [cancelBtn, confirmBtn] : [optionInput, cancelBtn, confirmBtn];
        var current = document.activeElement;
        var index = focusable.indexOf(current);
        if (e.shiftKey && index <= 0) {
          e.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!e.shiftKey && (index === -1 || index === focusable.length - 1)) {
          e.preventDefault();
          focusable[0].focus();
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });

    document.body.appendChild(overlay);
  }

  function showNext() {
    if (activeRequest || closing || pendingRequests.length === 0) return;
    activeRequest = pendingRequests.shift();
    var options = activeRequest.options;

    titleEl.textContent = options.title || 'Confirm';
    messageEl.textContent = options.message || '';

    var checkboxLabel = String(options.checkboxLabel || '').trim();
    optionEl.hidden = !checkboxLabel;
    optionInput.checked = Boolean(checkboxLabel && options.checkboxChecked === true);
    optionText.textContent = checkboxLabel;

    confirmBtn.textContent = options.confirmLabel || 'Confirm';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';
    confirmBtn.className = 'confirm-btn ' +
      (options.danger ? 'confirm-btn-danger' : 'confirm-btn-primary');

    activeRequest.previouslyFocused = document.activeElement;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('open');
    var request = activeRequest;
    setTimeout(function() {
      if (activeRequest === request && !closing) confirmBtn.focus();
    }, 50);
  }

  function close(result) {
    if (!overlay || !activeRequest || closing) return;
    closing = true;
    var request = activeRequest;
    var response = result;
    if (request.options.returnDetails === true) {
      response = {
        confirmed: result === true,
        checkboxChecked: Boolean(!optionEl.hidden && optionInput.checked)
      };
    }
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    activeRequest = null;
    optionEl.hidden = true;
    optionInput.checked = false;
    optionText.textContent = '';
    // Wait for the exit animation, then resolve
    setTimeout(function() {
      if (request.previouslyFocused && typeof request.previouslyFocused.focus === 'function') {
        request.previouslyFocused.focus();
      }
      closing = false;
      request.resolve(response);
      showNext();
    }, 150);
  }

  function confirm(options) {
    ensureDOM();
    var requestOptions = options && typeof options === 'object'
      ? Object.assign({}, options)
      : {};
    return new Promise(function(resolve) {
      pendingRequests.push({ options: requestOptions, resolve: resolve, previouslyFocused: null });
      showNext();
    });
  }

  BOBO.confirm = confirm;
})(window);
