const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Workspace
  pickWorkspace: () => ipcRenderer.invoke('pick-workspace'),
  onWorkspaceOpened: (cb) => ipcRenderer.on('workspace-opened', (_e, data) => cb(data)),
  onWorkspaceRefresh: (cb) => ipcRenderer.on('workspace-refresh', (_e, data) => cb(data)),

  // Files
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),

  // FS operations
  createFile: (payload) => ipcRenderer.invoke('create-file', payload),
  createFolder: (payload) => ipcRenderer.invoke('create-folder', payload),
  renameEntry: (payload) => ipcRenderer.invoke('rename-entry', payload),
  deleteEntry: (payload) => ipcRenderer.invoke('delete-entry', payload),
  onOpenServerSettings: (cb) => ipcRenderer.on('open-server-settings', cb),
  
  // Server settings
  readServerSettings: () => ipcRenderer.invoke('read-server-settings'),
  writeServerSettings: (settings) => ipcRenderer.invoke('write-server-settings', settings),
  
  // Rclone operations
  executeRclone: (command) => ipcRenderer.invoke('execute-rclone', command),
  checkRclone: () => ipcRenderer.invoke('check-rclone'),
  getRclonePath: () => ipcRenderer.invoke('get-rclone-path')
});
