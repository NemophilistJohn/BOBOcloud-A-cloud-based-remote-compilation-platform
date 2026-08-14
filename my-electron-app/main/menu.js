function createMenuController(options) {
  const Menu = options.Menu;
  const dialog = options.dialog;
  const getWindow = options.getWindow;
  const languagePacks = options.languagePacks;
  const getAuthState = options.getAuthState;
  const pickAndOpenWorkspace = options.pickAndOpenWorkspace;
  const t = languagePacks.t;

  function send(channel, payload) {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }

  function runLanguagePackTask(task) {
    Promise.resolve(task).catch((error) => {
      dialog.showErrorBox(t('Language Pack Error'), error && error.message ? error.message : String(error));
    });
  }

  function buildTemplate() {
    const template = [
      {
        label: t('File'),
        submenu: [
          { label: t('Open Folder...'), accelerator: 'CommandOrControl+O', click: pickAndOpenWorkspace },
          { type: 'separator' },
          { label: t('Server Projects...'), click: () => send('open-server-projects') },
          { type: 'separator' },
          { label: t('Save'), accelerator: 'CommandOrControl+S', click: () => send('menu-save') },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: t('Settings'),
        submenu: [
          { label: t('Server Settings'), click: () => send('open-server-settings') },
          { label: t('Diagnostics Settings'), click: () => send('open-diagnostics-settings') },
          { type: 'separator' },
          { label: t('AI Settings'), click: () => send('open-ai-settings') },
          { type: 'separator' },
          {
            label: t('Display Language'),
            submenu: languagePacks.list().packs.map((pack) => ({
              label: pack.manifest.nativeName,
              type: 'radio',
              checked: pack.manifest.id === languagePacks.getActiveId(),
              click: () => languagePacks.setActive(pack.manifest.id)
            }))
          },
          { label: t('Install Language Pack...'), click: () => runLanguagePackTask(languagePacks.installFromDialog()) },
          { label: t('Open Language Pack Folder'), click: () => runLanguagePackTask(languagePacks.openFolder()) }
        ]
      },
      {
        label: t('Account'),
        submenu: [
          { label: t('Login / Register...'), accelerator: 'CommandOrControl+L', click: () => send('open-auth-login') },
          { label: t('Logout'), click: () => send('auth-logout-request') }
        ]
      }
    ];

    const authState = getAuthState();
    if (authState.loggedIn && (authState.role === 'admin' || authState.role === 'root')) {
      template.push({
        label: t('Manage'),
        submenu: [
          { label: t('Administration...'), click: () => send('open-admin-panel', { tab: 'users' }) },
          { type: 'separator' },
          { label: t('Users'), click: () => send('open-admin-panel', { tab: 'users' }) },
          { label: t('Invite Codes'), click: () => send('open-admin-panel', { tab: 'invites' }) },
          { label: t('Audit Log'), click: () => send('open-admin-panel', { tab: 'audit' }) }
        ]
      });
    }

    const editSubmenu = [
      { label: t('Undo'), role: 'undo' },
      { label: t('Redo'), role: 'redo' },
      { type: 'separator' },
      { label: t('Cut'), role: 'cut' },
      { label: t('Copy'), role: 'copy' },
      { label: t('Paste'), role: 'paste' },
      { label: t('Paste and Match Style'), role: 'pasteAndMatchStyle' },
      { label: t('Delete'), role: 'delete' },
      { type: 'separator' },
      { label: t('Select All'), role: 'selectAll' }
    ];
    if (process.platform === 'darwin') {
      editSubmenu.push(
        { type: 'separator' },
        {
          label: t('Speech'),
          submenu: [
            { label: t('Start Speaking'), role: 'startSpeaking' },
            { label: t('Stop Speaking'), role: 'stopSpeaking' }
          ]
        }
      );
    }
    template.push({ label: t('Edit'), submenu: editSubmenu });
    template.push({
      label: t('View'),
      submenu: [
        { label: t('Reload'), role: 'reload' },
        { label: t('Force Reload'), role: 'forceReload' },
        { label: t('Toggle Developer Tools'), role: 'toggleDevTools' },
        { type: 'separator' },
        { label: t('Actual Size'), role: 'resetZoom' },
        { label: t('Zoom In'), role: 'zoomIn' },
        { label: t('Zoom Out'), role: 'zoomOut' },
        { type: 'separator' },
        { label: t('Toggle Full Screen'), role: 'togglefullscreen' },
        { type: 'separator' },
        { label: t('Theme...'), click: () => send('theme-open-picker') }
      ]
    });
    return template;
  }

  function rebuild() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
  }

  return { rebuild, buildTemplate };
}

module.exports = { createMenuController };
