// src/run-output.js - Structured presentation for cloud run lifecycle events.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  var activeRun = null;
  var runSequence = 0;
  var initialized = false;
  var panelActive = true;
  var detailsVisible = false;
  var MAX_DETAIL_BADGE = 300;
  var cachedElements = null;
  var CACHED_ELEMENT_KEYS = ['summary', 'title', 'phase', 'meta', 'toggle', 'count', 'log'];

  var PHASE_LABELS = {
    preparing: 'Preparing',
    syncing: 'Synchronizing workspace',
    runtime: 'Starting runtime',
    dependencies: 'Resolving dependencies',
    workspace: 'Preparing workspace',
    container: 'Starting container',
    compiling: 'Compiling',
    running: 'Running',
    artifacts: 'Collecting results',
    analysis: 'Updating analysis environment',
    completed: 'Run completed',
    failed: 'Run failed',
    stopped: 'Run stopped'
  };

  function tr(source, replacements) {
    if (BOBO.i18n && typeof BOBO.i18n.t === 'function') return BOBO.i18n.t(source, replacements);
    return String(source).replace(/\{([^}]+)\}/g, function(match, key) {
      return replacements && replacements[key] !== undefined ? replacements[key] : match;
    });
  }

  function elements() {
    var needsRefresh = !cachedElements;
    for (var index = 0; !needsRefresh && index < CACHED_ELEMENT_KEYS.length; index += 1) {
      var current = cachedElements[CACHED_ELEMENT_KEYS[index]];
      needsRefresh = !current || current.isConnected === false;
    }
    if (needsRefresh) {
      cachedElements = {
        summary: document.getElementById('run-summary'),
        title: document.getElementById('run-summary-title'),
        phase: document.getElementById('run-summary-phase'),
        meta: document.getElementById('run-summary-meta'),
        toggle: document.getElementById('run-details-toggle'),
        count: document.getElementById('run-details-count'),
        log: document.getElementById('run-log')
      };
    }
    return cachedElements;
  }

  function selectedRuntimeLabel() {
    if (!document.querySelector) return '';
    var label = document.querySelector('#runtime-btn .runtime-label');
    return label ? String(label.textContent || '').trim() : '';
  }

  function phaseLabel(phase) {
    return tr(PHASE_LABELS[phase] || PHASE_LABELS.preparing);
  }

  function formatDuration(durationMs) {
    var value = Math.max(0, Number(durationMs) || 0);
    if (value < 1000) return tr('{duration} ms', { duration: Math.round(value) });
    var seconds = value / 1000;
    return tr('{duration} s', { duration: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) });
  }

  function resultMeta(run) {
    var parts = [];
    if (run.runtime) parts.push(run.runtime);
    if (Number.isInteger(run.returnCode)) parts.push(tr('Exit code {code}', { code: run.returnCode }));
    if (run.finishedAt) parts.push(formatDuration(run.finishedAt - run.startedAt));
    return parts.join('  |  ');
  }

  function runningMeta(run) {
    return run.runtime || tr('Started at {time}', { time: run.startedLabel });
  }

  function updateToggle(elementsValue) {
    var toggle = elementsValue.toggle;
    if (!toggle) return;
    toggle.hidden = !activeRun || !panelActive;
    toggle.setAttribute('aria-expanded', detailsVisible ? 'true' : 'false');
    toggle.setAttribute('aria-label', tr(detailsVisible ? 'Hide run details' : 'Show run details'));
    toggle.setAttribute('title', tr(detailsVisible ? 'Hide run details' : 'Show run details'));
    if (elementsValue.count) {
      elementsValue.count.textContent = activeRun && activeRun.detailCount
        ? (activeRun.detailCount > MAX_DETAIL_BADGE ? MAX_DETAIL_BADGE + '+' : String(activeRun.detailCount))
        : '';
      elementsValue.count.hidden = !(activeRun && activeRun.detailCount);
    }
  }

  function sessionMatches(sessionId) {
    return sessionId === undefined || Boolean(activeRun && activeRun.id === sessionId);
  }

  function render() {
    var el = elements();
    if (!el.summary) return;
    el.summary.hidden = !activeRun;
    if (!activeRun) {
      updateToggle(el);
      return;
    }

    el.summary.dataset.state = activeRun.state;
    if (el.title) {
      el.title.textContent = activeRun.target;
      el.title.title = activeRun.target;
    }
    if (el.phase) {
      var phaseText = activeRun.reasonSource ? tr(activeRun.reasonSource) : (activeRun.reason || phaseLabel(activeRun.phase));
      el.phase.textContent = phaseText;
      el.phase.title = phaseText;
    }
    if (el.meta) el.meta.textContent = activeRun.finishedAt ? resultMeta(activeRun) : runningMeta(activeRun);
    if (el.log) el.log.classList.toggle('show-run-details', detailsVisible);
    updateToggle(el);
  }

  function setDetailsVisible(visible) {
    detailsVisible = Boolean(visible && activeRun);
    render();
  }

  function begin(options) {
    options = options || {};
    if (typeof BOBO.clearRunOutputDetails === 'function') BOBO.clearRunOutputDetails();
    var now = Date.now();
    activeRun = {
      id: ++runSequence,
      target: String(options.target || options.label || tr('Cloud run')),
      runtime: String(options.runtime || selectedRuntimeLabel()),
      state: 'running',
      phase: 'preparing',
      reason: '',
      reasonSource: '',
      returnCode: null,
      startedAt: now,
      startedLabel: new Date(now).toLocaleTimeString(),
      finishedAt: 0,
      detailCount: 0
    };
    detailsVisible = false;
    render();
    detail(tr('Preparing run: {target}', { target: activeRun.target }), { stage: 'client' });
    return activeRun.id;
  }

  function detail(message, options) {
    options = options || {};
    if (!sessionMatches(options.sessionId)) return false;
    if (!activeRun) return false;
    if (activeRun.finishedAt) return false;
    var updatesDetailCount = !(options.streamFragment === true && (options.append === true || options.replace === true));
    if (updatesDetailCount) {
      activeRun.detailCount += 1;
    }
    BOBO.updateRunOutput(message, Object.assign({}, options, {
      kind: 'detail',
      stage: options.stage || '',
      raw: options.raw || ''
    }));
    if (updatesDetailCount) updateToggle(elements());
    return true;
  }

  function phase(name, message, options) {
    options = options || {};
    if (!sessionMatches(options.sessionId)) return false;
    if (!activeRun || activeRun.finishedAt) return false;
    if (PHASE_LABELS[name]) activeRun.phase = name;
    activeRun.reason = '';
    activeRun.reasonSource = '';
    render();
    if (message) detail(message, options);
    return true;
  }

  function conciseStageMessage(stage) {
    if (stage.indexOf('run:') === 0) {
      return '[' + stage + '] ' + tr('Program process started.');
    }
    if (stage.indexOf('compile:') === 0) {
      return '[' + stage + '] ' + tr('Compiler process started.');
    }
    return '';
  }

  function handleStatus(payload, sessionId) {
    payload = payload || {};
    var stage = String(payload.stage || '').toLowerCase();
    var message = String(payload.message || '');
    var nextPhase = 'preparing';

    if (stage === 'cache') nextPhase = 'dependencies';
    else if (stage === 'analysis') nextPhase = 'analysis';
    else if (stage === 'docker') nextPhase = /artifact|recycl/i.test(message) ? 'artifacts' : 'container';
    else if (stage === 'setup') nextPhase = /runtime/i.test(message) ? 'runtime' : 'workspace';
    else if (stage.indexOf('compile:') === 0) nextPhase = 'compiling';
    else if (stage.indexOf('run:') === 0 || stage.indexOf('task:') === 0) nextPhase = 'running';
    else if (stage.indexOf('artifact:') === 0 || stage === 'target') nextPhase = 'artifacts';
    else if (stage === 'plan' || stage === 'task') nextPhase = 'compiling';

    var concise = conciseStageMessage(stage);
    return phase(nextPhase, concise || message, { stage: stage, raw: concise ? message : '', sessionId: sessionId });
  }

  function finish(options) {
    options = options || {};
    if (!sessionMatches(options.sessionId)) return false;
    if (!activeRun || activeRun.finishedAt) return false;
    var cancelled = options.cancelled === true;
    var success = options.success === true && !cancelled;
    var hasReturnCode = options.returnCode !== null && options.returnCode !== undefined && options.returnCode !== '';
    var returnCode = hasReturnCode ? Number(options.returnCode) : NaN;

    activeRun.finishedAt = Date.now();
    activeRun.returnCode = Number.isInteger(returnCode) ? returnCode : null;
    activeRun.state = cancelled ? 'stopped' : (success ? 'completed' : 'failed');
    activeRun.phase = activeRun.state;
    activeRun.reason = String(options.message || '');
    activeRun.reasonSource = '';
    if (!activeRun.reason && !cancelled && !success && activeRun.returnCode === 137) {
      activeRun.reasonSource = 'Process was forcibly terminated (exit code 137). It may have exceeded a resource limit or been stopped.';
    }
    render();
    return true;
  }

  function clear() {
    activeRun = null;
    detailsVisible = false;
    var el = elements();
    if (el.summary) el.summary.hidden = true;
    if (el.log) el.log.classList.remove('show-run-details');
    updateToggle(el);
  }

  function clearTranscript() {
    if (!activeRun || activeRun.finishedAt) {
      clear();
      return;
    }
    activeRun.detailCount = 0;
    detailsVisible = false;
    render();
  }

  function setPanelActive(value) {
    panelActive = value !== false;
    updateToggle(elements());
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var toggle = document.getElementById('run-details-toggle');
    if (toggle) toggle.addEventListener('click', function() { setDetailsVisible(!detailsVisible); });
    if (BOBO.i18n && typeof BOBO.i18n.onChange === 'function') BOBO.i18n.onChange(function() {
      render();
      if (typeof BOBO.refreshRunOutputOmission === 'function') BOBO.refreshRunOutputOmission();
    });
    render();
  }

  BOBO.runOutput = {
    init: init,
    begin: begin,
    detail: detail,
    phase: phase,
    handleStatus: handleStatus,
    finish: finish,
    clear: clear,
    clearTranscript: clearTranscript,
    isActive: function(sessionId) { return Boolean(activeRun && !activeRun.finishedAt && sessionMatches(sessionId)); },
    setDetailsVisible: setDetailsVisible,
    setPanelActive: setPanelActive
  };
})(window);
