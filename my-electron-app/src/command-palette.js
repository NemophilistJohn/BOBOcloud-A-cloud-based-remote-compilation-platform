// src/command-palette.js - Quick command launcher (Ctrl+Shift+P)
(function(global) {
  var BOBO = global.BOBO || {};

  var overlay = null;
  var input = null;
  var list = null;
  var commands = [];
  var selectedIndex = 0;
  var filtered = [];

  function ensureDOM() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';

    var palette = document.createElement('div');
    palette.className = 'cmd-palette';

    var inputWrap = document.createElement('div');
    inputWrap.className = 'cmd-input-wrap';
    input = document.createElement('input');
    input.className = 'cmd-input';
    input.placeholder = 'Type a command...';
    inputWrap.appendChild(input);

    list = document.createElement('div');
    list.className = 'cmd-list';

    palette.appendChild(inputWrap);
    palette.appendChild(list);
    overlay.appendChild(palette);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) hide();
    });
    input.addEventListener('input', function() { filter(); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigate(-1); }
      if (e.key === 'Enter') { e.preventDefault(); executeSelected(); }
    });

    document.body.appendChild(overlay);
  }

  function register(id, label, hint, category, handler) {
    commands.push({ id: id, label: label, hint: hint || '', category: category || 'General', handler: handler });
  }

  function filter() {
    var q = input.value.toLowerCase().trim();
    filtered = [];
    for (var i = 0; i < commands.length; i++) {
      if (!q || commands[i].label.toLowerCase().indexOf(q) !== -1 || commands[i].id.indexOf(q) !== -1) {
        filtered.push(commands[i]);
      }
    }
    selectedIndex = 0;
    render();
  }

  function render() {
    list.innerHTML = '';
    if (filtered.length === 0) {
      list.innerHTML = '<div class="cmd-empty">No matching commands</div>';
      return;
    }
    for (var i = 0; i < filtered.length; i++) {
      (function(item, idx) {
        var el = document.createElement('div');
        el.className = 'cmd-item' + (idx === selectedIndex ? ' selected' : '');
        el.innerHTML =
          '<span class="cmd-category">' + item.category + '</span>' +
          '<span class="cmd-label">' + item.label + '</span>' +
          (item.hint ? '<span class="cmd-hint">' + item.hint + '</span>' : '');
        el.addEventListener('click', function() { selectedIndex = idx; executeSelected(); });
        list.appendChild(el);
      })(filtered[i], i);
    }
  }

  function navigate(dir) {
    if (filtered.length === 0) return;
    selectedIndex += dir;
    if (selectedIndex < 0) selectedIndex = filtered.length - 1;
    if (selectedIndex >= filtered.length) selectedIndex = 0;
    render();
  }

  function executeSelected() {
    if (filtered.length === 0 || selectedIndex >= filtered.length) return;
    var cmd = filtered[selectedIndex];
    hide();
    if (cmd.handler) cmd.handler();
  }

  function show() {
    ensureDOM();
    input.value = '';
    filter();
    overlay.classList.add('open');
    setTimeout(function() { input.focus(); }, 50);
  }

  function hide() {
    if (overlay) overlay.classList.remove('open');
  }

  BOBO.commands = {
    register: register,
    show: show,
    hide: hide
  };
})(window);
