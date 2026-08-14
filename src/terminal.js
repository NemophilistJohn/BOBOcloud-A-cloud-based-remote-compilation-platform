// src/terminal.js - Terminal functionality (embedded in bottom panel)
// Enhanced: ANSI color parsing, command history (up/down arrows), package-install detection
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var MAX_TERMINAL_LINES = 3000;
  var termLines = [];
  var pendingTermLines = [];
  var termFlushTimer = null;

  // Command history
  var cmdHistory = [];
  var historyIdx = -1;          // -1 = not browsing history

  // Patterns for commands that install packages -- these are replayed before runCode.
  var PACKAGE_CMD_RE = /^(\s*(sudo\s+)?(pip3?\s+install|python3?\s+-m\s+pip\s+install|npm\s+install|npx\s+install|yarn\s+add|cargo\s+(install|add)|go\s+(install|get)|apt(-get)?\s+install|gem\s+install|composer\s+(install|require)|mvn\s+(install|dependency:get))\b)/;

  function isPackageInstallCommand(cmd) {
    return PACKAGE_CMD_RE.test(cmd);
  }

  // ──── ANSI color parsing ────
  // Convert ANSI escape codes to HTML spans
  var ANSI_COLORS = {
    '0': '', '30': 'var(--text-tertiary)', '31': 'var(--red)', '32': 'var(--green)',
    '33': 'var(--yellow)', '34': 'var(--blue)', '35': 'var(--magenta, var(--purple))',
    '36': 'var(--cyan, var(--teal))', '37': 'var(--text-primary)',
    '90': 'var(--text-tertiary)', '91': 'var(--red)', '92': 'var(--green)',
    '93': 'var(--yellow)', '94': 'var(--blue)', '95': 'var(--magenta, var(--purple))',
    '96': 'var(--cyan, var(--teal))', '97': 'var(--text-primary)'
  };
  var ansiState = { color: '', bold: false, underline: false };

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function resetAnsiState() {
    ansiState = { color: '', bold: false, underline: false };
  }

  function applyAnsiCodes(rawCodes) {
    var codes = rawCodes === '' ? ['0'] : rawCodes.split(';');
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i] || '0';
      if (code === '0') resetAnsiState();
      else if (code === '1') ansiState.bold = true;
      else if (code === '4') ansiState.underline = true;
      else if (code === '22') ansiState.bold = false;
      else if (code === '24') ansiState.underline = false;
      else if (code === '39') ansiState.color = '';
      else if (ANSI_COLORS[code]) ansiState.color = ANSI_COLORS[code];
    }
  }

  function styleAnsiText(text) {
    // Cursor/control sequences do not have a useful representation in this
    // line-oriented terminal. Remove them before escaping the visible text.
    var visible = String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    if (!visible) return '';
    var html = escHtml(visible);
    var styles = [];
    if (ansiState.color) styles.push('color:' + ansiState.color);
    if (ansiState.bold) styles.push('font-weight:bold');
    if (ansiState.underline) styles.push('text-decoration:underline');
    return styles.length ? '<span style="' + styles.join(';') + '">' + html + '</span>' : html;
  }

  function parseAnsi(text) {
    var source = String(text);
    var html = '';
    var offset = 0;
    var match;
    var sgrPattern = /\x1b\[([0-9;]*)m/g;
    while ((match = sgrPattern.exec(source))) {
      html += styleAnsiText(source.slice(offset, match.index));
      applyAnsiCodes(match[1]);
      offset = match.index + match[0].length;
    }
    html += styleAnsiText(source.slice(offset));
    return html;
  }

  function getTermOutput() {
    return document.getElementById('terminal-output');
  }

  function flushTermLines() {
    var output = getTermOutput();
    if (termFlushTimer) clearTimeout(termFlushTimer);
    termFlushTimer = null;
    if (!output || pendingTermLines.length === 0) return;

    var fragment = document.createDocumentFragment();
    var batch = pendingTermLines;
    pendingTermLines = [];
    for (var i = 0; i < batch.length; i++) {
      var line = document.createElement('span');
      line.className = 'terminal-output-line';
      line.innerHTML = parseAnsi(batch[i]);
      line.appendChild(document.createTextNode('\n'));
      fragment.appendChild(line);
    }
    output.appendChild(fragment);

    while (output.childNodes.length > MAX_TERMINAL_LINES) {
      output.removeChild(output.firstChild);
    }
    output.scrollTop = output.scrollHeight;
  }

  function appendTermLine(msg) {
    var lines = String(msg).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) lines.push('');
    for (var i = 0; i < lines.length; i++) {
      termLines.push(lines[i]);
      pendingTermLines.push(lines[i]);
    }
    if (termLines.length > MAX_TERMINAL_LINES) {
      termLines.splice(0, termLines.length - MAX_TERMINAL_LINES);
    }
    if (pendingTermLines.length > MAX_TERMINAL_LINES) {
      var discarded = pendingTermLines.splice(0, pendingTermLines.length - MAX_TERMINAL_LINES);
      // Preserve terminal state even when old, not-yet-rendered rows are
      // discarded from a very large batch.
      for (var j = 0; j < discarded.length; j++) parseAnsi(discarded[j]);
    }
    if (!termFlushTimer) {
      termFlushTimer = setTimeout(flushTermLines, 100);
    }
  }

  function resetTerminalLines() {
    termLines = [];
    pendingTermLines = [];
    resetAnsiState();
    if (termFlushTimer) {
      clearTimeout(termFlushTimer);
      termFlushTimer = null;
    }
    var output = getTermOutput();
    if (output) output.textContent = '';
  }

  function checkDockerStatus() {
    var output = getTermOutput();
    BOBO.sendToServer('checkDocker').then(function(result) {
      if (result && result.success) {
        resetTerminalLines();
        appendTermLine('[Docker available - ' + result.message + ']');
      } else {
        var errMsg = result ? result.error : 'Cannot reach server';
        resetTerminalLines();
        if (errMsg.indexOf('daemon') !== -1 || errMsg.indexOf('systemctl') !== -1) {
          appendTermLine('[WARNING] Docker daemon is not running on the server.');
          appendTermLine('SSH into the server and run: systemctl start docker');
          appendTermLine('Server says: ' + errMsg);
        } else if (errMsg.indexOf('not installed') !== -1 || errMsg.indexOf('get.docker.com') !== -1) {
          appendTermLine('[WARNING] Docker is not installed on the server.');
          appendTermLine('SSH into the server and run: curl -fsSL https://get.docker.com | sh');
          appendTermLine('Server says: ' + errMsg);
        } else {
          appendTermLine('[WARNING] Docker is not available on the server.');
          appendTermLine('Terminal and Docker-based runtimes will NOT work.');
          appendTermLine('Please check Docker on the server.');
          appendTermLine('Error: ' + errMsg);
        }
      }
      flushTermLines();
    }).catch(function() {
      resetTerminalLines();
      appendTermLine('[Terminal ready - type a command and press Enter]');
      flushTermLines();
    });
  }

  function clearTerminal() {
    resetTerminalLines();
    S.setupCommands = [];
  }

  async function sendTerminalCommand() {
    var input = document.getElementById('terminal-input');
    var command = input.value.trim();
    if (!command) return;

    // Reset buffer if showing initial message
    if (termLines.length === 1 && (
        termLines[0].indexOf('[Terminal ready') !== -1 ||
        termLines[0].indexOf('[Docker available') !== -1 ||
        termLines[0].indexOf('[WARNING]') !== -1)) {
      resetTerminalLines();
    }

    appendTermLine('$ ' + command);
    flushTermLines();
    input.value = '';

    // Add to history
    cmdHistory.push(command);
    historyIdx = -1;

    var runtime = S.selectedRuntime || 'python:3.11';
    var result = await BOBO.sendToServer('terminal', { command: command, runtime: runtime });
    if (result) {
      if (result.error) {
        appendTermLine('[Server Error] ' + result.error);
      } else {
        if (result.stdout) appendTermLine(result.stdout);
        if (result.stderr) appendTermLine('[stderr] ' + result.stderr);
        if (!result.success && !result.stdout && !result.stderr) {
          appendTermLine('[Exit code: ' + (result.exitCode || '?') + ']');
        }
      }
    } else {
      appendTermLine('[Error] Failed to reach server (check server IP and network)');
    }
    flushTermLines();

    // Only successful package installs are replayed and announced to the
    // analyzer. Failed installs must not become permanent setup commands.
    if (isPackageInstallCommand(command) && result && !result.error && Number(result.exitCode || 0) === 0) {
      if (S.setupCommands.indexOf(command) === -1) S.setupCommands.push(command);
      if (BOBO.environmentActivity && typeof BOBO.environmentActivity.record === 'function') {
        BOBO.environmentActivity.record('install', { outcome: 'completed' });
      }
      if (BOBO.lsp && typeof BOBO.lsp.dependenciesChanged === 'function') {
        BOBO.lsp.dependenciesChanged();
      }
    }
  }

  function initTerminal() {
    var input = document.getElementById('terminal-input');

    if (input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          sendTerminalCommand();
        } else if (e.key === 'ArrowUp') {
          // Command history: go back
          e.preventDefault();
          if (cmdHistory.length === 0) return;
          if (historyIdx === -1) historyIdx = cmdHistory.length - 1;
          else if (historyIdx > 0) historyIdx--;
          input.value = cmdHistory[historyIdx] || '';
          // Move cursor to end
          setTimeout(function() { input.setSelectionRange(input.value.length, input.value.length); }, 0);
        } else if (e.key === 'ArrowDown') {
          // Command history: go forward
          e.preventDefault();
          if (historyIdx === -1) return;
          historyIdx++;
          if (historyIdx >= cmdHistory.length) {
            historyIdx = -1;
            input.value = '';
          } else {
            input.value = cmdHistory[historyIdx] || '';
          }
        }
      });
    }

    // Initial focus: clicking anywhere in terminal output focuses the input
    var termOutput = getTermOutput();
    if (termOutput) {
      termOutput.addEventListener('click', function() {
        var inp = document.getElementById('terminal-input');
        if (inp) inp.focus();
      });
    }
  }

  BOBO.terminal = {
    init: initTerminal,
    checkDockerStatus: checkDockerStatus,
    clear: clearTerminal,
    sendCommand: sendTerminalCommand,
    isPackageInstallCommand: isPackageInstallCommand
  };
})(window);
