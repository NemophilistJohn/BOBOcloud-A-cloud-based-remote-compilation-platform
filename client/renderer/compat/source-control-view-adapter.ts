import { createSourceControlViewService } from '../../src/source-control-view';
import type {
  SourceControlViewI18n,
  SourceControlViewService,
  SourceControlViewWorkbench
} from '../../types/source-control-view';
import { rendererPlatform } from '../core/bootstrap';

export const SOURCE_CONTROL_VIEW_SERVICE_ID = 'workbench.sourceControlView';

interface LegacyBobo {
  i18n?: SourceControlViewI18n;
  workbench?: SourceControlViewWorkbench;
  sourceControlView?: SourceControlViewService;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
if (!BOBO.i18n) throw new Error('Source Control View requires the renderer i18n service.');
if (!BOBO.workbench) throw new Error('Source Control View requires the workbench layout service.');

const sourceControlView = createSourceControlViewService({
  document,
  window: legacyWindow,
  i18n: BOBO.i18n,
  workbench: BOBO.workbench,
  sourceControls: rendererPlatform.sourceControls,
  commands: rendererPlatform.commands
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  SOURCE_CONTROL_VIEW_SERVICE_ID,
  sourceControlView,
  { owner: 'core.source-control-view', exposeToPlugins: false }
));

// Compatibility projection only. The service registry owns this instance.
BOBO.sourceControlView = sourceControlView;
