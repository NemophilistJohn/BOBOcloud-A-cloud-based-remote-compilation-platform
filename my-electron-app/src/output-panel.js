// src/output-panel.js — Bottom panel with OUTPUT | TERMINAL tabs
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function initOutputPanel() {
    var tabs = document.querySelectorAll('#panel-tabs .panel-tab');
    var contents = document.querySelectorAll('#bottom-panel .panel-content');
    var clearBtn = document.getElementById('panel-clear');

    // Tab switching
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        var panelName = tab.getAttribute('data-panel');

        if (BOBO.workbench) BOBO.workbench.revealPanel();

        // Update active tab
        tabs.forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        // Show active content
        contents.forEach(function(c) { c.classList.remove('active'); });
        var panel = document.getElementById('panel-' + panelName);
        if (panel) panel.classList.add('active');

        S.activePanel = panelName;

        // Focus terminal input when switching to terminal
        if (panelName === 'terminal') {
          var input = document.getElementById('terminal-input');
          if (input) setTimeout(function() { input.focus(); }, 50);

          // Check docker status on first open
          if (BOBO.terminal && BOBO.terminal.checkDockerStatus) {
            BOBO.terminal.checkDockerStatus();
          }
        }
      });

      tab.addEventListener('keydown', function(event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        var visible = Array.prototype.filter.call(tabs, function(item) { return getComputedStyle(item).display !== 'none'; });
        var index = visible.indexOf(tab);
        if (index < 0) return;
        event.preventDefault();
        var next = visible[(index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
        next.focus();
        next.click();
      });
    });

    // Clear button
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        if (S.activePanel === 'output') {
          document.getElementById('run-log').textContent = '';
          S.runLogInitialized = true;
        } else if (S.activePanel === 'terminal') {
          if (BOBO.terminal && BOBO.terminal.clear) BOBO.terminal.clear();
          var termOut = document.getElementById('terminal-output');
          if (termOut) termOut.textContent = '';
        } else if (S.activePanel === 'debug') {
          if (BOBO.dap && BOBO.dap.clearConsole) BOBO.dap.clearConsole();
        }
      });
    }

  }

  BOBO.switchToPanel = function(panelName) {
    var tab = document.querySelector('#panel-tabs .panel-tab[data-panel="' + panelName + '"]');
    if (tab) tab.click();
  };

  // Kept for callers from older builds; geometry now belongs to BOBO.workbench.
  function setupOutputResizer() {
    if (BOBO.workbench) BOBO.workbench.init();
  }

  BOBO.outputPanel = {
    init: initOutputPanel,
    setupOutputResizer: setupOutputResizer
  };
})(window);
