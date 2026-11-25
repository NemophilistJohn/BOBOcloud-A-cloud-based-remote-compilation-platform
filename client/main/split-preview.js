'use strict';

const MAX_SIDE = 4096;
const MAX_IMAGE_SIDE = 1280;

function registerSplitPreview({ ipcMain, getWindow }) {
  let capturing = false;
  ipcMain.handle('views:capture-split-preview', async (event, bounds) => {
    const window = getWindow();
    if (!window || !window.isVisible() || window.isMinimized() || capturing || !bounds) return null;
    const zoom = event.sender.getZoomFactor();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
    const x = Math.ceil(bounds.x * zoom);
    const y = Math.ceil(bounds.y * zoom);
    const width = Math.floor((bounds.x + bounds.width) * zoom) - x;
    const height = Math.floor((bounds.y + bounds.height) * zoom) - y;
    const [viewportWidth, viewportHeight] = window.getContentSize();
    if (x < 0 || y < 0 || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE ||
        x + width > viewportWidth || y + height > viewportHeight) return null;

    capturing = true;
    try {
      const captured = await event.sender.capturePage({ x, y, width, height });
      if (captured.isEmpty()) return null;
      const size = captured.getSize();
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(size.width, size.height));
      const preview = scale === 1 ? captured : captured.resize({ width: Math.max(1, Math.round(size.width * scale)) });
      return `data:image/jpeg;base64,${preview.toJPEG(86).toString('base64')}`;
    } finally {
      capturing = false;
    }
  });
}

module.exports = { registerSplitPreview };
