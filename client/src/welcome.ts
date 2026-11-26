export const WELCOME_SERVICE_ID = 'workbench.welcome';

interface Preview { id: string; kind: string; host: string; httpPort: number; certificateFingerprint: string; version: string; expiresAt: string; syncMode: string; requiresPasswordSetup?: boolean }
interface WelcomePorts {
  document: Document;
  host: { enrollmentPreview(link: string): Promise<Preview>; enrollmentActivate(id: string): Promise<Record<string, unknown>>; enrollmentIncoming(): Promise<string>; onEnrollmentOpen(callback: () => void): () => void; writeServerSettings(settings: unknown): Promise<unknown>; commitServerSettings(): Promise<unknown> };
  t(key: string, params?: Record<string, unknown>): string;
  locale(): string; setLocale(id: string): Promise<unknown>;
  beforeServerChange(): Promise<boolean>;
  applySettings(settings: Record<string, unknown>): void;
  authenticate(kind: string, id: string, requiresPasswordSetup?: boolean): void;
  completeLocal(): Promise<void>;
}

// An editor-area document, independent of the settings dialog and Monaco model.
// All link parsing, TLS verification, and credential handling belongs to main.
export function createWelcome(ports: WelcomePorts) {
  const d = ports.document;
  let page: HTMLElement | null = null;
  let preview: Preview | null = null;
  let revision = 0;
  let disposeIncoming: (() => void) | undefined;
  let disposed = false;
  function text(id: string, value: string) { const element = d.getElementById(id); if (element) element.textContent = value; }
  function render() {
    if (!page) return;
    for (const node of page.querySelectorAll<HTMLElement>('[data-welcome-i18n]')) node.textContent = ports.t(node.dataset.welcomeI18n || '');
    const language = d.getElementById('welcome-language') as HTMLSelectElement | null;
    if (language) language.value = ports.locale();
    if (preview) text('welcome-kind', ports.t(preview.requiresPasswordSetup ? 'enrollment.kind.rootSetup' : 'enrollment.kind.' + preview.kind));
  }
  function close() { if (page) page.hidden = true; d.getElementById('editor')?.classList.remove('welcome-open'); d.getElementById('welcome-editor-tab')?.remove(); }
  function open() {
    if (disposed) return;
    if (!page) {
      page = d.createElement('section'); page.id = 'welcome-page'; page.className = 'welcome-page'; page.setAttribute('aria-labelledby', 'welcome-title');
      page.innerHTML = `<div class="welcome-content"><header class="welcome-top"><span class="welcome-wordmark">BOBOCLOUD <span>3.0</span></span><label class="welcome-language"><span data-welcome-i18n="enrollment.language"></span><select id="welcome-language" aria-label="Language"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option></select></label></header>
      <div class="welcome-hero"><div class="welcome-art" aria-hidden="true"><svg viewBox="0 0 320 170" fill="none"><path class="welcome-orbit" d="M22 114C60 28 259 11 298 96S69 188 22 114Z"/><path class="welcome-orbit secondary" d="M30 64C114 5 302 93 274 135S25 131 30 64Z"/><path class="welcome-cloud" d="M104 105a23 23 0 0 1 0-46 41 41 0 0 1 78-12 29 29 0 0 1 9 58H104Z"/><path class="welcome-code" d="m135 70-11 10 11 10m27-20 11 10-11 10m-13-25-7 30"/><circle class="welcome-node" cx="44" cy="78" r="6"/><circle class="welcome-node" cx="266" cy="115" r="5"/><path class="welcome-spark" d="M246 37v14m-7-7h14M78 128v10m-5-5h10"/></svg></div><div class="welcome-kicker" data-welcome-i18n="enrollment.kicker"></div><h1 id="welcome-title" data-welcome-i18n="enrollment.title"></h1><p data-welcome-i18n="enrollment.subtitle"></p></div>
      <form id="welcome-form" class="welcome-connect"><div class="welcome-step"><span>01</span><label for="welcome-link" data-welcome-i18n="enrollment.linkLabel"></label></div><textarea id="welcome-link" rows="3" spellcheck="false" autocomplete="off" placeholder="bobocloud://enroll#…"></textarea><div class="welcome-form-foot"><span data-welcome-i18n="enrollment.linkHelp"></span><button id="welcome-preview" type="submit" class="welcome-primary" data-welcome-i18n="enrollment.inspect"></button></div></form>
      <section id="welcome-overview" class="welcome-overview" hidden><div class="welcome-step"><span>02</span><h2 data-welcome-i18n="enrollment.serverOverview"></h2><span class="welcome-verified" data-welcome-i18n="enrollment.verified"></span></div><dl><div><dt data-welcome-i18n="enrollment.server"></dt><dd id="welcome-server"></dd></div><div><dt data-welcome-i18n="enrollment.kind"></dt><dd id="welcome-kind"></dd></div><div><dt data-welcome-i18n="enrollment.version"></dt><dd id="welcome-version"></dd></div><div><dt data-welcome-i18n="enrollment.expiry"></dt><dd id="welcome-expiry"></dd></div></dl><details><summary data-welcome-i18n="enrollment.certificate"></summary><code id="welcome-pin"></code></details><button id="welcome-connect" class="welcome-primary" type="button" data-welcome-i18n="enrollment.connect"></button></section>
      <p id="welcome-status" class="welcome-status" role="status" aria-live="polite"></p><footer class="welcome-bottom"><button id="welcome-local" class="welcome-text-button" type="button" data-welcome-i18n="enrollment.local"></button><span data-welcome-i18n="enrollment.privacy"></span></footer><div class="welcome-arrival" aria-hidden="true"><div class="welcome-arrival-ring"></div><strong data-welcome-i18n="enrollment.connected"></strong></div></div>`;
      d.getElementById('editor')?.appendChild(page);
      d.getElementById('welcome-form')?.addEventListener('submit', inspect);
      d.getElementById('welcome-connect')?.addEventListener('click', connect);
      d.getElementById('welcome-language')?.addEventListener('change', async event => { await ports.setLocale((event.target as HTMLSelectElement).value); render(); });
      d.getElementById('welcome-local')?.addEventListener('click', async () => { await ports.completeLocal(); close(); });
      d.getElementById('welcome-link')?.addEventListener('input', () => { revision++; preview = null; const overview = d.getElementById('welcome-overview'); if (overview) overview.hidden = true; });
    }
    page.hidden = false;
    d.getElementById('editor')?.classList.add('welcome-open');
    if (!d.getElementById('welcome-editor-tab')) {
      const tab = d.createElement('button'); tab.id = 'welcome-editor-tab'; tab.className = 'tab active'; tab.type = 'button'; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected','true');
      tab.textContent = ports.t('enrollment.tab'); tab.onclick = close; d.getElementById('tabbar')?.appendChild(tab);
    }
    render();
  }
  async function inspect(event?: Event) {
    event?.preventDefault();
    const request = ++revision;
    const button = d.getElementById('welcome-preview') as HTMLButtonElement; button.disabled = true;
    text('welcome-status', ports.t('enrollment.checking'));
    try {
      const result = await ports.host.enrollmentPreview((d.getElementById('welcome-link') as HTMLTextAreaElement).value);
      if (disposed || request !== revision) return;
      preview = result;
      text('welcome-server', result.host + ':' + result.httpPort); text('welcome-kind', ports.t(result.requiresPasswordSetup ? 'enrollment.kind.rootSetup' : 'enrollment.kind.' + result.kind)); text('welcome-version', result.version);
      text('welcome-expiry', result.expiresAt ? new Date(result.expiresAt).toLocaleString(ports.locale()) : '—'); text('welcome-pin', result.certificateFingerprint.match(/.{2}/g)?.join(':') || '');
      const overview = d.getElementById('welcome-overview'); if (overview) overview.hidden = false;
      text('welcome-status', ports.t('enrollment.ready'));
    } catch (error) { if (request === revision) text('welcome-status', ports.t(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /,'') : 'enrollment.error.rejected')); }
    finally { button.disabled = false; }
  }
  async function connect() {
    const selected = preview; if (!selected) return;
    const button = d.getElementById('welcome-connect') as HTMLButtonElement; button.disabled = true;
    try {
      if (!await ports.beforeServerChange()) return;
      const settings = await ports.host.enrollmentActivate(selected.id); ports.applySettings(settings);
      await ports.host.commitServerSettings();
      page?.classList.add('arriving');
      await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 750));
      page?.classList.remove('arriving'); close();
      ports.authenticate(selected.kind, selected.id, selected.requiresPasswordSetup);
      (d.getElementById('welcome-link') as HTMLTextAreaElement).value = ''; preview = null;
    } catch (error) { text('welcome-status', ports.t(error instanceof Error ? error.message : 'enrollment.error.rejected')); }
    finally { button.disabled = false; }
  }
  async function receive() { const link = await ports.host.enrollmentIncoming(); if (link) { open(); (d.getElementById('welcome-link') as HTMLTextAreaElement).value = link; await inspect(); } }
  function init(firstRun: boolean) { disposeIncoming = ports.host.onEnrollmentOpen(() => { void receive(); }); if (firstRun) open(); void receive(); }
  return { init, open, close, render, dispose() { disposed = true; revision++; disposeIncoming?.(); page?.remove(); page = null; } };
}
