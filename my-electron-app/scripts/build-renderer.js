'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'renderer', 'entry.js');
const AI_UI_ENTRY = path.join(ROOT, 'renderer', 'ai-ui-entry.js');
const OUTPUT_DIRECTORY = path.join(ROOT, 'renderer-dist');
const OUTPUT_FILE = path.join(OUTPUT_DIRECTORY, 'bobo-renderer.js');
const AI_UI_OUTPUT_FILE = path.join(OUTPUT_DIRECTORY, 'bobo-ai-ui.js');

function readOrderedImports(source) {
  return Array.from(source.matchAll(/^import\s+['"]([^'"]+)['"];?\s*$/gm), (match) => match[1]);
}

function parseMode(argv = process.argv.slice(2)) {
  const modeArgument = argv.find((argument) => argument.startsWith('--mode='));
  const mode = modeArgument ? modeArgument.slice('--mode='.length) : 'production';
  if (mode !== 'development' && mode !== 'production') {
    throw new Error('Renderer build mode must be development or production.');
  }
  return mode;
}

async function buildRenderer(options = {}) {
  const mode = options.mode || parseMode();
  const production = mode === 'production';
  const outputDirectory = options.outputDirectory || OUTPUT_DIRECTORY;
  const outputFile = path.join(outputDirectory, 'bobo-renderer.js');
  const aiUiOutputFile = path.join(outputDirectory, 'bobo-ai-ui.js');
  await fs.mkdir(outputDirectory, { recursive: true });

  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: {
      'bobo-renderer': ENTRY,
      'bobo-ai-ui': AI_UI_ENTRY
    },
    outdir: outputDirectory,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome138'],
    minify: production,
    sourcemap: 'linked',
    sourcesContent: true,
    legalComments: 'none',
    treeShaking: true,
    define: {
      // Monaco exposes an AMD `require` global. Without this definition,
      // bundlers may mistake src/app.js calls for CommonJS imports.
      require: 'window.require'
    },
    logLevel: options.logLevel || 'info',
    metafile: true
  });

  const entrySource = await fs.readFile(ENTRY, 'utf8');
  const aiUiEntrySource = await fs.readFile(AI_UI_ENTRY, 'utf8');
  const orderedModules = readOrderedImports(entrySource);
  const orderedAiUiModules = readOrderedImports(aiUiEntrySource);
  const metadataFile = path.join(outputDirectory, 'bobo-renderer.meta.json');
  const manifestFile = path.join(outputDirectory, 'bobo-renderer.manifest.json');
  await fs.writeFile(metadataFile, JSON.stringify(result.metafile, null, 2) + '\n', 'utf8');
  await fs.writeFile(manifestFile, JSON.stringify({
    schemaVersion: 1,
    mode,
    format: 'iife',
    compatibilityNamespace: 'window.BOBO',
    entries: {
      core: {
        entry: path.relative(ROOT, ENTRY).replace(/\\/g, '/'),
        orderedModules,
        outputs: ['bobo-renderer.js', 'bobo-renderer.js.map']
      },
      aiUi: {
        entry: path.relative(ROOT, AI_UI_ENTRY).replace(/\\/g, '/'),
        load: 'first-visible-ai-ui',
        orderedModules: orderedAiUiModules,
        outputs: ['bobo-ai-ui.js', 'bobo-ai-ui.js.map']
      }
    }
  }, null, 2) + '\n', 'utf8');
  return { mode, outputFile, aiUiOutputFile, metadataFile, manifestFile, result };
}

if (require.main === module) {
  buildRenderer().then(({ mode, outputFile }) => {
    console.log('[renderer] built ' + mode + ' bundle: ' + path.relative(ROOT, outputFile));
  }).catch((error) => {
    console.error('[renderer] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  ENTRY,
  AI_UI_ENTRY,
  OUTPUT_DIRECTORY,
  OUTPUT_FILE,
  AI_UI_OUTPUT_FILE,
  buildRenderer,
  parseMode,
  readOrderedImports
};
