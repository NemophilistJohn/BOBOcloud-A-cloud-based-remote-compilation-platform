const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let watchers = new Map();
let win;
let workspaceRoot = null;

// Server settings file path (in user's app data directory)
const SERVER_SETTINGS_PATH = path.join(app.getPath('userData'), 'server-settings.json');


// Read server settings from file
async function readServerSettings() {
  try {
    // Check if settings file exists in user data directory
    if (fs.existsSync(SERVER_SETTINGS_PATH)) {
      const data = fs.readFileSync(SERVER_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(data);
      // Update rclone config when reading settings
      await updateRcloneConfig(settings);
      return settings;
    } else {
      // Try to copy default settings from app directory
      const defaultSettingsPath = path.join(__dirname, 'server-settings.json');
      if (fs.existsSync(defaultSettingsPath)) {
        const defaultData = fs.readFileSync(defaultSettingsPath, 'utf-8');
        const defaultSettings = JSON.parse(defaultData);
        // Write default settings to user data directory
        fs.writeFileSync(SERVER_SETTINGS_PATH, defaultData, 'utf-8');
        // Update rclone config with default settings
        await updateRcloneConfig(defaultSettings);
        return defaultSettings;
      }
    }
  } catch (error) {
    console.error('Error reading server settings:', error);
  }
  return {};
}

// Update rclone config using rclone config create command
async function updateRcloneConfig(settings) {
  return new Promise((resolve, reject) => {
    if (!settings.ip || !settings.user) {
      resolve(false);
      return;
    }

    // Create rclone config directory if it doesn't exist
    const rcloneConfigDir = path.join(process.env.APPDATA, 'rclone');
    if (!fs.existsSync(rcloneConfigDir)) {
      try {
        fs.mkdirSync(rcloneConfigDir, { recursive: true });
      } catch (error) {
        console.error('Error creating rclone config directory:', error);
        resolve(false);
        return;
      }
    }

    // Get rclone executable path
    let rcloneExecutable = settings.rclonePath || 'rclone';

    
    // Fix rclone path if it's a directory
    if (rcloneExecutable) {
      // Check if path ends with directory separator
      if (rcloneExecutable.endsWith('\\') || rcloneExecutable.endsWith('/')) {
        // Add rclone.exe to directory path
        rcloneExecutable += 'rclone.exe';
      } else if (rcloneExecutable.includes('\\') || rcloneExecutable.includes('/')) {
        const lastPart = rcloneExecutable.split(/[/\\]/).pop();
        if (lastPart.toLowerCase() === 'rclone') {
          // It's a directory, add .exe
          rcloneExecutable += '.exe';
        }
      } else if (!rcloneExecutable.endsWith('.exe')) {
        // If it's just a filename without path, add .exe if needed
        rcloneExecutable += '.exe';
      }
    }
    const configName = 'cloud-compiler-sftp';
    const command = `${rcloneExecutable} config create ${configName} sftp ` +
      `host="${settings.ip}" ` +
      `user="${settings.user}" ` +
      `port=22 ` +
      (settings.pass ? `pass="${settings.pass}" ` : '') +
      `--non-interactive`;

    console.log('Running rclone config command:', command);
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error('Error updating rclone config:', error);
        console.error('stderr:', stderr);
        console.error('stdout:', stdout);
        resolve(false);
      } else {
        console.log('rclone config updated successfully');
        console.log('stdout:', stdout);
        resolve(true);
      }
    });
  });
}

// Write server settings to file
async function writeServerSettings(settings) {
  try {
    fs.writeFileSync(SERVER_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    // Update rclone config after writing settings
    await updateRcloneConfig(settings);
    return true;
  } catch (error) {
    console.error('Error writing server settings:', error);
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder...', accelerator: 'Ctrl+O', click: pickAndOpenWorkspace },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Server Settings',
          click: () => {
            win.webContents.send('open-server-settings');
          }
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}



app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const watcher of watchers.values()) {
    try { watcher.close(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function pickAndOpenWorkspace() {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths[0]) {
    openWorkspace(result.filePaths[0]);
  }
}

function openWorkspace(folderPath) {
  workspaceRoot = folderPath;
  const tree = readTree(folderPath);
  win.webContents.send('workspace-opened', { rootPath: folderPath, tree });
  watchFolderRecursive(folderPath);
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Read directory recursively
function readTree(dirPath) {
  const stat = safeStat(dirPath);
  if (!stat || !stat.isDirectory()) return null;

  const node = {
    name: path.basename(dirPath),
    path: dirPath,
    type: 'folder',
    children: []
  };

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      node.children.push(readTree(full));
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: full,
        type: 'file'
      });
    }
  }
  return node;
}

// Watch folder recursively and notify renderer
function watchFolderRecursive(root) {
  // clear existing watchers first
  for (const [p, w] of [...watchers]) {
    if (p.startsWith(root)) {
      try { w.close(); } catch {}
      watchers.delete(p);
    }
  }
  attachWatcher(root);
}

function attachWatcher(dir) {
  if (watchers.has(dir)) return;
  const watcher = fs.watch(dir, { recursive: false }, (_eventType, filename) => {
    // Emit a lightweight change signal; renderer will rebuild tree but preserve expansion state
    const rootPath = workspaceRoot || dir;
    const fullTree = readTree(rootPath);
    win.webContents.send('workspace-refresh', { rootPath, tree: fullTree });
    // Add watcher for new subfolder
    const subPath = filename ? path.join(dir, filename) : null;
    const st = subPath ? safeStat(subPath) : null;
    if (st && st.isDirectory()) {
      attachWatcher(subPath);
    }
  });
  watchers.set(dir, watcher);

  // Attach watchers to subfolders
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      attachWatcher(path.join(dir, entry.name));
    }
  }
}

// IPC handlers

ipcMain.handle('pick-workspace', async (_e, path) => {
  let folder;
  if (path !== undefined) {
    folder = path;
  } else {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    folder = result.filePaths[0];
    watchFolderRecursive(folder);
    workspaceRoot = folder;
  }
  const tree = readTree(folder);
  return { rootPath: folder, tree };
});

ipcMain.handle('read-file', async (_e, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('save-file', async (_e, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('create-file', async (_e, { parentDir, name }) => {
  const full = path.join(parentDir, name);
  fs.writeFileSync(full, '', 'utf-8');
  return { path: full };
});

ipcMain.handle('create-folder', async (_e, { parentDir, name }) => {
  const full = path.join(parentDir, name);
  fs.mkdirSync(full, { recursive: true });
  return { path: full };
});

ipcMain.handle('rename-entry', async (_e, { oldPath, newName }) => {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  fs.renameSync(oldPath, newPath);
  return { path: newPath };
});

ipcMain.handle('delete-entry', async (_e, { entryPath }) => {
  const stat = safeStat(entryPath);
  if (!stat) return false;
  if (stat.isDirectory()) {
    fs.rmSync(entryPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(entryPath);
  }
  return true;
});

// Server settings IPC handlers
ipcMain.handle('read-server-settings', async () => {
  return readServerSettings();
});

ipcMain.handle('write-server-settings', async (_e, settings) => {
  return writeServerSettings(settings);
});

// Check if rclone is available
ipcMain.handle('check-rclone', async () => {
  return new Promise((resolve) => {
    exec('rclone --version', { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        available: !error,
        version: stdout ? stdout.split('\n')[0] : null,
        error: error ? error.message : null
      });
    });
  });
});

// Get rclone path
ipcMain.handle('get-rclone-path', async () => {
  return new Promise((resolve) => {
    // Try to find rclone in PATH
    exec('where rclone', { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // Try powershell command to find rclone
        exec('powershell -Command "Get-Command rclone | Select-Object -ExpandProperty Source"', { windowsHide: true }, (psError, psStdout, psStderr) => {
          if (psError) {
            resolve({ path: null, error: 'rclone not found in PATH' });
          } else {
            resolve({ path: psStdout.trim(), error: null });
          }
        });
      } else {
        resolve({ path: stdout.trim(), error: null });
      }
    });
  });
});

// Rclone execution IPC handler
ipcMain.handle('execute-rclone', async (_e, command) => {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        error: error ? error.message : null,
        stdout: stdout,
        stderr: stderr,
        success: !error
      });
    });
  });
});
