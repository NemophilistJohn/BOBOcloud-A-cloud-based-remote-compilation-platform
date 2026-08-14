'use strict';

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const forbiddenPaths = [
  /(^|\/)server-settings\.json$/i,
  /(^|\/)ai-settings\.json$/i,
  /(^|\/)diagnostics-settings\.json$/i,
  /(^|\/)window-state\.json$/i,
  /(^|\/)chat-history\.json$/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)project-names\.json$/i,
  /(^|\/)rclone\.conf$/i,
  /(^|\/)\.mcp\.json$/i,
  /^\/\.claude(\/|$)/i,
  /^\/\.vscode(\/|$)/i,
  /^\/\.idea(\/|$)/i,
  /^\/server(\/|$)/i,
  /^\/dist(\/|$)/i,
  /^\/release(\/|$)/i,
  /(^|\/)PLAN-[^/]+\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /\.log$/i
];

const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.cjs', '.txt', '.xml', '.yaml', '.yml'
]);

function collectSensitiveValues(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }

  const values = [];
  function visit(value, key) {
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
      return;
    }
    if (!/(ip|host|pass(word)?|api.?key|token|secret)/i.test(key || '')) return;
    const text = String(value || '').trim();
    if (text.length >= 7) values.push(text);
  }
  visit(data, '');
  return values;
}

function findAppAsars(directory) {
  if (!fs.existsSync(directory)) return [];

  const results = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === 'app.asar' &&
        path.basename(current).toLowerCase() === 'resources'
      ) {
        results.push(entryPath);
      }
    });
  }
  return results.sort();
}

function resolveAsarPath(explicitPath, root = projectRoot, version = packageJson.version) {
  if (explicitPath) return path.resolve(explicitPath);

  const versionDirectory = path.join(root, 'release', version);
  const candidates = findAppAsars(versionDirectory);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error('no app.asar found for release version ' + version + ' under ' + versionDirectory);
  }
  throw new Error(
    'multiple app.asar files found for release version ' + version +
    '; pass the intended path explicitly: ' + candidates.join(', ')
  );
}

function fail(message) {
  console.error('[release-audit] FAILED: ' + message);
  process.exitCode = 1;
}

function inspectRendererBundleEntries(entries) {
  const normalized = entries.map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, ''));
  const entrySet = new Set(normalized);
  const requiredEntries = [
    'renderer-dist/bobo-renderer.js',
    'renderer-dist/bobo-renderer.js.map',
    'renderer-dist/bobo-ai-ui.js',
    'renderer-dist/bobo-ai-ui.js.map',
    'renderer-dist/bobo-renderer.manifest.json'
  ];
  const missingEntries = requiredEntries.filter((entry) => !entrySet.has(entry));
  const legacyRendererEntries = normalized.filter((entry) => (
    /^editor-rules\//.test(entry) ||
    /^renderer\//.test(entry) ||
    entry === 'completion-rules.js' ||
    entry === 'theme-manager.js' ||
    (/^src\/.*\.js$/i.test(entry) && entry !== 'src/ai-settings-schema.js')
  ));
  return { missingEntries, legacyRendererEntries };
}

function main() {
  let asarPath;
  try {
    asarPath = resolveAsarPath(process.argv[2]);
  } catch (error) {
    fail(error.message);
    return;
  }

  if (!fs.existsSync(asarPath)) {
    fail('app.asar was not found: ' + asarPath);
    return;
  }

  const entries = asar.listPackage(asarPath);
  const normalizedEntries = entries.map((entry) => entry.replace(/\\/g, '/'));
  const forbiddenEntries = normalizedEntries.filter((entry) => forbiddenPaths.some((pattern) => pattern.test(entry)));
  if (forbiddenEntries.length) {
    fail('forbidden local or debug files were packaged: ' + forbiddenEntries.join(', '));
  }

  const rendererInspection = inspectRendererBundleEntries(normalizedEntries);
  if (rendererInspection.missingEntries.length) {
    fail('renderer bundle artifacts are missing: ' + rendererInspection.missingEntries.join(', '));
  }
  if (rendererInspection.legacyRendererEntries.length) {
    fail('legacy renderer source files were packaged: ' + rendererInspection.legacyRendererEntries.join(', '));
  }

  const sensitiveValues = [
    ...collectSensitiveValues(path.join(projectRoot, 'server-settings.json')),
    ...collectSensitiveValues(path.join(projectRoot, '.mcp.json'))
  ].filter((value, index, values) => values.indexOf(value) === index);

  const sensitiveMatches = [];
  if (sensitiveValues.length) {
    normalizedEntries.forEach((entry) => {
      if (!textExtensions.has(path.extname(entry).toLowerCase())) return;
      let content;
      try {
        content = asar.extractFile(asarPath, entry.replace(/^\//, '')).toString('utf8');
      } catch {
        return;
      }
      if (sensitiveValues.some((value) => content.includes(value))) sensitiveMatches.push(entry);
    });
  }

  if (sensitiveMatches.length) {
    fail('local secret values were found in packaged text files: ' + sensitiveMatches.join(', '));
  }

  if (!process.exitCode) {
    console.log('[release-audit] PASS');
    console.log('[release-audit] inspected ' + asarPath);
    console.log('[release-audit] inspected ' + normalizedEntries.length + ' app.asar entries');
    console.log('[release-audit] no local settings files or known local secret values were packaged');
  }
}

if (require.main === module) main();

module.exports = {
  findAppAsars,
  inspectRendererBundleEntries,
  resolveAsarPath
};
