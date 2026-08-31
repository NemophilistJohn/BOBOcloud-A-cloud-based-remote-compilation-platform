'use strict';

const RCLONE_IGNORED_DIRECTORIES = Object.freeze([
  '.git', '.bobocloud', 'target', 'node_modules', '__pycache__', '.venv', 'venv'
]);

const DEFAULT_EXCLUDES = Object.freeze([
  '**/target/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.bobocloud/**',
  '**/.bobocloud-team.json'
]);

module.exports = { DEFAULT_EXCLUDES, RCLONE_IGNORED_DIRECTORIES };
