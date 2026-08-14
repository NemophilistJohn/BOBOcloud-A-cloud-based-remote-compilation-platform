// theme-manager.js - BOBOCLOUD Editor Theme System
// Redesigned: each theme defines a core palette; buildTokens() generates
// the full CSS variable set. Custom Monaco themes match each palette.
(function(global) {
  var STORAGE_KEY = 'bobocloud.theme';

  // ── Helpers ──
  function rgba(hexStr, alpha) {
    var r = parseInt(hexStr.slice(1, 3), 16);
    var g = parseInt(hexStr.slice(3, 5), 16);
    var b = parseInt(hexStr.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function hexRaw(hexStr) { return hexStr.replace('#', ''); }

  // ── Theme Palettes ──
  // Each defines ~20 core colors. buildTokens() derives the full 40+ set.
  var palettes = {
    'cloud-forge': {
      label: 'Cloud Forge',
      isDark: true,
      bgDeep: '#101311', bgSurface: '#171b18', bgElevated: '#202521',
      bgHover: '#29302b', bgActive: '#343c36',
      textPrimary: '#edf0ed', textSecondary: '#9aa39c', textTertiary: '#6f7972',
      brand: '#d8a63f', brandHover: '#e8b955', brandPressed: '#bd8623',
      blue: '#6aa9d6', green: '#56b87a', red: '#e45d5d',
      yellow: '#d8a63f', orange: '#d98245', purple: '#aa8ed6',
      borderColor: '#a8b5aa', shadowColor: '#000000',
      statusbarBg: '#101311', statusbarText: '#9aa39c',
      monacoBase: 'vs-dark'
    },
    light: {
      label: 'Light',
      isDark: false,
      bgDeep: '#ffffff', bgSurface: '#f6f8fa', bgElevated: '#ffffff',
      bgHover: '#eaeef2', bgActive: '#d8dee4',
      textPrimary: '#1f2328', textSecondary: '#656d76', textTertiary: '#8c959f',
      brand: '#bc8c00', brandHover: '#d29922', brandPressed: '#9a7400',
      blue: '#0969da', green: '#1a7f37', red: '#cf222e',
      yellow: '#bf8700', orange: '#bc4c00', purple: '#8250df',
      borderColor: '#1f2328', shadowColor: '#000000',
      statusbarBg: '#f6f8fa', statusbarText: '#656d76',
      monacoBase: 'vs'
    },
    nord: {
      label: 'Nord',
      isDark: true,
      bgDeep: '#2E3440', bgSurface: '#3B4252', bgElevated: '#434C5E',
      bgHover: '#4C566A', bgActive: '#5E6779',
      textPrimary: '#ECEFF4', textSecondary: '#D8DEE9', textTertiary: '#939AA8',
      brand: '#88C0D0', brandHover: '#9BCCDA', brandPressed: '#76B4C6',
      blue: '#81A1C1', green: '#A3BE8C', red: '#BF616A',
      yellow: '#EBCB8B', orange: '#D08770', purple: '#B48EAD',
      borderColor: '#D8DEE9', shadowColor: '#000000',
      statusbarBg: '#2E3440', statusbarText: '#D8DEE9',
      monacoBase: 'vs-dark'
    },
    monokai: {
      label: 'Monokai',
      isDark: true,
      bgDeep: '#272822', bgSurface: '#2D2E27', bgElevated: '#3E3D32',
      bgHover: '#49483E', bgActive: '#5C5B4E',
      textPrimary: '#F8F8F2', textSecondary: '#C8C8BF', textTertiary: '#9A9A8E',
      brand: '#A6E22E', brandHover: '#B6F23E', brandPressed: '#8FC01E',
      blue: '#66D9EF', green: '#A6E22E', red: '#F92672',
      yellow: '#E6DB74', orange: '#FD971F', purple: '#AE81FF',
      borderColor: '#F8F8F2', shadowColor: '#000000',
      statusbarBg: '#272822', statusbarText: '#C8C8BF',
      monacoBase: 'vs-dark'
    },
    dracula: {
      label: 'Dracula',
      isDark: true,
      bgDeep: '#282A36', bgSurface: '#343746', bgElevated: '#44475A',
      bgHover: '#565B70', bgActive: '#686D88',
      textPrimary: '#F8F8F2', textSecondary: '#C5C8D6', textTertiary: '#9698B0',
      brand: '#BD93F9', brandHover: '#CAA9FA', brandPressed: '#A678E8',
      blue: '#8BE9FD', green: '#50FA7B', red: '#FF5555',
      yellow: '#F1FA8C', orange: '#FFB86C', purple: '#BD93F9',
      borderColor: '#F8F8F2', shadowColor: '#000000',
      statusbarBg: '#282A36', statusbarText: '#C5C8D6',
      monacoBase: 'vs-dark'
    }
  };

  // ── Build full CSS token set from a palette ──
  function buildTokens(p) {
    var sa = p.isDark ? 0.3 : 0.08;
    var tokens = {
      // Background layers
      '--bg-deep': p.bgDeep, '--bg-surface': p.bgSurface, '--bg-elevated': p.bgElevated,
      '--bg-hover': p.bgHover, '--bg-active': p.bgActive,
      // Text
      '--text-primary': p.textPrimary, '--text-secondary': p.textSecondary, '--text-tertiary': p.textTertiary,
      // Brand
      '--brand': p.brand, '--brand-hover': p.brandHover, '--brand-pressed': p.brandPressed,
      '--brand-muted': rgba(p.brand, 0.12), '--brand-border': rgba(p.brand, 0.30),
      // Semantic
      '--blue': p.blue, '--blue-muted': rgba(p.blue, 0.12),
      '--green': p.green, '--green-muted': rgba(p.green, 0.12),
      '--red': p.red, '--red-muted': rgba(p.red, 0.12),
      '--yellow': p.yellow, '--yellow-muted': rgba(p.yellow, 0.12),
      '--orange': p.orange, '--purple': p.purple,
      // Borders
      '--border-subtle': rgba(p.borderColor, 0.06),
      '--border-default': rgba(p.borderColor, 0.10),
      '--border-strong': rgba(p.borderColor, 0.18),
      // Shadows
      '--shadow-sm': '0 1px 3px ' + rgba(p.shadowColor, sa),
      '--shadow-md': '0 4px 12px ' + rgba(p.shadowColor, sa + 0.1),
      '--shadow-lg': '0 16px 48px ' + rgba(p.shadowColor, sa + 0.2),
      '--shadow-xl': '0 24px 64px ' + rgba(p.shadowColor, sa + 0.3),
      // Status bar
      '--statusbar-bg': p.statusbarBg, '--statusbar-text': p.statusbarText,
      '--statusbar-accent': p.brand, '--statusbar-border': rgba(p.borderColor, 0.10),
      // Panel tabs
      '--panel-tab-active-bg': p.bgDeep, '--panel-tab-active-border': p.brand,
      // Legacy aliases (for inline styles in JS code)
      '--bg': p.bgDeep, '--panel': p.bgSurface,
      '--text': p.textPrimary, '--text-dim': p.textSecondary,
      '--accent': p.bgHover, '--accent-hover': p.bgActive,
      '--border': rgba(p.borderColor, 0.10),
      '--shadow': '0 4px 12px ' + rgba(p.shadowColor, sa + 0.1)
    };
    return tokens;
  }

  // ── Define a custom Monaco theme matching the palette ──
  function defineMonacoTheme(monaco, themeId, p) {
    var h = hexRaw;
    monaco.editor.defineTheme(themeId, {
      base: p.monacoBase,
      inherit: true,
      rules: [
        { token: '', foreground: h(p.textPrimary) },
        { token: 'comment', foreground: h(p.textTertiary), fontStyle: 'italic' },
        { token: 'keyword', foreground: h(p.brand) },
        { token: 'keyword.control', foreground: h(p.purple) },
        { token: 'operator', foreground: h(p.textSecondary) },
        { token: 'string', foreground: h(p.green) },
        { token: 'string.escape', foreground: h(p.orange) },
        { token: 'number', foreground: h(p.orange) },
        { token: 'regexp', foreground: h(p.orange) },
        { token: 'function', foreground: h(p.blue) },
        { token: 'type', foreground: h(p.yellow) },
        { token: 'type.identifier', foreground: h(p.yellow) },
        { token: 'variable', foreground: h(p.textPrimary) },
        { token: 'variable.predefined', foreground: h(p.orange) },
        { token: 'variable.language', foreground: h(p.brand) },
        { token: 'constant', foreground: h(p.orange) },
        { token: 'delimiter', foreground: h(p.textSecondary) },
        { token: 'delimiter.bracket', foreground: h(p.textSecondary) },
        { token: 'tag', foreground: h(p.red) },
        { token: 'attribute.name', foreground: h(p.yellow) },
        { token: 'attribute.value', foreground: h(p.green) },
        { token: 'namespace', foreground: h(p.textSecondary) },
        { token: 'metatag', foreground: h(p.orange) },
        { token: 'annotation', foreground: h(p.yellow) },
      ],
      colors: {
        'editor.background': p.bgDeep,
        'editor.foreground': p.textPrimary,
        'editorLineNumber.foreground': p.textTertiary,
        'editorLineNumber.activeForeground': p.textSecondary,
        'editorCursor.foreground': p.brand,
        'editor.selectionBackground': rgba(p.blue, 0.25),
        'editor.inactiveSelectionBackground': rgba(p.blue, 0.12),
        'editor.lineHighlightBackground': rgba(p.brand, 0.06),
        'editor.lineHighlightBorder': 'transparent',
        'editorWhitespace.foreground': rgba(p.textTertiary, 0.4),
        'editorIndentGuide.background': rgba(p.borderColor, 0.06),
        'editorIndentGuide.activeBackground': rgba(p.borderColor, 0.12),
        'editor.findMatchBackground': rgba(p.brand, 0.25),
        'editor.findMatchHighlightBackground': rgba(p.brand, 0.15),
        'editorGutter.background': p.bgDeep,
        'editor.foldBackground': rgba(p.blue, 0.06),
        'editorBracketMatch.background': rgba(p.blue, 0.12),
        'editorBracketMatch.border': rgba(p.blue, 0.25),
        'editorWidget.background': p.bgElevated,
        'editorWidget.border': rgba(p.borderColor, 0.18),
        'editorSuggestWidget.background': p.bgElevated,
        'editorSuggestWidget.border': rgba(p.borderColor, 0.18),
        'editorSuggestWidget.selectedBackground': rgba(p.blue, 0.12),
        'editorSuggestWidget.highlightForeground': p.brand,
        'editorHoverWidget.background': p.bgElevated,
        'editorHoverWidget.border': rgba(p.borderColor, 0.18),
        'editorOverviewRuler.border': rgba(p.borderColor, 0.06),
        'editorError.foreground': p.red,
        'editorWarning.foreground': p.yellow,
        'editorInfo.foreground': p.blue,
        'editorGutter.modifiedBackground': rgba(p.blue, 0.20),
        'editorGutter.addedBackground': rgba(p.green, 0.20),
        'editorGutter.deletedBackground': rgba(p.red, 0.20),
        'scrollbarSlider.background': rgba(p.borderColor, 0.12),
        'scrollbarSlider.hoverBackground': rgba(p.borderColor, 0.18),
        'scrollbarSlider.activeBackground': rgba(p.borderColor, 0.25),
        'minimap.background': p.bgDeep,
        'editor.selectionHighlightBackground': rgba(p.blue, 0.06),
        'editor.wordHighlightBackground': rgba(p.blue, 0.05),
        'editor.wordHighlightStrongBackground': rgba(p.blue, 0.10),
      }
    });
  }

  // ── State ──
  var currentThemeId = loadThemeId() || 'cloud-forge';
  // Migrate old 'dark' theme ID to 'cloud-forge'
  if (currentThemeId === 'dark') currentThemeId = 'cloud-forge';
  var monacoRef = null;
  var definedThemes = new Set();
  var listeners = new Set();

  function loadThemeId() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function saveThemeId(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) {}
  }

  function setCssVars(vars) {
    var root = document.documentElement;
    Object.keys(vars).forEach(function(key) {
      root.style.setProperty(key, vars[key]);
    });
  }

  function applyTheme(themeId) {
    var p = palettes[themeId] || palettes['cloud-forge'];
    currentThemeId = themeId;
    setCssVars(buildTokens(p));
    saveThemeId(themeId);
    if (monacoRef && monacoRef.editor) {
      if (!definedThemes.has(themeId)) {
        try { defineMonacoTheme(monacoRef, themeId, p); definedThemes.add(themeId); } catch (e) {}
      }
      try { monacoRef.editor.setTheme(themeId); } catch (e) {}
    }
    listeners.forEach(function(cb) { try { cb(themeId); } catch (e) {} });
    return themeId;
  }

  function setMonaco(monaco) {
    monacoRef = monaco;
    // Pre-define all Monaco themes
    Object.keys(palettes).forEach(function(id) {
      if (!definedThemes.has(id)) {
        try { defineMonacoTheme(monaco, id, palettes[id]); definedThemes.add(id); } catch (e) {}
      }
    });
    applyTheme(currentThemeId);
  }

  function getCurrentTheme() { return currentThemeId; }
  function listThemes() {
    return Object.keys(palettes).map(function(id) {
      return { id: id, label: palettes[id].label };
    });
  }
  function toggleTheme() {
    var next = currentThemeId === 'cloud-forge' ? 'light' : 'cloud-forge';
    return applyTheme(next);
  }
  function onChange(cb) {
    if (typeof cb !== 'function') return function() {};
    listeners.add(cb);
    return function() { listeners.delete(cb); };
  }
  function init() { applyTheme(currentThemeId); }

  global.themeManager = {
    init: init, setMonaco: setMonaco, applyTheme: applyTheme,
    toggleTheme: toggleTheme, getCurrentTheme: getCurrentTheme,
    listThemes: listThemes, onChange: onChange
  };

  // Apply saved theme immediately to prevent flash of default theme
  init();
})(typeof window !== 'undefined' ? window : globalThis);
