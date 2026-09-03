'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const DEFAULT_EXTERNAL_PROTOCOLS = Object.freeze(['http:', 'https:']);

function normalizedPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createNavigationSecurity(options) {
  const shell = options && options.shell;
  const trustedRendererPath = options && options.trustedRendererPath;
  if (!shell || typeof shell.openExternal !== 'function') throw new TypeError('shell.openExternal is required');
  if (!trustedRendererPath) throw new TypeError('trustedRendererPath is required');

  const trustedPath = normalizedPath(trustedRendererPath);
  const externalProtocols = new Set(Array.from(options.externalProtocols || DEFAULT_EXTERNAL_PROTOCOLS)
    .map((protocol) => String(protocol).toLowerCase()));
  const trustedWebContents = new WeakSet();
  const recentlyOpenedExternalUrls = new Set();

  function isTrustedRendererUrl(value) {
    try {
      const target = new URL(String(value));
      if (target.protocol !== 'file:' || target.hostname) return false;
      return normalizedPath(fileURLToPath(target)) === trustedPath;
    } catch (_) {
      return false;
    }
  }

  function allowedExternalUrl(value) {
    try {
      const target = new URL(String(value));
      const protocol = target.protocol.toLowerCase();
      if (!externalProtocols.has(protocol)) return '';
      if (!target.hostname || target.username || target.password) return '';
      return target.href;
    } catch (_) {
      return '';
    }
  }

  function openExternal(value) {
    const target = allowedExternalUrl(value);
    if (!target || recentlyOpenedExternalUrls.has(target)) return false;
    recentlyOpenedExternalUrls.add(target);
    try {
      Promise.resolve(shell.openExternal(target))
        .catch(() => {})
        .finally(() => setTimeout(() => recentlyOpenedExternalUrls.delete(target), 0));
      return true;
    } catch (_) {
      recentlyOpenedExternalUrls.delete(target);
      return false;
    }
  }

  function navigationUrl(event, legacyUrl) {
    if (typeof legacyUrl === 'string') return legacyUrl;
    return event && typeof event.url === 'string' ? event.url : '';
  }

  function isPluginSandboxBootstrap(isMainFrame, value) {
    // The extension host uses a sandboxed srcdoc iframe; never allow these at top level.
    if (isMainFrame !== false) return false;
    try {
      const target = new URL(String(value));
      return target.href === 'about:blank' || target.href === 'about:srcdoc';
    } catch (_) {
      return false;
    }
  }

  function blockUntrustedNavigation(event, url, isMainFrame) {
    if (isTrustedRendererUrl(url) || isPluginSandboxBootstrap(isMainFrame, url)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    // Subframes are untrusted plugin/document sandboxes. Block their navigation
    // without turning it into an OS-level network side effect.
    if (isMainFrame === true) openExternal(url);
  }

  function navigationIsMainFrame(event, legacyIsMainFrame) {
    if (event && typeof event.isMainFrame === 'boolean') return event.isMainFrame;
    return legacyIsMainFrame === true;
  }

  function isTrustedWebContents(webContents) {
    return Boolean(webContents && trustedWebContents.has(webContents) &&
      typeof webContents.getURL === 'function' && isTrustedRendererUrl(webContents.getURL()));
  }

  function protectWindow(browserWindow) {
    if (!browserWindow || !browserWindow.webContents) throw new TypeError('BrowserWindow webContents is required');
    const webContents = browserWindow.webContents;
    trustedWebContents.add(webContents);

    webContents.on('will-navigate', (event, legacyUrl) => {
      blockUntrustedNavigation(event, navigationUrl(event, legacyUrl), true);
    });
    webContents.on('will-frame-navigate', (event, legacyUrl, isMainFrame) => {
      blockUntrustedNavigation(
        event,
        navigationUrl(event, legacyUrl),
        navigationIsMainFrame(event, isMainFrame)
      );
    });
    webContents.on('will-redirect', (event, legacyUrl, isInPlace, isMainFrame) => {
      blockUntrustedNavigation(
        event,
        navigationUrl(event, legacyUrl),
        navigationIsMainFrame(event, isMainFrame)
      );
    });
    webContents.on('will-attach-webview', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
    webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
  }

  function protectSession(session) {
    if (!session || typeof session.setPermissionCheckHandler !== 'function' ||
      typeof session.setPermissionRequestHandler !== 'function') {
      throw new TypeError('Electron session permission handlers are required');
    }
    session.setPermissionCheckHandler((webContents, permission) =>
      permission === 'clipboard-sanitized-write' && isTrustedWebContents(webContents));
    session.setPermissionRequestHandler((webContents, permission, callback) =>
      callback(permission === 'clipboard-sanitized-write' && isTrustedWebContents(webContents)));
  }

  return {
    protectWindow,
    protectSession,
    isTrustedRendererUrl,
    allowedExternalUrl
  };
}

module.exports = { createNavigationSecurity, DEFAULT_EXTERNAL_PROTOCOLS };
