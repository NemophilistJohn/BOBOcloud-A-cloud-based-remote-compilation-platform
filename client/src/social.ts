import type { RendererState } from '../types/state';
import type { ConfirmFacade } from '../types/confirm-dialog';

interface Person { uid: string; name: string; avatar?: string; lastSyncAt?: string }
interface Message {
  id: string; sender: Person; kind: 'project' | 'note' | 'invite'; title: string;
  note?: string; status: string; createdAt: string; expiresAt?: string; bytes?: number; read?: boolean;
}
interface Inbox { pending: Message[]; archived: Message[]; unread: number }
interface Team { id: string; name: string; is_admin: boolean }
interface Project { key: string; name: string; sizeBytes?: number }
interface Dependencies {
  document: Document;
  events: Window;
  state: RendererState;
  send(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  t(key: string, params?: Record<string, unknown>): string;
  confirm: ConfirmFacade;
  profile(): void;
  signIn(): void;
  download(id: string, name: string): Promise<{ archived: boolean } | null>;
}

const icons: Record<string, string> = {
  inbox: '<path d="M4 4h16v16H4zM4 13h5l1 3h4l1-3h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  send: '<path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>'
};
function icon(name: string): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
}
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function createSocialService(d: Dependencies): { dispose(): void } {
  const { document: doc, events, state, t } = d;
  const host = doc.getElementById('collab-sidebar-friends');
  if (!host) return { dispose() {} };
  const listeners: (() => void)[] = [];
  const modal = doc.createElement('div');
  const menu = doc.createElement('div');
  modal.className = 'social-overlay';
  modal.hidden = true;
  menu.className = 'social-menu';
  menu.hidden = true;
  doc.body.append(menu, modal);
  let visible = false;
  let gone = false;
  let revision = 0;
  let identity = '';
  let refreshingRevision: number | undefined;
  let friends: Person[] = [];
  let inbox: Inbox = { pending: [], archived: [], unread: 0 };
  let friend: Person | undefined;
  let submenu: '' | 'project' | 'note' | 'invite' = '';
  let selected = '';
  let archive = false;
  let busy = false;
  let confirming = false;
  let returnFocus: HTMLElement | null = null;
  let closeTimer: number | undefined;
  let refreshTimer: number | undefined;

  function on(target: EventTarget, event: string, fn: EventListener): void {
    target.addEventListener(event, fn);
    listeners.push(() => target.removeEventListener(event, fn));
  }
  function currentIdentity(): string {
    return JSON.stringify([state.serverSettings?.ip, state.serverSettings?.httpPort,
      state.serverSettings?.secureTransport, state.auth?.token, state.auth?.user?.uid]);
  }
  function valid(r: number): boolean { return !gone && r === revision && identity === currentIdentity(); }
  function avatar(p: Person): string {
    const data = p.avatar || '';
    if (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(data)) {
      return '<span class="social-avatar"><img alt="" src="' + esc(data) + '"></span>';
    }
    const preset = /^(ocean|forest|sunset|graphite|violet|rose|amber)$/.test(data) ? data : 'ocean';
    return '<span class="social-avatar avatar-' + preset + '">' + esc((p.name || p.uid).slice(0, 1).toUpperCase()) + '</span>';
  }
  function time(value?: string): string {
    if (!value) return t('Not synced yet');
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : t('Not synced yet');
  }
  function self(): Person {
    const u = state.auth?.user;
    return { uid: String(u?.uid || ''), name: String(u?.name || u?.username || ''), avatar: String(u?.avatar || '') };
  }
  function render(): void {
    if (!host) return;
    if (!state.auth?.token || !state.auth.user) {
      host.innerHTML = '<div class="collab-empty">' + esc(t('Sign in to connect with people on this server')) + '<button data-social="signin">' + esc(t('Sign in')) + '</button></div>';
      return;
    }
    const me = self();
    host.innerHTML = '<div class="social-self"><button data-social="profile" class="social-profile">' + avatar(me) + '<span><strong>' + esc(me.name) + '</strong><small>' + esc(me.uid) + '</small></span></button>' +
      '<button data-social="inbox" class="social-icon social-inbox-button" title="' + esc(t('Personal inbox')) + '" aria-label="' + esc(t('Personal inbox')) + '">' + icon('inbox') +
      (inbox.unread ? '<span class="social-unread">' + Math.min(inbox.unread, 99) + '</span>' : '') + '</button></div>' +
      '<div class="social-list-heading"><span>' + esc(t('People on this server')) + '</span><button data-social="refresh" class="social-icon" aria-label="' + esc(t('Refresh')) + '">' + icon('refresh') + '</button></div>' +
      (friends.length ? friends.map((p, i) => '<div class="social-person">' + avatar(p) + '<span class="social-person-copy"><strong dir="auto">' + esc(p.name) + '</strong><small>' + esc(p.uid) +
        '</small><small class="social-last-sync" title="' + esc(t('Last successful sync')) + '">' + esc(time(p.lastSyncAt)) + '</small></span><button data-friend="' + i + '" class="social-icon social-friend-menu" aria-haspopup="menu" aria-label="' + esc(t('Actions for {name}', { name: p.name })) + '">' + icon('more') + '</button></div>').join('') :
      '<div class="collab-empty">' + esc(t('No other people on this server yet')) + '</div>');
  }
  function notice(error: unknown, target: HTMLElement | null = host): void {
    if (!target) return;
    let el = target.querySelector<HTMLElement>('.social-error');
    if (!el) { el = doc.createElement('div'); el.className = 'social-error'; el.setAttribute('role', 'alert'); target.append(el); }
    el.textContent = t('Could not complete this action') + ': ' + String(error instanceof Error ? error.message : error);
  }
  function closeMenu(): void {
    if (confirming) return;
    clearTimeout(closeTimer);
    menu.hidden = true;
    friend = undefined;
    submenu = '';
  }
  function scheduleClose(): void {
    clearTimeout(closeTimer);
    closeTimer = events.setTimeout(closeMenu, 400);
  }
  function cancelClose(): void { clearTimeout(closeTimer); }
  function position(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(530, events.innerWidth - 24);
    menu.style.maxWidth = width + 'px';
    menu.style.left = Math.max(12, Math.min(rect.right + 5, events.innerWidth - menu.offsetWidth - 12)) + 'px';
    menu.style.top = Math.max(12, Math.min(rect.top - 8, events.innerHeight - menu.offsetHeight - 12)) + 'px';
  }
  function openMenu(button: HTMLElement, p: Person): void {
    cancelClose();
    if (confirming || busy) return;
    if (friend?.uid === p.uid && !menu.hidden) return;
    friend = p;
    submenu = '';
    menu.innerHTML = '<div class="social-menu-main" role="menu"><button role="menuitem" data-sub="project">' + esc(t('Send project')) + '<span>›</span></button><button role="menuitem" data-sub="note">' + esc(t('Send note')) + '<span>›</span></button><button role="menuitem" data-sub="invite">' + esc(t('Invite to team')) + '<span>›</span></button></div><div class="social-submenu" hidden></div>';
    menu.hidden = false;
    position(button);
  }
  async function showSub(kind: typeof submenu): Promise<void> {
    if (!kind || !friend || busy) return;
    submenu = kind;
    const r = revision;
    const uid = friend.uid;
    const sub = menu.querySelector<HTMLElement>('.social-submenu')!;
    sub.hidden = false;
    sub.innerHTML = '<span class="collab-empty">' + esc(t('Loading...')) + '</span>';
    menu.querySelectorAll<HTMLElement>('[data-sub]').forEach(el => el.classList.toggle('active', el.dataset.sub === kind));
    if (kind === 'note') {
      sub.innerHTML = '<label for="social-note">' + esc(t('Note (up to 150 characters)')) + '</label><textarea id="social-note" rows="4" maxlength="300"></textarea><div class="social-note-footer"><span id="social-note-count">0 / 150</span><button class="social-icon" data-send-note aria-label="' + esc(t('Send note')) + '">' + icon('send') + '</button></div>';
      sub.querySelector('textarea')?.focus();
      return;
    }
    try {
      const response = kind === 'project' ? await d.send('listProjects') : await d.send('listTeams');
      if (!valid(r) || friend?.uid !== uid || submenu !== kind) return;
      const items = kind === 'project' ? (response as { projects?: Project[] } | undefined)?.projects || [] : (response as Team[]).filter(item => item.is_admin);
      sub.innerHTML = items.length ? items.map(item => '<button data-offer="' + esc(kind === 'project' ? (item as Project).key : (item as Team).id) + '" data-title="' + esc(item.name) + '" title="' + esc(item.name) + '"><span dir="auto">' + esc(item.name) + '</span></button>').join('') :
        '<span class="collab-empty">' + esc(t(kind === 'project' ? 'No personal cloud projects' : 'No teams you administer')) + '</span>';
      const anchor = host?.querySelector<HTMLElement>('[data-friend="' + friends.findIndex(p => p.uid === uid) + '"]');
      if (anchor) position(anchor);
    } catch (error) { if (valid(r) && submenu === kind) { sub.innerHTML = ''; notice(error, sub); } }
  }
  async function sendOffer(button: HTMLElement): Promise<void> {
    if (!friend || busy || confirming) return;
    const r = revision;
    const uid = friend.uid;
    const kind = submenu;
    const title = button.dataset.title || '';
    const key = button.dataset.offer;
    confirming = true;
    button.setAttribute('disabled', '');
    cancelClose();
    let sent = false;
    try {
      const ok = await d.confirm({
        title: t(kind === 'project' ? 'Send project snapshot' : 'Invite to team'),
        message: kind === 'project' ? t('Send a snapshot of {project} to {name}?', { project: title, name: friend.name }) :
          t('Invite {name} to team {team}?', { name: friend.name, team: title }),
        confirmLabel: t('Yes'), cancelLabel: t('No')
      });
      if (!ok || !valid(r)) return;
      busy = true;
      button.setAttribute('disabled', '');
      await d.send('sendInbox', { recipientId: uid, kind, ...(kind === 'project' ? { projectKey: key } : { teamId: key }) });
      sent = true;
      if (valid(r)) { button.textContent = t('Sent'); button.setAttribute('disabled', ''); }
    } catch (error) { if (valid(r)) { button.removeAttribute('disabled'); notice(error, menu.querySelector<HTMLElement>('.social-submenu')); } }
    finally { busy = false; confirming = false; if (!sent) button.removeAttribute('disabled'); }
  }
  async function sendNote(): Promise<void> {
    const input = menu.querySelector<HTMLTextAreaElement>('textarea');
    const note = input?.value.trim() || '';
    if (!friend || busy || !note || [...note].length > 150) return;
    const r = revision;
    busy = true;
    try {
      await d.send('sendInbox', { recipientId: friend.uid, kind: 'note', note });
      if (valid(r) && input) { input.value = ''; input.dispatchEvent(new Event('input')); }
    } catch (error) { if (valid(r)) notice(error, menu.querySelector<HTMLElement>('.social-submenu')); }
    finally { busy = false; }
  }
  function showInbox(): void {
    closeMenu();
    if (modal.hidden) returnFocus = doc.activeElement as HTMLElement | null;
    modal.hidden = false;
    modal.innerHTML = '<section class="social-inbox-dialog" role="dialog" aria-modal="true" aria-labelledby="social-inbox-title"><header><h2 id="social-inbox-title">' + esc(t('Personal inbox')) +
      '</h2><button class="social-icon" data-close aria-label="' + esc(t('Close')) + '">' + icon('close') + '</button></header><div class="social-inbox-tabs" role="tablist"><button data-inbox-tab="pending" role="tab">' + esc(t('Pending')) + '</button><button data-inbox-tab="archive" role="tab">' + esc(t('Archive')) + '</button></div><div class="social-inbox-content"><div class="social-messages"></div><article class="social-message-detail"></article></div></section>';
    renderInbox();
    modal.querySelector<HTMLButtonElement>('[data-close]')?.focus();
    void refresh();
  }
  function label(m: Message): string { return m.kind === 'note' ? t('Note') : m.title || t(m.kind === 'project' ? 'Project snapshot' : 'Team invitation'); }
  function renderInbox(): void {
    if (modal.hidden) return;
    const messages = archive ? inbox.archived : inbox.pending;
    const list = modal.querySelector<HTMLElement>('.social-messages')!;
    modal.querySelectorAll<HTMLElement>('[data-inbox-tab]').forEach(el => el.setAttribute('aria-selected', String((el.dataset.inboxTab === 'archive') === archive)));
    list.innerHTML = messages.length ? messages.map(m => '<button class="social-message-row" data-message="' + esc(m.id) + '" aria-pressed="' + String(m.id === selected) + '">' + avatar(m.sender) +
      '<span><strong dir="auto">' + esc(label(m)) + '</strong><small>' + esc(m.sender.name) + ' · ' + esc(time(m.createdAt)) + '</small><span class="social-message-preview" dir="auto">' + esc(m.note || t(m.kind === 'project' ? 'Project snapshot' : 'Team invitation')) + '</span></span></button>').join('') :
      '<div class="collab-empty">' + esc(t('No messages')) + '</div>';
    renderMessage(messages.find(m => m.id === selected) || (inbox.archived.find(m => m.id === selected)));
  }
  function renderMessage(m?: Message): void {
    const target = modal.querySelector<HTMLElement>('.social-message-detail')!;
    if (!m) { target.innerHTML = '<div class="collab-empty">' + esc(t('Select a message')) + '</div>'; return; }
    const pending = m.status === 'pending' && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now());
    target.innerHTML = '<h3 dir="auto">' + esc(label(m)) + '</h3><p>' + esc(m.sender.name) + ' · ' + esc(m.sender.uid) + '</p><time>' + esc(time(m.createdAt)) + '</time>' +
      (m.note ? '<p class="social-note-body" dir="auto">' + esc(m.note) + '</p>' : '') +
      (m.expiresAt ? '<p>' + esc(t('Valid until {time}', { time: time(m.expiresAt) })) + '</p>' : '') +
      (m.bytes !== undefined ? '<p>' + esc((m.bytes / 1e6).toFixed(2)) + ' MB</p>' : '') +
      '<div class="social-message-actions">' + (pending && m.kind !== 'note' ? (m.kind === 'project' ?
        '<button data-decision="cloud">' + esc(t('Receive in cloud')) + '</button><button data-decision="local">' + esc(t('Receive locally')) + '</button>' :
        '<button data-decision="invite">' + esc(t('Accept invitation')) + '</button>') +
        '<button data-decision="reject">' + esc(t('Reject')) + '</button>' : '<span>' + esc(t(m.status === 'pending' ? 'Read' : ({ accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', read: 'Read' }[m.status] || 'Read'))) + '</span>') + '</div>';
  }
  async function readMessage(id: string): Promise<void> {
    selected = id;
    renderInbox();
    const message = inbox.pending.find(m => m.id === id);
    if (message && !message.read) await decide('read');
  }
  async function decide(decision: string): Promise<void> {
    const message = inbox.pending.find(m => m.id === selected);
    if (!message || busy) return;
    const r = revision;
    busy = true;
    const article = modal.querySelector<HTMLElement>('.social-message-detail');
    let ackFailed = false;
    article?.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = true; });
    try {
      if (decision === 'local') {
        const result = await d.download(message.id, label(message));
        if (!result || !valid(r)) return;
        ackFailed = !result.archived;
      } else {
        await d.send('respondInbox', { messageId: message.id, decision });
        if (decision === 'cloud') events.dispatchEvent(new Event('bobo:cloud-storage-changed'));
      }
      if (valid(r)) await refresh();
      if (valid(r) && ackFailed) notice(t('Project saved locally; inbox confirmation can be retried'), article);
    } catch (error) { if (valid(r)) notice(error, article); }
    finally { busy = false; article?.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = false; }); }
  }
  async function refresh(): Promise<void> {
    if (refreshingRevision === revision || !state.auth?.token || !state.auth.user) { render(); return; }
    const r = revision;
    refreshingRevision = r;
    try {
      const [people, messages] = await Promise.all([d.send('listFriends'), d.send('listInbox')]);
      if (!valid(r)) return;
      friends = (people as Person[]).filter(p => p.uid !== self().uid);
      inbox = messages as Inbox;
      render();
      renderInbox();
    } catch (error) { if (valid(r)) notice(error, modal.hidden ? host : modal.querySelector<HTMLElement>('.social-inbox-dialog')); }
    finally { if (refreshingRevision === r) refreshingRevision = undefined; }
  }
  function reset(): void {
    revision++;
    identity = currentIdentity();
    confirming = false;
    closeMenu();
    modal.hidden = true;
    friends = [];
    inbox = { pending: [], archived: [], unread: 0 };
    selected = '';
    render();
  }
  on(host, 'click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('button');
    if (!el) return;
    if (el.dataset.social === 'profile') d.profile();
    if (el.dataset.social === 'signin') d.signIn();
    if (el.dataset.social === 'inbox') showInbox();
    if (el.dataset.social === 'refresh') void refresh();
    if (el.dataset.friend !== undefined) openMenu(el, friends[Number(el.dataset.friend)]!);
  });
  on(host, 'pointerover', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-friend]');
    if (el) openMenu(el, friends[Number(el.dataset.friend)]!);
  });
  on(host, 'pointerout', (ev) => {
    if ((ev.target as Element).closest('[data-friend]')) scheduleClose();
  });
  on(menu, 'pointerenter', cancelClose);
  on(menu, 'pointerleave', scheduleClose);
  on(menu, 'pointerover', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-sub]');
    if (el?.dataset.sub && submenu !== el.dataset.sub) void showSub(el.dataset.sub as typeof submenu);
  });
  on(menu, 'click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('button');
    if (!el) return;
    if (el.dataset.sub) void showSub(el.dataset.sub as typeof submenu);
    if (el.dataset.offer) void sendOffer(el);
    if (el.hasAttribute('data-send-note')) void sendNote();
  });
  on(menu, 'input', (ev) => {
    const input = menu.querySelector<HTMLTextAreaElement>('textarea');
    const counter = menu.querySelector('#social-note-count');
    if (input && !(ev as InputEvent).isComposing && [...input.value].length > 150) input.value = [...input.value].slice(0, 150).join('');
    if (input && counter) counter.textContent = [...input.value].length + ' / 150';
  });
  on(modal, 'click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('button');
    if (!el) return;
    if (el.hasAttribute('data-close')) { modal.hidden = true; returnFocus?.focus(); }
    if (el.dataset.inboxTab) { archive = el.dataset.inboxTab === 'archive'; selected = ''; renderInbox(); }
    if (el.dataset.message) void readMessage(el.dataset.message);
    if (el.dataset.decision) void decide(el.dataset.decision);
  });
  on(doc, 'pointerdown', (ev) => {
    if (!menu.contains(ev.target as Node) && !modal.contains(ev.target as Node) && !(ev.target as Element).closest('[data-friend]')) closeMenu();
  });
  on(doc, 'keydown', (ev) => {
    const key = ev as KeyboardEvent;
    if (key.key === 'Escape' && !confirming) { closeMenu(); if (!modal.hidden) { modal.hidden = true; returnFocus?.focus(); } }
    if (key.key === 'Tab' && !modal.hidden) {
      const elements = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const first = elements[0], last = elements[elements.length - 1];
      if (key.shiftKey && doc.activeElement === first) { key.preventDefault(); last?.focus(); }
      if (!key.shiftKey && doc.activeElement === last) { key.preventDefault(); first?.focus(); }
    }
  });
  on(events, 'bobo:social-friends-visible', () => {
    visible = true;
    if (identity !== currentIdentity()) reset();
    void refresh();
    clearInterval(refreshTimer);
    refreshTimer = events.setInterval(() => { if (visible && !doc.hidden && doc.hasFocus()) void refresh(); }, 60000);
  });
  on(events, 'bobo:social-friends-hidden', () => { visible = false; clearInterval(refreshTimer); closeMenu(); });
  on(events, 'bobo:auth-changed', () => { if (identity !== currentIdentity()) { reset(); if (visible) void refresh(); } });
  on(events, 'bobo:language-changed', () => { render(); closeMenu(); if (!modal.hidden) showInbox(); });
  on(events, 'resize', closeMenu);
  reset();
  return { dispose() { gone = true; revision++; listeners.splice(0).forEach(fn => fn()); clearInterval(refreshTimer); clearTimeout(closeTimer); menu.remove(); modal.remove(); } };
}
