'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { endpoint } = require('./server-transport');
const { credentialForServer, serverAccountIdentity, serverEndpointIdentity } = require('./server-identity');
const { createCloudWebSocketFactory, createCloudPeerVerifier } = require('./cloud-websocket');
const { readTeamMapping } = require('./team-mapping');
const { writeFileAtomic } = require('./atomic-file');

const MAX_BYTES = 64 * 1024 * 1024;
const TYPES = new Set(['open', 'close', 'edit', 'presence', 'heartbeat', 'create', 'rename', 'deleteRequest', 'deleteVote', 'run', 'stdin', 'cancelRun']);

function createRealtimeController({ ipcMain, settings, dialog, getWindow, prepareTransition, getWorkspaceIdentity, runMutation, notifyWorkspaceFiles,
  sendToRenderer, userDataPath, factory = createCloudWebSocketFactory, verifier = createCloudPeerVerifier }) {
  let current = null;
  let generation = 0;
  let draftQueue = Promise.resolve();
  const draftContexts = new Set();

  function emit(message) {
    if (current) sendToRenderer('realtime:message', { ...message, workspaceIdentity: current.identity.workspaceIdentity });
  }
  function close(reason) {
    if (typeof reason === 'string') emit({ type: 'reset', reason });
    generation++;
    const previous = current;
    current = null;
    if (previous) {
      clearTimeout(previous.connectTimer);
      clearInterval(previous.heartbeat);
      previous.reject?.(new Error('Collaboration connection closed'));
      previous.socket?.terminate();
    }
  }
  function assertContext(session) {
    const identity = getWorkspaceIdentity();
    if (!session || session !== current || identity.rootPath !== session.identity.rootPath ||
        identity.workspaceIdentity !== session.identity.workspaceIdentity) throw new Error('Collaboration workspace changed');
  }
  async function persistEpoch(session, epoch) {
    if (session.mapping.realtimeEpoch === epoch) return;
    await runMutation(session.identity.rootPath, async mutation => {
      assertContext(session); mutation.assertCurrent();
      const target = path.join(session.identity.rootPath, '.bobocloud-team.json');
      mutation.resolvePath(target);
      const mapping = { ...session.mapping, realtimeEpoch: epoch };
      await writeFileAtomic(target, JSON.stringify(mapping), {
        maxBytes: 32768, beforeReplace: () => { assertContext(session); mutation.assertCurrent(); }
      });
      session.mapping = mapping;
    });
  }
  async function connect(payload) {
    close();
    const turn = generation;
    const identity = getWorkspaceIdentity();
    const mapping = identity?.rootPath && readTeamMapping(identity.rootPath, { requireLocalPath: true });
    if (!mapping || mapping.teamId !== payload?.teamId || mapping.projectId !== payload?.projectId ||
        typeof payload.epoch !== 'string' || !payload.epoch || payload.epoch.length > 256 ||
        !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.sessionId || '')) throw new Error('Invalid collaboration mapping');
    const preferences = await settings.readServerSettings();
    const stored = credentialForServer(settings.readAuth(), preferences).credential;
    const token = stored?.token && (!stored.expiresAt || stored.expiresAt > Date.now()) ? stored.token : preferences.apiKey;
    if (!token || generation !== turn) throw new Error('Collaboration account unavailable');
    const url = new URL('/collaboration', endpoint(preferences, 'http'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = factory(preferences, { maxPayload: MAX_BYTES })(url.toString());
    const session = { identity, mapping, socket, epoch: payload.epoch, heartbeat: null, reject: null };
    current = session;
    const state = await new Promise((resolve, reject) => {
      session.reject = reject;
      session.connectTimer = setTimeout(() => fail(new Error('Collaboration connection timed out')), 15000);
      const fail = error => {
        if (current !== session) return;
        if (session.reject) reject(error);
        else emit({ type: 'disconnected', reason: error.message });
        close();
      };
      socket.once('open', () => {
        try {
          assertContext(session);
          verifier(preferences)(socket, url.toString());
          socket.send(JSON.stringify({ type: 'join', token, teamId: mapping.teamId, projectId: mapping.projectId,
            epoch: payload.epoch, sessionId: payload.sessionId }));
        } catch (error) { fail(error); }
      });
      socket.on('message', bytes => {
        try {
          assertContext(session);
          if (bytes.length > MAX_BYTES) throw new Error('Collaboration message too large');
          const message = JSON.parse(String(bytes));
          if (message.type === 'error' && session.reject) {
            fail(new Error(String(message.message || message.code || 'Collaboration join rejected')));
            return;
          }
          if (message.type === 'state' && session.reject) {
            if (!message.state?.enabled || message.state.epoch !== payload.epoch) throw new Error('Unexpected collaboration epoch');
            clearTimeout(session.connectTimer);
            session.reject = null;
            session.lastMessageAt = Date.now();
            session.heartbeat = setInterval(() => {
              try {
                assertContext(session);
                if (Date.now() - session.lastMessageAt > 55000 || socket.readyState !== 1) throw new Error('Collaboration heartbeat timed out');
                socket.send(JSON.stringify({ type: 'heartbeat', epoch: payload.epoch }));
              } catch (error) { fail(error); }
            }, 15000);
            session.heartbeat.unref?.();
            resolve(message.state);
            return;
          }
          session.lastMessageAt = Date.now();
          emit(message);
        } catch (error) { fail(error); }
      });
      socket.on('error', error => fail(error));
      socket.on('close', () => fail(new Error('Collaboration disconnected')));
    });
    assertContext(session);
    await persistEpoch(session, payload.epoch);
    return state;
  }
  async function send(message) {
    assertContext(current);
    if (!message || !TYPES.has(message.type) || message.token !== undefined) throw new Error('Invalid collaboration message');
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_BYTES || current.socket.bufferedAmount > 2 * 1024 * 1024) throw new Error('Collaboration connection is busy');
    if (current.socket.readyState !== 1) throw new Error('Collaboration disconnected');
    current.socket.send(encoded);
  }
  function relativeFile(root, value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0')) throw new Error('Invalid shared file path');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^\.git$/i.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        value.toLowerCase() === '.bobocloud-team.json') throw new Error('Invalid shared file path');
    const target = path.resolve(root, ...parts);
    if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) throw new Error('Shared path escapes workspace');
    return target;
  }
  async function materialize(files, options = {}) {
    if (!Array.isArray(files) || files.length > 4096) throw new Error('Invalid collaboration snapshot');
    if (options.reconcile === true) {
      const identity = getWorkspaceIdentity();
      const mapping = identity?.rootPath && readTeamMapping(identity.rootPath, { requireLocalPath: true });
      if (!mapping?.realtimeEpoch || mapping.realtimeEpoch !== options.previousEpoch ||
          identity.workspaceIdentity !== options.workspaceIdentity || typeof options.epoch !== 'string' || !options.epoch) {
        throw new Error('Stale collaboration transition');
      }
      close();
      const transient = { identity, mapping, epoch: options.epoch };
      current = transient;
      try {
        await materialize(files, { replace: true, epoch: options.epoch, workspaceIdentity: options.workspaceIdentity });
        await persistEpoch(transient, '');
      } finally { if (current === transient) close(); }
      return;
    }
    const session = current;
    assertContext(session);
    if (options.epoch !== session.epoch || options.workspaceIdentity !== session.identity.workspaceIdentity) throw new Error('Stale collaboration snapshot');
    if (options.replace === true) {
      // Build a complete sibling before moving existing data. Rollback retains
      // the original directory until every staged file is ready to publish.
      return runMutation(session.identity.rootPath, async mutation => {
        const root = session.identity.rootPath;
        const staging = await fs.mkdtemp(path.join(path.dirname(root), '.bobo-live-stage-'));
        const backup = await fs.mkdtemp(path.join(path.dirname(root), '.bobo-live-backup-'));
        const moved = [];
        const published = [];
        let committed = false;
        try {
          for (const file of files) {
            const target = relativeFile(staging, file.path);
            await fs.mkdir(file.directory ? target : path.dirname(target), { recursive: true });
            if (!file.directory) {
              const bytes = file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.content || '', 'utf8');
              await writeFileAtomic(target, bytes, { maxBytes: 16 * 1024 * 1024 });
            }
          }
          assertContext(session); mutation.assertCurrent();
          for (const entry of await fs.readdir(root)) {
            if (entry === '.bobocloud-team.json') continue;
            mutation.resolvePath(path.join(root, entry));
            await fs.rename(path.join(root, entry), path.join(backup, entry)); moved.push(entry);
          }
          for (const entry of await fs.readdir(staging)) {
            assertContext(session); mutation.assertCurrent();
            await fs.rename(path.join(staging, entry), path.join(root, entry)); published.push(entry);
          }
          committed = true;
        } catch (error) {
          for (const entry of published) await fs.rm(path.join(root, entry), { recursive: true, force: true });
          for (const entry of moved) await fs.rename(path.join(backup, entry), path.join(root, entry));
          throw error;
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
          // Preserve a backup if rollback itself failed.
          if (committed || (await fs.readdir(backup)).length === 0) await fs.rm(backup, { recursive: true, force: true });
        }
        notifyWorkspaceFiles(files.map(file => ({ path: relativeFile(root, file.path), event: 'file-created' })), session.identity);
      });
    }
    await runMutation(session.identity.rootPath, async mutation => {
      for (const file of files) {
        assertContext(session); mutation.assertCurrent();
        const target = relativeFile(session.identity.rootPath, file.path);
        mutation.resolvePath(target);
        if (file.deleted) {
          await fs.rm(target, { recursive: true, force: true });
          continue;
        }
        if (file.previousPath && file.previousPath !== file.path) {
          const previous = relativeFile(session.identity.rootPath, file.previousPath);
          mutation.resolvePath(previous);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(previous, target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        if (file.directory) { await fs.mkdir(target, { recursive: true }); continue; }
        if (typeof file.content !== 'string' && typeof file.base64 !== 'string') continue;
        const bytes = typeof file.base64 === 'string' ? Buffer.from(file.base64, 'base64') : Buffer.from(file.content, 'utf8');
        if (bytes.length > 16 * 1024 * 1024) throw new Error('Shared file too large');
        await fs.mkdir(path.dirname(target), { recursive: true });
        mutation.resolvePath(target);
        await writeFileAtomic(target, bytes, { maxBytes: 16 * 1024 * 1024, beforeReplace: () => { assertContext(session); mutation.assertCurrent(); } });
      }
      assertContext(session); mutation.assertCurrent();
      notifyWorkspaceFiles(files.map(file => ({ path: relativeFile(session.identity.rootPath, file.path), event: file.deleted ? 'file-deleted' : 'file-changed' })), session.identity);
    });
  }
  async function drafts(payload) {
    let key = payload?.contextKey;
    if (key && !draftContexts.has(key)) throw new Error('Unknown collaboration draft context');
    if (!key) {
      const identity = getWorkspaceIdentity();
      const mapping = identity?.rootPath && readTeamMapping(identity.rootPath, { requireLocalPath: true });
      if (!mapping) throw new Error('No collaboration mapping');
      const prefs = await settings.readServerSettings();
      key = crypto.createHash('sha256').update(JSON.stringify([serverEndpointIdentity(prefs), serverAccountIdentity(prefs, credentialForServer(settings.readAuth(), prefs).credential),
        mapping.teamId, mapping.projectId, mapping.branch, identity.rootPath])).digest('hex');
      draftContexts.add(key);
      if (draftContexts.size > 64) draftContexts.delete(draftContexts.values().next().value);
    }
    const directory = path.join(userDataPath, 'collaboration-drafts');
    const target = path.join(directory, key + '.json');
    const operation = draftQueue.catch(() => {}).then(async () => {
      let value;
      try { value = JSON.parse(await fs.readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      value ||= { sessionId: crypto.randomBytes(16).toString('hex'), drafts: [] };
      if (payload) {
        if (!Array.isArray(payload.drafts) || payload.drafts.length > 64) throw new Error('Too many collaboration drafts');
        value.drafts = payload.drafts;
      }
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Collaboration drafts exceed storage limit');
      await fs.mkdir(directory, { recursive: true });
      await writeFileAtomic(target, encoded, { maxBytes: MAX_BYTES });
      return { ...value, contextKey: key };
    });
    draftQueue = operation;
    return operation;
  }
  ipcMain.handle('realtime:connect', (_event, payload) => connect(payload));
  ipcMain.handle('realtime:prepare-transition', () => prepareTransition?.());
  ipcMain.handle('realtime:send', (_event, payload) => send(payload));
  ipcMain.handle('realtime:close', close);
  ipcMain.handle('realtime:materialize', (_event, payload, options) => materialize(payload, options));
  ipcMain.handle('realtime:drafts', (_event, payload) => drafts(payload));
  ipcMain.handle('realtime:recover', async (_event, fileId) => {
    const saved = await drafts();
    const draft = saved.drafts.find(item => item.fileId === fileId);
    if (!draft || typeof draft.text !== 'string') throw new Error('Recovery draft not found');
    const result = await dialog.showSaveDialog(getWindow(), { defaultPath: path.basename(draft.path) + '.recovered' });
    if (result.canceled || !result.filePath) return false;
    await writeFileAtomic(result.filePath, draft.text, { maxBytes: MAX_BYTES });
    return true;
  });
  return { close, dispose: close };
}
module.exports = { createRealtimeController };
