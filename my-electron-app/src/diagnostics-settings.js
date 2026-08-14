// src/diagnostics-settings.js - Diagnostics (red/yellow) settings modal.
// Lets the user enable/disable each check and choose its severity, like VSCode's
// settings. Changes are persisted to diagnostics-settings.json (via main process)
// and applied live to every open editor model.
(function (global) {
  'use strict';
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  function t(source) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(source) : source;
  }

  function bindText(element, source) {
    if (!element) return;
    if (BOBO.i18n && BOBO.i18n.bindText) BOBO.i18n.bindText(element, source);
    else element.textContent = t(source);
  }

  function bindAttribute(element, attribute, source) {
    if (!element) return;
    if (BOBO.i18n && BOBO.i18n.bindAttribute) BOBO.i18n.bindAttribute(element, attribute, source);
    else element.setAttribute(attribute, t(source));
  }

  // Catalog of every configurable check. Order = display order.
  // hasLength: show a maxLineLength input next to the toggle.
  var CHECK_CATALOG = [
    { id: 'missingSemicolon',      label: 'Missing semicolon',          desc: 'Statements without a terminating ; (C / C++ / Java). Uses a real tokenizer, so for/if/while headers are not flagged.' },
    { id: 'strayTokens',           label: 'Stray / unexpected tokens',  desc: 'Invalid tokens at file scope (bare numbers, operators, unknown chars) and stray characters.' },
    { id: 'unmatchedBrackets',     label: 'Unmatched brackets',         desc: 'Mismatched or unclosed ( ) [ ] { }.' },
    { id: 'unclosedStrings',       label: 'Unclosed strings',           desc: 'String / char literals not closed on the same line.' },
    { id: 'assignmentInCondition', label: 'Assignment in condition',    desc: '= used inside an if / while condition (likely meant ==).' },
    { id: 'unsafeFunctions',       label: 'Unsafe functions',           desc: 'gets(), scanf("%s") without field width, and similar.' },
    { id: 'trailingWhitespace',    label: 'Trailing whitespace',        desc: 'Spaces or tabs at the end of a line.' },
    { id: 'mixedIndent',           label: 'Mixed tabs & spaces',        desc: 'File mixes tab and space indentation.' },
    { id: 'longLines',             label: 'Long lines',                 desc: 'Lines exceeding the length limit.', hasLength: true },
    { id: 'todoComments',          label: 'TODO / FIXME / HACK',        desc: 'Highlight task markers in comments.' },
    { id: 'cppModernize',          label: 'C++ modernization',          desc: 'NULL → nullptr, C-style casts → static_cast.' },
    { id: 'styleHints',            label: 'Language style hints',       desc: 'Python / Java / Rust / Go best-practice nits (bare except, unwrap, raw types...).' }
  ];

  var SEVERITIES = [
    { value: 'error',   label: 'Error',   cls: 'err' },
    { value: 'warning', label: 'Warning', cls: 'warn' },
    { value: 'info',    label: 'Info',    cls: 'info' },
    { value: 'hint',    label: 'Hint',    cls: 'hint' }
  ];

  function defaults() {
    var reg = global.editorRuleRegistry;
    return reg ? JSON.parse(JSON.stringify(reg.DEFAULT_DIAGNOSTICS_SETTINGS)) : null;
  }

  function getChecks() {
    var s = S.diagnosticsSettings;
    if (s && s.checks) return s.checks;
    var d = defaults();
    return d ? d.checks : {};
  }

  // ─── render ───
  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function makeToggle(checked) {
    var lbl = el('label', 'diag-toggle');
    var inp = el('input');
    inp.type = 'checkbox';
    inp.checked = !!checked;
    var sl = el('span', 'slider');
    lbl.appendChild(inp);
    lbl.appendChild(sl);
    return { wrap: lbl, input: inp };
  }

  function makeSeverity(value) {
    var sel = el('select', 'diag-sev-select');
    SEVERITIES.forEach(function (sv) {
      var o = el('option');
      o.value = sv.value;
      o.textContent = t(sv.label);
      if (sv.value === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.className = 'diag-sev-select ' + sevCls(value);
    sel.addEventListener('change', function () {
      sel.className = 'diag-sev-select ' + sevCls(sel.value);
    });
    return sel;
  }
  function sevCls(v) {
    var m = { error: 'err', warning: 'warn', info: 'info', hint: 'hint' };
    return m[v] || 'warn';
  }

  function render(draftSettings) {
    var body = document.getElementById('diag-body');
    if (!body) return;
    body.innerHTML = '';

    var s = draftSettings || S.diagnosticsSettings || defaults();
    var checks = draftSettings && draftSettings.checks ? draftSettings.checks : getChecks();

    // ── General section ──
    var sec1 = el('div');
    var sl1 = el('div', 'ss-section-label'); sl1.textContent = t('General');
    sec1.appendChild(sl1);

    // master enable
    var rowEnabled = el('div', 'diag-global-row');
    var tgE = makeToggle(s.enabled !== false);
    var labE = el('span', 'diag-label'); labE.textContent = t('Enable diagnostics');
    labE.style.flex = '1';
    rowEnabled.appendChild(labE);
    rowEnabled.appendChild(tgE.wrap);
    sec1.appendChild(rowEnabled);

    // check on
    var rowOn = el('div', 'diag-global-row');
    var labOn = el('span', 'diag-label'); labOn.textContent = t('Check on'); labOn.style.flex = '1';
    var selOn = el('select', 'ss-input'); selOn.style.width = 'auto';
    [['type', 'While typing (debounced)'], ['save', 'On save only']].forEach(function (opt) {
      var o = el('option'); o.value = opt[0]; o.textContent = t(opt[1]);
      if (opt[0] === (s.checkOn || 'type')) o.selected = true;
      selOn.appendChild(o);
    });
    rowOn.appendChild(labOn); rowOn.appendChild(selOn);
    sec1.appendChild(rowOn);

    // debounce
    var rowDb = el('div', 'diag-global-row');
    var labDb = el('span', 'diag-label'); labDb.textContent = t('Debounce (ms)'); labDb.style.flex = '1';
    var inpDb = el('input', 'ss-input'); inpDb.type = 'number'; inpDb.min = '0'; inpDb.max = '5000'; inpDb.step = '50';
    inpDb.value = (s.debounceMs != null ? s.debounceMs : 300);
    rowDb.appendChild(labDb); rowDb.appendChild(inpDb);
    sec1.appendChild(rowDb);

    body.appendChild(sec1);

    // ── Checks section ──
    var sec2 = el('div');
    var sl2 = el('div', 'ss-section-label'); sl2.textContent = t('Checks');
    sec2.appendChild(sl2);

    var lengthInputs = {};
    CHECK_CATALOG.forEach(function (c) {
      var cfg = checks[c.id] || { enabled: true, severity: 'warning' };
      var row = el('div', 'diag-row');

      var left = el('div'); left.style.flex = '1';
      var lab = el('span', 'diag-label'); lab.textContent = t(c.label);
      left.appendChild(lab);
      if (c.desc) {
        var d = el('span', 'diag-desc'); d.textContent = t(c.desc);
        left.appendChild(d);
      }
      row.appendChild(left);

      if (c.hasLength) {
        var inpLen = el('input', 'ss-input'); inpLen.type = 'number'; inpLen.min = '20'; inpLen.max = '1000';
        inpLen.value = cfg.maxLineLength || 120;
        inpLen.style.width = '80px';
        inpLen.title = t('Max line length');
        lengthInputs[c.id] = inpLen;
        row.appendChild(inpLen);
      }

      var sel = makeSeverity(cfg.severity || 'warning');
      sel.dataset.checkId = c.id;
      row.appendChild(sel);

      var tg = makeToggle(cfg.enabled !== false);
      tg.input.dataset.checkId = c.id;
      row.appendChild(tg.wrap);

      sec2.appendChild(row);
    });

    body.appendChild(sec2);

    // stash controls for save
    S._diagForm = {
      enabled: tgE.input, checkOn: selOn, debounceMs: inpDb,
      lengthInputs: lengthInputs
    };
  }

  function collect() {
    var form = S._diagForm;
    if (!form) return null;
    var debounceMs = parseInt(form.debounceMs.value, 10);
    if (!Number.isFinite(debounceMs)) debounceMs = 300;
    debounceMs = Math.max(0, Math.min(5000, debounceMs));
    var out = {
      enabled: form.enabled.checked,
      checkOn: form.checkOn.value,
      debounceMs: debounceMs,
      checks: {}
    };
    var checkboxes = document.querySelectorAll('.diag-toggle input[data-check-id]');
    var selects = document.querySelectorAll('.diag-sev-select[data-check-id]');
    var sevById = {};
    selects.forEach(function (sel) { sevById[sel.dataset.checkId] = sel.value; });
    checkboxes.forEach(function (cb) {
      var id = cb.dataset.checkId;
      var entry = { enabled: cb.checked, severity: sevById[id] || 'warning' };
      if (form.lengthInputs[id]) entry.maxLineLength = parseInt(form.lengthInputs[id].value, 10) || 120;
      out.checks[id] = entry;
    });
    return out;
  }

  function open() {
    render();
    var m = document.getElementById('diag-modal');
    if (m) m.style.display = 'flex';
  }
  function close() {
    var m = document.getElementById('diag-modal');
    if (m) m.style.display = 'none';
  }

  async function save() {
    var cfg = collect();
    if (!cfg) { close(); return; }
    try {
      await global.api.writeDiagnosticsSettings(cfg);
      S.diagnosticsSettings = cfg;
      var reg = global.editorRuleRegistry;
      if (reg) reg.setDiagnosticsSettings(cfg);
      if (BOBO.editorCore && BOBO.editorCore.recheckAll) BOBO.editorCore.recheckAll();
    } catch (e) {
      console.error('diagnostics save failed:', e);
    }
    close();
  }

  function resetDefaults() {
    var d = defaults();
    if (!d) return;
    S.diagnosticsSettings = d;
    render();
  }

  function bindStaticText() {
    bindText(document.querySelector('#diag-modal .ss-title'), 'Diagnostics Settings');
    bindText(document.getElementById('diag-reset'), 'Reset to Defaults');
    bindText(document.getElementById('diag-close'), 'Cancel');
    bindText(document.getElementById('diag-save'), 'Save & Re-check');
    bindAttribute(document.getElementById('diag-close-x'), 'title', 'Close');
  }

  function init() {
    bindStaticText();
    // buttons
    var saveBtn = document.getElementById('diag-save');
    var cancelBtn = document.getElementById('diag-close');
    var closeX = document.getElementById('diag-close-x');
    var resetBtn = document.getElementById('diag-reset');
    if (saveBtn) saveBtn.addEventListener('click', save);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (closeX) closeX.addEventListener('click', close);
    if (resetBtn) resetBtn.addEventListener('click', resetDefaults);

    // click backdrop to close
    var modal = document.getElementById('diag-modal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    // open via IPC (menu) - but app.js also wires it; guard against double
    if (global.api && typeof global.api.onOpenDiagnosticsSettings === 'function') {
      global.api.onOpenDiagnosticsSettings(function () { open(); });
    }
    global.addEventListener('bobo:language-changed', function () {
      bindStaticText();
      var modal = document.getElementById('diag-modal');
      if (modal && modal.style.display === 'flex') render(collect());
    });
  }

  BOBO.diagnosticsSettings = { init: init, open: open, close: close };
})(window);
