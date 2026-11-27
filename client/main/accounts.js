"use strict";

const { randomBytes } = require("node:crypto");
const { authStorageKey, credentialForServer, effectiveCredential } = require("./server-identity");
const {
  accountId,
  migrateActiveAccount,
  publicAccount,
  serverDescriptor,
} = require("./account-vault");

function createAccountsController(options) {
  const { settings, auth, enrollment } = options;
  let tail = Promise.resolve();
  let enrollmentSource = null;
  const write = (data) => {
    if (!settings.writeAuth(data)) throw new Error("enrollment.error.save");
  };
  const request = (server, payload, token) =>
    enrollment.request({ host: server.ip, ...server }, payload, token);
  const serialized = (fn) => {
    const next = tail.then(fn);
    tail = next.catch(() => {});
    return next;
  };
  const currentId = async (data) => {
    const server = await settings.readServerSettings();
    const active = effectiveCredential(credentialForServer(data, server).credential);
    return active?.user && active.token ? accountId(server, active.user) : "";
  };
  async function activeSnapshot() {
    const server = await settings.readServerSettings();
    const credential = credentialForServer(
      settings.readAuth(),
      server,
    ).credential;
    return { key: authStorageKey(server), token: credential?.token || "", server };
  }
  async function assertActive(expected) {
    const current = await activeSnapshot();
    if (current.key !== expected.key || current.token !== expected.token)
      throw new Error("enrollment.error.serverChanged");
  }

  async function trustCurrent() {
    const server = await settings.readServerSettings();
    let data = settings.readAuth();
    const entry = migrateActiveAccount(data, server);
    if (!entry) return;
    if (!entry.deviceSecret)
      entry.deviceSecret = randomBytes(32).toString("hex");
    write(data); // Persist before remote enrollment, including recovery after a lost response.
    if (entry.deviceId) return;
    let result;
    try {
      result = await request(
        server,
        { action: "trustCurrentDevice", deviceSecret: entry.deviceSecret },
        entry.token,
      );
    } catch (error) {
      // A revoked/expired legacy session must not block signing out or adding
      // another account. Other failures preserve it for a migration retry.
      if (error.status === 401) return;
      throw error;
    }
    const latest = settings.readAuth();
    if (
      (await currentId(latest)) !== entry.id ||
      latest.accounts?.[entry.id]?.deviceSecret !== entry.deviceSecret
    )
      return;
    if (!result.data?.deviceId)
      throw new Error("enrollment.error.invalidResponse");
    latest.accounts[entry.id].deviceId = result.data.deviceId;
    write(latest);
  }

  async function list() {
    // Saved identities remain visible while their server is offline.
    try {
      await trustCurrent();
    } catch (_) {}
    const data = settings.readAuth();
    const active = await currentId(data);
    return Object.values(data.accounts || {})
      .map((entry) => publicAccount(entry, active))
      .sort(
        (a, b) => Number(b.online) - Number(a.online) || b.savedAt - a.savedAt,
      );
  }

  async function clearActive() {
    await trustCurrent();
    const server = await settings.readServerSettings();
    let data = settings.readAuth();
    const credential = credentialForServer(data, server).credential;
    const expected = {
      key: authStorageKey(server),
      token: credential?.token || "",
    };
    if (credential?.token) {
      // A failed network logout keeps the session locally available for retry.
      try {
        await request(server, { action: "logout" }, credential.token);
      } catch (error) {
        if (error.status !== 401) throw error;
      }
      await assertActive(expected);
      data = settings.readAuth();
      const id = accountId(server, credential.user);
      if (data.accounts?.[id]) {
        data.accounts[id].token = "";
        data.accounts[id].expiresAt = 0;
      }
    }
    delete data.servers[authStorageKey(server)];
    write(data);
    auth.discardServerSettingsRollback?.();
    const updated = {
      ...server,
      user: "",
      pass: "",
      apiKey: "",
      syncManaged: false,
    };
    if (
      !(await auth.applyServerSettings(
        updated,
        "account-logout",
        false,
        expected.key,
      ))
    )
      throw new Error("enrollment.error.save");
    await options.credentialsChanged();
  }

  async function switchAccount(id) {
    const data = settings.readAuth();
    const target = data.accounts?.[id];
    if (!target?.deviceId || !target.deviceSecret)
      throw new Error("accounts.error.authorizationRequired");
    if ((await currentId(data)) === id) return { unchanged: true };
    const source = await activeSnapshot();
    // Authenticate the target before changing local active identity. A failure
    // leaves the current account usable and keeps the account manager open.
    const result = await request(target.server, {
      action: "resumeDevice",
      deviceId: target.deviceId,
      deviceSecret: target.deviceSecret,
    });
    if (
      !result.user ||
      accountId(target.server, result.user) !== id ||
      typeof result.token !== "string" ||
      !result.token ||
      !(Date.parse(result.expiresAt) > Date.now())
    )
      throw new Error("accounts.error.invalidAccount");
    try {
      await assertActive(source);
      await clearActive();
      if (
        !(await auth.applyServerSettings(
          {
            ...serverDescriptor(target.server),
            user: "",
            pass: "",
            apiKey: "",
          },
          "account-switch",
          false,
        ))
      )
        throw new Error("enrollment.error.save");
      const latest = settings.readAuth();
      const entry = latest.accounts?.[id];
      if (!entry || entry.deviceId !== target.deviceId)
        throw new Error("accounts.error.authorizationRequired");
      entry.token = result.token;
      entry.expiresAt = Date.parse(result.expiresAt);
      entry.user = result.user;
      entry.savedAt = Date.now();
      latest.servers[authStorageKey(target.server)] = {
        token: entry.token,
        expiresAt: entry.expiresAt,
        user: entry.user,
      };
      write(latest);
      const syncReady = await enrollment.installCredential(
        result,
        await settings.readServerSettings(),
      );
      await options.credentialsChanged();
      return {
        success: true,
        token: entry.token,
        expiresAt: result.expiresAt,
        user: result.user,
        syncReady,
      };
    } catch (error) {
      await request(target.server, { action: "logout" }, result.token).catch(
        () => {},
      );
      throw error;
    }
  }

  async function remove(id) {
    const data = settings.readAuth();
    const entry = data.accounts?.[id];
    if (!entry) return true;
    if ((await currentId(data)) === id)
      throw new Error("accounts.error.logoutFirst");
    if (!entry.deviceId || !entry.deviceSecret)
      throw new Error("accounts.error.authorizationRequired");
    // The service atomically checks the remaining authorizations and revokes
    // this one before any local credential is removed.
    try {
      await request(entry.server, {
        action: "forgetDevice",
        deviceId: entry.deviceId,
        deviceSecret: entry.deviceSecret,
      });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    const latest = settings.readAuth();
    delete latest.accounts[id];
    const key = authStorageKey(entry.server);
    if (
      latest.servers[key]?.user &&
      accountId(entry.server, latest.servers[key].user) === id
    )
      delete latest.servers[key];
    write(latest);
    return true;
  }

  function registerIpc() {
    options.ipcMain.handle("accounts:list", () => serialized(list));
    options.ipcMain.handle("accounts:switch", (_event, id) =>
      serialized(() => {
        validateId(id);
        return switchAccount(id);
      }),
    );
    options.ipcMain.handle("accounts:logout", () => serialized(clearActive));
    options.ipcMain.handle("accounts:remove", (_event, id) =>
      serialized(() => {
        validateId(id);
        return remove(id);
      }),
    );
  }
  async function afterAuthenticationCommit(result) {
    const source = enrollmentSource;
    enrollmentSource = null;
    if (!source?.token || source.token === result.token) return;
    try {
      await request(source.server, { action: "logout" }, source.token);
    } catch (error) {
      if (error.status !== 401)
        options.logger?.warn?.("Previous account session could not be closed remotely.");
    }
    const latest = settings.readAuth();
    if (latest.servers[source.key]?.token === source.token) delete latest.servers[source.key];
    for (const entry of Object.values(latest.accounts || {})) {
      if (entry.token === source.token) {
        entry.token = "";
        entry.expiresAt = 0;
      }
    }
    write(latest);
  }
  function validateId(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("accounts.error.invalidAccount");
  }
  return {
    registerIpc,
    trustCurrent: () => serialized(trustCurrent),
    beforeAuthenticationCommit: () => serialized(async () => {
      await trustCurrent();
      enrollmentSource = await activeSnapshot();
    }),
    afterAuthenticationCommit: (result) => serialized(() => afterAuthenticationCommit(result)),
  };
}

module.exports = { createAccountsController };
