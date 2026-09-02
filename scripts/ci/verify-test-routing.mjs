#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'ci.yml');
const require = createRequire(import.meta.url);

// This table is the machine-readable contract between test discovery and CI.
// A test suite that cannot use an existing automatic glob needs a reviewed
// route here and a matching BOBOCLOUD_TEST_ROUTES entry in ci.yml.
const WORKFLOW_ROUTE_OWNERS = Object.freeze({
  'client-node': 'client-contracts',
  'client-typecheck': 'client-contracts',
  'client-ui-core': 'client-ui-core',
  'client-ui-packages': 'client-ui-packages',
  'client-ui-plugin-compat': 'client-ui-plugin-compat',
  'client-ui-packaged': 'client-ui-packaged',
  'server-go': 'server-go',
  'server-go-race': 'server-race',
  'server-go-windows': 'server-release-preflight',
  'server-privileged-mount': 'server-privileged-mount',
  'lsp-toolkit-node': 'server-toolkit-contracts',
  'dap-toolkit-python': 'server-toolkit-contracts',
  'dap-bridge-go': 'server-toolkit-contracts',
  'node-smoke-syntax': 'server-toolkit-contracts',
  'server-deploy-preflight': 'server-release-preflight'
});

const GO_MODULE_ROUTES = Object.freeze({
  server: 'server-go',
  'server/deploy/dap-toolkit/bridge': 'dap-bridge-go'
});

const NODE_TEST_MODULE_ROUTES = Object.freeze({
  '.': 'client-node',
  client: 'client-node',
  'server/deploy/lsp-toolkit': 'lsp-toolkit-node'
});

const GO_OPERATING_SYSTEMS = Object.freeze(new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'illumos', 'ios',
  'js', 'linux', 'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows'
]));
const GO_ARCHITECTURES = Object.freeze(new Set([
  '386', 'amd64', 'arm', 'arm64', 'loong64', 'mips', 'mips64', 'mips64le',
  'mipsle', 'ppc64', 'ppc64le', 'riscv64', 's390x', 'wasm'
]));

function fail(message) {
  throw new Error('[ci-routing] ' + message);
}

function normalize(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function repositoryFiles() {
  const result = childProcess.spawnSync(
    'git',
    ['-C', REPOSITORY_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail('git ls-files failed: ' + result.stderr.toString('utf8').trim());
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(normalize).sort();
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8'));
  } catch (error) {
    fail('cannot read ' + relativePath + ': ' + error.message);
  }
}

function parseInlineScalar(value, lineNumber) {
  const trimmed = value.trim();
  if (!trimmed) fail('empty BOBOCLOUD_TEST_ROUTES at ci.yml:' + lineNumber);
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      fail('invalid quoted BOBOCLOUD_TEST_ROUTES at ci.yml:' + lineNumber + ': ' + error.message);
    }
  }
  if (trimmed.includes('#')) {
    fail('quote BOBOCLOUD_TEST_ROUTES instead of using an inline comment at ci.yml:' + lineNumber);
  }
  return trimmed;
}

// Parse only the deliberately constrained job metadata we own. This avoids
// guessing test coverage from shell command text and does not pretend to be a
// general YAML parser.
function workflowRouteRegistrations() {
  if (!fs.existsSync(WORKFLOW_PATH)) fail('.github/workflows/ci.yml is missing');
  const lines = fs.readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
  const registrations = new Map();
  const jobs = new Set();
  const gateNeeds = new Set();
  let inJobs = false;
  let currentJob = '';
  let readingGateNeeds = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      currentJob = '';
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s#]/.test(line)) break;

    const jobMatch = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.add(currentJob);
      readingGateNeeds = false;
      continue;
    }

    if (currentJob === 'ci-gate' && /^    needs:\s*$/.test(line)) {
      readingGateNeeds = true;
      continue;
    }
    if (readingGateNeeds) {
      const needMatch = /^      - ([a-zA-Z0-9_-]+)\s*$/.exec(line);
      if (needMatch) {
        gateNeeds.add(needMatch[1]);
        continue;
      }
      if (/^\s{0,4}\S/.test(line)) readingGateNeeds = false;
    }

    const routeMatch = /^\s{4,}BOBOCLOUD_TEST_ROUTES:\s*(.+?)\s*$/.exec(line);
    if (!routeMatch) continue;
    if (!currentJob) fail('BOBOCLOUD_TEST_ROUTES is not inside a job at ci.yml:' + (index + 1));
    const value = parseInlineScalar(routeMatch[1], index + 1);
    for (const route of value.split(',').map((item) => item.trim()).filter(Boolean)) {
      if (registrations.has(route)) {
        fail('workflow route ' + route + ' is registered by both ' + registrations.get(route) + ' and ' + currentJob);
      }
      registrations.set(route, currentJob);
    }
  }

  for (const [route, expectedJob] of Object.entries(WORKFLOW_ROUTE_OWNERS)) {
    if (!jobs.has(expectedJob)) fail('workflow job ' + expectedJob + ' required by route ' + route + ' is missing');
    const actualJob = registrations.get(route);
    if (!actualJob) fail('workflow route ' + route + ' is not registered');
    if (actualJob !== expectedJob) {
      fail('workflow route ' + route + ' belongs to ' + actualJob + ', expected ' + expectedJob);
    }
    if (!gateNeeds.has(expectedJob)) {
      fail('CI Gate does not require routed workflow job ' + expectedJob);
    }
  }
  for (const [route, job] of registrations) {
    if (!Object.hasOwn(WORKFLOW_ROUTE_OWNERS, route)) {
      fail('workflow job ' + job + ' registers unknown route ' + route + '; add it to the routing contract');
    }
  }
  const routedJobs = new Set(registrations.values());
  for (const job of jobs) {
    if (job !== 'ci-gate' && !routedJobs.has(job)) {
      fail('workflow job ' + job + ' is outside the test-route and CI Gate contract');
    }
  }
  return registrations;
}

function nearestGoModule(file, moduleDirectories) {
  return moduleDirectories
    .filter((directory) => file === directory + '/go.mod' || file.startsWith(directory + '/'))
    .sort((left, right) => right.length - left.length)[0] || '';
}

function goFilePlatform(file) {
  const suffix = '_test.go';
  const stem = path.posix.basename(file).slice(0, -suffix.length);
  const parts = stem.split('_');
  let operatingSystem = '';
  let architecture = '';
  const last = parts[parts.length - 1];
  if (GO_ARCHITECTURES.has(last)) {
    architecture = last;
    const previous = parts[parts.length - 2];
    if (GO_OPERATING_SYSTEMS.has(previous)) operatingSystem = previous;
  } else if (GO_OPERATING_SYSTEMS.has(last)) {
    operatingSystem = last;
  }
  return { architecture, operatingSystem };
}

function goBuildConstraint(file, source) {
  const directives = [...source.matchAll(/^\/\/go:build\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
  if (directives.length > 1) fail(file + ' contains more than one //go:build directive');
  const legacyDirectives = [...source.matchAll(/^\/\/\s*\+build\s+(.+?)\s*$/gm)];
  if (legacyDirectives.length > 0 && directives.length === 0) {
    fail(file + ' uses a legacy +build constraint without a //go:build contract');
  }
  return directives[0] || '';
}

function classifyGoTest(file, source, moduleDirectory, defaultRoute) {
  const platform = goFilePlatform(file);
  if (platform.architecture && platform.architecture !== 'amd64') {
    fail(file + ' targets unsupported Go architecture ' + platform.architecture + '; add an explicit CI lane');
  }
  if (platform.operatingSystem && platform.operatingSystem !== 'linux' && platform.operatingSystem !== 'windows') {
    fail(file + ' targets unsupported Go operating system ' + platform.operatingSystem + '; add an explicit CI lane');
  }

  const expression = goBuildConstraint(file, source);
  const normalized = expression.replace(/[\s()]/g, '');
  let constraint = '';
  if (!normalized) constraint = 'default';
  else if (normalized === 'linux') constraint = 'linux';
  else if (normalized === '!linux' || normalized === 'windows') constraint = 'windows';
  else if (normalized === 'linux&&privileged_integration' || normalized === 'privileged_integration&&linux') {
    constraint = 'privileged-linux';
  } else {
    fail(file + ' has unsupported Go build constraint "' + expression + '"; add a reviewed CI route');
  }

  if (moduleDirectory !== 'server' && (
    constraint !== 'default' || platform.operatingSystem || platform.architecture
  )) {
    fail(file + ' is a platform-constrained test in nested Go module ' + moduleDirectory + '; add a dedicated CI route');
  }

  if (constraint === 'privileged-linux') {
    if (moduleDirectory !== 'server') {
      fail(file + ' is a privileged test outside the root server module; add a dedicated CI route');
    }
    if (platform.operatingSystem && platform.operatingSystem !== 'linux') {
      fail(file + ' combines a privileged Linux constraint with a non-Linux file suffix');
    }
    return { privileged: true, route: 'server-privileged-mount' };
  }

  let effectiveOperatingSystem = platform.operatingSystem;
  if (constraint === 'linux') {
    if (effectiveOperatingSystem && effectiveOperatingSystem !== 'linux') {
      fail(file + ' combines a Linux build constraint with a ' + effectiveOperatingSystem + ' file suffix');
    }
    effectiveOperatingSystem = 'linux';
  } else if (constraint === 'windows') {
    if (effectiveOperatingSystem && effectiveOperatingSystem !== 'windows') {
      fail(file + ' combines a non-Linux build constraint with a ' + effectiveOperatingSystem + ' file suffix');
    }
    effectiveOperatingSystem = 'windows';
  }

  return {
    privileged: false,
    route: moduleDirectory === 'server'
      ? effectiveOperatingSystem === 'windows' ? 'server-go-windows' : 'server-go'
      : defaultRoute
  };
}

function privilegedPackageForFile(file) {
  const relativeDirectory = path.posix.relative('server', path.posix.dirname(file));
  const packagePath = relativeDirectory ? './' + relativeDirectory : '.';
  if (packagePath !== '.' && !/^\.\/[A-Za-z0-9_./-]+$/.test(packagePath)) {
    fail('privileged package path is not safe for CI execution: ' + packagePath);
  }
  if (packagePath.includes('/../') || packagePath.endsWith('/..') || packagePath.includes('//')) {
    fail('privileged package path escapes its module or is ambiguous: ' + packagePath);
  }
  return packagePath;
}

function commandWords(command) {
  return String(command || '').trim().split(/\s+/).filter(Boolean);
}

function assertNpmRoutingContracts(uiGroups) {
  const rootPackage = readJson('package.json');
  const clientPackage = readJson('client/package.json');
  const rendererTsconfig = readJson('client/tsconfig.renderer.json');
  const lspPackage = readJson('server/deploy/lsp-toolkit/package.json');
  const rootTest = commandWords(rootPackage.scripts && rootPackage.scripts.test);
  if (rootTest.join(' ') !== 'npm --prefix client run test') {
    fail('root npm test must remain the stable delegate to the complete client Node suite');
  }

  const clientTest = commandWords(clientPackage.scripts && clientPackage.scripts.test);
  if (clientTest[0] !== 'node' || !clientTest.includes('--test') || !clientTest.includes('tests/*.test.js')) {
    fail('client npm test must keep the automatic tests/*.test.js Node test glob');
  }

  const rootTypecheck = commandWords(rootPackage.scripts && rootPackage.scripts.typecheck);
  if (rootTypecheck.join(' ') !== 'npm --prefix client run typecheck') {
    fail('root npm typecheck must remain the stable delegate to the client type gate');
  }
  const clientTypecheck = commandWords(clientPackage.scripts && clientPackage.scripts.typecheck);
  if (clientTypecheck.join(' ') !== 'npm run typecheck:renderer') {
    fail('client npm typecheck must delegate to every owned TypeScript project');
  }
  const rendererTypecheck = commandWords(clientPackage.scripts && clientPackage.scripts['typecheck:renderer']);
  if (rendererTypecheck.join(' ') !== 'tsc --project tsconfig.renderer.json') {
    fail('client renderer typecheck must use the checked-in renderer tsconfig');
  }
  if (!clientPackage.devDependencies || typeof clientPackage.devDependencies.typescript !== 'string') {
    fail('client must declare TypeScript directly as a devDependency');
  }
  const compilerOptions = rendererTsconfig.compilerOptions || {};
  if (compilerOptions.strict !== true || compilerOptions.noEmit !== true
      || compilerOptions.allowJs !== true || compilerOptions.checkJs !== false
      || compilerOptions.moduleResolution !== 'Bundler') {
    fail('renderer tsconfig must retain strict no-emit gradual migration settings');
  }
  if (!Array.isArray(compilerOptions.types) || compilerOptions.types.length !== 0) {
    fail('renderer tsconfig must not leak Node or Electron ambient types into the sandboxed renderer');
  }

  for (const group of uiGroups) {
    const scriptName = 'test:ui:ci:' + group;
    const words = commandWords(clientPackage.scripts && clientPackage.scripts[scriptName]);
    if (words[0] !== 'playwright' || words[1] !== 'test'
        || !words.includes('--config=playwright.ci.config.js')
        || !words.includes('--project=' + group)) {
      fail('client npm script ' + scriptName + ' must run its named Playwright CI project');
    }
  }

  const lspTest = commandWords(lspPackage.scripts && lspPackage.scripts.test);
  if (lspTest.join(' ') !== 'node --test') {
    fail('LSP toolkit npm test must retain Node automatic test discovery');
  }
}

function classifyUiSpecs(files, coverage) {
  const groupsPath = path.join(REPOSITORY_ROOT, 'client', 'tests', 'ui-test-groups.js');
  if (!fs.existsSync(groupsPath)) fail('client/tests/ui-test-groups.js is missing');
  delete require.cache[require.resolve(groupsPath)];
  const groups = require(groupsPath);
  if (!Array.isArray(groups.UI_GROUPS) || typeof groups.groupForSpec !== 'function') {
    fail('client/tests/ui-test-groups.js must export UI_GROUPS and groupForSpec');
  }

  const specs = files.filter((file) => /^client\/tests\/.+\.spec\.js$/.test(file));
  const names = new Set();
  const counts = new Map(groups.UI_GROUPS.map((group) => [group, 0]));
  for (const spec of specs) {
    const name = path.posix.basename(spec);
    if (names.has(name)) fail('UI spec basenames must be unique for group routing: ' + name);
    names.add(name);
    let group;
    try {
      group = groups.groupForSpec(name);
    } catch (error) {
      fail('cannot classify ' + spec + ': ' + error.message);
    }
    if (!groups.UI_GROUPS.includes(group)) fail(spec + ' resolved to unknown UI group ' + group);
    const route = 'client-ui-' + group;
    if (!Object.hasOwn(WORKFLOW_ROUTE_OWNERS, route)) {
      fail(spec + ' uses UI group ' + group + ' without a workflow route');
    }
    counts.set(group, (counts.get(group) || 0) + 1);
    coverage.set(spec, route);
  }

  if (groups.SPECIAL_UI_GROUPS && typeof groups.SPECIAL_UI_GROUPS === 'object') {
    const listed = new Set();
    for (const [group, groupSpecs] of Object.entries(groups.SPECIAL_UI_GROUPS)) {
      if (!groups.UI_GROUPS.includes(group) || !Array.isArray(groupSpecs)) {
        fail('invalid special UI group declaration: ' + group);
      }
      for (const name of groupSpecs) {
        if (listed.has(name)) fail(name + ' is listed in more than one special UI group');
        listed.add(name);
        if (!names.has(name)) fail('special UI group ' + group + ' references missing spec ' + name);
      }
    }
  }
  return { specs, counts };
}

function discoverRouting() {
  const files = repositoryFiles();
  const fileSet = new Set(files);
  const coverage = new Map();
  const errors = [];
  const privilegedPackages = new Set();
  const goModules = files.filter((file) => file.endsWith('/go.mod') || file === 'go.mod');
  const goModuleDirectories = goModules.map((file) => path.posix.dirname(file)).sort();

  for (const moduleFile of goModules) {
    const directory = path.posix.dirname(moduleFile);
    const route = GO_MODULE_ROUTES[directory];
    if (!route) errors.push('Go module has no CI route: ' + moduleFile);
    else coverage.set(moduleFile, route);
  }

  for (const file of files.filter((candidate) => candidate.endsWith('_test.go'))) {
    const moduleDirectory = nearestGoModule(file, goModuleDirectories);
    const route = GO_MODULE_ROUTES[moduleDirectory];
    if (!moduleDirectory || !route) {
      errors.push('Go test is outside a routed module: ' + file);
      continue;
    }
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
    try {
      const classification = classifyGoTest(file, source, moduleDirectory, route);
      coverage.set(file, classification.route);
      if (classification.privileged) privilegedPackages.add(privilegedPackageForFile(file));
    } catch (error) {
      errors.push(error.message.replace(/^\[ci-routing\]\s*/, ''));
    }
  }

  for (const manifestFile of files.filter((file) => file === 'package.json' || file.endsWith('/package.json'))) {
    const manifest = readJson(manifestFile);
    if (!manifest.scripts || typeof manifest.scripts.test !== 'string') continue;
    const directory = path.posix.dirname(manifestFile);
    const route = NODE_TEST_MODULE_ROUTES[directory];
    if (!route) errors.push('Node package with a test script has no CI route: ' + manifestFile);
    else coverage.set(manifestFile + '#test-script', route);
  }

  const clientUnitTests = files.filter((file) => /^client\/tests\/[^/]+\.test\.js$/.test(file));
  for (const file of clientUnitTests) coverage.set(file, 'client-node');
  for (const file of files.filter((candidate) => /^client\/tests\/.+\.test\.js$/.test(candidate))) {
    if (!clientUnitTests.includes(file)) {
      errors.push('nested client Node test is not matched by tests/*.test.js: ' + file);
    }
  }

  const clientTypeSources = files.filter((file) => (
    /^client\/(?:renderer|src|types)\/.+\.(?:ts|tsx)$/.test(file)
    && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file)
  ));
  for (const file of clientTypeSources) coverage.set(file, 'client-typecheck');
  if (clientTypeSources.length === 0) {
    errors.push('client TypeScript route has no renderer sources or contract declarations');
  }

  const ui = classifyUiSpecs(files, coverage);
  assertNpmRoutingContracts([...ui.counts.keys()]);

  for (const file of files.filter((candidate) => /^server\/deploy\/lsp-toolkit\/.+\.(?:test|spec)\.(?:js|cjs|mjs)$/.test(candidate))) {
    coverage.set(file, 'lsp-toolkit-node');
  }
  for (const file of files.filter((candidate) => /^server\/deploy\/dap-toolkit\/test_[^/]+\.py$/.test(candidate))) {
    coverage.set(file, 'dap-toolkit-python');
  }

  const smokeScripts = files.filter((file) => /^server\/deploy\/.*smoke[^/]*\.(?:js|cjs|mjs)$/.test(file));
  for (const file of smokeScripts) coverage.set(file, 'node-smoke-syntax');

  for (const file of files.filter((candidate) => /^server\/deploy\/(?:test-.+|.+\.test)\.ps1$/i.test(candidate))) {
    coverage.set(file, 'server-deploy-preflight');
  }

  const testLike = files.filter((file) => (
    /_test\.go$/.test(file)
    || /\/(?:test_[^/]+|[^/]+_test)\.py$/.test(file)
    || /\.(?:test|spec)\.(?:js|cjs|mjs|ts|cts|mts)$/.test(file)
    || /\/(?:test-.+|.+\.test)\.ps1$/i.test(file)
  ));
  for (const file of testLike) {
    if (!coverage.has(file)) errors.push('test file has no automatic CI route: ' + file);
  }

  const privilegedTests = [...coverage.values()].filter((route) => route === 'server-privileged-mount');
  if (privilegedTests.length === 0) {
    errors.push('no privileged_integration Go tests were discovered; remove or update the privileged CI route intentionally');
  }
  if (!fileSet.has('server/deploy/test-deploy-server.ps1')) {
    errors.push('server deployment offline contract test is missing');
  }
  const coveredRoutes = new Set(coverage.values());
  for (const route of Object.keys(WORKFLOW_ROUTE_OWNERS)) {
    if (route !== 'server-go-race' && !coveredRoutes.has(route)) {
      errors.push('workflow route no longer covers a discovered test or module: ' + route);
    }
  }

  if (errors.length > 0) fail(errors.join('\n - '));
  return {
    files,
    coverage,
    privilegedPackages: [...privilegedPackages].sort(),
    smokeScripts,
    ui,
    counts: {
      clientUnit: clientUnitTests.length,
      clientTypeSources: clientTypeSources.length,
      goTests: files.filter((file) => file.endsWith('_test.go')).length,
      privilegedGoTests: privilegedTests.length,
      smokeScripts: smokeScripts.length,
      uiSpecs: ui.specs.length
    }
  };
}

function checkSmokeSyntax(smokeScripts) {
  for (const relativePath of smokeScripts) {
    const result = childProcess.spawnSync(process.execPath, ['--check', relativePath], {
      cwd: REPOSITORY_ROOT,
      stdio: 'inherit',
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) fail('Node syntax check failed: ' + relativePath);
  }
}

function parseArguments(argumentsList) {
  const routes = [];
  let checkSmokeSyntaxRequested = false;
  let privilegedPackagesOutput = '';
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--route') {
      const value = argumentsList[index + 1];
      if (!value) fail('--route requires a route id');
      routes.push(value);
      index += 1;
    } else if (argument === '--check-smoke-syntax') {
      checkSmokeSyntaxRequested = true;
    } else if (argument === '--write-privileged-packages') {
      const value = argumentsList[index + 1];
      if (!value) fail('--write-privileged-packages requires an output path');
      privilegedPackagesOutput = path.resolve(REPOSITORY_ROOT, value);
      index += 1;
    } else {
      fail('unknown argument: ' + argument);
    }
  }
  return { checkSmokeSyntaxRequested, privilegedPackagesOutput, routes };
}

function main() {
  const discovery = discoverRouting();
  const registrations = workflowRouteRegistrations();
  const options = parseArguments(process.argv.slice(2));
  for (const route of options.routes) {
    const expectedJob = WORKFLOW_ROUTE_OWNERS[route];
    if (!expectedJob) fail('unknown route requested: ' + route);
    if (process.env.GITHUB_JOB && process.env.GITHUB_JOB !== expectedJob) {
      fail('route ' + route + ' is running in ' + process.env.GITHUB_JOB + ', expected ' + expectedJob);
    }
  }
  if (options.checkSmokeSyntaxRequested) checkSmokeSyntax(discovery.smokeScripts);
  if (options.privilegedPackagesOutput) {
    if (discovery.privilegedPackages.length === 0) fail('cannot write an empty privileged package list');
    fs.writeFileSync(options.privilegedPackagesOutput, discovery.privilegedPackages.join('\n') + '\n', 'utf8');
  }

  const uiCounts = [...discovery.ui.counts.entries()]
    .map(([group, count]) => group + '=' + count)
    .join(', ');
  console.log(
    '[ci-routing] OK: ' + discovery.counts.clientUnit + ' client Node tests, '
    + discovery.counts.clientTypeSources + ' client TypeScript sources, '
    + discovery.counts.uiSpecs + ' UI specs (' + uiCounts + '), '
    + discovery.counts.goTests + ' Go tests, '
    + discovery.counts.privilegedGoTests + ' privileged Go tests, '
    + discovery.counts.smokeScripts + ' smoke scripts, '
    + registrations.size + ' workflow routes.'
  );
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
