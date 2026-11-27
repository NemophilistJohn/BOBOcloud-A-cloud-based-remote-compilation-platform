import { createAccountManager } from "../../src/account-manager";
import { rendererPlatform } from "../core/bootstrap";
import { ENROLLMENT_HOST_SERVICE_ID } from "../core/native-host-adapter";
import type { EnrollmentAuthResult } from "../../types/enrollment";

type Bobo = {
  i18n: {
    t(key: string, params?: Record<string, unknown>): string;
    onChange(listener: () => void): () => void;
  };
  auth: {
    prepareAccountTransition(): Promise<boolean>;
    completeAccountTransition(result: EnrollmentAuthResult): Promise<void>;
    accountLoggedOut(): void;
  };
  welcome: { open(kind?: "device" | "register"): void };
  accountManager?: ReturnType<typeof createAccountManager>;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
};
const bobo = (window as unknown as { BOBO: Bobo }).BOBO;
const service = createAccountManager({
  document,
  host: rendererPlatform.services.require(ENROLLMENT_HOST_SERVICE_ID),
  t: (key, params) => bobo.i18n.t(key, params),
  prepare: () => bobo.auth.prepareAccountTransition(),
  activated: (result) => bobo.auth.completeAccountTransition(result),
  loggedOut: () => bobo.auth.accountLoggedOut(),
  add: (kind) => bobo.welcome.open(kind),
  confirm: (options) => bobo.confirm(options),
});
bobo.accountManager = service;
rendererPlatform.lifecycle.add({ dispose: () => service.dispose() });
rendererPlatform.lifecycle.add({
  dispose: bobo.i18n.onChange(() => service.render()),
});
