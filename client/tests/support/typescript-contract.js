'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');

function assertTypeScriptContract({ root, fileName, source }) {
  const contractPath = path.join(root, 'tests', fileName);
  const config = ts.readConfigFile(path.join(root, 'tsconfig.renderer.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const isContract = candidate => path.resolve(candidate) === contractPath;

  host.fileExists = candidate => isContract(candidate) || fileExists(candidate);
  host.readFile = candidate => isContract(candidate) ? source : readFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => (
    isContract(candidate)
      ? ts.createSourceFile(candidate, source, languageVersion, true)
      : getSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
  );

  const program = ts.createProgram([contractPath], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: candidate => candidate,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n'
  });
  assert.equal(diagnostics.length, 0, formatted);
}

module.exports = { assertTypeScriptContract };
