interface Invitation {
  id: string;
  kind: string;
  state: string;
  syncMode: string;
  role?: string;
  label?: string;
  createdBy?: string;
  claimedBy?: string;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  targetUserId?: string;
}
interface InvitationPorts {
  document: Document;
  t(key: string, params?: Record<string, unknown>): string;
  identity(): string;
  isRoot(): boolean;
  send(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
  clipboard: { writeText(value: string): Promise<void> };
}
const icon = (path: string) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  path +
  "</svg>";
const copyIcon = icon(
  '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
);
const revokeIcon = icon(
  '<circle cx="12" cy="12" r="8"/><path d="m6.4 6.4 11.2 11.2"/>',
);
const refreshIcon = icon('<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>');
const plusIcon = icon('<path d="M12 5v14M5 12h14"/>');
const detailsIcon = icon(
  '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
);
const searchIcon = icon(
  '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
);

function operationError(value: unknown): string {
  const key = value instanceof Error ? value.message : String(value || "");
  return key === "enrollment.error.noLongerAvailable" ||
    key === "enrollment.error.tooMany"
    ? key
    : "enrollment.auth.operationFailed";
}

export function createInvitationManager(p: InvitationPorts) {
  const d = p.document;
  const events = new AbortController();
  let disposed = false,
    epoch = 0,
    creating = false;
  let entries: Invitation[] = [];
  let filter = "available",
    kind = "register",
    search = "";
  let generated: { link: string; expiresAt: string } | null = null;
  const pane = d.getElementById("admin-pane-invites")!;
  function el(id: string) {
    return d.getElementById(id)!;
  }
  function t(key: string, params?: Record<string, unknown>) {
    return p.t(key, params);
  }
  function status(key = "", error = false) {
    const node = el("invite-status");
    node.textContent = key ? t(key) : "";
    node.classList.toggle("error", error);
  }
  function recordState(r: Invitation) {
    return r.state === "available" && Date.parse(r.expiresAt) <= Date.now()
      ? "expired"
      : r.state;
  }
  function date(value: string) {
    return value ? new Date(value).toLocaleString() : t("Not available");
  }
  function render() {
    pane
      .querySelectorAll<HTMLElement>("[data-invite-i18n]")
      .forEach((n) => (n.textContent = t(n.dataset.inviteI18n || "")));
    el("invite-refresh").title = t("invitations.refresh");
    el("invite-refresh").setAttribute("aria-label", t("invitations.refresh"));
    el("invite-kind").setAttribute("aria-label", t("enrollment.auth.type"));
    const root = p.isRoot();
    for (const id of ["invite-role-admin", "invite-sync-root"]) {
      const option = el(id) as HTMLOptionElement;
      option.disabled = !root;
      option.hidden = !root;
    }
    if (!root) {
      (el("invite-role") as HTMLSelectElement).value = "member";
      (el("invite-sync-mode") as HTMLSelectElement).value = "restricted";
    }
    const usable = entries.filter(
      (r) => recordState(r) === "available" && r.kind === kind,
    ).length;
    el("invite-available-count").textContent = String(usable);
    el("invite-history-count").textContent = String(
      entries.filter((r) => r.kind === kind && recordState(r) !== "available")
        .length,
    );
    const searchInput = el("invite-search") as HTMLInputElement;
    searchInput.placeholder = t("invitations.search");
    searchInput.setAttribute("aria-label", t("invitations.search"));
    pane.querySelectorAll<HTMLElement>("[data-invite-filter]").forEach((b) => {
      b.classList.toggle("active", b.dataset.inviteFilter === filter);
      b.setAttribute("aria-pressed", String(b.dataset.inviteFilter === filter));
    });
    const list = el("invite-list");
    list.replaceChildren();
    const visible = entries.filter(
      (r) =>
        r.kind === kind &&
        (filter === "available"
          ? recordState(r) === "available"
          : recordState(r) !== "available") &&
        (!search ||
          [r.label, r.id, r.createdBy, r.claimedBy, r.targetUserId].some((s) =>
            String(s || "")
              .toLowerCase()
              .includes(search),
          )),
    );
    if (!visible.length) {
      const empty = d.createElement("div");
      empty.className = "invitation-empty";
      empty.textContent = t(
        filter === "available"
          ? "invitations.emptyActive"
          : "invitations.emptyHistory",
      );
      list.append(empty);
      return;
    }
    const table = d.createElement("table");
    table.className = "invitation-table";
    const head = d.createElement("thead");
    const hr = d.createElement("tr");
    for (const key of [
      "invitations.invitation",
      "invitations.permissions",
      "enrollment.auth.status",
      "invitations.expiry",
      "Actions",
    ]) {
      const th = d.createElement("th");
      th.textContent = t(key);
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const body = d.createElement("tbody");
    for (const r of visible) {
      const row = d.createElement("tr");
      row.dataset.invitationId = r.id;
      const state = recordState(r);
      const name = d.createElement("td");
      const strong = d.createElement("strong");
      strong.textContent =
        r.label ||
        t(
          (
            {
              root: "enrollment.auth.kind.root",
              register: "enrollment.auth.kind.register",
              device: "enrollment.auth.kind.device",
            } as Record<string, string>
          )[r.kind] || "enrollment.auth.kind.unknown",
        );
      const sub = d.createElement("small");
      sub.textContent =
        "#" +
        r.id.slice(0, 8) +
        " · " +
        (r.createdBy || t("invitations.system"));
      name.append(strong, sub);
      const access = d.createElement("td");
      access.className = "invitation-access";
      access.textContent = t(r.role === "admin" ? "Admin" : "Member");
      const mode = d.createElement("small");
      mode.textContent = t(
        r.syncMode === "root"
          ? "enrollment.auth.rootAccess"
          : "enrollment.auth.restricted",
      );
      mode.className = r.syncMode === "root" ? "danger" : "";
      access.append(mode);
      const statusCell = d.createElement("td");
      const badge = d.createElement("span");
      badge.className = "invitation-state";
      badge.dataset.state = state;
      badge.textContent = t(
        (
          {
            available: "enrollment.auth.state.available",
            revoked: "enrollment.auth.state.revoked",
            expired: "enrollment.auth.state.expired",
            used: "enrollment.auth.state.used",
            reserved: "enrollment.auth.state.reserved",
          } as Record<string, string>
        )[state] || "enrollment.auth.state.unknown",
      );
      statusCell.append(badge);
      const expiry = d.createElement("td");
      expiry.className = "invitation-expiry";
      expiry.title = date(r.expiresAt);
      const left = Math.max(
        0,
        Math.ceil((Date.parse(r.expiresAt) - Date.now()) / 60000),
      );
      expiry.textContent =
        state === "available"
          ? t("{count} min remaining", { count: left })
          : date(r.expiresAt);
      const action = d.createElement("td");
      const details = d.createElement("details");
      const summary = d.createElement("summary");
      summary.title = t("Details");
      summary.setAttribute("aria-label", t("Details"));
      summary.innerHTML = detailsIcon;
      const info = d.createElement("div");
      info.className = "invitation-record-details";
      info.textContent = [
        t("Created: {date}", { date: date(r.createdAt) }),
        t("Claimed by: {user}", { user: r.claimedBy || "—" }),
        r.targetUserId ? t("Account: {user}", { user: r.targetUserId }) : "",
        t("Expires: {date}", { date: date(r.expiresAt) }),
      ]
        .filter(Boolean)
        .join("\n");
      details.append(summary, info);
      action.append(details);
      if (state === "available") {
        const revoke = d.createElement("button");
        revoke.type = "button";
        revoke.className = "invitation-icon danger";
        revoke.dataset.revokeInvitation = r.id;
        revoke.title = t("enrollment.auth.revoke");
        revoke.setAttribute("aria-label", t("enrollment.auth.revoke"));
        revoke.innerHTML = revokeIcon;
        action.append(revoke);
      }
      row.append(name, access, statusCell, expiry, action);
      body.append(row);
    }
    table.append(body);
    list.append(table);
  }
  function renderGenerated() {
    const box = el("invite-new-box");
    box.replaceChildren();
    if (!generated) return;
    box.className = "invitation-share";
    const heading = d.createElement("div");
    const title = d.createElement("strong");
    title.textContent = t("invitations.ready");
    const help = d.createElement("small");
    help.textContent = t("invitations.shareHelp");
    const expiry = d.createElement("small");
    expiry.className = "invitation-expiry-note";
    expiry.textContent = t("This link expires {date}.", {
      date: date(generated.expiresAt),
    });
    heading.append(title, help, expiry);
    const copy = d.createElement("button");
    copy.type = "button";
    copy.className = "invitation-copy";
    copy.innerHTML = copyIcon + "<span></span>";
    copy.querySelector("span")!.textContent = t("Copy link");
    copy.dataset.copyInvitation = "true";
    const details = d.createElement("details");
    const summary = d.createElement("summary");
    summary.textContent = t("invitations.showLink");
    const code = d.createElement("code");
    code.textContent = generated.link;
    details.append(summary, code);
    box.append(heading, copy, details);
  }
  async function load() {
    const request = ++epoch,
      identity = p.identity();
    status("Loading...");
    try {
      const result = await p.send("listEnrollments", {});
      if (disposed || request !== epoch || identity !== p.identity()) return;
      if (!result.success) throw Error(String(result.error || ""));
      const data = result.data as { enrollments?: Invitation[] } | undefined;
      entries = Array.isArray(data?.enrollments) ? data.enrollments : [];
      entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      render();
      status();
    } catch {
      if (request === epoch) status("Load failed", true);
    }
  }
  async function create() {
    if (creating) return;
    const identity = p.identity();
    creating = true;
    (el("invite-create") as HTMLButtonElement).disabled = true;
    try {
      const mode = (el("invite-sync-mode") as HTMLSelectElement).value;
      if (
        mode === "root" &&
        !(await p.confirm({
          title: t("enrollment.auth.rootConfirmTitle"),
          message: t("enrollment.auth.rootConfirmMessage"),
          confirmLabel: t("enrollment.auth.rootConfirmButton"),
          danger: true,
        }))
      )
        return;
      if (identity !== p.identity()) return;
      const result = await p.send("createEnrollment", {
        role: (el("invite-role") as HTMLSelectElement).value,
        syncMode: mode,
        expiresInHours: Number((el("invite-hours") as HTMLSelectElement).value),
        label: (el("invite-label") as HTMLInputElement).value.trim(),
      });
      if (identity !== p.identity()) return;
      const data = result.data as
        | { link?: string; expiresAt?: string }
        | undefined;
      if (!result.success || !data?.link)
        throw Error(String(result.error || ""));
      generated = { link: data.link, expiresAt: String(data.expiresAt || "") };
      renderGenerated();
      filter = "available";
      kind = "register";
      (el("invite-kind") as HTMLSelectElement).value = kind;
      await load();
    } catch (error) {
      status(operationError(error), true);
    } finally {
      creating = false;
      (el("invite-create") as HTMLButtonElement).disabled = false;
    }
  }
  async function onClick(event: Event) {
    const target = event.target as Element;
    const tab = target.closest<HTMLElement>("[data-invite-filter]");
    if (tab) {
      filter = tab.dataset.inviteFilter || "available";
      render();
      return;
    }
    if (target.closest("#invite-refresh")) {
      await load();
      return;
    }
    if (target.closest("#invite-create")) {
      await create();
      return;
    }
    if (target.closest("[data-copy-invitation]") && generated) {
      try {
        await p.clipboard.writeText(generated.link);
        status("Copied");
      } catch {
        status("Copy failed", true);
      }
      return;
    }
    const revoke = target.closest<HTMLButtonElement>(
      "[data-revoke-invitation]",
    );
    if (revoke) {
      revoke.disabled = true;
      const identity = p.identity();
      try {
        const result = await p.send("revokeEnrollment", {
          enrollmentId: revoke.dataset.revokeInvitation,
        });
        if (identity !== p.identity()) return;
        await load();
        if (!result.success) status(operationError(result.error), true);
      } catch (error) {
        status(operationError(error), true);
      } finally {
        revoke.disabled = false;
      }
    }
  }
  function init() {
    pane.classList.add("invitation-center");
    pane.innerHTML = `
      <header class="invitation-center-head">
        <div><h2 data-invite-i18n="enrollment.auth.inviteLinks"></h2><p data-invite-i18n="invitations.subtitle"></p></div>
        <button type="button" id="invite-refresh" class="invitation-icon">${refreshIcon}</button>
      </header>
      <section class="invitation-create">
        <div class="invitation-create-title"><span class="invitation-mark" aria-hidden="true">${plusIcon}</span><strong data-invite-i18n="invitations.create"></strong></div>
        <div class="invitation-form">
          <label><span data-invite-i18n="invitations.label"></span><input id="invite-label" maxlength="80"></label>
          <label><span data-invite-i18n="invitations.role"></span><select id="invite-role"><option value="member" data-invite-i18n="Member"></option><option value="admin" id="invite-role-admin" data-invite-i18n="Admin"></option></select></label>
          <label><span data-invite-i18n="enrollment.auth.access"></span><select id="invite-sync-mode"><option value="restricted" data-invite-i18n="enrollment.auth.restricted"></option><option value="root" id="invite-sync-root" data-invite-i18n="enrollment.auth.rootAccess"></option></select></label>
          <label><span data-invite-i18n="invitations.validity"></span><select id="invite-hours"><option value="1" data-invite-i18n="invitations.oneHour"></option><option value="6" data-invite-i18n="invitations.sixHours"></option><option value="24" data-invite-i18n="invitations.oneDay"></option></select></label>
          <button id="invite-create" type="button">${plusIcon}<span data-invite-i18n="invitations.generate"></span></button>
        </div>
      </section>
      <div id="invite-new-box"></div>
      <div class="invitation-tools">
        <div class="invitation-filters">
          <button type="button" data-invite-filter="available"><span data-invite-i18n="invitations.active"></span><b id="invite-available-count">0</b></button>
          <button type="button" data-invite-filter="history"><span data-invite-i18n="History"></span><b id="invite-history-count">0</b></button>
        </div>
        <select id="invite-kind"><option value="register" data-invite-i18n="enrollment.auth.kind.register"></option><option value="device" data-invite-i18n="enrollment.auth.kind.device"></option><option value="root" data-invite-i18n="enrollment.auth.kind.root"></option></select>
        <label class="invitation-search"><span aria-hidden="true">${searchIcon}</span><input id="invite-search" type="search"></label>
      </div>
      <div id="invite-list" class="invitation-list"></div>
      <p id="invite-status" role="status" aria-live="polite"></p>`;
    pane.addEventListener("click", onClick, { signal: events.signal });
    el("invite-kind").addEventListener(
      "change",
      () => {
        kind = (el("invite-kind") as HTMLSelectElement).value;
        render();
      },
      { signal: events.signal },
    );
    el("invite-search").addEventListener(
      "input",
      () => {
        search = (el("invite-search") as HTMLInputElement).value
          .trim()
          .toLowerCase();
        render();
      },
      { signal: events.signal },
    );
    render();
  }
  init();
  const timer = setInterval(() => {
    if (
      !disposed &&
      pane.classList.contains("active") &&
      d.getElementById("admin-modal")?.classList.contains("open")
    )
      render();
  }, 30000);
  return {
    load,
    refreshLocale() {
      render();
      renderGenerated();
    },
    reset() {
      epoch++;
      entries = [];
      generated = null;
      render();
      renderGenerated();
    },
    dispose() {
      disposed = true;
      epoch++;
      events.abort();
      clearInterval(timer);
    },
  };
}
