"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rememberAccount, publicAccount } = require("../main/account-vault");
const { createAccountsController } = require("../main/accounts");
const { authStorageKey } = require("../main/server-identity");
const pin = "AB".repeat(32);
function fixture() {
  let server = {
    ip: "cloud.example",
    httpPort: 3100,
    wsPort: 3101,
    dapChildWsPort: 3102,
    secureTransport: true,
    certificateFingerprints: [pin],
  };
  let data = { servers: {}, accounts: {} };
  const calls = [],
    handlers = {};
  let rejectForget = false;
  const first = rememberAccount(
    data,
    server,
    {
      token: "session-a",
      expiresAt: Date.now() + 60000,
      user: { id: "a", uid: "u_a", username: "a" },
    },
    { deviceId: "device-a", deviceSecret: "a".repeat(64) },
  );
  const second = rememberAccount(
    data,
    server,
    { token: "", user: { id: "b", uid: "u_b", username: "b" } },
    { deviceId: "device-b", deviceSecret: "b".repeat(64) },
  );
  data.servers[authStorageKey(server)] = {
    token: first.token,
    expiresAt: first.expiresAt,
    user: first.user,
  };
  const settings = {
    readAuth: () => structuredClone(data),
    writeAuth: (value) => {
      data = structuredClone(value);
      return true;
    },
    readServerSettings: async () => structuredClone(server),
  };
  const enrollment = {
    request: async (link, payload, token) => {
      calls.push({ payload, token });
      if (payload.action === "forgetDevice" && rejectForget)
        throw Error("accounts.error.lastDevice");
      if (payload.action === "resumeDevice")
        return {
          success: true,
          user: second.user,
          token: "resumed-b",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          data: { syncCredential: { mode: "restricted" } },
        };
      return { success: true };
    },
    installCredential: async () => true,
  };
  const controller = createAccountsController({
    settings,
    auth: {
      applyServerSettings: async (next) => {
        server = structuredClone(next);
        return true;
      },
    },
    enrollment,
    ipcMain: { handle: (key, fn) => (handlers[key] = fn) },
    credentialsChanged: async () => {},
  });
  controller.registerIpc();
  return {
    handlers,
    calls,
    first,
    second,
    data: () => data,
    rejectForget: () => (rejectForget = true),
  };
}
test("logout retains authorization and switching chooses a distinct saved account without exposing secrets", async () => {
  const f = fixture();
  await f.handlers["accounts:logout"]();
  const list = await f.handlers["accounts:list"]();
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => !a.online));
  assert.ok(!JSON.stringify(list).includes("deviceSecret"));
  assert.equal(f.data().accounts[f.first.id].deviceSecret, "a".repeat(64));
  const result = await f.handlers["accounts:switch"]({}, f.second.id);
  assert.equal(result.user.id, "b");
  const active = await f.handlers["accounts:list"]();
  assert.equal(active[0].id, f.second.id);
  assert.equal(active[0].online, true);
  assert.ok(
    f.calls.some(
      (c) =>
        c.payload.action === "resumeDevice" &&
        c.payload.deviceSecret === "b".repeat(64),
    ),
  );
});
test("last-device refusal keeps local authorization and delete revokes before removing", async () => {
  const f = fixture();
  f.rejectForget();
  await assert.rejects(
    () => f.handlers["accounts:remove"]({}, f.second.id),
    /lastDevice/,
  );
  assert.ok(f.data().accounts[f.second.id]);
  const next = fixture();
  await next.handlers["accounts:remove"]({}, next.second.id);
  assert.equal(next.data().accounts[next.second.id], undefined);
  assert.equal(next.calls.at(-1).payload.action, "forgetDevice");
  await assert.rejects(
    () => next.handlers["accounts:remove"]({}, next.first.id),
    /logoutFirst/,
  );
});
test("an expired session is shown offline and can resume its authorized account", async () => {
  const f = fixture();
  for (const value of Object.values(f.data().servers)) value.expiresAt = Date.now() - 1;
  const list = await f.handlers["accounts:list"]();
  assert.ok(list.every((account) => !account.online));
  const result = await f.handlers["accounts:switch"]({}, f.second.id);
  assert.equal(result.user.id, "b");
  assert.equal((await f.handlers["accounts:list"]())[0].online, true);
});
test("public saved account data contains only display metadata", () => {
  const value = publicAccount(
    {
      id: "x",
      server: { ip: "example" },
      user: { id: "a", uid: "u_a" },
      deviceId: "d",
      deviceSecret: "secret",
      token: "token",
    },
    "x",
  );
  assert.equal(value.online, true);
  assert.equal(JSON.stringify(value).includes("secret"), false);
  assert.equal(JSON.stringify(value).includes("token"), false);
});
