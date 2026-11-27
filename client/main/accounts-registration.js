"use strict";
const { registerEnrollment } = require("./enrollment-registration");
const { createAccountsController } = require("./accounts");

function registerAccounts(options) {
  let accounts;
  const enrollment = registerEnrollment({
    ...options,
    beforeAuthenticationCommit: () => accounts.beforeAuthenticationCommit(),
    afterAuthenticationCommit: (result) => accounts.afterAuthenticationCommit(result),
  });
  accounts = createAccountsController({ ...options, enrollment });
  accounts.registerIpc();
  return { dispose: () => enrollment.dispose() };
}

module.exports = { registerAccounts };
