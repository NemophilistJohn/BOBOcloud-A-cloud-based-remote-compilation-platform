require.config({ paths: { 'vs': './node_modules/monaco-editor/min/vs' } });

let editor;

// Workspace and explorer state
let workspaceRoot = null;
let expandedPaths = new Set();
const ALWAYS_COLLAPSED = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

// Tabs state
let tabs = []; // { path, name, model, language, dirty }
let activeTabPath = null;

// Server settings
let serverSettings = {};
let autoSyncInterval = null;

// UI references
let contextMenuEl = null;
let isResizing = false;

// Server communication
async function sendToServer(action, data = {}) {
  if (!serverSettings.ip) {
    updateRunOutput('Error: Server IP not configured');
    return null;
  }

  const url = `http://${serverSettings.ip}:3100`;
  const payload = { action, ...data };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    updateRunOutput(`Error communicating with server: ${error.message}`);
    return null;
  }
}

// Update run output
function updateRunOutput(message) {
  const outputEl = document.getElementById('run-log');
  const timestamp = new Date().toLocaleTimeString();
  outputEl.innerHTML += `[${timestamp}] ${message}\n`;
  outputEl.scrollTop = outputEl.scrollHeight;
}

// Load server settings from file
async function loadServerSettings() {
  try {
    serverSettings = await window.api.readServerSettings();
    console.log('Server settings loaded:', serverSettings);
    // Set up auto sync interval if configured
    setupAutoSync();
    // Check rclone availability
    await checkRcloneAvailability();
  } catch (error) {
    console.error('Error loading server settings:', error);
  }
}

// Check if rclone is available
async function checkRcloneAvailability() {
  try {
    let rcloneExecutable = serverSettings.rclonePath || 'rclone';
    
    // Fix rclone path if it's a directory (same logic as in syncWithServer)
    if (rcloneExecutable) {
      if (rcloneExecutable.endsWith('\\') || rcloneExecutable.endsWith('/')) {
        // Add rclone.exe to directory path
        rcloneExecutable += 'rclone.exe';
      } else if (rcloneExecutable.includes('\\') || rcloneExecutable.includes('/')) {
        // Check if it's a directory (ends with rclone folder name)
        const lastPart = rcloneExecutable.split(/[/\\]/).pop();
        if (lastPart.toLowerCase() === 'rclone') {
          rcloneExecutable += '.exe';
        }
      }
    }
    // Use the same path for checking as for execution
    const checkResult = await window.api.executeRclone(`${rcloneExecutable} --version`);
    if (checkResult.success) {
      updateRunOutput(`rclone available: ${checkResult.stdout.split('\n')[0]}`);
    } else {
      updateRunOutput(`Warning: rclone not found at path: ${rcloneExecutable}`);
      updateRunOutput('Please install rclone or specify the correct path in server settings.');
      updateRunOutput('Example: F:\\rclone\\rclone.exe');
      updateRunOutput('Download rclone from: https://rclone.org/downloads/');
    }
  } catch (error) {
    updateRunOutput(`Error checking rclone: ${error.message}`);
  }
}

// Sync with server using rclone
async function syncWithServer() {
  if (!workspaceRoot || !serverSettings.ip || !serverSettings.user) {
    updateRunOutput('Error: Workspace not opened or server settings not configured');
    return false;
  }

  try {
    const projectName = workspaceRoot.split(/[/\\]/).pop();
    
    const checkResult = await sendToServer('checkFolder', { folderName: projectName });
    if (!checkResult) {
      updateRunOutput('Error checking folder on server');
      return false;
    }
    
    // Display check result
    if (checkResult.success) {
      updateRunOutput(`Server folder ready: ${checkResult.folderPath}`);
    } else {
      updateRunOutput(`Error preparing server folder: ${checkResult.error}`);
      return false;
    }

    // Get rclone executable path
    let rcloneExecutable = serverSettings.rclonePath || 'rclone';
    
    // Fix rclone path if it's a directory
    if (rcloneExecutable) {
      // Check if path ends with directory separator
      if (rcloneExecutable.endsWith('\\') || rcloneExecutable.endsWith('/')) {
        // Add rclone.exe to directory path
        rcloneExecutable += 'rclone.exe';
      } else if (rcloneExecutable.includes('\\') || rcloneExecutable.includes('/')) {
        // Check if it's a directory (ends with rclone folder name)
        const lastPart = rcloneExecutable.split(/[/\\]/).pop();
        if (lastPart.toLowerCase() === 'rclone') {
          // It's a directory, add .exe
          rcloneExecutable += '.exe';
        }
      }
    }
    
    // Use rclone to sync local to server - ensure all files are synced
    // Use --include "*" to ensure all files are synced, and --progress for detailed output
    const remotePath = `/shareOnling/${projectName}`;
    const rcloneCommand = `${rcloneExecutable} sync "${workspaceRoot}" "cloud-compiler-sftp:${remotePath}" ` +
      `--progress`;
    
    updateRunOutput(`Starting sync: ${rcloneCommand}`);
    
    // Use the new API to execute rclone command via main process
    const result = await window.api.executeRclone(rcloneCommand);
    
    if (result.error) {
      updateRunOutput(`Sync error: ${result.error}`);
      
      // Check if error is about rclone executable not found
      // This should only match errors like "command not found" or "系统找不到指定的文件"
      const isRcloneNotFound = (result.error.includes('系统找不到指定的文件') || 
                              result.error.includes('command not found') || 
                              result.error.includes('The system cannot find')) &&
                             !result.error.includes('didn\'t find section');
      
      if (isRcloneNotFound) {
        updateRunOutput('Error: rclone executable not found. Please specify the full path to rclone.exe in server settings.');
        updateRunOutput('Example: F:\\rclone\\rclone.exe');
        updateRunOutput('Download rclone from: https://rclone.org/downloads/');
      } else {
        // Add troubleshooting tips for other errors
        updateRunOutput('\nTroubleshooting tips:');
        updateRunOutput('1. Check if server IP, username, and password are correct');
        updateRunOutput('2. Ensure SFTP port 22 is open on the server');
        updateRunOutput('3. Verify that the server has SFTP enabled');
        updateRunOutput('4. Check if the remote directory exists on the server');
        updateRunOutput('5. Ensure your network connection is stable');
      }
      
      return false;
    }
    
    if (result.stderr) {
      // Filter out rclone progress messages if needed, but keep important error messages
      const filteredStderr = result.stderr.split('\n')
        .filter(line => !line.startsWith('Transferred:') && !line.startsWith('Elapsed time:') && !line.startsWith('Checking:'))
        .join('\n');
      if (filteredStderr) {
        updateRunOutput(`Sync stderr: ${filteredStderr}`);
      }
    }
    
    if (result.stdout) {
      updateRunOutput(`Sync stdout: ${result.stdout}`);
    }
    
    updateRunOutput('Sync completed successfully - all files synced');
    return true;
  } catch (error) {
    updateRunOutput(`Sync exception: ${error.message}`);
    return false;
  }
}

require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true
  });

  registerCompletionProviders();
  
  // Load server settings on startup
  loadServerSettings();

  monaco.editor.onDidCreateModel((model) => {
    model.onDidChangeContent(() => {
      const t = tabs.find(t => t.model === model);
      if (t && !t.dirty) {
        t.dirty = true;
        updateTabbar();
        updateTitlebar();
      }
    });
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveActiveTab();
  });

  document.getElementById('open-folder').addEventListener('click', async () => {
    const res = await window.api.pickWorkspace();
    if (!res) return;
    applyWorkspace(res.rootPath, res.tree);
  });

  document.getElementById('save-file').addEventListener('click', () => {
    saveActiveTab();
  });

  // Run 按钮
  document.getElementById('run-code').addEventListener('click', () => {
    const active = tabs.find(t => t.path === activeTabPath);
    if (!active) return;
    runCodeOnServer(active.path, active.model.getValue());
  });

  // Server Settings 弹窗
  window.api.onOpenServerSettings(() => {
    // Load saved settings into input fields
    document.getElementById('server-ip').value = serverSettings.ip || '';
    document.getElementById('server-user').value = serverSettings.user || '';
    document.getElementById('server-pass').value = serverSettings.pass || '';
    document.getElementById('rclone-path').value = serverSettings.rclonePath || '';
    document.getElementById('sync-interval').value = serverSettings.syncInterval || 30;
    document.getElementById('server-modal').style.display = 'block';
  });

  document.getElementById('server-save').onclick = async () => {
    const config = {
      ip: document.getElementById('server-ip').value,
      user: document.getElementById('server-user').value,
      pass: document.getElementById('server-pass').value,
      rclonePath: document.getElementById('rclone-path').value || '',
      syncInterval: parseInt(document.getElementById('sync-interval').value) || 30
    };
    // Save settings to file
    try {
      await window.api.writeServerSettings(config);
      serverSettings = config;
      console.log('Server settings saved:', config);
      // Update auto sync interval
      setupAutoSync();
      // Check rclone availability with new path
      await checkRcloneAvailability();
    } catch (error) {
      console.error('Error saving server settings:', error);
    }
    connectServer(config);
    syncWorkspace();
    document.getElementById('server-modal').style.display = 'none';
  };

  document.getElementById('server-close').onclick = () => {
    document.getElementById('server-modal').style.display = 'none';
  };

  window.api.onWorkspaceOpened(({ rootPath, tree }) => applyWorkspace(rootPath, tree));
  window.api.onWorkspaceRefresh(({ rootPath, tree }) => {
    if (rootPath === workspaceRoot) renderTree(tree);
  });

  document.getElementById('workspace-label').textContent = 'No folder opened';
  
  // Setup output resizer
  setupOutputResizer();
  
  // Setup syntax checking
  setupSyntaxChecking();
});

// Setup syntax checking for Monaco Editor
function setupSyntaxChecking() {
  // Listen for model changes to trigger syntax checking
  monaco.editor.onDidCreateModel((model) => {
    model.onDidChangeContent(() => {
      performSyntaxCheck(model);
    });
    // Initial check
    performSyntaxCheck(model);
  });
}

// Perform syntax checking based on language
function performSyntaxCheck(model) {
  const language = model.getLanguageId();
  const content = model.getValue();
  const markers = [];
  
  // Basic syntax checking for different languages
  switch (language) {
    case 'python':
      markers.push(...checkPythonSyntax(content));
      break;
    case 'java':
      markers.push(...checkJavaSyntax(content));
      break;
    case 'cpp':
    case 'c':
      markers.push(...checkCppSyntax(content));
      break;
    case 'go':
      markers.push(...checkGoSyntax(content));
      break;
    case 'rust':
      markers.push(...checkRustSyntax(content));
      break;
    // Add more languages as needed
  }
  
  // Apply markers to the model
  monaco.editor.setModelMarkers(model, 'syntax', markers);
}

// Basic Python syntax checking
function checkPythonSyntax(content) {
  const markers = [];
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for missing colons
    if ((line.trim().startsWith('if ') || line.trim().startsWith('elif ') || 
         line.trim().startsWith('else') || line.trim().startsWith('for ') || 
         line.trim().startsWith('while ') || line.trim().startsWith('try') || 
         line.trim().startsWith('except ') || line.trim().startsWith('finally') || 
         line.trim().startsWith('with ') || line.trim().startsWith('def ') || 
         line.trim().startsWith('class ')) && 
        !line.trim().endsWith(':') && !line.trim().endsWith('#')) {
      markers.push({
        startLineNumber: lineNum,
        endLineNumber: lineNum,
        startColumn: line.length,
        endColumn: line.length + 1,
        message: 'Missing colon at end of line',
        severity: monaco.MarkerSeverity.Error
      });
    }
  });
  
  return markers;
}

// Basic Java syntax checking
function checkJavaSyntax(content) {
  const markers = [];
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for missing semicolons
    if (line.trim() && !line.trim().endsWith(';') && !line.trim().endsWith('{') && 
        !line.trim().endsWith('}') && !line.trim().startsWith('if') && 
        !line.trim().startsWith('else') && !line.trim().startsWith('for') && 
        !line.trim().startsWith('while') && !line.trim().startsWith('try') && 
        !line.trim().startsWith('catch') && !line.trim().startsWith('finally') && 
        !line.trim().startsWith('public') && !line.trim().startsWith('private') && 
        !line.trim().startsWith('protected') && !line.trim().startsWith('class') && 
        !line.trim().startsWith('interface') && !line.trim().startsWith('import') && 
        !line.trim().startsWith('package') && !line.trim().startsWith('//') && 
        !line.trim().startsWith('/*') && !line.trim().endsWith('*/')) {
      markers.push({
        startLineNumber: lineNum,
        endLineNumber: lineNum,
        startColumn: line.length,
        endColumn: line.length + 1,
        message: 'Missing semicolon',
        severity: monaco.MarkerSeverity.Error
      });
    }
  });
  
  return markers;
}

// Basic C/C++ syntax checking
function checkCppSyntax(content) {
  const markers = [];
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for missing semicolons
    if (line.trim() && !line.trim().endsWith(';') && !line.trim().endsWith('{') && 
        !line.trim().endsWith('}') && !line.trim().startsWith('#') && 
        !line.trim().startsWith('if') && !line.trim().startsWith('else') && 
        !line.trim().startsWith('for') && !line.trim().startsWith('while') && 
        !line.trim().startsWith('do') && !line.trim().startsWith('switch') && 
        !line.trim().startsWith('case') && !line.trim().startsWith('default') && 
        !line.trim().startsWith('try') && !line.trim().startsWith('catch') && 
        !line.trim().startsWith('finally') && !line.trim().startsWith('//') && 
        !line.trim().startsWith('/*') && !line.trim().endsWith('*/')) {
      markers.push({
        startLineNumber: lineNum,
        endLineNumber: lineNum,
        startColumn: line.length,
        endColumn: line.length + 1,
        message: 'Missing semicolon',
        severity: monaco.MarkerSeverity.Error
      });
    }
  });
  
  return markers;
}

// Basic Go syntax checking
function checkGoSyntax(content) {
  const markers = [];
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for missing braces
    if (line.trim().startsWith('func ') || line.trim().startsWith('if ') || 
        line.trim().startsWith('else') || line.trim().startsWith('for ') || 
        line.trim().startsWith('switch') || line.trim().startsWith('select')) {
      if (!line.trim().endsWith('{')) {
        markers.push({
          startLineNumber: lineNum,
          endLineNumber: lineNum,
          startColumn: line.length,
          endColumn: line.length + 1,
          message: 'Missing opening brace',
          severity: monaco.MarkerSeverity.Error
        });
      }
    }
  });
  
  return markers;
}

// Basic Rust syntax checking
function checkRustSyntax(content) {
  const markers = [];
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for missing semicolons
    if (line.trim() && !line.trim().endsWith(';') && !line.trim().endsWith('{') && 
        !line.trim().endsWith('}') && !line.trim().startsWith('fn ') && 
        !line.trim().startsWith('if ') && !line.trim().startsWith('else') && 
        !line.trim().startsWith('for ') && !line.trim().startsWith('while ') && 
        !line.trim().startsWith('loop') && !line.trim().startsWith('match') && 
        !line.trim().startsWith('let ') && !line.trim().startsWith('const ') && 
        !line.trim().startsWith('static ') && !line.trim().startsWith('//') && 
        !line.trim().startsWith('/*') && !line.trim().endsWith('*/')) {
      markers.push({
        startLineNumber: lineNum,
        endLineNumber: lineNum,
        startColumn: line.length,
        endColumn: line.length + 1,
        message: 'Missing semicolon',
        severity: monaco.MarkerSeverity.Error
      });
    }
  });
  
  return markers;
}

// Setup output resizer functionality
function setupOutputResizer() {
  const resizer = document.getElementById('output-resizer');
  const layout = document.getElementById('layout');
  
  if (!resizer || !layout) return;
  
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'ns-resize';
    
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      
      const rect = layout.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const totalHeight = rect.height;
      
      // Calculate new heights for editor and output
      const editorHeight = y - 36 - 32; // titlebar + tabbar height
      const outputHeight = totalHeight - y - 4; // resizer height
      
      // Set minimum heights
      if (editorHeight < 100 || outputHeight < 50) return;
      
      // Update grid template rows
      layout.style.gridTemplateRows = `36px 32px ${editorHeight}px 4px ${outputHeight}px`;
    };
    
    const handleMouseUp = () => {
      isResizing = false;
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  });
}

// ===== Workspace & Tree =====
async function applyWorkspace(rootPath, tree) {
  workspaceRoot = rootPath;
  document.getElementById('workspace-label').textContent = rootPath;
  expandedPaths.clear();
  expandedPaths.add(rootPath);
  renderTree(tree);
  
  // Sync with server when opening a new workspace
  await syncWithServer();
}

function renderTree(tree) {
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  const rootUl = document.createElement('ul');
  container.appendChild(rootUl);
  rootUl.appendChild(createTreeItem(tree));
  document.addEventListener('click', closeContextMenu);
}

function createTreeItem(node) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'item ' + (node.type === 'folder' ? 'folder' : 'file');

  const icon = document.createElement('span');
  const name = document.createElement('span');
  name.textContent = node.name;

  const isAlwaysCollapsed = node.type === 'folder' && ALWAYS_COLLAPSED.has(node.name);
  const isExpanded = node.type === 'folder'
    ? expandedPaths.has(node.path) && !isAlwaysCollapsed
    : false;

  icon.textContent = node.type === 'folder'
    ? (isExpanded ? '▾' : '▸')
    : '•';

  row.appendChild(icon);
  row.appendChild(name);
  li.appendChild(row);

  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  };

  if (node.type === 'file') {
    row.onclick = () => openFile(node.path, node.name);
  } else {
    row.onclick = () => {
      const expanded = expandedPaths.has(node.path);
      if (expanded && !isAlwaysCollapsed) {
        expandedPaths.delete(node.path);
      } else {
        expandedPaths.add(node.path);
      }
      const updated = createTreeItem(node);
      li.replaceWith(updated);
    };

    const childrenContainer = document.createElement('ul');
    childrenContainer.style.paddingLeft = '14px';
    li.appendChild(childrenContainer);

    if (isExpanded && node.children && node.children.length) {
      for (const child of node.children) {
        childrenContainer.appendChild(createTreeItem(child));
      }
    }
  }

  return li;
}

function openContextMenu(x, y, node) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addAction = (label, handler) => {
    const a = document.createElement('div');
    a.className = 'action';
    a.textContent = label;
    a.onclick = () => { handler(); closeContextMenu(); };
    menu.appendChild(a);
  };

  if (node.type === 'folder') {
    addAction('New File', () => promptCreate(node.path, 'file'));
    addAction('New Folder', () => promptCreate(node.path, 'folder'));
  }
  addAction('Rename', () => promptRename(node.path));
  addAction('Delete', () => promptDelete(node.path, node.type));

  document.body.appendChild(menu);
  contextMenuEl = menu;
}

function closeContextMenu() {
  if (contextMenuEl && contextMenuEl.parentNode) {
    contextMenuEl.parentNode.removeChild(contextMenuEl);
  }
  contextMenuEl = null;
}

function promptCreate(parentDir, type) {
  const container = document.getElementById('file-tree');
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.placeholder = type === 'file' ? 'newFile.py' : 'NewFolder';
  container.prepend(input);
  input.focus();

  input.onkeydown = async (e) => {
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (!name) return cleanup();
      try {
        if (type === 'file') {
          await window.api.createFile({ parentDir, name });
        } else {
          await window.api.createFolder({ parentDir, name });
        }
        // Refresh file tree by re-reading the workspace without opening dialog
        const res = await window.api.pickWorkspace(workspaceRoot);
        if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
      } finally {
        cleanup();
      }
    } else if (e.key === 'Escape') {
      cleanup();
    }
  };

  function cleanup() {
    if (input && input.parentNode) input.parentNode.removeChild(input);
  }
}

function promptRename(oldPath) {
  const base = oldPath.split(/[/\\]/).pop();
  const container = document.getElementById('file-tree');
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.value = base;
  container.prepend(input);
  input.focus();

  input.onkeydown = async (e) => {
    if (e.key === 'Enter') {
      const newName = input.value.trim();
      if (!newName || newName === base) return cleanup();
      try {
        const result = await window.api.renameEntry({ oldPath, newName });
        if (result && result.path) {
          // Update tab paths if any tab is using the old path
          for (const tab of tabs) {
            if (tab.path === oldPath) {
              tab.path = result.path;
              tab.name = newName;
            }
          }
          // Update active tab path if needed
          if (activeTabPath === oldPath) {
            activeTabPath = result.path;
          }
          updateTabbar();
          updateTitlebar();
        }
      } finally {
        cleanup();
        // Refresh file tree by re-reading the workspace without opening dialog
        const res = await window.api.pickWorkspace(workspaceRoot);
        if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
      }
    } else if (e.key === 'Escape') {
      cleanup();
    }
  };

  function cleanup() {
    if (input && input.parentNode) input.parentNode.removeChild(input);
  }
}

async function promptDelete(entryPath, type) {
  const ok = confirm(`Delete ${type}:\n${entryPath}\nThis cannot be undone.`);
  if (!ok) return;
  await window.api.deleteEntry({ entryPath });
  const res = await window.api.pickWorkspace();
  if (res && res.rootPath === workspaceRoot) renderTree(res.tree);
}

// ===== Tabs =====
async function openFile(filePath, name) {
  const existing = tabs.find(t => t.path === filePath);
  if (existing) {
    activateTab(existing.path);
    return;
  }

  const content = await window.api.readFile(filePath);
  const language = detectLanguage(name, content);
  const uri = monaco.Uri.file(filePath);

  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(content, language, uri);
  } else {
    model.setValue(content);
    monaco.editor.setModelLanguage(model, language);
  }

  const tab = { path: filePath, name, model, language, dirty: false };
  tabs.push(tab);
  activateTab(filePath);
  updateTabbar();
}

// Activate tab
function activateTab(filePath) {
  const tab = tabs.find(t => t.path === filePath);
  if (!tab) return;
  activeTabPath = filePath;
  editor.setModel(tab.model);
  updateTabbar();
  updateTitlebar();
  bindGlobalKeys();
}

// Close tab
function closeTab(filePath) {
  const idx = tabs.findIndex(t => t.path === filePath);
  if (idx === -1) return;

  const tab = tabs[idx];
  // If dirty, ask confirmation
  if (tab.dirty) {
    const ok = confirm(`Close unsaved file?\n${tab.path}\nUnsaved changes will be lost.`);
    if (!ok) return;
  }

  tabs.splice(idx, 1);

  // If it was active, activate a neighbor
  if (activeTabPath === filePath) {
    const next = tabs[idx] || tabs[idx - 1];
    activeTabPath = next ? next.path : null;
    editor.setModel(next ? next.model : null);
  }

  updateTabbar();
  updateTitlebar();
}

// Save active tab
async function saveActiveTab() {
  const tab = tabs.find(t => t.path === activeTabPath);
  if (!tab) return;
  const content = tab.model.getValue();
  await window.api.saveFile({ filePath: tab.path, content });
  tab.dirty = false;
  updateTabbar();
  updateTitlebar();
}

// Tabbar UI
function updateTabbar() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.path === activeTabPath ? ' active' : '');
    const title = document.createElement('span');
    title.textContent = t.dirty ? `${t.name} *` : t.name;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';

    el.onclick = () => activateTab(t.path);
    close.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };

    el.appendChild(title);
    el.appendChild(close);
    bar.appendChild(el);
  }
}

// Titlebar label shows workspace and active file
function updateTitlebar() {
  const label = document.getElementById('workspace-label');
  const base = workspaceRoot ? workspaceRoot : 'No folder opened';
  const active = tabs.find(t => t.path === activeTabPath);
  label.textContent = active
    ? `${base} — ${active.path}${active.dirty ? ' *' : ''}`
    : base;
}

// Global keys: F2 rename current file, Delete delete current file
function bindGlobalKeys() {
  window.onkeydown = async (e) => {
    const active = tabs.find(t => t.path === activeTabPath);
    if (!active) return;

    if (e.key === 'F2') {
      e.preventDefault();
      promptRename(active.path);
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      promptDelete(active.path, 'file');
    }
  };
}

// Language detection: by extension + shebang
function detectLanguage(filename, content) {
  const f = filename.toLowerCase();
  if (f.endsWith('.ts')) return 'typescript';
  if (f.endsWith('.js')) return 'javascript';
  if (f.endsWith('.jsx')) return 'javascript';
  if (f.endsWith('.tsx')) return 'typescript';
  if (f.endsWith('.py')) return 'python';
  if (f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.cxx')) return 'cpp';
  if (f.endsWith('.c')) return 'c';
  if (f.endsWith('.java')) return 'java';
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.md')) return 'markdown';
  if (f.endsWith('.html')) return 'html';
  if (f.endsWith('.css')) return 'css';
  if (f.endsWith('.sh')) return 'shell';
  if (f.endsWith('.go')) return 'go';
  if (f.endsWith('.rs')) return 'rust';
  // shebang check
  if (content && content.startsWith('#!')) {
    if (content.includes('python')) return 'python';
    if (content.includes('node')) return 'javascript';
    if (content.includes('bash') || content.includes('sh')) return 'shell';
    if (content.includes('go')) return 'go';
    if (content.includes('rust')) return 'rust';
  }
  return 'plaintext';
}

// Run code on server
async function runCodeOnServer(filePath, content) {
  if (!workspaceRoot || !serverSettings.ip) {
    updateRunOutput('Error: Workspace not opened or server not configured');
    return;
  }

  try {
    // Sync with server before running
    const syncSuccess = await syncWithServer();
    if (!syncSuccess) {
      updateRunOutput('Error: Failed to sync with server before running');
      return;
    }

    const projectName = workspaceRoot.split(/[/\\]/).pop();
    const relativeFilePath = filePath.replace(workspaceRoot, '').replace(/^[/\\]/, '');
    
    updateRunOutput(`Running code: ${relativeFilePath}`);
    
    // Send run request to server
    const runResult = await sendToServer('runCode', {
      folderName: projectName,
      filePath: relativeFilePath,
      content: content
    });
    
    if (runResult) {
      if (runResult.success) {
        updateRunOutput('\n=== RUN SUCCESS ===');
        if (runResult.output) {
          updateRunOutput('Output:');
          updateRunOutput(runResult.output);
        }
        if (runResult.error) {
          updateRunOutput('Warnings:');
          updateRunOutput(runResult.error);
        }
        updateRunOutput(`Return code: ${runResult.returncode}`);
      } else {
        updateRunOutput('\n=== RUN FAILED ===');
        if (runResult.error) {
          updateRunOutput('Error:');
          updateRunOutput(runResult.error);
        }
        if (runResult.returncode !== undefined) {
          updateRunOutput(`Return code: ${runResult.returncode}`);
        }
      }
    } else {
      updateRunOutput('Error: Failed to get run result from server');
    }
  } catch (error) {
    updateRunOutput(`Run error: ${error.message}`);
  }
}

// Setup auto sync
function setupAutoSync() {
  // Clear existing interval if any
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
  }

  const interval = serverSettings.syncInterval || 30;
  if (interval > 0) {
    updateRunOutput(`Setting up auto sync every ${interval} seconds`);
    autoSyncInterval = setInterval(() => {
      syncWithServer();
    }, interval * 1000);
  }
}

// Connect to server (placeholder)
function connectServer(config) {
  updateRunOutput('Connecting to server...');
  // This function can be expanded for additional connection logic if needed
}

// Sync workspace (placeholder)
function syncWorkspace() {
  syncWithServer();
}

