'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const { createNavigationSecurity } = require('../main/navigation-security');

function event(url, isMainFrame) {
  return {
    url,
    isMainFrame,
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
}

function createHarness() {
  const listeners = new Map();
  const opened = [];
  const trustedRendererPath = path.join(process.cwd(), 'index.html');
  const webContents = {
    currentUrl: pathToFileURL(trustedRendererPath).href,
    on(name, listener) { listeners.set(name, listener); },
    setWindowOpenHandler(listener) { this.windowOpenHandler = listener; },
    getURL() { return this.currentUrl; }
  };
  const session = {
    setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; },
    setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  };
  const security = createNavigationSecurity({
    shell: { openExternal: async (url) => { opened.push(url); } },
    trustedRendererPath
  });
  security.protectSession(session);
  security.protectWindow({ webContents });
  return { security, listeners, opened, webContents, session, trustedRendererPath };
}

test('only the local workbench document is trusted for in-app navigation', () => {
  const harness = createHarness();
  const trusted = pathToFileURL(harness.trustedRendererPath).href;
  assert.equal(harness.security.isTrustedRendererUrl(trusted), true);
  assert.equal(harness.security.isTrustedRendererUrl(trusted + '?restore=1#editor'), true);
  assert.equal(harness.security.isTrustedRendererUrl(pathToFileURL(path.join(process.cwd(), 'other.html')).href), false);
  assert.equal(harness.security.isTrustedRendererUrl('https://example.test/'), false);
  assert.equal(harness.security.isTrustedRendererUrl('not a url'), false);
});

test('the main-process composition installs the guard before loading the renderer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /require\('\.\/main\/navigation-security'\)/);
  assert.match(source, /webviewTag:\s*false/);
  assert.match(source, /navigationSecurity\.protectSession\(electronSession\.defaultSession\)/);
  const protectWindow = source.indexOf('navigationSecurity.protectWindow(window)');
  const loadRenderer = source.indexOf("window.loadFile(path.join(__dirname, 'index.html'))");
  assert.ok(protectWindow >= 0 && protectWindow < loadRenderer, 'guard must be active before the renderer loads');
});

test('only explicit HTTP(S) external links can leave the app', () => {
  const harness = createHarness();
  assert.equal(harness.security.allowedExternalUrl('https://docs.example.test/guide'), 'https://docs.example.test/guide');
  assert.equal(harness.security.allowedExternalUrl('http://docs.example.test/guide'), 'http://docs.example.test/guide');
  assert.equal(harness.security.allowedExternalUrl('javascript:alert(1)'), '');
  assert.equal(harness.security.allowedExternalUrl('file:///C:/secret.txt'), '');
  assert.equal(harness.security.allowedExternalUrl('mailto:person@example.test'), '');
  assert.equal(harness.security.allowedExternalUrl('https://user:secret@example.test/'), '');
});

test('navigation events retain the trusted renderer and only externalize blocked main-frame URLs', async () => {
  const harness = createHarness();
  const navigate = harness.listeners.get('will-navigate');
  const frameNavigate = harness.listeners.get('will-frame-navigate');
  const redirect = harness.listeners.get('will-redirect');
  const trustedEvent = event(pathToFileURL(harness.trustedRendererPath).href);
  navigate(trustedEvent);
  assert.equal(trustedEvent.prevented, false);

  const externalEvent = event('https://docs.example.test/guide');
  navigate(externalEvent);
  assert.equal(externalEvent.prevented, true);

  const subframeEvent = event('https://sandbox.example.test/exfiltrate?secret=value', false);
  frameNavigate(subframeEvent);
  assert.equal(subframeEvent.prevented, true);
  const subframeRedirectEvent = event('https://redirect.example.test/exfiltrate?secret=value', false);
  redirect(subframeRedirectEvent);
  assert.equal(subframeRedirectEvent.prevented, true);
  const ambiguousFrameEvent = event('https://ambiguous.example.test/exfiltrate');
  frameNavigate(ambiguousFrameEvent);
  assert.equal(ambiguousFrameEvent.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.opened, ['https://docs.example.test/guide'], 'subframe and ambiguous navigation must fail closed');

  const blockedEvent = event('javascript:alert(1)');
  frameNavigate(blockedEvent, undefined, false);
  assert.equal(blockedEvent.prevented, true);
  const mainFrameRedirectEvent = event('https://redirect.example.test/', true);
  redirect(mainFrameRedirectEvent);
  assert.equal(mainFrameRedirectEvent.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.opened, ['https://docs.example.test/guide', 'https://redirect.example.test/']);

  for (const url of ['about:blank', 'about:srcdoc']) {
    const pluginSandboxEvent = event(url, false);
    frameNavigate(pluginSandboxEvent);
    assert.equal(pluginSandboxEvent.prevented, false, 'the sandboxed plugin iframe must retain its local bootstrap');
  }
  const topLevelAboutBlank = event('about:blank', true);
  navigate(topLevelAboutBlank);
  assert.equal(topLevelAboutBlank.prevented, true, 'the privileged workbench must not navigate to about:blank');

  const legacyMainFrameEvent = event('');
  delete legacyMainFrameEvent.url;
  delete legacyMainFrameEvent.isMainFrame;
  frameNavigate(legacyMainFrameEvent, 'https://legacy.example.test/', true);
  assert.equal(legacyMainFrameEvent.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.opened, [
    'https://docs.example.test/guide',
    'https://redirect.example.test/',
    'https://legacy.example.test/'
  ]);
});

test('window.open is always denied and only approved links are opened by the system browser', async () => {
  const harness = createHarness();
  assert.deepEqual(harness.webContents.windowOpenHandler({ url: 'https://example.test/docs' }), { action: 'deny' });
  assert.deepEqual(harness.webContents.windowOpenHandler({ url: 'file:///C:/secret.txt' }), { action: 'deny' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.opened, ['https://example.test/docs']);
});

test('webviews and sensitive permissions are denied while trusted clipboard writes keep working', () => {
  const harness = createHarness();
  const attachEvent = event('');
  harness.listeners.get('will-attach-webview')(attachEvent, {}, {});
  assert.equal(attachEvent.prevented, true);

  let granted = null;
  harness.session.permissionRequestHandler(harness.webContents, 'media', (value) => { granted = value; });
  assert.equal(granted, false);
  harness.session.permissionRequestHandler(harness.webContents, 'clipboard-sanitized-write', (value) => { granted = value; });
  assert.equal(granted, true);
  assert.equal(harness.session.permissionCheckHandler(harness.webContents, 'geolocation'), false);
  assert.equal(harness.session.permissionCheckHandler(harness.webContents, 'clipboard-sanitized-write'), true);
  assert.equal(harness.session.permissionCheckHandler({ getURL: () => pathToFileURL(harness.trustedRendererPath).href }, 'clipboard-sanitized-write'), false);
  harness.webContents.currentUrl = 'https://untrusted.example.test/';
  assert.equal(harness.session.permissionCheckHandler(harness.webContents, 'clipboard-sanitized-write'), false);
  harness.session.permissionRequestHandler(harness.webContents, 'clipboard-sanitized-write', (value) => { granted = value; });
  assert.equal(granted, false);
});

test('external launch failures are contained and do not weaken navigation blocking', async () => {
  const listeners = new Map();
  const security = createNavigationSecurity({
    shell: { openExternal: () => Promise.reject(new Error('no browser')) },
    trustedRendererPath: path.join(process.cwd(), 'index.html')
  });
  const webContents = {
    on(name, listener) { listeners.set(name, listener); },
    setWindowOpenHandler() {},
    getURL() { return pathToFileURL(path.join(process.cwd(), 'index.html')).href; }
  };
  security.protectWindow({ webContents });
  const blocked = event('https://docs.example.test/');
  assert.doesNotThrow(() => listeners.get('will-navigate')(blocked));
  assert.equal(blocked.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
});
