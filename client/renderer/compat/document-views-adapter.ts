import { createDocumentViewService } from '../../src/document-views';
import type {
  DocumentAnalysisPort,
  DocumentViewContributionChangeEventDto,
  DocumentViewI18n,
  DocumentViewService,
  DocumentViewState,
  DocumentViewThemeDto,
  DocumentViewViewsPort,
  DocumentViewWorkspacePort
} from '../../types/document-view';
import { THEME_SERVICE_ID } from '../../src/theme-manager';
import { rendererPlatform } from '../core/bootstrap';
import { ContributionPoint } from '../core/contribution-registry';
import { DOCUMENT_VIEWS_HOST_SERVICE_ID } from '../core/native-host-adapter';

export const DOCUMENT_VIEWS_SERVICE_ID = 'workbench.documentViews';

interface LegacyBobo {
  state?: DocumentViewState;
  i18n?: DocumentViewI18n;
  views?: DocumentViewViewsPort;
  workspace?: DocumentViewWorkspacePort & {
    documentViewDirty?(path: string, dirty: boolean): void;
    documentViewSaved?(path: string): void;
  };
  lsp?: { virtualDocuments?: DocumentAnalysisPort };
  documentViews?: DocumentViewService;
}

type DocumentViewsWindow = Window & {
  BOBO?: LegacyBobo;
};

const legacyWindow = window as DocumentViewsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Document Views requires renderer state.');
if (!BOBO.i18n) throw new Error('Document Views requires the renderer i18n service.');
const theme = rendererPlatform.services.require(THEME_SERVICE_ID);

function themeSnapshot(): DocumentViewThemeDto {
  const styles = legacyWindow.getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => (
    styles.getPropertyValue(name).trim() || fallback
  );
  const activeTheme = theme.getCurrentTheme();
  return Object.freeze({
    kind: activeTheme === 'light' ||
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    background: value('--bg-deep', '#111318'),
    surface: value('--bg-surface', '#1a1d24'),
    border: value('--border-default', '#343945'),
    text: value('--text-primary', '#e7eaf0'),
    muted: value('--text-secondary', '#9da5b4'),
    accent: value('--brand', '#4da3ff'),
    danger: value('--red', '#ef6461'),
    fontFamily: value('--font-ui', 'system-ui, sans-serif'),
    monoFontFamily: value('--font-mono', 'ui-monospace, monospace')
  });
}

const documentViews = createDocumentViewService({
  document,
  state: BOBO.state,
  i18n: BOBO.i18n,
  theme: Object.freeze({
    snapshot: themeSnapshot,
    onChange: (listener: () => void) => theme.onChange(listener)
  }),
  views: Object.freeze({
    closeSplit: () => BOBO.views?.closeSplit?.(),
    closeDiff: () => BOBO.views?.closeDiff?.(),
    closeImagePreview: () => BOBO.views?.closeImagePreview?.()
  }),
  workspace: Object.freeze({
    closeTab: (path: string, options: Readonly<{ force: true }>) => (
      BOBO.workspace?.closeTab(path, options)
    )
  }),
  analysis: {
    update: (...args) => BOBO.lsp?.virtualDocuments?.update(...args),
    complete: async (...args) => await BOBO.lsp?.virtualDocuments?.complete(...args) ?? [],
    close: (path) => BOBO.lsp?.virtualDocuments?.close(path)
  },
  onDirty: (path, dirty) => BOBO.workspace?.documentViewDirty?.(path, dirty),
  onSave: (path) => BOBO.workspace?.documentViewSaved?.(path),
  contributions: Object.freeze({
    list: () => rendererPlatform.contributions.listEntries(ContributionPoint.DOCUMENT_VIEWS),
    onDidChange: (listener: (event: DocumentViewContributionChangeEventDto) => void) => (
      rendererPlatform.contributions.onDidChange((event) => {
        if (event.point !== ContributionPoint.DOCUMENT_VIEWS) return;
        listener(Object.freeze({ type: event.type, owner: event.owner, id: event.id }));
      })
    )
  }),
  host: rendererPlatform.services.require(DOCUMENT_VIEWS_HOST_SERVICE_ID)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  DOCUMENT_VIEWS_SERVICE_ID,
  documentViews,
  { owner: 'core.document-views', exposeToPlugins: false }
));

// Compatibility projection only. The service registry owns this instance.
BOBO.documentViews = documentViews;
