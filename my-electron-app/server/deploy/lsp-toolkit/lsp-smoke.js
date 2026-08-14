#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const externalSmokeRoot = process.env.BOBO_LSP_SMOKE_ROOT || '';
const analysisCacheRoot = process.env.BOBO_LSP_SMOKE_ANALYSIS_CACHE || '/analysis-cache';
const smokeRoot = externalSmokeRoot || process.env.BOBO_LSP_SMOKE_WORK_ROOT || path.join(analysisCacheRoot, 'smoke-workspaces');
const stateRoot = process.env.BOBO_LSP_SMOKE_STATE_ROOT || path.join(analysisCacheRoot, 'smoke-state');
const dependencyRoot = process.env.BOBO_LSP_SMOKE_DEPENDENCY_ROOT || '/analysis-deps';
const pythonInterpreter = process.env.BOBO_LSP_SMOKE_PYTHON || '/usr/local/bin/bobocloud-python';
const typescriptServerPath = process.env.BOBO_LSP_SMOKE_TSSERVER || resolveNodeModule('typescript/lib/tsserver.js', '/opt/node-lsp/node_modules/typescript/lib/tsserver.js');
const typescriptLanguageServerPath = resolveNodeModule('typescript-language-server/lib/cli.mjs', '/opt/node-lsp/node_modules/typescript-language-server/lib/cli.mjs');
const pyrightServerPath = resolveNodeModule('pyright/langserver.index.js', '/opt/node-lsp/node_modules/pyright/langserver.index.js');

function resolveNodeModule(moduleName, fallback) {
  try {
    return require.resolve(moduleName);
  } catch {
    return fallback;
  }
}

const tests = [
  {
    name: 'go', command: ['gopls'], languageId: 'go', file: 'main.go',
    files: {
      'go.mod': 'module example.com/bobocloud/smoke\n\ngo 1.23\n\nrequire example.com/bobocloud/dependency v1.0.0\n',
      'go.sum': 'example.com/bobocloud/dependency v1.0.0 h1:CZLrd9o1GgB9pdi7iYt8QryBxSvIejOxI8jKU4Ye84c=\nexample.com/bobocloud/dependency v1.0.0/go.mod h1:c4lRDTinGkQO/0YMTYw18j9wX9THxSbxh+QByscJPnU=\n',
      'main.go': 'package main\n\nimport dependency "example.com/bobocloud/dependency"\n\nfunc main() {\n    dependency.Clo\n}\n'
    },
    position: { line: 5, character: 18 }, requireCompletion: true,
    expectedCompletion: 'CloudAnswer', setup: setupGoDependency
  },
  {
    name: 'rust', command: ['rust-analyzer'], languageId: 'rust', file: 'src/main.rs',
    files: {
      'Cargo.toml': '[package]\nname = "bobocloud-smoke"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nbobocloud-dependency = { path = "__BOBO_RUST_DEPENDENCY__" }\n',
      'src/main.rs': 'fn main() {\n    bobocloud_dependency::cloud_an\n}\n'
    },
    position: { line: 1, character: 34 }, requireCompletion: true,
    expectedCompletion: 'cloud_answer', coverage: 'workspace-path-dependency', setup: setupRustDependency,
    initializationOptions: {
      cachePriming: { enable: false },
      cargo: {
        allTargets: false, buildScripts: { enable: false },
        extraEnv: { CARGO_HOME: path.join(analysisCacheRoot, 'cargo-home'), CARGO_NET_OFFLINE: 'true' }
      },
      checkOnSave: false,
      procMacro: { enable: false }
    }
  },
  {
    name: 'c', command: ['bobocloud-clangd'], languageId: 'c', file: 'main.c',
    files: { 'main.c': '#include <bobocloud_smoke.h>\nint main(void) {\n    return bobocloud_an\n}\n' },
    position: { line: 2, character: 23 }, requireCompletion: true,
    expectedCompletion: 'bobocloud_answer', setup: setupNativeDependency
  },
  {
    name: 'python-pyrightconfig', family: 'python', command: [process.execPath, pyrightServerPath, '--stdio'], languageId: 'python', file: 'main.py',
    files: {
      'pyrightconfig.json': '{"extraPaths":["./user-only"],"reportMissingImports":"error"}\n',
      'user-only/keep.txt': 'user configuration remains untouched\n',
      'main.py': 'import bobocloud_dependency\n\nbobocloud_dependency.cloud_\n'
    },
    position: { line: 2, character: 27 }, requireCompletion: true,
    expectedCompletion: 'cloud_answer', setup: setupPythonDependency
  },
  {
    name: 'python-pyproject', family: 'python', command: [process.execPath, pyrightServerPath, '--stdio'], languageId: 'python', file: 'main.py',
    files: {
      'pyproject.toml': '[tool.pyright]\nextraPaths = ["./user-only"]\nreportMissingImports = "error"\n',
      'user-only/keep.txt': 'user configuration remains untouched\n',
      'main.py': 'import bobocloud_dependency\n\nbobocloud_dependency.cloud_\n'
    },
    position: { line: 2, character: 27 }, requireCompletion: true,
    expectedCompletion: 'cloud_answer', setup: setupPythonDependency
  },
  {
    name: 'python-import-module', family: 'python', command: [process.execPath, pyrightServerPath, '--stdio'], languageId: 'python', file: 'main.py',
    files: { 'main.py': 'import nu\n' },
    position: { line: 0, character: 9 }, requireCompletion: true,
    expectedCompletion: 'numpy', setup: setupPythonModuleCompletionDependency
  },
  {
    name: 'typescript', family: 'node', command: [process.execPath, typescriptLanguageServerPath, '--stdio'], languageId: 'typescript', file: 'main.ts',
    files: {
      'node_modules/@bobocloud/smoke-dependency/package.json': '{"name":"@bobocloud/smoke-dependency","version":"1.0.0","types":"index.d.ts"}\n',
      'node_modules/@bobocloud/smoke-dependency/index.d.ts': 'export declare function cloudAnswer(value: number): string;\n',
      'main.ts': 'import * as dependency from "@bobocloud/smoke-dependency";\n\ndependency.cloud\n'
    },
    position: { line: 2, character: 16 }, requireCompletion: true,
    expectedCompletion: 'cloudAnswer', expectedTypescriptSource: 'user-setting',
    initializationOptions: { tsserver: { path: typescriptServerPath } }
  },
  {
    name: 'maven', family: 'java', command: ['jdtls'], languageId: 'java', file: 'src/main/java/Smoke.java',
    files: {
      '.project': '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>bobocloud-maven-smoke</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand><buildCommand><name>org.eclipse.m2e.core.maven2Builder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature><nature>org.eclipse.m2e.core.maven2Nature</nature></natures></projectDescription>\n',
      '.classpath': '<?xml version="1.0" encoding="UTF-8"?><classpath><classpathentry kind="src" path="src/main/java"/><classpathentry kind="con" path="org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>\n',
      'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example.com</groupId><artifactId>smoke</artifactId><version>1.0.0</version><packaging>pom</packaging><dependencies><dependency><groupId>com.bobocloud</groupId><artifactId>smoke-dependency</artifactId><version>1.0.0</version></dependency></dependencies></project>\n',
      'src/main/java/Smoke.java': 'import com.bobocloud.smoke.CloudDependency;\npublic class Smoke {\n    String value = CloudDependency.cloud\n}\n'
    },
    position: { line: 2, character: 40 }, requireCompletion: true,
    expectedCompletion: 'cloudAnswer', attempts: 20, setup: setupMavenDependency
  },
  {
    name: 'gradle', family: 'java', command: ['jdtls'], languageId: 'java', file: 'src/main/java/Smoke.java',
    files: {
      '.project': '<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>bobocloud-gradle-smoke</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>\n',
      '.classpath': '<?xml version="1.0" encoding="UTF-8"?><classpath><classpathentry kind="src" path="src/main/java"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="__BOBO_GRADLE_JAR__"/><classpathentry kind="output" path="bin"/></classpath>\n',
      'build.gradle': 'plugins { id "java" }\nrepositories { mavenCentral() }\ndependencies { implementation "com.bobocloud:smoke-dependency:1.0.0" }\n',
      'src/main/java/Smoke.java': 'import com.bobocloud.smoke.CloudDependency;\npublic class Smoke {\n    String value = CloudDependency.cloud\n}\n'
    },
    position: { line: 2, character: 40 }, requireCompletion: true,
    expectedCompletion: 'cloudAnswer', coverage: 'mounted-classpath-only', attempts: 20, setup: setupGradleDependency
  },
  {
    name: 'html', command: ['vscode-html-language-server', '--stdio'], languageId: 'html', file: 'index.html',
    files: { 'index.html': '<!doctype html>\n<html>\n<body>\n<di\n</body>\n</html>\n' },
    position: { line: 3, character: 3 }, requireCompletion: true
  },
  {
    name: 'css', command: ['vscode-css-language-server', '--stdio'], languageId: 'css', file: 'style.css',
    files: { 'style.css': 'body {\n  col\n}\n' },
    position: { line: 1, character: 5 }, requireCompletion: true
  },
  {
    name: 'json', command: ['vscode-json-language-server', '--stdio'], languageId: 'json', file: 'data.json',
    files: { 'data.json': '{\n  "enabled": true\n}\n' },
    position: { line: 1, character: 2 }, requireCompletion: false
  },
  {
    name: 'yaml', command: ['yaml-language-server', '--stdio'], languageId: 'yaml', file: 'config.yaml',
    files: { 'config.yaml': 'service:\n  enabled: true\n' },
    position: { line: 1, character: 2 }, requireCompletion: false
  },
  {
    name: 'shell', command: ['bash-language-server', 'start'], languageId: 'shellscript', file: 'script.sh',
    files: { 'script.sh': '#!/bin/sh\nec\n' },
    position: { line: 1, character: 2 }, requireCompletion: false
  }
].filter((test) => !process.env.BOBO_LSP_SMOKE_ONLY || test.name === process.env.BOBO_LSP_SMOKE_ONLY || test.family === process.env.BOBO_LSP_SMOKE_ONLY);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const javaDependencyJar = Buffer.from(
  'UEsDBAoAAAgAAG4eDF0AAAAAAAAAAAAAAAAJAAQATUVUQS1JTkYv/soAAFBLAwQUAAgICABuHgxdAAAAAAAAAAAAAAAAFAAAAE1FVEEtSU5GL01BTklGRVNULk1G803My0xLLS7RDUstKs7Mz7NSMNQz4OVyLkpNLElN0XWqtFIwAoromSpoOKXm5ATnp5Vo8nLxcgEAUEsHCGystiI5AAAAOAAAAFBLAwQKAAAIAABuHgxdAAAAAAAAAAAAAAAABAAAAGNvbS9QSwMECgAACAAAbh4MXQAAAAAAAAAAAAAAAA4AAABjb20vYm9ib2Nsb3VkL1BLAwQKAAAIAABuHgxdAAAAAAAAAAAAAAAAFAAAAGNvbS9ib2JvY2xvdWQvc21va2UvUEsDBBQACAgIAG4eDF0AAAAAAAAAAAAAAAApAAAAY29tL2JvYm9jbG91ZC9zbW9rZS9DbG91ZERlcGVuZGVuY3kuY2xhc3N9kV1LAkEUht/j1+q6pdmaZVoX3ayRLUF3G0EZQSB1YQRd7scga+uOrGvRv6obhYJ+QD8qmtmEQKMZOOfMO+d558B8fr19ADjGrooU0goyGrLIEcoD+9E2AzvsmzfOgLkxIXfih358SkgbrTsFeULtt6kXR37YP5/4gcciFQrSeRQF4wZ84rWlsKJhFSUh2aMRCz1C2+gu8lZrSZpbWtJiTVpUCA3j6v9GXUMVG4R8zH8uCbqxjFgKNgl7Lh+aDnd4Mqs5HvIHZnZkfcHkpCx0nwmZDvcYodT1Q3Y9GTosurWdQCjFBDsLx08sIlT/Gs0iqD0+iVx26UtEX3A/lACOUBN/IFdKbPELIGyJU1NkEjm7PwO9ioJQFzGXiBkUsI3GvPVAgFLV36Hcz1CoqFNo9SnKU6y/LJCKiM3ksZ1vUEsHCHvoesY/AQAABgIAAFBLAQIKAAoAAAgAAG4eDF0AAAAAAAAAAAAAAAAJAAQAAAAAAAAAAAAAAAAAAABNRVRBLUlORi/+ygAAUEsBAhQAFAAICAgAbh4MXWystiI5AAAAOAAAABQAAAAAAAAAAAAAAAAAKwAAAE1FVEEtSU5GL01BTklGRVNULk1GUEsBAgoACgAACAAAbh4MXQAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAApgAAAGNvbS9QSwECCgAKAAAIAABuHgxdAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAADIAAAAY29tL2JvYm9jbG91ZC9QSwECCgAKAAAIAABuHgxdAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAAAAD0AAAAY29tL2JvYm9jbG91ZC9zbW9rZS9QSwECFAAUAAgICABuHgxde+h6xj8BAAAGAgAAKQAAAAAAAAAAAAAAAAAmAQAAY29tL2JvYm9jbG91ZC9zbW9rZS9DbG91ZERlcGVuZGVuY3kuY2xhc3NQSwUGAAAAAAYABgCEAQAAvAIAAAAA',
  'base64'
);

function writeFixture(destination, content) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function replaceFixtureToken(file, token, value) {
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, current.replaceAll(token, value));
}

function portablePath(value) {
  return value.split(path.sep).join('/');
}

function setupPythonDependency() {
  const packages = path.join(dependencyRoot, 'python', 'runtime-site-packages');
  return setupPythonDependencyAt(packages, true);
}

function setupPythonDependencyAt(packages, includeFixture) {
  if (includeFixture) {
    writeFixture(path.join(packages, 'bobocloud_dependency', '__init__.py'), 'def cloud_answer(value: int) -> str:\n    return f"cloud-{value}"\n');
    writeFixture(path.join(packages, 'bobocloud_dependency', '__init__.pyi'), 'def cloud_answer(value: int) -> str: ...\n');
  }
  const analysis = { extraPaths: [packages], useLibraryCodeForTypes: true, autoImportCompletions: true };
  return {
    environment: {
      BOBO_PYRIGHT_DEPENDENCY_PATHS: packages,
      PYTHONPATH: packages
    },
    settings: {
      python: { analysis, pythonPath: pythonInterpreter, defaultInterpreterPath: pythonInterpreter },
      'python.analysis': analysis,
      pyright: { pythonPlatform: process.platform === 'win32' ? 'Windows' : 'Linux' }
    }
  };
}

function setupPythonModuleCompletionDependency() {
  const packages = path.join(dependencyRoot, 'python', 'legacy-site-packages');
  writeFixture(path.join(packages, 'numpy', '__init__.pyi'), '__version__: str\n');
  return setupPythonDependencyAt(packages, false);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [entryName, entryContent] of entries) {
    const name = Buffer.from(entryName, 'utf8');
    const content = Buffer.from(entryContent, 'utf8');
    const checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function setupGoDependency() {
  const proxy = path.join(dependencyRoot, 'go', 'proxy');
  const versionRoot = path.join(proxy, 'example.com', 'bobocloud', 'dependency', '@v');
  const moduleFile = 'module example.com/bobocloud/dependency\n\ngo 1.23\n';
  const prefix = 'example.com/bobocloud/dependency@v1.0.0/';
  writeFixture(path.join(versionRoot, 'list'), 'v1.0.0\n');
  writeFixture(path.join(versionRoot, 'v1.0.0.info'), '{"Version":"v1.0.0","Time":"2026-01-01T00:00:00Z"}\n');
  writeFixture(path.join(versionRoot, 'v1.0.0.mod'), moduleFile);
  writeFixture(path.join(versionRoot, 'v1.0.0.zip'), storedZip([
    [prefix + 'go.mod', moduleFile],
    [prefix + 'dependency.go', 'package dependency\n\nfunc CloudAnswer() string { return "cloud" }\n']
  ]));
  return {
    environment: {
      GOPROXY: pathToFileURL(proxy).href,
      GOSUMDB: 'off'
    },
    settings: { gopls: { env: { GOPROXY: pathToFileURL(proxy).href, GOSUMDB: 'off' } } }
  };
}

function setupRustDependency(root) {
  // A path dependency makes rust-analyzer's resolver deterministic under the
  // smoke test's network=none contract. Registry source discovery is covered
  // separately by the service dependency-view tests.
  const dependency = path.join(root, '.bobocloud-smoke-dependency');
  writeFixture(path.join(dependency, 'Cargo.toml'), '[package]\nname = "bobocloud-dependency"\nversion = "1.0.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n');
  writeFixture(path.join(dependency, 'src', 'lib.rs'), 'pub fn cloud_answer() -> &\'static str { "cloud" }\n');
  replaceFixtureToken(path.join(root, 'Cargo.toml'), '__BOBO_RUST_DEPENDENCY__', portablePath(dependency));
  return { environment: { CARGO_NET_OFFLINE: 'true' } };
}

function setupNativeDependency() {
  const include = path.join(dependencyRoot, 'native', 'include');
  writeFixture(path.join(include, 'bobocloud_smoke.h'), 'int bobocloud_answer(void);\n');
  return {
    environment: {
      BOBO_LSP_MODE: 'full',
      BOBO_CLANGD_FALLBACK_FLAGS_JSON: JSON.stringify([`-I${portablePath(include)}`])
    }
  };
}

function writeJavaRepository(repository) {
  const artifact = path.join(repository, 'com', 'bobocloud', 'smoke-dependency', '1.0.0');
  writeFixture(path.join(artifact, 'smoke-dependency-1.0.0.pom'), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>com.bobocloud</groupId><artifactId>smoke-dependency</artifactId><version>1.0.0</version></project>\n');
  writeFixture(path.join(artifact, 'smoke-dependency-1.0.0.jar'), javaDependencyJar);
  return path.join(artifact, 'smoke-dependency-1.0.0.jar');
}

function setupMavenDependency() {
	const repository = path.join(dependencyRoot, 'java', 'maven-repository');
	writeJavaRepository(repository);
	const mavenRoot = path.join(analysisCacheRoot, 'maven');
	const option = `-Dmaven.repo.local=${portablePath(path.join(mavenRoot, 'repository'))}`;
	const settings = {
	  java: {
	    configuration: { maven: { userSettings: portablePath(path.join(mavenRoot, 'settings.xml')) } },
	    import: { maven: { enabled: true } }
	  }
	};
	return {
    environment: {
      BOBO_MAVEN_SOURCE_REPO: portablePath(repository),
      BOBO_LSP_CACHE_DIR: analysisCacheRoot,
      JAVA_TOOL_OPTIONS: option,
      MAVEN_OPTS: option
    },
	  settings,
	  initializationOptions: { settings }
	};
}

function setupGradleDependency(root) {
  const snapshot = path.join(dependencyRoot, 'java', 'gradle-read-only');
  const jar = path.join(snapshot, 'modules-2', 'files-2.1', 'com.bobocloud', 'smoke-dependency', '1.0.0', 'fixture', 'smoke-dependency-1.0.0.jar');
  writeFixture(path.join(snapshot, '.bobocloud-gradle-dependency-snapshot.json'), '{"format":"bobocloud.gradle-dependency-snapshot/v1","state":"ready"}\n');
  writeFixture(jar, javaDependencyJar);
  replaceFixtureToken(path.join(root, '.classpath'), '__BOBO_GRADLE_JAR__', portablePath(jar).replaceAll('&', '&amp;').replaceAll('"', '&quot;'));
  const settings = { java: { import: { gradle: { enabled: false } } } };
  return {
    environment: { GRADLE_RO_DEP_CACHE: portablePath(snapshot) },
    settings,
    initializationOptions: { settings }
  };
}

function writeWorkspace(test) {
  if (externalSmokeRoot) return externalSmokeRoot;
  const root = path.join(smokeRoot, test.name);
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(test.files)) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return root;
}

function completionItems(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.items)) return result.items;
  return [];
}

function completionLabel(item) {
  if (typeof item?.label === 'string') return item.label;
  if (item?.label && typeof item.label.label === 'string') return item.label.label;
  return '';
}

function completionSatisfied(test, items) {
  if (items.length === 0) return false;
  if (!test.expectedCompletion) return true;
  return items.some((item) => completionLabel(item).includes(test.expectedCompletion));
}

function configurationForSection(settings, section) {
  if (!settings || typeof settings !== 'object') return {};
  if (Object.prototype.hasOwnProperty.call(settings, section)) return settings[section];
  let current = settings;
  for (const part of String(section || '').split('.')) {
    if (!part || !current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return {};
    current = current[part];
  }
  return current;
}

class LSPClient {
  constructor(test, root) {
    this.test = test;
    this.root = root;
    this.nextID = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.closed = false;
    this.notifications = [];
  }

  start() {
    const state = path.join(stateRoot, this.test.name);
    fs.mkdirSync(state, { recursive: true });
    const env = {
      ...process.env,
      BOBO_LSP_CACHE_DIR: state,
      BOBO_LSP_WORKSPACE: this.root,
      XDG_CACHE_HOME: path.join(state, 'xdg'),
      GOCACHE: path.join(state, 'go-build'),
      GOMODCACHE: path.join(state, 'go-mod'),
      CARGO_HOME: path.join(state, 'cargo-home'),
      CARGO_TARGET_DIR: path.join(state, 'cargo-target'),
      JDTLS_WORKSPACE: path.join(state, 'jdtls'),
      ...this.test.environment
    };
    const [program, ...args] = this.test.command;
    this.process = spawn(program, args, { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.on('data', (chunk) => this.onData(chunk));
    this.process.stderr.on('data', (chunk) => {
      if (this.stderr.length < 16384) this.stderr += chunk.toString('utf8');
    });
    this.process.on('error', (error) => this.rejectAll(error));
    this.process.on('exit', (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`${this.test.name} exited (${code ?? signal}): ${this.stderr.trim()}`));
      }
    });
  }

  rejectAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.closed) throw new Error(`${this.test.name} language server is closed`);
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.process.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.process.stdin.write(payload);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.test.name} timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`${this.test.name} returned an invalid LSP frame`);
      const length = Number(match[1]);
      const payloadStart = headerEnd + 4;
      if (this.buffer.length < payloadStart + length) return;
      const payload = this.buffer.subarray(payloadStart, payloadStart + length);
      this.buffer = this.buffer.subarray(payloadStart + length);
      this.onMessage(JSON.parse(payload.toString('utf8')));
    }
  }

  onMessage(message) {
    if (message.id !== undefined && message.method) {
      let result = null;
      if (message.method === 'workspace/configuration') {
        result = (message.params?.items || []).map((item) => configurationForSection(this.test.settings, item.section));
      } else if (message.method === 'workspace/workspaceFolders') {
        result = [{ uri: pathToFileURL(this.root).href, name: this.test.name }];
      } else if (message.method === 'workspace/applyEdit') {
        result = { applied: false };
      }
      this.send({ id: message.id, result });
      return;
    }
    if (message.id === undefined) {
      if (message.method) this.notifications.push(message);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${this.test.name}: ${message.error.message || 'LSP error'}`));
    else request.resolve(message.result);
  }

  async close() {
    try {
      await this.request('shutdown', null, 3000);
      if (!this.closed) this.notify('exit');
    } catch {
      // A forced stop is fine after the protocol checks have completed.
    }
    if (await this.waitForExit(3000)) return;
    this.process.kill('SIGTERM');
    if (await this.waitForExit(1500)) return;
    this.process.kill('SIGKILL');
    await this.waitForExit(1500);
  }

  waitForExit(timeoutMs) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer;
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        this.process.removeListener('exit', onExit);
        resolve(this.closed);
      }, timeoutMs);
      this.process.once('exit', onExit);
      if (this.closed) {
        clearTimeout(timer);
        this.process.removeListener('exit', onExit);
        resolve(true);
      }
    });
  }
}

async function runTest(test) {
  const root = writeWorkspace(test);
  const setup = test.setup ? test.setup(root, path.join(stateRoot, test.name)) : {};
  test = {
    ...test,
    environment: { ...(test.environment || {}), ...(setup.environment || {}) },
    settings: { ...(test.settings || {}), ...(setup.settings || {}) },
    initializationOptions: setup.initializationOptions || test.initializationOptions
  };
  const filePath = path.join(root, test.file);
  const documentUri = pathToFileURL(filePath).href;
  const client = new LSPClient(test, root);
  client.start();
  try {
    const initialized = await client.request('initialize', {
      processId: null,
      clientInfo: { name: 'bobocloud-lsp-smoke', version: '1' },
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: test.name }],
      initializationOptions: test.initializationOptions || {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { completion: { completionItem: { snippetSupport: true } } }
      },
      trace: 'off'
    }, 60000);
    if (!initialized || !initialized.capabilities) throw new Error(`${test.name} returned no capabilities`);
    client.notify('initialized', {});
    if (Object.keys(test.settings).length > 0) {
      client.notify('workspace/didChangeConfiguration', { settings: test.settings });
    }
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: documentUri,
        languageId: test.languageId,
        version: 1,
        text: fs.readFileSync(filePath, 'utf8')
      }
    });

    let items = [];
    let completionError = null;
    const attempts = test.attempts || 8;
    for (let attempt = 0; attempt < attempts && !completionSatisfied(test, items); attempt++) {
      await delay(attempt === 0 ? 500 : 1200);
      try {
        const result = await client.request('textDocument/completion', {
          textDocument: { uri: documentUri }, position: test.position,
          context: { triggerKind: 1 }
        }, 20000);
        items = completionItems(result);
      } catch (error) {
        completionError = error;
      }
    }
    if (test.requireCompletion && !completionSatisfied(test, items)) {
      const labels = items.slice(0, 20).map(completionLabel).filter(Boolean).join(', ');
      const detail = client.stderr.trim() ? `; stderr: ${client.stderr.trim()}` : '';
      if (completionError) throw new Error(`${completionError.message}${detail}`);
      throw new Error(`${test.name} did not resolve completion ${test.expectedCompletion || '<any>'}; received: ${labels || '<none>'}${detail}`);
    }
    if (test.expectedTypescriptSource) {
      for (let attempt = 0; attempt < 10 && !client.notifications.some((message) => message.method === '$/typescriptVersion'); attempt++) {
        await delay(200);
      }
      const version = client.notifications.find((message) => message.method === '$/typescriptVersion');
      if (version?.params?.source !== test.expectedTypescriptSource) {
        throw new Error(`${test.name} used TypeScript source ${version?.params?.source || '<missing>'}, want ${test.expectedTypescriptSource}`);
      }
    }
    process.stdout.write(`${test.name.padEnd(22)} initialize=ok dependency=${test.expectedCompletion || 'n/a'} coverage=${test.coverage || 'resolver'} completion_items=${items.length}\n`);
  } finally {
    await client.close();
  }
}

async function main() {
  fs.mkdirSync(smokeRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  for (const test of tests) await runTest(test);
}

main().catch((error) => {
  process.stderr.write(`LSP smoke failed: ${error.stack || error}\n`);
  process.exitCode = 1;
});
