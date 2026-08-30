// src/server-comm.js - Server HTTP/WebSocket communication
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // ──── Output logging (bounded, batched DOM appends + colored prefixes) ────
  var MAX_OUTPUT_LINES = 5000;
  var MAX_DETAIL_LINES = 300;
  var pendingOutputLines = [];
  var outputFlushTimer = null;
  var outputFlushThreshold = 50;
  var renderedOutputCount = 0;
  var renderedProgramCount = 0;
  var renderedDetailCount = 0;
  var omittedProgramCount = 0;

  function localizeServerError(message) {
    if (!message) return message;
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(String(message)) : String(message);
  }

  function invalidResponseMessage(response, body) {
    if (/Client sent an HTTP request to an HTTPS server/i.test(String(body || ''))) {
      return localizeServerError('The server requires HTTPS, but secure transport is disabled in Server Settings.');
    }
    return localizeServerError('The server returned an invalid response. Check the server address and transport setting.');
  }

  function retryAfterSeconds(response) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') return 0;
    var raw = response.headers.get('Retry-After');
    var seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
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

  function normalizeOutputKind(options) {
    return options && options.kind === 'detail' ? 'detail' : 'program';
  }

  function trimPendingKind(kind, limit) {
    var count = 0;
    var removed = 0;
    for (var i = 0; i < pendingOutputLines.length; i++) {
      if (pendingOutputLines[i].kind === kind) count += 1;
    }
    for (var index = 0; count > limit && index < pendingOutputLines.length;) {
      if (pendingOutputLines[index].kind === kind) {
        pendingOutputLines.splice(index, 1);
        count -= 1;
        removed += 1;
      } else {
        index += 1;
      }
    }
    return removed;
  }

  function removeOldestRendered(outputEl, kind) {
    for (var i = 0; i < outputEl.childNodes.length; i++) {
      var child = outputEl.childNodes[i];
      if (child && child.getAttribute && child.getAttribute('data-output-kind') === kind) {
        outputEl.removeChild(child);
        return true;
      }
    }
    return false;
  }

  function outputText(source, replacements) {
    if (BOBO.i18n && typeof BOBO.i18n.t === 'function') return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function updateOmissionMarker(outputEl) {
    if (!outputEl) return;
    var marker = null;
    for (var i = 0; i < outputEl.childNodes.length; i++) {
      var child = outputEl.childNodes[i];
      if (child && child.getAttribute && child.getAttribute('data-output-omission') === 'true') {
        marker = child;
        break;
      }
    }
    if (omittedProgramCount <= 0) {
      if (marker) outputEl.removeChild(marker);
      return;
    }
    if (!marker) {
      marker = document.createElement('span');
      marker.className = 'run-output-omission';
      marker.setAttribute('data-output-kind', 'notice');
      marker.setAttribute('data-output-omission', 'true');
      if (typeof outputEl.insertBefore === 'function') outputEl.insertBefore(marker, outputEl.firstChild);
      else outputEl.appendChild(marker);
    }
    marker.textContent = outputText('Earlier output omitted: {count} lines (latest {limit} kept).', {
      count: omittedProgramCount,
      limit: MAX_OUTPUT_LINES
    });
  }

  function flushOutputLines() {
    var outputEl = document.getElementById('run-log');
    var containerEl = document.getElementById('panel-output');
    outputFlushTimer = null;
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
      renderedProgramCount = 0;
      renderedDetailCount = 0;
      omittedProgramCount = 0;
      return;
    }
    if (!outputEl || pendingOutputLines.length === 0) return;

    var wasAtBottom = !containerEl ||
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < 50;
    var batch = pendingOutputLines;
    pendingOutputLines = [];
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < batch.length; i++) {
      var record = batch[i];
      var line = document.createElement('span');
      line.className = 'run-output-line' + (record.kind === 'detail' ? ' run-output-detail' : '');
      line.setAttribute('data-output-kind', record.kind);
      if (record.stage) line.setAttribute('data-output-stage', record.stage);
      if (record.raw && record.raw !== record.text) {
        line.setAttribute('title', record.raw);
        line.setAttribute('aria-label', record.raw);
        line.setAttribute('tabindex', '0');
      }
      // colorizeMessage escapes remote output before adding known markup.
      line.innerHTML = colorizeMessage(record.text);
      line.appendChild(document.createTextNode('\n'));
      fragment.appendChild(line);
      if (record.kind === 'detail') renderedDetailCount += 1;
      else renderedProgramCount += 1;
    }
    outputEl.appendChild(fragment);

    while (renderedProgramCount > MAX_OUTPUT_LINES && removeOldestRendered(outputEl, 'program')) {
      renderedProgramCount -= 1;
      omittedProgramCount += 1;
    }
    while (renderedDetailCount > MAX_DETAIL_LINES && removeOldestRendered(outputEl, 'detail')) {
      renderedDetailCount -= 1;
    }
    updateOmissionMarker(outputEl);
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

  BOBO.updateRunOutput = function(message, options) {
    var outputEl = document.getElementById('run-log');
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
      renderedProgramCount = 0;
      renderedDetailCount = 0;
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
    var kind = normalizeOutputKind(options);
    var stage = options && options.stage ? String(options.stage) : '';
    var raw = options && options.raw ? String(options.raw) : '';
    var messageLines = String(message).replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < messageLines.length; i++) {
      pendingOutputLines.push({
        text: (i === 0 ? prefix : '') + messageLines[i],
        kind: kind,
        stage: stage,
        raw: raw
      });
    }
    omittedProgramCount += trimPendingKind('program', MAX_OUTPUT_LINES);
    trimPendingKind('detail', MAX_DETAIL_LINES);

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
    renderedProgramCount = 0;
    renderedDetailCount = 0;
    omittedProgramCount = 0;
    S.runLogInitialized = true;
    S.runSessionTimestamp = new Date().toLocaleTimeString();
    S.showTimestampNextLine = true;
    if (BOBO.runOutput && typeof BOBO.runOutput.clearTranscript === 'function') {
      BOBO.runOutput.clearTranscript();
    }
  };

  BOBO.clearRunOutputDetails = function() {
    pendingOutputLines = pendingOutputLines.filter(function(record) { return record.kind !== 'detail'; });
    var outputEl = document.getElementById('run-log');
    if (outputEl) {
      for (var i = outputEl.childNodes.length - 1; i >= 0; i--) {
        var child = outputEl.childNodes[i];
        if (child && child.getAttribute && child.getAttribute('data-output-kind') === 'detail') {
          outputEl.removeChild(child);
        }
      }
      renderedOutputCount = outputEl.childNodes.length;
    }
    renderedDetailCount = 0;
  };

  BOBO.refreshRunOutputOmission = function() {
    updateOmissionMarker(document.getElementById('run-log'));
  };

  // ──── HTTP communication ────
  // opts.quiet: 不把错误写入输出面板、返回 {success:false,error} 而非 null（供登录等 UI 场景使用）
  // opts.timeoutMs: abort the underlying fetch after the requested deadline.
  // opts.signal: allow a caller to cancel superseded requests.
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
    var timeoutMs = Number(opts.timeoutMs || 0);
    var externalSignal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
    var abortController = (timeoutMs > 0 || externalSignal) && typeof global.AbortController === 'function'
      ? new global.AbortController()
      : null;
    var timeoutHandle = null;
    var didTimeout = false;
    var didCancel = false;
    var externalAbortHandler = null;
    if (externalSignal && abortController) {
      externalAbortHandler = function() {
        didCancel = true;
        abortController.abort();
      };
      if (externalSignal.aborted) externalAbortHandler();
      else if (typeof externalSignal.addEventListener === 'function') externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
    if (abortController) {
      timeoutHandle = setTimeout(function() {
        didTimeout = true;
        abortController.abort();
      }, timeoutMs);
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
        body: JSON.stringify(payload),
        signal: abortController ? abortController.signal : externalSignal || undefined
      });
      // Reverse proxies and TLS listeners can return plain text or HTML. Never
      // leak a JSON parser exception into the workspace/sync workflow.
      var result;
      if (typeof response.text === 'function') {
        var body = await response.text();
        try {
          result = JSON.parse(body);
        } catch (parseError) {
          var responseError = invalidResponseMessage(response, body);
          if (opts.quiet) {
            return { success: false, error: responseError, status: response.status, errorCode: 'invalid_server_response' };
          }
          throw new Error(responseError);
        }
      } else {
        // Compatibility with lightweight test doubles and older fetch shims.
        result = await response.json();
      }
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
          var failure = Object.assign({}, result || {}, {
            success: false,
            error: errMsg,
            status: response.status
          });
          var retrySeconds = retryAfterSeconds(response);
          if (retrySeconds) failure.retryAfterSeconds = retrySeconds;
          return failure;
        }
        throw new Error(errMsg);
      }
      if (result && result.error) {
        return Object.assign({}, result, { error: localizeServerError(result.error) });
      }
      return result;
    } catch (error) {
      if (didTimeout) {
        var timeoutError = localizeServerError('The server request timed out.');
        if (opts.quiet) return { success: false, error: timeoutError, errorCode: 'transport_timeout' };
        BOBO.updateRunOutput('Error communicating with server: ' + timeoutError);
        return null;
      }
      if (didCancel || externalSignal && externalSignal.aborted) {
        var cancelError = localizeServerError('The server request was cancelled.');
        if (opts.quiet) return { success: false, error: cancelError, errorCode: 'transport_cancelled' };
        return null;
      }
      var localizedError = localizeServerError(error.message);
      if (opts.quiet) return { success: false, error: localizedError };
      BOBO.updateRunOutput('Error communicating with server: ' + localizedError);
      return null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (externalSignal && externalAbortHandler && typeof externalSignal.removeEventListener === 'function') externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  };
})(window);
