import { rendererPlatform } from '../core/bootstrap.js';
import { createFileIconService, FILE_ICONS_SERVICE_ID } from '../../src/file-icons.js';

const fileIcons = createFileIconService({ iconDirectory: 'ico' });
const pluginFileIcons = Object.freeze({
  getFileIcon: (fileName) => fileIcons.getFileIcon(fileName),
  getFolderIcon: (folderName) => fileIcons.getFolderIcon(folderName)
});

rendererPlatform.services.register(FILE_ICONS_SERVICE_ID, fileIcons, {
  owner: 'core.file-icons',
  exposeToPlugins: true,
  pluginView: pluginFileIcons
});

// Existing workbench modules continue to read BOBO.fileIcons until they are
// migrated to constructor/factory injection.
const BOBO = window.BOBO = window.BOBO || {};
BOBO.fileIcons = fileIcons;
