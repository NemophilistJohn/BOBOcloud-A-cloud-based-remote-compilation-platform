const fs = require('fs');

function createWindowState(options) {
  const screen = options.screen;
  const filePath = options.filePath;
  const getWindow = options.getWindow;

  function save() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
      fs.writeFileSync(filePath, JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: window.isMaximized()
      }, null, 2), 'utf-8');
    } catch (error) {
      console.error('Error saving window state:', error);
    }
  }

  function read() {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      console.error('Error loading window state:', error);
    }
    return null;
  }

  function normalize(savedState) {
    if (!savedState || typeof savedState !== 'object') return null;
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const savedRect = {
      x: Number(savedState.x),
      y: Number(savedState.y),
      width: Number(savedState.width) || 1280,
      height: Number(savedState.height) || 860
    };
    const display = displays.find((item) => {
      const area = item.workArea;
      return savedRect.x < area.x + area.width && savedRect.x + savedRect.width > area.x &&
        savedRect.y < area.y + area.height && savedRect.y + savedRect.height > area.y;
    });
    if (!display) {
      return {
        width: Math.min(1280, primary.workArea.width),
        height: Math.min(860, primary.workArea.height),
        isMaximized: Boolean(savedState.isMaximized)
      };
    }
    const area = display.workArea;
    const width = Math.max(Math.min(760, area.width), Math.min(savedRect.width, area.width));
    const height = Math.max(Math.min(520, area.height), Math.min(savedRect.height, area.height));
    return {
      x: Math.max(area.x, Math.min(savedRect.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(savedRect.y, area.y + area.height - height)),
      width,
      height,
      isMaximized: Boolean(savedState.isMaximized)
    };
  }

  return { save, load: () => normalize(read()) };
}

module.exports = { createWindowState };
