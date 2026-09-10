import { icons } from '../../src/icons';
import type { RendererIconsFacade } from '../../types/icons';

type LegacyIconsNamespace = {
  icons?: RendererIconsFacade;
};

const legacyWindow = window as Window & { BOBO?: LegacyIconsNamespace };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Keep the historical object writable while ensuring typed core data remains
// immutable and cannot be changed by a legacy consumer.
BOBO.icons = { ...icons };
