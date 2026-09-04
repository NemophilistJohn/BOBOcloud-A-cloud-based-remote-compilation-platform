import {
  createThemeService,
  THEME_SERVICE_ID
} from '../../src/theme-manager';
import type { ThemeManagerFacade } from '../../types/theme';
import { rendererPlatform } from '../core/bootstrap';

type ThemeManagerWindow = Window & {
  themeManager?: ThemeManagerFacade;
};

const legacyWindow = window as ThemeManagerWindow;
let storage: Storage | null = null;
try {
  storage = legacyWindow.localStorage;
} catch (_) {
  // Access can be denied for opaque origins; the theme service falls back safely.
}

const theme = createThemeService({ document, storage });
rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  THEME_SERVICE_ID,
  theme,
  { owner: 'core.theme', exposeToPlugins: false }
));

// Preserve the historical seven-key facade and keep disposal registry-owned.
legacyWindow.themeManager = {
  init: theme.init,
  setMonaco: theme.setMonaco,
  applyTheme: theme.applyTheme,
  toggleTheme: theme.toggleTheme,
  getCurrentTheme: theme.getCurrentTheme,
  listThemes: theme.listThemes,
  onChange: theme.onChange
};

// Apply the persisted theme synchronously before the workbench renders.
theme.init();
