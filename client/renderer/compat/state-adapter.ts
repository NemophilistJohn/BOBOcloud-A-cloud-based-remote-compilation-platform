import { createRendererState } from '../../src/state';
import type { RendererState } from '../../types/state';

interface LegacyRendererNamespace {
  state?: RendererState;
}

type RendererWindow = Window & { BOBO?: LegacyRendererNamespace };

const legacyWindow = window as RendererWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Preserve the historical eager singleton initialization.  The adapter is
// imported exactly once by the renderer composition root before consumers.
BOBO.state = createRendererState();

