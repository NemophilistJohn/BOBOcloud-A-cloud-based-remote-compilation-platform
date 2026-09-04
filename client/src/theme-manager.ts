import type {
  BuiltinThemeId,
  ThemeChangeListener,
  ThemeCssTokenMap,
  ThemeDependencies,
  ThemeDescriptorDto,
  ThemeMonacoDataDto,
  ThemeMonaco,
  ThemePaletteDto,
  ThemePaletteMap,
  ThemeService
} from '../types/theme';
import type { Dispose } from '../types/lifecycle';

export const THEME_SERVICE_ID = 'workbench.theme';

const STORAGE_KEY = 'bobocloud.theme';
const DEFAULT_THEME_ID: BuiltinThemeId = 'cloud-forge';

function rgba(hexStr: string, alpha: number): string {
  const red = parseInt(hexStr.slice(1, 3), 16);
  const green = parseInt(hexStr.slice(3, 5), 16);
  const blue = parseInt(hexStr.slice(5, 7), 16);
  return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')';
}

function hexRaw(hexStr: string): string {
  return hexStr.replace('#', '');
}

const PALETTES = {
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
} satisfies ThemePaletteMap;

function themeIds(): BuiltinThemeId[] {
  return Object.keys(PALETTES) as BuiltinThemeId[];
}

function paletteFor(themeId: string): ThemePaletteDto {
  return Object.prototype.hasOwnProperty.call(PALETTES, themeId)
    ? PALETTES[themeId as BuiltinThemeId]
    : PALETTES[DEFAULT_THEME_ID];
}

function buildTokens(palette: ThemePaletteDto): ThemeCssTokenMap {
  const shadowAlpha = palette.isDark ? 0.3 : 0.08;
  return {
    '--bg-deep': palette.bgDeep,
    '--bg-surface': palette.bgSurface,
    '--bg-elevated': palette.bgElevated,
    '--bg-hover': palette.bgHover,
    '--bg-active': palette.bgActive,
    '--text-primary': palette.textPrimary,
    '--text-secondary': palette.textSecondary,
    '--text-tertiary': palette.textTertiary,
    '--brand': palette.brand,
    '--brand-hover': palette.brandHover,
    '--brand-pressed': palette.brandPressed,
    '--brand-muted': rgba(palette.brand, 0.12),
    '--brand-border': rgba(palette.brand, 0.30),
    '--blue': palette.blue,
    '--blue-muted': rgba(palette.blue, 0.12),
    '--green': palette.green,
    '--green-muted': rgba(palette.green, 0.12),
    '--red': palette.red,
    '--red-muted': rgba(palette.red, 0.12),
    '--yellow': palette.yellow,
    '--yellow-muted': rgba(palette.yellow, 0.12),
    '--orange': palette.orange,
    '--purple': palette.purple,
    '--border-subtle': rgba(palette.borderColor, 0.06),
    '--border-default': rgba(palette.borderColor, 0.10),
    '--border-strong': rgba(palette.borderColor, 0.18),
    '--shadow-sm': '0 1px 3px ' + rgba(palette.shadowColor, shadowAlpha),
    '--shadow-md': '0 4px 12px ' + rgba(palette.shadowColor, shadowAlpha + 0.1),
    '--shadow-lg': '0 16px 48px ' + rgba(palette.shadowColor, shadowAlpha + 0.2),
    '--shadow-xl': '0 24px 64px ' + rgba(palette.shadowColor, shadowAlpha + 0.3),
    '--statusbar-bg': palette.statusbarBg,
    '--statusbar-text': palette.statusbarText,
    '--statusbar-accent': palette.brand,
    '--statusbar-border': rgba(palette.borderColor, 0.10),
    '--panel-tab-active-bg': palette.bgDeep,
    '--panel-tab-active-border': palette.brand,
    '--bg': palette.bgDeep,
    '--panel': palette.bgSurface,
    '--text': palette.textPrimary,
    '--text-dim': palette.textSecondary,
    '--accent': palette.bgHover,
    '--accent-hover': palette.bgActive,
    '--border': rgba(palette.borderColor, 0.10),
    '--shadow': '0 4px 12px ' + rgba(palette.shadowColor, shadowAlpha + 0.1)
  };
}

function defineMonacoTheme(
  monaco: ThemeMonaco | null | undefined,
  themeId: string,
  palette: ThemePaletteDto
): void {
  if (!monaco?.editor) throw new TypeError('Monaco editor is unavailable.');
  const theme: ThemeMonacoDataDto = {
    base: palette.monacoBase,
    inherit: true,
    rules: [
      { token: '', foreground: hexRaw(palette.textPrimary) },
      { token: 'comment', foreground: hexRaw(palette.textTertiary), fontStyle: 'italic' },
      { token: 'keyword', foreground: hexRaw(palette.brand) },
      { token: 'keyword.control', foreground: hexRaw(palette.purple) },
      { token: 'operator', foreground: hexRaw(palette.textSecondary) },
      { token: 'string', foreground: hexRaw(palette.green) },
      { token: 'string.escape', foreground: hexRaw(palette.orange) },
      { token: 'number', foreground: hexRaw(palette.orange) },
      { token: 'regexp', foreground: hexRaw(palette.orange) },
      { token: 'function', foreground: hexRaw(palette.blue) },
      { token: 'type', foreground: hexRaw(palette.yellow) },
      { token: 'type.identifier', foreground: hexRaw(palette.yellow) },
      { token: 'variable', foreground: hexRaw(palette.textPrimary) },
      { token: 'variable.predefined', foreground: hexRaw(palette.orange) },
      { token: 'variable.language', foreground: hexRaw(palette.brand) },
      { token: 'constant', foreground: hexRaw(palette.orange) },
      { token: 'delimiter', foreground: hexRaw(palette.textSecondary) },
      { token: 'delimiter.bracket', foreground: hexRaw(palette.textSecondary) },
      { token: 'tag', foreground: hexRaw(palette.red) },
      { token: 'attribute.name', foreground: hexRaw(palette.yellow) },
      { token: 'attribute.value', foreground: hexRaw(palette.green) },
      { token: 'namespace', foreground: hexRaw(palette.textSecondary) },
      { token: 'metatag', foreground: hexRaw(palette.orange) },
      { token: 'annotation', foreground: hexRaw(palette.yellow) }
    ],
    colors: {
      'editor.background': palette.bgDeep,
      'editor.foreground': palette.textPrimary,
      'editorLineNumber.foreground': palette.textTertiary,
      'editorLineNumber.activeForeground': palette.textSecondary,
      'editorCursor.foreground': palette.brand,
      'editor.selectionBackground': rgba(palette.blue, 0.25),
      'editor.inactiveSelectionBackground': rgba(palette.blue, 0.12),
      'editor.lineHighlightBackground': rgba(palette.brand, 0.06),
      'editor.lineHighlightBorder': 'transparent',
      'editorWhitespace.foreground': rgba(palette.textTertiary, 0.4),
      'editorIndentGuide.background': rgba(palette.borderColor, 0.06),
      'editorIndentGuide.activeBackground': rgba(palette.borderColor, 0.12),
      'editor.findMatchBackground': rgba(palette.brand, 0.25),
      'editor.findMatchHighlightBackground': rgba(palette.brand, 0.15),
      'editorGutter.background': palette.bgDeep,
      'editor.foldBackground': rgba(palette.blue, 0.06),
      'editorBracketMatch.background': rgba(palette.blue, 0.12),
      'editorBracketMatch.border': rgba(palette.blue, 0.25),
      'editorWidget.background': palette.bgElevated,
      'editorWidget.border': rgba(palette.borderColor, 0.18),
      'editorSuggestWidget.background': palette.bgElevated,
      'editorSuggestWidget.border': rgba(palette.borderColor, 0.18),
      'editorSuggestWidget.selectedBackground': rgba(palette.blue, 0.12),
      'editorSuggestWidget.highlightForeground': palette.brand,
      'editorHoverWidget.background': palette.bgElevated,
      'editorHoverWidget.border': rgba(palette.borderColor, 0.18),
      'editorOverviewRuler.border': rgba(palette.borderColor, 0.06),
      'editorError.foreground': palette.red,
      'editorWarning.foreground': palette.yellow,
      'editorInfo.foreground': palette.blue,
      'editorGutter.modifiedBackground': rgba(palette.blue, 0.20),
      'editorGutter.addedBackground': rgba(palette.green, 0.20),
      'editorGutter.deletedBackground': rgba(palette.red, 0.20),
      'scrollbarSlider.background': rgba(palette.borderColor, 0.12),
      'scrollbarSlider.hoverBackground': rgba(palette.borderColor, 0.18),
      'scrollbarSlider.activeBackground': rgba(palette.borderColor, 0.25),
      'minimap.background': palette.bgDeep,
      'editor.selectionHighlightBackground': rgba(palette.blue, 0.06),
      'editor.wordHighlightBackground': rgba(palette.blue, 0.05),
      'editor.wordHighlightStrongBackground': rgba(palette.blue, 0.10)
    }
  };
  monaco.editor.defineTheme(themeId, theme);
}

export function createThemeService(dependencies: ThemeDependencies): ThemeService {
  const hostDocument = dependencies.document;
  const storage = dependencies.storage;
  const listeners = new Set<ThemeChangeListener>();
  const definedThemes = new Set<string>();
  let currentThemeId = loadThemeId() || DEFAULT_THEME_ID;
  if (currentThemeId === 'dark') currentThemeId = DEFAULT_THEME_ID;
  let monacoRef: ThemeMonaco | null = null;

  function loadThemeId(): string | null {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null;
    } catch (_) {
      return null;
    }
  }

  function saveThemeId(themeId: string): void {
    try {
      storage?.setItem(STORAGE_KEY, themeId);
    } catch (_) {}
  }

  function setCssVars(tokens: ThemeCssTokenMap): void {
    const root = hostDocument.documentElement;
    Object.keys(tokens).forEach((key) => {
      const value = tokens[key];
      if (value !== undefined) root.style.setProperty(key, value);
    });
  }

  function applyTheme(themeId: string): string {
    const palette = paletteFor(themeId);
    currentThemeId = themeId;
    setCssVars(buildTokens(palette));
    saveThemeId(themeId);
    if (monacoRef?.editor) {
      if (!definedThemes.has(themeId)) {
        try {
          defineMonacoTheme(monacoRef, themeId, palette);
          definedThemes.add(themeId);
        } catch (_) {}
      }
      try {
        monacoRef.editor.setTheme(themeId);
      } catch (_) {}
    }
    listeners.forEach((listener) => {
      try {
        listener(themeId);
      } catch (_) {}
    });
    return themeId;
  }

  function setMonaco(monaco: ThemeMonaco | null | undefined): void {
    monacoRef = monaco || null;
    themeIds().forEach((themeId) => {
      if (definedThemes.has(themeId)) return;
      try {
        defineMonacoTheme(monaco, themeId, PALETTES[themeId]);
        definedThemes.add(themeId);
      } catch (_) {}
    });
    applyTheme(currentThemeId);
  }

  function getCurrentTheme(): string {
    return currentThemeId;
  }

  function listThemes(): readonly ThemeDescriptorDto[] {
    return themeIds().map((themeId) => {
      const palette = PALETTES[themeId];
      return {
        id: themeId,
        label: palette.label,
        colors: [
          palette.bgDeep,
          palette.bgSurface,
          palette.textPrimary,
          palette.brand,
          palette.blue
        ]
      };
    });
  }

  function toggleTheme(): string {
    const next = currentThemeId === DEFAULT_THEME_ID ? 'light' : DEFAULT_THEME_ID;
    return applyTheme(next);
  }

  function onChange(listener: ThemeChangeListener): Dispose {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function init(): void {
    applyTheme(currentThemeId);
  }

  function dispose(): void {
    listeners.clear();
    monacoRef = null;
  }

  return Object.freeze({
    init,
    setMonaco,
    applyTheme,
    toggleTheme,
    getCurrentTheme,
    listThemes,
    onChange,
    dispose
  });
}
