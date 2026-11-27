"use strict";

const { createHash } = require("node:crypto");
const { authStorageKey, credentialForServer } = require("./server-identity");

function accountId(settings, user) {
  const userId = String((user && (user.uid || user.id)) || "");
  if (!userId || userId.length > 256)
    throw new Error("accounts.error.invalidAccount");
  return createHash("sha256")
    .update(authStorageKey(settings) + "\0" + userId)
    .digest("hex");
}

function serverDescriptor(settings) {
  return {
    ip: settings.ip,
    httpPort: settings.httpPort,
    wsPort: settings.wsPort,
    dapChildWsPort: settings.dapChildWsPort,
    secureTransport: true,
    certificateFingerprints: settings.certificateFingerprints || [],
    certificateFingerprint: settings.certificateFingerprint || "",
    setupCompleted: true,
  };
}

function rememberAccount(data, settings, credential, authorization = {}) {
  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
  const id = accountId(settings, credential.user);
  const key = authStorageKey(settings);
  for (const entry of Object.values(data.accounts)) {
    if (
      credential.token && entry.id !== id && entry.token &&
      authStorageKey(entry.server) === key
    ) {
      entry.token = "";
      entry.expiresAt = 0;
    }
  }
  const previous = data.accounts[id] || {};
  data.accounts[id] = {
    ...previous,
    id,
    server: serverDescriptor(settings),
    user: credential.user,
    token: credential.token || "",
    expiresAt: credential.expiresAt || 0,
    savedAt: Date.now(),
    ...authorization,
  };
  return data.accounts[id];
}

function migrateActiveAccount(data, settings) {
  const found = credentialForServer(data, settings).credential;
  if (found && found.user && found.token)
    return rememberAccount(data, settings, found);
  return null;
}

function publicAccount(account, activeId) {
  const user = account.user || {};
  return {
    id: account.id,
    username: String(user.username || user.id || ""),
    uid: String(user.uid || user.id || ""),
    userId: String(user.id || ""),
    name: String(user.name || user.username || ""),
    avatar: String(user.avatar || "graphite"),
    role: String(user.role || "member"),
    server: String(account.server.ip || ""),
    online: account.id === activeId && Boolean(account.token),
    authorized: Boolean(account.deviceId && account.deviceSecret),
    savedAt: account.savedAt || 0,
  };
}

module.exports = {
  accountId,
  serverDescriptor,
  rememberAccount,
  migrateActiveAccount,
  publicAccount,
};
