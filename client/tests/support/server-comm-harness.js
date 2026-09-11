'use strict';

const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

const bundled = esbuild.buildSync({
  absWorkingDir: ROOT,
  stdin: {
    contents: "export { createServerCommService } from './src/server-comm.ts';",
    resolveDir: ROOT,
    sourcefile: 'server-comm-test-entry.ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text;

const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundled)(require, loaded, loaded.exports);
const { createServerCommService } = loaded.exports;

function projectServerCommFacade(BOBO, service) {
  BOBO.updateRunOutput = service.updateRunOutput;
  BOBO.clearRunOutput = service.clearRunOutput;
  BOBO.clearRunOutputDetails = service.clearRunOutputDetails;
  BOBO.refreshRunOutputOmission = service.refreshRunOutputOmission;
  BOBO.sendToServer = service.sendToServer;
}

function installServerComm(windowObject, options = {}) {
  const BOBO = windowObject.BOBO = windowObject.BOBO || {};
  const document = options.document || windowObject.document;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const fetchImpl = options.fetch || windowObject.fetch;
  const Controller = options.AbortController || windowObject.AbortController || globalThis.AbortController;
  const service = createServerCommService({
    document,
    getState: () => BOBO.state,
    getI18n: () => BOBO.i18n,
    getTransport: () => BOBO.serverTransport,
    getWorkspace: () => BOBO.workspace,
    getAuth: () => BOBO.auth,
    getRunOutput: () => BOBO.runOutput,
    getLocalPathSeparator: workspaceRoot => (
      typeof BOBO.localPathSeparator === 'function'
        ? BOBO.localPathSeparator(workspaceRoot)
        : '/'
    ),
    fetch: (url, init) => {
      if (typeof fetchImpl !== 'function') return Promise.reject(new Error('fetch is unavailable'));
      return fetchImpl.call(windowObject, url, init);
    },
    createAbortController: () => typeof Controller === 'function' ? new Controller() : null,
    setTimeout: setTimer,
    clearTimeout: clearTimer
  });
  projectServerCommFacade(BOBO, service);
  return service;
}

module.exports = {
  createServerCommService,
  installServerComm,
  projectServerCommFacade
};
