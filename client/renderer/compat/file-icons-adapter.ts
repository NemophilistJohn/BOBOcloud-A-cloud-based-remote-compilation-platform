import { rendererPlatform } from '../core/bootstrap';
import { createFileIconService, FILE_ICONS_SERVICE_ID } from '../../src/file-icons';
import type { FileIconPluginView, FileIconService } from '../../types/file-icons';

interface LegacyBobo {
  fileIcons?: FileIconService;
}

const fileIcons = createFileIconService({ iconDirectory: 'ico' });
const pluginFileIcons: FileIconPluginView = Object.freeze({
  getFileIcon: (fileName?: string | null) => fileIcons.getFileIcon(fileName),
  getFolderIcon: (folderName?: string | null) => fileIcons.getFolderIcon(folderName)
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  FILE_ICONS_SERVICE_ID,
  fileIcons,
  {
    owner: 'core.file-icons',
    exposeToPlugins: true,
    pluginView: pluginFileIcons
  }
));

// Existing workbench modules continue to read BOBO.fileIcons until they are
// migrated to constructor/factory injection.
const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
BOBO.fileIcons = fileIcons;
