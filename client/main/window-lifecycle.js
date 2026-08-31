'use strict';

function attachWindowLifecycle(options) {
  const owner = options.window;
  const {
    dialog, languagePacks, lifecycle, localDirectories, packageCenter,
    rcloneService, windowState, workspace
  } = options;
  let saveTimer = null;
  let closeApproved = false;
  let closeDecisionPending = false;
  let finishWorkspaceClose = null;
  let approvedLeaveToken = null;

  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(windowState.save, 300);
  };
  owner.on('resize', saveSoon);
  owner.on('move', saveSoon);
  owner.on('maximize', saveSoon);
  owner.on('unmaximize', saveSoon);

  owner.on('close', (event) => {
    windowState.save();
    if (closeApproved) return;
    event.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    workspace.requestRendererLeave('window-close', null).then(async (decision) => {
      if (owner.isDestroyed()) return;
      if (!decision.allowed) {
        if (!decision.timedOut) {
          workspace.abortRendererLeave(decision.leaveToken);
          return;
        }
        const response = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: languagePacks.t('The workbench is not responding.'),
          message: languagePacks.t('The workbench is not responding.'),
          detail: languagePacks.t('Closing now may discard unsaved changes. Close anyway?'),
          buttons: [languagePacks.t('Cancel'), languagePacks.t('Close Anyway')],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        if (response.response !== 1) {
          workspace.abortRendererLeave(decision.leaveToken);
          return;
        }
      }
      approvedLeaveToken = decision.leaveToken;
      const prepared = await workspace.prepareWindowClose();
      finishWorkspaceClose = prepared.complete;
      closeApproved = true;
      owner.close();
    }).catch(async (error) => {
      if (finishWorkspaceClose) {
        try { await finishWorkspaceClose('window-close-aborted'); } catch (_) {}
        finishWorkspaceClose = null;
      }
      workspace.abortRendererLeave(approvedLeaveToken);
      approvedLeaveToken = null;
      console.error('[lifecycle] window close preparation failed:', error && error.message ? error.message : error);
    }).finally(() => {
      closeDecisionPending = false;
    });
  });

  owner.on('closed', () => {
    clearTimeout(saveTimer);
    workspace.handleWindowClosed();
    if (finishWorkspaceClose) {
      void finishWorkspaceClose('window-close-complete');
      finishWorkspaceClose = null;
    }
    void lifecycle.run('window-closed');
    if (typeof options.onClosed === 'function') options.onClosed(owner);
  });

  owner.webContents.on('render-process-gone', () => {
    const senderId = owner.webContents.id;
    workspace.handleRendererGone();
    void packageCenter.preserveAll('renderer-gone');
    localDirectories.revokeSender(senderId);
    void rcloneService.cancelSender(senderId, 'renderer-gone');
    void lifecycle.run('renderer-gone');
  });
}

module.exports = { attachWindowLifecycle };
