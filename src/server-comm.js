// src/server-comm.js - Server HTTP/WebSocket communication
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── Output logging (bounded, batched DOM appends + colored prefixes) ────
  var MAX_OUTPUT_LINES = 5000;
  var pendingOutputLines = [];
  var outputFlushTimer = null;
  var outputFlushThreshold = 50;
  var renderedOutputCount = 0;

  function localizeServerError(message) {
    if (!message) return message;
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(String(message)) : String(message);
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function colorSpan(text, cssVar) {
    return '<span style="color:' + cssVar + ';font-weight:bold">' + text + '</span>';
  }

  // Compiler error location patterns for different languages.
  // Each entry: [regex, fileCaptureGroup, lineCaptureGroup]
  var ERROR_PATTERNS = [
    // GCC/Clang/C/Cpp: file.c:10:5: error  or  file.c:10: error
    [/(^|[^\w/.])([\w][\w/.\-]*\.(?:c|cpp|cc|cxx|h|hpp)):(\d+)(?::\d+)?/g, 2, 3],
    // Java: Main.java:10: error
    [/(^|[^\w/.])([\w][\w/.\-]*\.java):(\d+)(?::\d+)?/g, 2, 3],
    // Rust: --> src/main.rs:10:5  (after escHtml, > becomes &gt;)
    [/--&gt;\s*([\w][\w/.\-]*\.rs):(\d+):(\d+)/g, 1, 2],
    // Python: File "main.py", line 10 (quotes have already been escaped)
    [/File &quot;([\w][\w/\.\-]*\.py)&quot;, line (\d+)/g, 1, 2],
    // Go: main.go:10:5: error
    [/(^|[^\w/.])([\w][\w/.\-]*\.go):(\d+)(?::\d+)?/g, 2, 3],
  ];

  function linkifyErrorPaths(html) {
    for (var i = 0; i < ERROR_PATTERNS.length; i++) {
      var pat = ERROR_PATTERNS[i][0];
      var fileGroup = ERROR_PATTERNS[i][1];
      var lineGroup = ERROR_PATTERNS[i][2];
      html = html.replace(pat, function() {
        var match = arguments[0];
        var file = arguments[fileGroup];
        var line = arguments[lineGroup];
        if (!file || !line) return match;
        var cleanFile = file.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        var prefix = match.substring(0, match.indexOf(file));
        var suffix = match.substring(match.indexOf(file) + file.length);
        return prefix +
          '<a class="err-link" data-file="' + cleanFile + '" data-line="' + line + '" ' +
          'style="color:var(--blue);text-decoration:underline;cursor:pointer">' + file + '</a>' +
          suffix;
      });
    }
    return html;
  }

  // Colorize the prefix of a message line - only the keyword/tag, not the whole line.
  // Also detects compiler error file:line patterns and makes them clickable.
  function colorizeMessage(msg) {
    var raw = escHtml(msg);
    var linkified = linkifyErrorPaths(raw);

    // Error: red
    if (/^\[(Error|Server Error)\]/.test(raw) || /^Error[: ]/.test(raw)) {
      var m = raw.match(/^(\[?(?:Error|Server Error)\]?:?)/);
      return colorSpan(m[1], 'var(--red)') + linkified.slice(m[0].length);
    }
    // Warnings: yellow
    if (/^\[WARNING\]/.test(raw) || /^Warning[: ]/.test(raw)) {
      var m = raw.match(/^(\[WARNING\]|Warning:?)/);
      return colorSpan(m[1], 'var(--yellow)') + linkified.slice(m[0].length);
    }
    // Setup / Docker stages: blue
    if (/^\[(setup|docker|docker:pull)\]/.test(raw)) {
      var m = raw.match(/^(\[(?:setup|docker|docker:pull)\]\s*)/);
      return colorSpan(m[1], 'var(--blue)') + linkified.slice(m[0].length);
    }
    // Run stages: green
    if (/^\[run:/.test(raw)) {
      var m = raw.match(/^(\[run:[^\]]+\]\s*)/);
      return colorSpan(m[1], 'var(--green)') + linkified.slice(m[0].length);
    }
    // Stderr: yellow prefix + linkified body
    if (/^\[stderr\]/.test(raw)) {
      var body = linkified.slice('[stderr] '.length);
      return colorSpan('[stderr] ', 'var(--yellow)') + body;
    }
    // Artifacts / saved: blue
    if (/^(Saved figure|Artifacts)/.test(raw)) {
      var m = raw.match(/^(Saved figure:|Artifacts)/);
      return colorSpan(m[1], 'var(--blue)') + linkified.slice(m[0].length);
    }
    // Terminal prompt: blue
    if (/^\$ /.test(raw)) {
      return colorSpan('$ ', 'var(--blue)') + linkified.slice(2);
    }

    return linkified;
  }

  function flushOutputLines() {
    var outputEl = document.getElementById('run-log');
    var containerEl = document.getElementById('panel-output');
    outputFlushTimer = null;
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
      return;
    }
    if (!outputEl || pendingOutputLines.length === 0) return;

    var wasAtBottom = !containerEl ||
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < 50;
    var batch = pendingOutputLines;
    pendingOutputLines = [];
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < batch.length; i++) {
      var line = document.createElement('span');
      line.className = 'run-output-line';
      // colorizeMessage escapes remote output before adding known markup.
      line.innerHTML = colorizeMessage(batch[i]);
      line.appendChild(document.createTextNode('\n'));
      fragment.appendChild(line);
    }
    outputEl.appendChild(fragment);

    while (outputEl.childNodes.length > MAX_OUTPUT_LINES) {
      outputEl.removeChild(outputEl.firstChild);
    }
    renderedOutputCount = outputEl.childNodes.length;

    // Click delegation for compiler error links (bound once)
    if (!outputEl._errLinkBound) {
      outputEl._errLinkBound = true;
      outputEl.addEventListener('click', function(e) {
        var link = e.target.closest('.err-link');
        if (!link) return;
        e.preventDefault();
        var file = link.getAttribute('data-file');
        var line = parseInt(link.getAttribute('data-line'), 10);
        if (!file) return;
        var sep = BOBO.isWindows ? '\\' : '/';
        var fullPath = file;
        if (S.workspaceRoot && file.indexOf(':') !== 1) {
          fullPath = S.workspaceRoot + sep + file.replace(/\//g, sep);
        }
        var name = file.split(/[/\\]/).pop();
        if (BOBO.workspace && BOBO.workspace.openFile) {
          BOBO.workspace.openFile(fullPath, name).then(function() {
            if (S.editor && line > 0) {
              S.editor.revealLineInCenter(line);
              S.editor.setPosition({ lineNumber: line, column: 1 });
            }
          });
        }
      });
    }

    if (containerEl && (wasAtBottom || S.autoScrollEnabled)) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  function scheduleOutputFlush() {
    if (outputFlushTimer) return;
    outputFlushTimer = setTimeout(flushOutputLines, 200);
  }

  BOBO.updateRunOutput = function(message) {
    var outputEl = document.getElementById('run-log');
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
    }
    if (!S.runSessionTimestamp) {
      S.runSessionTimestamp = new Date().toLocaleTimeString();
    }
    if (!S.runLogInitialized) {
      pendingOutputLines = [];
      var initialOutput = document.getElementById('run-log');
      if (initialOutput) initialOutput.textContent = '';
      renderedOutputCount = 0;
      S.runLogInitialized = true;
    }
    var prefix = S.showTimestampNextLine ? '[' + S.runSessionTimestamp + '] ' : '';
    S.showTimestampNextLine = false;
    var messageLines = String(message).replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < messageLines.length; i++) {
      pendingOutputLines.push((i === 0 ? prefix : '') + messageLines[i]);
    }
    if (pendingOutputLines.length > MAX_OUTPUT_LINES) {
      pendingOutputLines.splice(0, pendingOutputLines.length - MAX_OUTPUT_LINES);
    }

    // Render the first line immediately so an external clear cannot race an
    // invisible initial batch; subsequent high-volume output stays batched.
    if (renderedOutputCount === 0 || pendingOutputLines.length >= outputFlushThreshold) {
      if (outputFlushTimer) { clearTimeout(outputFlushTimer); outputFlushTimer = null; }
      flushOutputLines();
    } else {
      scheduleOutputFlush();
    }
  };

  BOBO.clearRunOutput = function() {
    pendingOutputLines = [];
    if (outputFlushTimer) { clearTimeout(outputFlushTimer); outputFlushTimer = null; }
    var outputEl = document.getElementById('run-log');
    if (outputEl) outputEl.textContent = '';
    renderedOutputCount = 0;
    S.runLogInitialized = true;
    S.runSessionTimestamp = new Date().toLocaleTimeString();
    S.showTimestampNextLine = true;
  };

  // ──── HTTP communication ────
  // opts.quiet: 不把错误写入输出面板、返回 {success:false,error} 而非 null（供登录等 UI 场景使用）
  BOBO.sendToServer = async function(action, data, opts) {
    opts = opts || {};
    data = data || {};
    if (!S.serverSettings.ip) {
      if (opts.quiet) return { success: false, error: 'Server IP not configured' };
      BOBO.updateRunOutput('Error: Server IP not configured');
      return null;
    }
    var url = BOBO.serverTransport && BOBO.serverTransport.endpoint
      ? BOBO.serverTransport.endpoint(S.serverSettings, 'http')
      : 'http://' + S.serverSettings.ip + ':3100';
    var payload = { action: action };
    // merge data into payload
    for (var k in data) {
      if (data.hasOwnProperty(k)) payload[k] = data[k];
    }
    try {
      var headers = { 'Content-Type': 'application/json' };
      // 多人模式优先使用登录会话 token；否则回退到设置中的 API Key
      if (S.auth && S.auth.token) {
        headers['Authorization'] = 'Bearer ' + S.auth.token;
      } else if (S.serverSettings.apiKey) {
        headers['Authorization'] = 'Bearer ' + S.serverSettings.apiKey;
      }
      var response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
      var result = await response.json();
      if (!response.ok) {
        if (response.status === 429 && !opts.quiet) {
          BOBO.updateRunOutput('Rate limit exceeded - please slow down');
        }
        // 已有 token 被服务端拒绝 -> 凭证过期/被吊销，触发重新登录
        if (response.status === 401 && S.auth && S.auth.token && BOBO.auth) {
          BOBO.auth.handleAuthExpired();
        }
        var errMsg = localizeServerError(result && result.error ? result.error : 'HTTP ' + response.status);
        if (opts.quiet) {
          return Object.assign({}, result || {}, {
            success: false,
            error: errMsg,
            status: response.status
          });
        }
        throw new Error(errMsg);
      }
      if (result && result.error) {
        return Object.assign({}, result, { error: localizeServerError(result.error) });
      }
      return result;
    } catch (error) {
      var localizedError = localizeServerError(error.message);
      if (opts.quiet) return { success: false, error: localizedError };
      BOBO.updateRunOutput('Error communicating with server: ' + localizedError);
      return null;
    }
  };
})(window);
