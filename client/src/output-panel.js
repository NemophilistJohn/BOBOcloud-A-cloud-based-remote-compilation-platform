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

        if (BOBO.workbench) {
          if (panelName === 'debug' && BOBO.workbench.ensureBottomPanelSize) BOBO.workbench.ensureBottomPanelSize(300);
          else BOBO.workbench.revealPanel();
        }

        // Update active tab
        tabs.forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        // Show active content
        contents.forEach(function(c) { c.classList.remove('active'); });
        var panel = document.getElementById('panel-' + panelName);
        if (panel) panel.classList.add('active');

        S.activePanel = panelName;
        if (BOBO.runOutput && typeof BOBO.runOutput.setPanelActive === 'function') {
          BOBO.runOutput.setPanelActive(panelName === 'output');
        }

        // The terminal owns its own prompt and focus through xterm.js.
        if (panelName === 'terminal') {
          if (BOBO.terminal && BOBO.terminal.activate) {
            BOBO.terminal.activate();
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
          if (typeof BOBO.clearRunOutput === 'function') BOBO.clearRunOutput();
          else {
            document.getElementById('run-log').textContent = '';
            S.runLogInitialized = true;
            if (BOBO.runOutput && typeof BOBO.runOutput.clearTranscript === 'function') BOBO.runOutput.clearTranscript();
            else if (BOBO.runOutput && typeof BOBO.runOutput.clear === 'function') BOBO.runOutput.clear();
          }
        } else if (S.activePanel === 'terminal') {
          if (BOBO.terminal && BOBO.terminal.clear) BOBO.terminal.clear();
        } else if (S.activePanel === 'debug') {
          if (BOBO.dap && BOBO.dap.clearConsole) BOBO.dap.clearConsole();
        } else if (S.activePanel === 'problems') {
          if (BOBO.taskProblemMatcher && BOBO.taskProblemMatcher.clear) BOBO.taskProblemMatcher.clear();
        }
      });
    }

    if (BOBO.runOutput && typeof BOBO.runOutput.setPanelActive === 'function') {
      BOBO.runOutput.setPanelActive((S.activePanel || 'output') === 'output');
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
