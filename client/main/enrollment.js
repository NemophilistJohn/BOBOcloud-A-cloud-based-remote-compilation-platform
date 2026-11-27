'use strict';

const { parseEnrollmentLink, settingsForLink, publicPreview, randomId } = require('./enrollment-link');
const { createSecureTransportGuard } = require('./secure-transport');
const { endpoint } = require('./server-transport');
const { authStorageKey, credentialForServer, effectiveCredential } = require('./server-identity');
const { rendererServerSettings } = require('./auth');
const { readBoundedResponse } = require('./rclone-remote-authority');
const { randomBytes } = require('node:crypto');
const { rememberAccount } = require('./account-vault');

function createEnrollmentController(options) {
  const pending = new Map();
  const active = new Map();
  const previewEpoch = new Map();
  const now = options.now || Date.now;
  const devicePlatform = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[process.platform] || 'Desktop';
  let incoming = '';

  function captureIncoming(value) {
    try { parseEnrollmentLink(value); incoming = value; options.notify?.(); return true; } catch (_) { return false; }
  }
  function getGrant(id, senderId) {
    const grant = pending.get(id);
    if (!grant || grant.senderId !== senderId || grant.expires <= now()) throw new Error('enrollment.error.expiredPreview');
    return grant;
  }
  function validateAuthResult(result) {
    const expiresAt = Date.parse(result && result.expiresAt);
    if (!result || typeof result.token !== 'string' || !result.token || !Number.isFinite(expiresAt) || expiresAt <= now() ||
        !result.user || typeof result.user !== 'object' || !(result.user.id || result.user.uid)) {
      throw new Error('enrollment.error.invalidResponse');
    }
    return expiresAt;
  }
  function persistAuth(current, result, expiresAt, secret) {
    const auth = options.settings.readAuth();
    if (!auth.servers || typeof auth.servers !== 'object') auth.servers = {};
    auth.servers[authStorageKey(current)] = { token: result.token, expiresAt, user: result.user, savedAt: now() };
    rememberAccount(auth,current,{token:result.token,expiresAt,user:result.user},
      result.data?.deviceId && secret ? {deviceId:result.data.deviceId,deviceSecret:secret} : {});
    if (!options.settings.writeAuth(auth)) throw new Error('enrollment.error.save');
  }
  function accountToken(current) {
    const found = credentialForServer(options.settings.readAuth(), current).credential;
    return found && found.token || '';
  }
  async function installCredential(result, current) {
    const credential = result.data && result.data.syncCredential;
    if (!credential) return false;
    try { await options.installSyncCredential(credential, current); return true; } catch (_) { return false; }
  }
  async function request(link, payload, sessionToken) {
    const partition = options.session.fromPartition('enrollment-' + randomId());
    const guard = createSecureTransportGuard();
    guard.update(settingsForLink(link));
    partition.setCertificateVerifyProc((req, callback) => callback(guard.verify(req)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    active.set(controller, true);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
      const response = await partition.fetch(endpoint(settingsForLink(link)), { method: 'POST', headers,
        body: JSON.stringify(payload), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      let size = 0;
      const chunks = [];
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 128 * 1024) { await reader.cancel(); throw new Error('enrollment.error.invalidResponse'); }
        chunks.push(Buffer.from(chunk.value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok || !result.success) { const error = new Error(result.error || 'enrollment.error.rejected'); error.status=response.status; throw error; }
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('enrollment.error.timeout');
      // Do not include request URLs, link fragments, passwords, or tokens in logs.
      if (error instanceof SyntaxError) throw new Error('enrollment.error.invalidResponse');
      throw error;
    } finally {
      clearTimeout(timer); active.delete(controller);
      partition.setCertificateVerifyProc(null);
      await partition.closeAllConnections();
    }
  }
  function authorizationForIdentity(current, identity) {
    const accounts=options.settings.readAuth().accounts||{};
    const normalized=String(identity||'').trim().toLowerCase();
    const entry=Object.values(accounts).find(value=>authStorageKey(value.server)===authStorageKey(current) &&
      [value.user?.id,value.user?.username,value.user?.email,value.user?.uid].some(v=>String(v||'').trim().toLowerCase()===normalized) && value.deviceId && value.deviceSecret);
    return entry ? {deviceId:entry.deviceId,deviceSecret:entry.deviceSecret} : {};
  }
  function registerIpc() {
    options.ipcMain.handle('enrollment:login', async (_event, payload) => {
      if (!payload || typeof payload.identity !== 'string' || typeof payload.password !== 'string' || payload.identity.length > 4096 || payload.password.length > 4096) throw new Error('enrollment.error.invalidResponse');
      const current = await options.settings.readServerSettings();
      const priorToken = accountToken(current);
      const deviceAuthorization=authorizationForIdentity(current,payload.identity);
      const deviceSecret = deviceAuthorization.deviceSecret || randomBytes(32).toString('hex');
      const link = { host: current.ip, httpPort: current.httpPort, wsPort: current.wsPort, dapChildWsPort: current.dapChildWsPort, certificateFingerprints: current.certificateFingerprints || [] };
      const result = await request(link, { action: 'login', identity: payload.identity, password: payload.password,
        deviceName: 'BOBOCLOUD desktop', devicePlatform, ...deviceAuthorization, deviceSecret });
      if (authStorageKey(current) !== authStorageKey(await options.settings.readServerSettings())) throw new Error('enrollment.error.serverChanged');
      if (accountToken(current) !== priorToken) throw new Error('enrollment.error.serverChanged');
      const expiresAt = validateAuthResult(result);
      await options.beforeAuthenticationCommit?.();
      persistAuth(current, result, expiresAt, deviceSecret);
      const syncReady = await installCredential(result, current);
      await options.afterAuthenticationCommit?.(result, current);
      return { success: true, token: result.token, expiresAt: result.expiresAt, user: result.user, syncReady };
    });
    options.ipcMain.handle('enrollment:refresh-sync', async () => {
      const current = await options.settings.readServerSettings();
      const credential = effectiveCredential(credentialForServer(options.settings.readAuth(), current).credential);
      if (!credential) return false;
      const response = await options.fetch(endpoint(current), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential.token },
        body: JSON.stringify({ action: 'getSyncCredential' }), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const text = await readBoundedResponse(response, 128 * 1024);
      const result = JSON.parse(text);
      if (!response.ok || !result.success) return false;
      if (authStorageKey(current) !== authStorageKey(await options.settings.readServerSettings())) return false;
      const latest = effectiveCredential(credentialForServer(options.settings.readAuth(), current).credential);
      if (!latest || latest.token !== credential.token) return false;
      const sync = result.data && (result.data.syncCredential || result.data);
      if (!sync || !sync.mode) return false;
      await options.installSyncCredential(sync, current);
      return true;
    });
    options.ipcMain.handle('enrollment:incoming', () => { const value = incoming; incoming = ''; return value; });
    options.ipcMain.handle('enrollment:preview', async (event, input) => {
      const link = parseEnrollmentLink(input);
      const senderId = event.sender.id;
      const epoch = (previewEpoch.get(senderId) || 0) + 1;
      previewEpoch.set(senderId, epoch);
      for (const [key, value] of pending) if (value.senderId === senderId || value.expires <= now()) pending.delete(key);
      const result = await request(link, { action: 'inspectEnrollment', enrollmentToken: link.token });
      if (previewEpoch.get(senderId) !== epoch) throw new Error('enrollment.error.expiredPreview');
      const id = randomId();
      const meta = result.data || result;
      if (meta.kind && meta.kind !== link.kind) throw new Error('enrollment.error.invalidResponse');
      const origin=await options.settings.readServerSettings();
      const accounts=options.settings.readAuth().accounts || {};
      const existing=Object.values(accounts).find(entry=>authStorageKey(entry.server)===authStorageKey(settingsForLink(link)) && entry.user?.id===meta.targetUserId);
      const deviceSecret=existing?.deviceSecret || randomBytes(32).toString('hex');
      pending.set(id, { senderId, link, originKey:authStorageKey(origin), originToken:accountToken(origin), deviceSecret, expires: now() + 15 * 60000, activated: false });
      return Object.assign({ id }, publicPreview(link, meta));
    });
    options.ipcMain.handle('enrollment:activate', async (event, id) => {
      const grant = getGrant(id, event.sender.id);
      const settings = settingsForLink(grant.link, await options.settings.readServerSettings());
      grant.stagedSettings=settings;
      grant.activated = true;
      return rendererServerSettings(settings);
    });
    options.ipcMain.handle('enrollment:authenticate', async (event, payload) => {
      const grant = getGrant(payload && payload.id, event.sender.id);
      if (!grant.activated) throw new Error('enrollment.error.expiredPreview');
      const before = await options.settings.readServerSettings();
      if (authStorageKey(before) !== grant.originKey || accountToken(before)!==grant.originToken) throw new Error('enrollment.error.serverChanged');
      const priorToken = accountToken(before);
      const allowed = ['identity', 'password', 'username', 'email'];
      const body = { action: grant.link.kind === 'register' ? 'register' : 'login', enrollmentToken: grant.link.token,
        deviceName: 'BOBOCLOUD desktop', devicePlatform, deviceSecret:grant.deviceSecret };
      for (const key of allowed) {
        const value = payload[key];
        if (value !== undefined && (typeof value !== 'string' || value.length > 4096)) throw new Error('enrollment.error.invalidResponse');
        if (value !== undefined) body[key] = value;
      }
      // Keep a successful response in memory across local persistence failures:
      // the remote one-use link cannot be consumed twice.
      const result = grant.completed || await request(grant.link, body);
      validateAuthResult(result);
      grant.completed = result;
      let current = await options.settings.readServerSettings();
      if (authStorageKey(current)!==grant.originKey || accountToken(current)!==priorToken) throw new Error('enrollment.error.serverChanged');
      if (!grant.commitStarted) { await options.beforeAuthenticationCommit?.(); grant.commitStarted=true; }
      const next=grant.stagedSettings || settingsForLink(grant.link,current);
      if (!await options.applySettings(next,'enrollment-server-change',false)) throw new Error('enrollment.error.save');
      current=await options.settings.readServerSettings();
      grant.commitStarted=true;grant.originKey=authStorageKey(current);grant.originToken=accountToken(current);
      persistAuth(current, result, validateAuthResult(result),grant.deviceSecret);
      const syncReady = await installCredential(result, current);
      await options.afterAuthenticationCommit?.(result,current);
      pending.delete(payload.id);
      // Sync credentials stay main-owned. Existing auth UI still owns its app token.
      return { success: true, token: result.token, expiresAt: result.expiresAt, user: result.user, syncReady };
    });
  }
  function dispose() { for (const controller of active.keys()) controller.abort(); pending.clear(); previewEpoch.clear(); incoming = ''; }
  return { registerIpc, captureIncoming, dispose, request, installCredential };
}

module.exports = { createEnrollmentController };
