import { createCommandPalette, COMMAND_PALETTE_SERVICE_ID } from '../../src/command-palette';
import type { CommandPaletteFacade } from '../../types/command-palette';
import { rendererPlatform } from '../core/bootstrap';

interface LegacyBobo {
  commands?: CommandPaletteFacade;
}

const commandPalette = createCommandPalette({
  document,
  eventTarget: window,
  getI18n: () => rendererPlatform.services.get('workbench.i18n'),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  COMMAND_PALETTE_SERVICE_ID,
  commandPalette,
  { owner: 'core.command-palette', exposeToPlugins: false }
));

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Keep the historical BOBO.commands surface exact while the registry owns the
// disposable service behind it.
BOBO.commands = {
  register: commandPalette.register,
  unregister: commandPalette.unregister,
  has: commandPalette.has,
  supportsDisposables: true,
  show: commandPalette.show,
  hide: commandPalette.hide
};
