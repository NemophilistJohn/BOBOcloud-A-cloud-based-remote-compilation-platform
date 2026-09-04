import type { Disposable, Dispose } from './lifecycle';

export type BuiltinThemeId =
  | 'cloud-forge'
  | 'light'
  | 'nord'
  | 'monokai'
  | 'dracula';

export type ThemeMonacoBase = 'vs' | 'vs-dark';

export interface ThemePaletteDto {
  readonly label: string;
  readonly isDark: boolean;
  readonly bgDeep: string;
  readonly bgSurface: string;
  readonly bgElevated: string;
  readonly bgHover: string;
  readonly bgActive: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly brand: string;
  readonly brandHover: string;
  readonly brandPressed: string;
  readonly blue: string;
  readonly green: string;
  readonly red: string;
  readonly yellow: string;
  readonly orange: string;
  readonly purple: string;
  readonly borderColor: string;
  readonly shadowColor: string;
  readonly statusbarBg: string;
  readonly statusbarText: string;
  readonly monacoBase: ThemeMonacoBase;
}

export type ThemePaletteMap = Readonly<Record<BuiltinThemeId, ThemePaletteDto>>;
export type ThemeCssTokenMap = Readonly<Record<string, string>>;

export interface ThemeDescriptorDto {
  readonly id: BuiltinThemeId;
  readonly label: string;
  readonly colors: readonly [string, string, string, string, string];
}

export interface ThemeMonacoTokenRuleDto {
  readonly token: string;
  readonly foreground: string;
  readonly fontStyle?: string;
}

export interface ThemeMonacoDataDto {
  readonly base: ThemeMonacoBase;
  readonly inherit: true;
  readonly rules: readonly ThemeMonacoTokenRuleDto[];
  readonly colors: Readonly<Record<string, string>>;
}

export interface ThemeMonacoEditorPort {
  defineTheme(themeId: string, theme: ThemeMonacoDataDto): unknown;
  setTheme(themeId: string): unknown;
}

export interface ThemeMonaco {
  readonly editor?: ThemeMonacoEditorPort | null;
}

export type ThemeChangeListener = (themeId: string) => void;

export interface ThemeDependencies {
  readonly document: Document;
  readonly storage: Storage | null;
}

export interface ThemeManagerFacade {
  init(): void;
  setMonaco(monaco: ThemeMonaco | null | undefined): void;
  applyTheme(themeId: string): string;
  toggleTheme(): string;
  getCurrentTheme(): string;
  listThemes(): readonly ThemeDescriptorDto[];
  onChange(listener: ThemeChangeListener): Dispose;
}

export interface ThemeService extends ThemeManagerFacade, Disposable {}
