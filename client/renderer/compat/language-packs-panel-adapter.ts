import {
  createLanguagePacksPanel,
  LANGUAGE_PACKS_PANEL_SERVICE_ID
} from '../../src/language-packs-panel';
import type { LanguagePacksPanelFacade } from '../../types/language-packs-panel';
import { rendererPlatform } from '../core/bootstrap';
import { I18N_SERVICE_ID } from './i18n-adapter';

interface LegacyBobo {
  icons?: {
    readonly trash?: string;
  };
  languagePacksPanel?: LanguagePacksPanelFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const languagePacksPanel = createLanguagePacksPanel({
  document,
  getI18n: () => rendererPlatform.services.get(I18N_SERVICE_ID),
  getTrashIcon: () => BOBO.icons?.trash,
  confirm: (message) => legacyWindow.confirm(message)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  LANGUAGE_PACKS_PANEL_SERVICE_ID,
  languagePacksPanel,
  { owner: 'core.language-packs-panel', exposeToPlugins: false }
));

// Preserve the historical three-key compatibility facade and its insertion order.
BOBO.languagePacksPanel = {
  init: languagePacksPanel.init,
  render: languagePacksPanel.render,
  refresh: languagePacksPanel.refresh
};
