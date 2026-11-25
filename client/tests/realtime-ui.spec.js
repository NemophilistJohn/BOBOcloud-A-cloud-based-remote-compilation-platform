'use strict';
const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const esbuild = require('esbuild');
const vm = require('node:vm');

test('two workbenches converge through split renames, offline drafts, deletion votes, cursors, undo and a shared run', async () => {
  test.setTimeout(120000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-realtime-ui-'));
  const moduleValue = { exports: {} };
  const code = esbuild.buildSync({ entryPoints: ['src/realtime-document.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
  const { SharedDocument } = moduleValue.exports;
  let after = '';
  const initial = Array.from('print("hello")\n', (value, i) => {
    const id = '0000000000000000:base:' + String(i).padStart(8, '0');
    const node = { id, after, value }; after = id; return node;
  });
  const doc = new SharedDocument('server', initial);
  const documents = new Map([['f1', doc]]);
  const offlineUsers = new Set();
  let nextFile = 0, nextDelete = 0;
  const room = { enabled: true, epoch: 'epoch-fixture', branch: 'main', revision: 1,
    files: [{ id: 'f1', path: 'main.py', revision: 1 }], presence: [], deletions: [], run: null };
  const sockets = new Map();
  const broadcast = value => { for (const socket of sockets.keys()) if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    if (req.url === '/fixture/getRealtimeState') res.end(JSON.stringify({ success: true, data: room }));
    else if (req.url === '/fixture/getRealtimeSnapshot') res.end(JSON.stringify({ success: true, data: { ...room, files: room.files.map(file => ({ ...file, content: documents.get(file.id)?.text() || '' })) } }));
    else res.end('{"success":true}');
  });
  const ws = new WebSocketServer({ server, path: '/collaboration' });
  ws.on('connection', socket => {
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    const ack = () => socket.send(JSON.stringify({ type: 'ack', requestId: message.requestId }));
    if (message.type === 'join') {
      if (offlineUsers.has(message.token)) { socket.close(1013, 'fixture offline'); return; }
      sockets.set(socket, message); socket.send(JSON.stringify({ type: 'state', state: room }));
    }
    else if (message.type === 'open') socket.send(JSON.stringify({ type: 'document', requestId: message.requestId, file: { ...room.files.find(f => f.id === message.fileId), content: documents.get(message.fileId)?.text() || '', nodes: documents.get(message.fileId)?.snapshot() || [] } }));
    else if (message.type === 'edit') { documents.get(message.fileId).apply(message); broadcast({ ...message, type: 'operation', revision: ++room.revision }); ack(); }
    else if (message.type === 'presence') {
      const joined = sockets.get(socket), userId = joined.token;
      room.presence = room.presence.filter(p => p.sessionId !== joined.sessionId);
      room.presence.push({ userId, sessionId: joined.sessionId, name: userId, avatar: 'forest', panes: message.panes });
      broadcast({ type: 'presence', presence: room.presence, deletions: room.deletions }); ack();
    } else if (message.type === 'create') {
      const id = 'created-' + (++nextFile);
      room.files.push({ id, path: message.path, directory: message.directory, revision: ++room.revision });
      if (!message.directory) documents.set(id, new SharedDocument('server', []));
      broadcast({ type: 'state', state: room }); ack();
    } else if (message.type === 'rename') {
      room.files.find(file => file.id === message.fileId).path = message.path;
      room.revision++;
      broadcast({ type: 'state', state: room }); ack();
    } else if (message.type === 'deleteRequest') {
      room.deletions.push({ id: 'delete-' + (++nextDelete), fileId: message.fileId, requestedBy: sockets.get(socket).token,
        expiresAt: new Date(Date.now() + 180000).toISOString(), electorate: ['Alice', 'Bob'], consents: { [sockets.get(socket).token]: true } });
      broadcast({ type: 'state', state: room }); ack();
    } else if (message.type === 'deleteVote') {
      const vote = room.deletions.find(vote => vote.id === message.deleteId);
      if (message.decision === 'consent') vote.consents[sockets.get(socket).token] = true;
      if (message.decision !== 'consent' || vote.electorate.every(user => vote.consents[user])) {
        if (message.decision === 'consent') room.files = room.files.filter(file => file.id !== vote.fileId);
        room.deletions = room.deletions.filter(item => item.id !== vote.id);
      }
      room.revision++; broadcast({ type: 'state', state: room }); ack();
    } else if (message.type === 'run') {
      room.run = { id: 'one-run', status: 'running', starterUserId: sockets.get(socket).token, events: [] };
      broadcast({ type: 'state', state: room }); ack();
      for (const event of [{ type: 'status', message: 'Running shared snapshot', stage: 'run:python' }, { type: 'stdout', line: 'shared hello' }, { type: 'result', success: true, returncode: 0 }]) {
        room.run.events.push(event); broadcast({ type: 'runEvent', runId: 'one-run', event });
      }
    } else ack();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apps = [];
  async function focusEditor(page, index, resetPosition = true) {
    // Separate Electron processes have separate native windows. Selecting a
    // textarea in a background window is insufficient on a Windows runner.
    const nativeWindow = await apps[index].browserWindow(page);
    await nativeWindow.evaluate(window => { window.show(); window.focus(); });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.evaluate(reset => {
      const editor = window.BOBO.views.getActiveEditor();
      if (reset) editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
    }, resetPosition);
    await expect.poll(() => page.evaluate(() => window.BOBO.views.getActiveEditor().hasTextFocus())).toBe(true);
  }
  try {
    for (const user of ['Alice', 'Bob']) {
      const directory = path.join(sandbox, user), workspace = path.join(directory, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      const mapping = { teamId: 'team', projectId: 'project', branch: 'main', localPath: workspace, projectName: 'Shared project' };
      fs.writeFileSync(path.join(workspace, '.bobocloud-team.json'), JSON.stringify(mapping));
      const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--user-data-dir=' + path.join(directory, 'chromium')],
        env: { ...process.env, APPDATA: directory, USERPROFILE: directory, HOME: directory, XDG_CONFIG_HOME: directory } });
      apps.push(app);
      const page = await app.firstWindow();
      await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true');
      await page.evaluate(() => {
        window.__sharedInputEvidence = [];
        for (const type of ['keydown', 'input', 'focusin', 'focusout']) document.addEventListener(type, event => {
          window.__sharedInputEvidence.push({ type, key: event.key, target: event.target.className,
            focused: document.hasFocus(), active: document.activeElement?.className });
          if (window.__sharedInputEvidence.length > 80) window.__sharedInputEvidence.shift();
        }, true);
      });
      await page.evaluate(async ({ workspace, mapping, user, port, room, snapshot }) => {
        const b = window.BOBO;
        await window.api.writeServerSettings({ ip: '127.0.0.1', httpPort: port, wsPort: port, secureTransport: false });
        await window.api.authSet({ token: user, user: { id: user, uid: user, name: user } });
        b.state.serverSettings = { ...b.state.serverSettings, ip: '127.0.0.1', httpPort: port, wsPort: port, secureTransport: false };
        b.state.auth = { ...b.state.auth, mode: 'multi', token: user, user: { id: user, uid: user, name: user } };
        b.state.selectedRuntime = 'python:3.10';
        b.sendToServer = async action => {
          if (action === 'getRealtimeState' || action === 'getRealtimeSnapshot') return (await fetch('http://127.0.0.1:' + port + '/fixture/' + action)).json();
          return { success: true, data: [] };
        };
        const opened = await window.api.pickWorkspace(workspace);
        await b.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
        b.state.collaboration.current = mapping;
        await b.realtime.openProject({}, mapping);
        await b.workspace.openFile(workspace + '/main.py', 'main.py');
      }, { workspace, mapping, user, port, room, snapshot: doc.text() });
      await expect(page.locator('.realtime-panel')).toHaveCount(1);
    }
    const a = await apps[0].firstWindow(), b = await apps[1].firstWindow();
    await expect.poll(() => a.evaluate(() => window.BOBO.state.editor.getValue())).toContain('hello');
    await focusEditor(a, 0);
    await a.keyboard.type('#Alice\n');
    await expect.poll(() => b.evaluate(() => window.BOBO.state.editor.getValue())).toContain('#Alice');
    await focusEditor(b, 1);
    await b.keyboard.type('#Bob\n');
    await expect.poll(() => a.evaluate(() => window.BOBO.state.editor.getValue())).toContain('#Bob');
    await expect(a.locator('.realtime-cursor-label').filter({ hasText: 'Bob' })).toBeVisible();
    const fileRow = a.locator('#file-tree .tree-row[data-type="file"][data-path$="main.py"]');
    await expect(fileRow.locator('.realtime-tree-people')).toBeVisible();
    expect(await fileRow.evaluate(row => {
      const people = row.querySelector('.realtime-tree-people');
      const sync = row.querySelector('.tree-sync-rail');
      if (!people || !sync) return false;
      const peopleRect = people.getBoundingClientRect(), syncRect = sync.getBoundingClientRect();
      const before = syncRect.right;
      people.remove();
      const after = sync.getBoundingClientRect().right;
      return peopleRect.right <= syncRect.left && Math.abs(before - after) < 1;
    })).toBe(true);
    await focusEditor(a, 0, false);
    await a.keyboard.press('Control+z');
    await expect.poll(() => b.evaluate(() => window.BOBO.state.editor.getValue())).not.toContain('#Alice');
    await expect.poll(() => b.evaluate(() => window.BOBO.state.editor.getValue())).toContain('#Bob');
    await a.evaluate(() => window.BOBO.realtime.fileOperation('create', window.BOBO.state.workspaceRoot + '/second.py'));
    await expect(b.locator('[data-path$="second.py"]').first()).toBeAttached();
    await a.evaluate(() => window.BOBO.realtime.run(window.BOBO.state.workspaceRoot + '/main.py'));
    await expect(a.locator('#panel-output')).toContainText('shared hello');
    await expect(b.locator('#panel-output')).toContainText('shared hello');
    await expect.poll(() => b.evaluate(() => window.BOBO.state.editor.getValue())).toBe(await a.evaluate(() => window.BOBO.state.editor.getValue()));
    // A remote rename replaces the file model once, preserving both panes and the active path.
    await a.evaluate(() => {
      window.BOBO.views.openSplit();
      window.__beforeRenameModel = window.BOBO.views.getActiveEditor().getModel();
    });
    await b.evaluate(() => window.BOBO.realtime.fileOperation('rename', window.BOBO.state.workspaceRoot + '/main.py', window.BOBO.state.workspaceRoot + '/renamed.py'));
    for (const page of [a, b]) {
      await expect.poll(() => page.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().uri.fsPath.replace(/\\/g, '/').split('/').pop()))).toEqual(page === a ? ['renamed.py', 'renamed.py'] : ['renamed.py']);
      await expect.poll(() => page.evaluate(() => window.BOBO.state.activeTabPath.replace(/\\/g, '/').split('/').pop())).toBe('renamed.py');
    }
    expect(await a.evaluate(() => {
      const [left, right] = window.BOBO.views.getVisibleEditors();
      window.__renamedMainModel = left.getModel();
      return left.getModel() === right.getModel() && window.__beforeRenameModel.isDisposed();
    })).toBe(true);
    await focusEditor(a, 0);
    await a.keyboard.type('#afterMainRename\n');
    await expect.poll(() => b.evaluate(() => window.BOBO.views.getActiveEditor().getValue())).toContain('#afterMainRename');

    // A second rename updates only the assigned right pane and preserves the left document.
    await a.evaluate(async () => window.BOBO.workspace.openFile(window.BOBO.state.workspaceRoot + '/second.py', 'second.py'));
    await b.evaluate(() => window.BOBO.realtime.fileOperation('rename', window.BOBO.state.workspaceRoot + '/second.py', window.BOBO.state.workspaceRoot + '/helper.py'));
    await expect.poll(() => a.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().uri.fsPath.replace(/\\/g, '/').split('/').pop()))).toEqual(['renamed.py', 'helper.py']);
    await b.evaluate(async () => window.BOBO.workspace.openFile(window.BOBO.state.workspaceRoot + '/helper.py', 'helper.py'));
    await focusEditor(a, 0);
    await a.keyboard.type('#helperAfterRename\n');
    await expect.poll(() => b.evaluate(() => window.BOBO.views.getActiveEditor().getValue())).toContain('#helperAfterRename');

    // One client can edit a durable local draft while the other keeps editing online.
    offlineUsers.add('Alice');
    for (const [socket, joined] of sockets) if (joined.token === 'Alice') socket.terminate();
    const offlineStatus = await a.evaluate(() => window.BOBO.i18n.t('Collaboration is reconnecting. Your edits are kept locally.'));
    await expect(a.locator('.realtime-panel > header [role="status"]')).toHaveText(offlineStatus);
    await focusEditor(a, 0);
    await a.keyboard.type('#offlineAlice\n');
    await expect.poll(() => a.evaluate(async () => (await window.api.realtimeDrafts()).drafts.some(draft => draft.pending.length && draft.text.includes('#offlineAlice')))).toBe(true);
    expect(await b.evaluate(() => window.BOBO.views.getActiveEditor().getValue())).not.toContain('#offlineAlice');
    await focusEditor(b, 1);
    await b.keyboard.type('#onlineBob\n');
    offlineUsers.delete('Alice');
    for (const page of [a, b]) {
      await expect.poll(() => page.evaluate(() => window.BOBO.views.getActiveEditor().getValue()), { timeout: 20000 }).toContain('#offlineAlice');
      await expect.poll(() => page.evaluate(() => window.BOBO.views.getActiveEditor().getValue()), { timeout: 20000 }).toContain('#onlineBob');
      await expect.poll(() => page.evaluate(async () => (await window.api.realtimeDrafts()).drafts.some(draft => draft.pending.length)), { timeout: 20000 }).toBe(false);
    }
    expect(await a.evaluate(() => window.BOBO.views.getActiveEditor().getValue())).toBe(await b.evaluate(() => window.BOBO.views.getActiveEditor().getValue()));
    for (const user of ['Alice', 'Bob']) {
      const workspace = path.join(sandbox, user, 'workspace');
      await expect.poll(() => fs.readFileSync(path.join(workspace, 'helper.py'), 'utf8')).toContain('#offlineAlice');
      expect(fs.existsSync(path.join(workspace, 'main.py'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'second.py'))).toBe(false);
    }

    // The requester can cancel a vote through the visible panel without deleting anything.
    await a.evaluate(() => window.BOBO.realtime.fileOperation('delete', window.BOBO.state.workspaceRoot + '/renamed.py'));
    await b.evaluate(() => window.BOBO.switchToPanel('team'));
    await expect(a.locator('.realtime-delete [data-decision="cancel"]')).toBeVisible();
    await expect(b.locator('.realtime-delete [data-decision="consent"]')).toBeVisible();
    await a.locator('.realtime-delete [data-decision="cancel"]').click();
    for (const page of [a, b]) await expect(page.locator('.realtime-delete')).toHaveCount(0);
    expect(room.files.some(file => file.id === 'f1')).toBe(true);
    expect(await a.evaluate(() => window.__renamedMainModel.isDisposed())).toBe(false);

    // Consent from the other editor removes the file in both workbenches and detaches its model.
    await a.evaluate(() => window.BOBO.realtime.fileOperation('delete', window.BOBO.state.workspaceRoot + '/renamed.py'));
    await expect(b.locator('.realtime-delete [data-decision="consent"]')).toBeVisible();
    await b.locator('.realtime-delete [data-decision="consent"]').click();
    for (const page of [a, b]) {
      await expect(page.locator('.realtime-delete')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.BOBO.state.tabs.some(tab => tab.name === 'renamed.py'))).toBe(false);
      await expect.poll(() => page.evaluate(() => window.BOBO.views.getVisibleEditors().every(editor => editor.getModel() && editor.getModel().uri.fsPath.endsWith('helper.py')))).toBe(true);
    }
    expect(await a.evaluate(() => window.__renamedMainModel.isDisposed())).toBe(true);
    for (const user of ['Alice', 'Bob']) await expect.poll(() => fs.existsSync(path.join(sandbox, user, 'workspace', 'renamed.py'))).toBe(false);

    // A process that exits while live keeps a durable marker until the final Git snapshot is reconciled.
    for (const user of ['Alice', 'Bob']) {
      const workspace = path.join(sandbox, user, 'workspace');
      await expect.poll(() => JSON.parse(fs.readFileSync(path.join(workspace, '.bobocloud-team.json'), 'utf8')).realtimeEpoch).toBe('epoch-fixture');
      fs.writeFileSync(path.join(workspace, 'unopened.txt'), 'stale unopened local snapshot\n');
      fs.writeFileSync(path.join(workspace, 'orphan-local.txt'), 'removed from the canonical Git snapshot\n');
    }
    for (const page of [a, b]) expect(await page.evaluate(() => window.BOBO.state.tabs.some(tab => tab.name === 'unopened.txt'))).toBe(false);
    const bobProcess = apps[1].process();
    const bobExited = new Promise(resolve => bobProcess.exitCode !== null ? resolve() : bobProcess.once('exit', resolve));
    await apps[1].evaluate(({ app }) => app.exit(0));
    await bobExited;
    const bobWorkspace = path.join(sandbox, 'Bob', 'workspace');
    expect(JSON.parse(fs.readFileSync(path.join(bobWorkspace, '.bobocloud-team.json'), 'utf8')).realtimeEpoch).toBe('epoch-fixture');

    const helper = room.files.find(file => file.path === 'helper.py');
    const helperBeforeExit = documents.get(helper.id).text();
    const finalHelper = helperBeforeExit + '#mode-exit-canonical' + (helperBeforeExit.includes('\r\n') ? '\r\n' : '\n');
    const checkpoint = new SharedDocument('server', []);
    checkpoint.apply(checkpoint.change([{ rangeOffset: 0, rangeLength: 0, text: finalHelper }]));
    documents.set(helper.id, checkpoint);
    const unopened = new SharedDocument('server', []);
    unopened.apply(unopened.change([{ rangeOffset: 0, rangeLength: 0, text: 'authoritative unopened Git file\n' }]));
    documents.set('unopened-final', unopened);
    room.files.push({ id: 'unopened-final', path: 'unopened.txt', revision: ++room.revision });
    room.enabled = false;
    room.epoch = 'epoch-git-final';
    broadcast({ type: 'state', state: room });
    await expect.poll(() => a.evaluate(() => window.BOBO.realtime.isActive())).toBe(false);
    await expect.poll(() => a.evaluate(() => window.BOBO.views.getVisibleEditors().map(editor => editor.getModel().getValue()))).toEqual([finalHelper, finalHelper]);
    expect(await a.evaluate(() => window.BOBO.state.tabs.every(tab => !tab.dirty))).toBe(true);
    const aliceWorkspace = path.join(sandbox, 'Alice', 'workspace');
    await expect.poll(() => fs.readFileSync(path.join(aliceWorkspace, 'unopened.txt'), 'utf8')).toBe('authoritative unopened Git file\n');
    expect(fs.readFileSync(path.join(aliceWorkspace, 'helper.py'), 'utf8')).toBe(finalHelper);
    expect(fs.existsSync(path.join(aliceWorkspace, 'orphan-local.txt'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(aliceWorkspace, '.bobocloud-team.json'), 'utf8')).realtimeEpoch || '').toBe('');
    // Bob was offline throughout the transition: his files and marker are still stale on disk.
    expect(fs.readFileSync(path.join(bobWorkspace, 'unopened.txt'), 'utf8')).toBe('stale unopened local snapshot\n');
    expect(fs.readFileSync(path.join(bobWorkspace, 'helper.py'), 'utf8')).not.toBe(finalHelper);

    const bobDirectory = path.join(sandbox, 'Bob');
    const restarted = await electron.launch({ executablePath: require('electron'), args: ['.', '--user-data-dir=' + path.join(bobDirectory, 'chromium')],
      env: { ...process.env, APPDATA: bobDirectory, USERPROFILE: bobDirectory, HOME: bobDirectory, XDG_CONFIG_HOME: bobDirectory } });
    apps.push(restarted);
    const resumed = await restarted.firstWindow();
    await resumed.waitForFunction(() => document.documentElement.dataset.boboReady === 'true');
    const restartState = await resumed.evaluate(async ({ workspace, port }) => {
      const b = window.BOBO;
      b.sendToServer = async action => {
        if (action === 'getRealtimeState' || action === 'getRealtimeSnapshot') return (await fetch('http://127.0.0.1:' + port + '/fixture/' + action)).json();
        return { success: true, data: [] };
      };
      const opened = await window.api.pickWorkspace(workspace);
      await b.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
      b.collaboration.restoreMapping(opened.teamMapping, opened.rootPath);
      const pendingReconciliation = b.realtime.isActive();
      const persistedEpoch = opened.teamMapping.realtimeEpoch;
      await b.realtime.openProject({}, b.state.collaboration.current);
      await b.workspace.openFile(workspace + '/helper.py', 'helper.py');
      return { pendingReconciliation, persistedEpoch, activeAfterReconciliation: b.realtime.isActive(), text: b.state.editor.getModel().getValue() };
    }, { workspace: bobWorkspace, port });
    expect(restartState).toEqual({ pendingReconciliation: true, persistedEpoch: 'epoch-fixture', activeAfterReconciliation: false, text: finalHelper });
    expect(fs.readFileSync(path.join(bobWorkspace, 'unopened.txt'), 'utf8')).toBe('authoritative unopened Git file\n');
    expect(fs.readFileSync(path.join(bobWorkspace, 'helper.py'), 'utf8')).toBe(finalHelper);
    expect(fs.existsSync(path.join(bobWorkspace, 'orphan-local.txt'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(bobWorkspace, '.bobocloud-team.json'), 'utf8')).realtimeEpoch || '').toBe('');


  } catch (error) {
    for (const [index, app] of apps.entries()) {
      try {
        const page = await app.firstWindow();
        const evidence = await page.evaluate(() => ({ events: window.__sharedInputEvidence,
          text: window.BOBO.views.getActiveEditor()?.getValue(), focused: document.hasFocus(),
          active: document.activeElement?.className, readOnly: window.BOBO.views.getActiveEditor()?.getRawOptions().readOnly }));
        await test.info().attach('shared-input-' + index, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      } catch (_) {}
    }
    throw error;
  } finally {
    for (const app of apps) { try { await app.evaluate(({ app }) => app.exit(0)); } catch (_) {} }
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
