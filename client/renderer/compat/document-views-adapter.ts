import { createDocumentViewService } from '../../src/document-views';
import type {
  DocumentViewContributionChangeEventDto,
  DocumentViewI18n,
  DocumentViewService,
  DocumentViewState,
  DocumentViewSubscription,
  DocumentViewThemeDto,
  DocumentViewViewsPort,
  DocumentViewWorkspacePort
} from '../../types/document-view';
import { rendererPlatform } from '../core/bootstrap';
import { ContributionPoint } from '../core/contribution-registry';
import { DOCUMENT_VIEWS_HOST_SERVICE_ID } from '../core/native-host-adapter';

export const DOCUMENT_VIEWS_SERVICE_ID = 'workbench.documentViews';

interface LegacyThemeManager {
  getCurrentTheme?(): string;
  onChange?(listener: () => void): DocumentViewSubscription;
}

interface LegacyBobo {
  state?: DocumentViewState;
  i18n?: DocumentViewI18n;
  views?: DocumentViewViewsPort;
  workspace?: DocumentViewWorkspacePort;
  documentViews?: DocumentViewService;
}

type DocumentViewsWindow = Window & {
  BOBO?: LegacyBobo;
  themeManager?: LegacyThemeManager;
};

const legacyWindow = window as DocumentViewsWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.state) throw new Error('Document Views requires renderer state.');
if (!BOBO.i18n) throw new Error('Document Views requires the renderer i18n service.');

function themeSnapshot(): DocumentViewThemeDto {
  const styles = legacyWindow.getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => (
    styles.getPropertyValue(name).trim() || fallback
  );
  const activeTheme = legacyWindow.themeManager?.getCurrentTheme?.();
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
    onChange: (listener: () => void) => legacyWindow.themeManager?.onChange?.(listener)
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
