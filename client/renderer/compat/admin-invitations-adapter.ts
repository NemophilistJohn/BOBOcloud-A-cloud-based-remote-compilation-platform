import { createInvitationManager } from "../../src/admin-invitations";
import { rendererPlatform } from "../core/bootstrap";
type Bobo = {
  i18n: {
    t(key: string, params?: Record<string, unknown>): string;
    onChange(fn: () => void): () => void;
  };
  state: { auth: { token: string; user?: { id?: string; role?: string } } };
  sendToServer(
    action: string,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
  invitations?: ReturnType<typeof createInvitationManager>;
};
const bobo = (window as unknown as { BOBO: Bobo }).BOBO;
const service = createInvitationManager({
  document,
  t: (key, params) => bobo.i18n.t(key, params),
  identity: () => bobo.state.auth.token,
  isRoot: () => bobo.state.auth.user?.role === "root",
  send: (action, payload) =>
    bobo.sendToServer(action, payload, { quiet: true }),
  confirm: (options) => bobo.confirm(options),
  clipboard: navigator.clipboard,
});
bobo.invitations = service;
rendererPlatform.lifecycle.add({ dispose: () => service.dispose() });
rendererPlatform.lifecycle.add({
  dispose: bobo.i18n.onChange(() => service.refreshLocale()),
});
