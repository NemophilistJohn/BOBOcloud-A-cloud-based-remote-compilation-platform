'use strict';

const fs = require('fs');
const path = require('path');

const workspace = path.resolve(process.argv[2] || '/workspace');
const cacheRoot = path.resolve(process.argv[3] || '/analysis-cache/clangd');
const fallbackFlagsPath = process.argv[4] ? path.resolve(process.argv[4]) : '';
const outputDir = path.join(cacheRoot, 'cdb');
const outputPath = path.join(outputDir, 'compile_commands.json');
const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm']);
const ignoredDirectories = new Set([
  '.git', '.hg', '.svn', '.cache', 'node_modules', 'target', 'vendor'
]);
const maxDepth = 6;
const maxSources = 10000;
const maxDatabaseBytes = 64 * 1024 * 1024;

function readFallbackFlags() {
  if (!fallbackFlagsPath) return [];
  try {
    return fs.readFileSync(fallbackFlagsPath, 'utf8')
      .split(/\r?\n/)
      .map((flag) => flag.trim())
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

const fallbackFlags = readFallbackFlags();

function mergeArguments(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length === 0 || fallbackFlags.length === 0) {
    return argumentsList;
  }
  const existing = new Set(argumentsList);
  const additions = fallbackFlags.filter((flag) => !existing.has(flag));
  return [argumentsList[0], ...additions, ...argumentsList.slice(1)];
}

function posix(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
}

function walk(directory, depth, sources, databases) {
  if (depth > maxDepth || sources.length >= maxSources) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walk(absolute, depth + 1, sources, databases);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === 'compile_commands.json') databases.push(absolute);
    if (sourceExtensions.has(path.extname(entry.name).toLowerCase())) {
      sources.push(posix(path.relative(workspace, absolute)));
      if (sources.length >= maxSources) return;
    }
  }
}

function resolveOriginalFile(entry) {
  const file = posix(entry.file);
  const directory = posix(entry.directory);
  if (!file) return '';
  return file.startsWith('/') ? file : posix(path.posix.resolve(directory || '/', file));
}

function bestWorkspaceRelative(original, sources) {
  const normalized = posix(original);
  let match = '';
  for (const relative of sources) {
    if ((normalized === relative || normalized.endsWith('/' + relative)) && relative.length > match.length) {
      match = relative;
    }
  }
  return match;
}

function normalizeDatabase(entries, sources) {
  let oldRoot = '';
  for (const entry of entries) {
    const original = resolveOriginalFile(entry);
    const relative = bestWorkspaceRelative(original, sources);
    if (original && relative) {
      oldRoot = original.slice(0, original.length - relative.length).replace(/\/$/, '');
      if (oldRoot) break;
    }
  }

  const rewrite = (value) => {
    const normalized = posix(value);
    if (oldRoot && (normalized === oldRoot || normalized.startsWith(oldRoot + '/'))) {
      return '/workspace' + normalized.slice(oldRoot.length);
    }
    return normalized;
  };

  return entries.map((entry) => {
    const original = resolveOriginalFile(entry);
    const relative = bestWorkspaceRelative(original, sources);
    const normalized = { ...entry };
    normalized.directory = rewrite(entry.directory) || '/workspace';
    normalized.file = relative ? '/workspace/' + relative : rewrite(entry.file);
    if (Array.isArray(entry.arguments)) {
      normalized.arguments = mergeArguments(entry.arguments.map((argument) => {
        const text = String(argument);
        return oldRoot ? text.replaceAll(oldRoot, '/workspace') : text;
      }));
    }
    if (typeof entry.command === 'string' && oldRoot) {
      normalized.command = entry.command.replaceAll(oldRoot, '/workspace');
    }
    return normalized;
  });
}

function generatedDatabase(sources) {
  return sources.map((relative) => {
    const cpp = ['.cc', '.cpp', '.cxx', '.mm'].includes(path.extname(relative).toLowerCase());
    return {
      directory: '/workspace',
      file: '/workspace/' + relative,
      arguments: mergeArguments([cpp ? 'clang++' : 'clang', cpp ? '-std=gnu++17' : '-std=gnu17', '-I/workspace', '-c', '/workspace/' + relative])
    };
  });
}

const sources = [];
const databases = [];
walk(workspace, 0, sources, databases);
let output = [];

for (const database of databases) {
  try {
    const stat = fs.statSync(database);
    if (stat.size <= 0 || stat.size > maxDatabaseBytes) continue;
    const parsed = JSON.parse(fs.readFileSync(database, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) {
      output = normalizeDatabase(parsed, sources);
      break;
    }
  } catch {
    // Try the next database and finally fall back to a conservative generated one.
  }
}

if (output.length === 0) output = generatedDatabase(sources);
if (output.length === 0) process.exit(1);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath + '.tmp', JSON.stringify(output));
fs.renameSync(outputPath + '.tmp', outputPath);
process.stdout.write(outputDir);
