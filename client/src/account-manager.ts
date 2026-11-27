import type {
  EnrollmentHostPort,
  EnrollmentAuthResult,
  SavedAccount,
} from "../types/enrollment";

export interface AccountManagerPorts {
  document: Document;
  host: Pick<
    EnrollmentHostPort,
    "accountsList" | "accountsSwitch" | "accountsLogout" | "accountsRemove"
  >;
  t(key: string, params?: Record<string, unknown>): string;
  prepare(): Promise<boolean>;
  activated(result: EnrollmentAuthResult): Promise<void>;
  loggedOut(): void;
  add(kind: "device" | "register"): void;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
}

const glyphs = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout:
    '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M14 8l4 4-4 4m-6-4h10"/>',
  switch: '<path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/>',
  delete: '<path d="M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6m4-6v6"/>',
  device:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5m-3-12 2 2 4-4"/>',
  register:
    '<circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 13-3m4-3v8m-4-4h8"/>',
};
function svg(name: keyof typeof glyphs): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    glyphs[name] +
    "</svg>"
  );
}

export function createAccountManager(ports: AccountManagerPorts) {
  const d = ports.document;
  let modal: HTMLElement | null = null;
  let entries: SavedAccount[] = [];
  let busy = false;
  let generation = 0;
  let previousFocus: HTMLElement | null = null;
  let disposed = false;
  let statusKey = "";
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function setBusy(value: boolean) {
    busy = value;
    modal?.setAttribute("aria-busy", String(value));
    modal?.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      control.disabled = value;
    });
  }

  function message(key = "") {
    statusKey = key;
    const el = modal?.querySelector<HTMLElement>("[data-account-status]");
    if (el) {
      el.textContent = key ? ports.t(key) : "";
      el.classList.toggle("is-error", key.includes(".error."));
    }
  }
  function errorKey(error: unknown) {
    const value = error instanceof Error ? error.message : "";
    const key = value.replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
    return key.startsWith("accounts.error.") ||
      key.startsWith("enrollment.error.")
      ? key
      : "accounts.error.unavailable";
  }
  function button(
    action: "logout" | "switch" | "delete",
    id: string,
  ): HTMLButtonElement {
    const b = d.createElement("button");
    b.type = "button";
    b.className = "account-action " + action;
    b.dataset.accountAction = action;
    b.dataset.accountId = id;
    const key =
      action === "logout"
        ? "accounts.logout"
        : action === "switch"
          ? "accounts.switch"
          : "accounts.delete";
    b.title = ports.t(key);
    b.setAttribute("aria-label", ports.t(key));
    b.innerHTML = svg(action);
    b.disabled = busy;
    return b;
  }
  function render() {
    if (!modal) return;
    const focused = d.activeElement as HTMLElement | null;
    const focusAccount = focused?.dataset.accountId;
    const focusAction = focused?.dataset.accountAction;
    modal
      .querySelectorAll<HTMLElement>("[data-account-i18n]")
      .forEach((n) => (n.textContent = ports.t(n.dataset.accountI18n || "")));
    modal.querySelector<HTMLElement>("[data-account-close]")?.setAttribute("aria-label", ports.t("Close"));
    message(statusKey);
    const list = modal.querySelector<HTMLElement>("[data-account-list]")!;
    list.replaceChildren();
    for (const entry of entries) {
      const row = d.createElement("article");
      row.className = "managed-account" + (entry.online ? " is-online" : "");
      row.dataset.savedAccount = entry.id;
      const actions = d.createElement("div");
      actions.className = "account-row-actions";
      if (entry.online) actions.append(button("logout", entry.id));
      else
        actions.append(button("switch", entry.id), button("delete", entry.id));
      const main = d.createElement("button");
      main.type = "button";
      main.className = "account-row-main";
      main.dataset.accountAction = entry.online ? "current" : "switch";
      main.dataset.accountId = entry.id;
      main.disabled = busy;
      const avatar = d.createElement("span");
      avatar.className = "managed-account-avatar";
      if (/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(entry.avatar)) {
        const img = d.createElement("img");
        img.src = entry.avatar;
        img.alt = "";
        avatar.append(img);
      } else {
        avatar.dataset.preset =
          /^(ocean|forest|coral|violet|graphite|amber)$/.test(entry.avatar)
            ? entry.avatar
            : "graphite";
        avatar.textContent = (entry.name || entry.username || "?")
          .slice(0, 2)
          .toUpperCase();
      }
      const info = d.createElement("span");
      info.className = "managed-account-info";
      const heading = d.createElement("span");
      heading.className = "managed-account-heading";
      const name = d.createElement("strong");
      name.textContent = entry.name || entry.username;
      heading.append(name);
      const badge = d.createElement("span");
      badge.className = "account-presence";
      badge.textContent = ports.t(
        entry.online ? "accounts.online" : "accounts.offline",
      );
      heading.append(badge);
      const username = d.createElement("span");
      username.className = "managed-account-id";
      username.textContent = "@" + entry.username + " · ID " + entry.userId;
      username.title = entry.userId;
      const uid = d.createElement("code");
      uid.textContent = "UID · " + entry.uid;
      const server = d.createElement("small");
      server.textContent = entry.server;
      info.append(heading, username, uid, server);
      main.append(avatar, info);
      row.append(actions, main);
      list.append(row);
    }
    const add = d.createElement("div");
    add.className = "account-add-row";
    add.innerHTML =
      '<span class="account-add-plus" aria-hidden="true">' +
      svg("plus") +
      '</span><button type="button" class="account-add-half existing" data-add-account="device">' +
      svg("device") +
      '<span></span></button><button type="button" class="account-add-half register" data-add-account="register">' +
      svg("register") +
      "<span></span></button>";
    const halves = add.querySelectorAll<HTMLButtonElement>("button");
    halves[0]!.querySelector("span")!.textContent =
      ports.t("accounts.existing");
    halves[1]!.querySelector("span")!.textContent =
      ports.t("accounts.register");
    halves.forEach((b) => {
      b.disabled = busy;
      b.setAttribute(
        "aria-label",
        ports.t(
          b.dataset.addAccount === "device"
            ? "accounts.addExisting"
            : "accounts.addNew",
        ),
      );
    });
    list.append(add);
    setBusy(busy);
    if (focusAccount && focusAction) {
      list.querySelectorAll<HTMLButtonElement>("[data-account-id]").forEach((control) => {
        if (control.dataset.accountId === focusAccount && control.dataset.accountAction === focusAction) control.focus();
      });
    }
  }
  async function refresh() {
    const epoch = ++generation;
    const result = await ports.host.accountsList();
    if (disposed || epoch !== generation) return;
    entries = [...result].sort(
      (a, b) => Number(b.online) - Number(a.online) || b.savedAt - a.savedAt,
    );
    render();
  }
  async function act(action: string, id: string) {
    if (busy || action === "current") return;
    setBusy(true);
    message("accounts.working");
    try {
      if (action === "delete") {
        const approved = await ports.confirm({
          title: ports.t("accounts.deleteTitle"),
          message: ports.t("accounts.deleteHelp"),
          confirmLabel: ports.t("accounts.delete"),
          cancelLabel: ports.t("Cancel"),
          danger: true,
        });
        if (!approved) {
          message();
          return;
        }
        await ports.host.accountsRemove(id);
      } else {
        if (!(await ports.prepare())) {
          message();
          return;
        }
        if (action === "logout") {
          await ports.host.accountsLogout();
          ports.loggedOut();
        } else {
          const result = await ports.host.accountsSwitch(id);
          if (!("unchanged" in result)) await ports.activated(result);
        }
      }
      await refresh();
      message();
    } catch (error) {
      const key = errorKey(error);
      message(key);
      if (key === "accounts.error.lastDevice")
        await ports.confirm({
          title: ports.t("accounts.cannotDelete"),
          message: ports.t(key),
          confirmLabel: ports.t("OK"),
          cancelLabel: ports.t("Close"),
        });
    } finally {
      setBusy(false);
      const row = Array.from(modal?.querySelectorAll<HTMLElement>("[data-saved-account]") || [])
        .find((item) => item.dataset.savedAccount === id);
      row?.querySelector<HTMLButtonElement>(".account-row-main")?.focus({ preventScroll: true });
    }
  }
  function close(restoreFocus = true) {
    if (busy) return;
    generation++;
    modal?.classList.add("is-closing");
    const overlay = modal;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (overlay) {
        overlay.hidden = true;
        overlay.classList.remove("is-closing");
      }
      if (restoreFocus) previousFocus?.focus();
    }, d.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  }
  function trap(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || !modal) return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex="0"]',
      ),
    ).filter((n) => n.offsetParent !== null);
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && d.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && d.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  async function open() {
    if (disposed) return;
    clearTimeout(closeTimer);
    if (!modal) {
      modal = d.createElement("section");
      modal.id = "account-manager";
      modal.className = "account-manager-overlay";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "account-manager-title");
      modal.innerHTML =
        '<div class="account-manager-card"><header><span class="account-manager-symbol" aria-hidden="true">' +
        svg("device") +
        '</span><div><h2 id="account-manager-title" data-account-i18n="accounts.title"></h2><p data-account-i18n="accounts.subtitle"></p></div><button class="account-manager-close" type="button" data-account-close aria-label="' +
        ports.t("Close") +
        '">×</button></header><div class="account-manager-list" data-account-list></div><footer><span class="account-status-dot" aria-hidden="true"></span><span data-account-status role="status" aria-live="polite"></span></footer></div>';
      d.body.append(modal);
      modal.addEventListener("click", (event) => {
        const target = event.target as Element;
        if (target === modal || target.closest("[data-account-close]")) {
          close();
          return;
        }
        const add = target.closest<HTMLElement>("[data-add-account]");
        if (add && !busy) {
          close(false);
          ports.add(add.dataset.addAccount as "device" | "register");
          return;
        }
        const control = target.closest<HTMLElement>("[data-account-action]");
        if (control)
          void act(
            control.dataset.accountAction || "",
            control.dataset.accountId || "",
          );
      });
      modal.addEventListener("keydown", (event) => trap(event));
    }
    previousFocus = d.activeElement as HTMLElement;
    modal.hidden = false;
    modal.classList.remove("is-closing");
    render();
    message("Loading...");
    try {
      await refresh();
      message("accounts.footer");
    } catch (error) {
      message(errorKey(error));
    }
    modal.querySelector<HTMLButtonElement>("[data-account-close]")?.focus();
  }
  return {
    open,
    close,
    render,
    dispose() {
      disposed = true;
      generation++;
      clearTimeout(closeTimer);
      modal?.remove();
      modal = null;
    },
  };
}
