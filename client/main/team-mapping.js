'use strict';

const path = require('node:path');
const { readJsonFileSync } = require('./atomic-file');

const MAX_TEAM_MAPPING_BYTES = 32 * 1024;

function boundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : '';
}

function readTeamMapping(directory, options = {}) {
  const markerPath = path.join(directory, '.bobocloud-team.json');
  try {
    const stored = readJsonFileSync(markerPath, { maxBytes: MAX_TEAM_MAPPING_BYTES });
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
    const mapping = {
      version: Number(stored.version) || 1,
      teamId: boundedText(stored.teamId, 256),
      teamName: boundedText(stored.teamName, 512),
      projectId: boundedText(stored.projectId, 256),
      projectName: boundedText(stored.projectName, 512),
      branch: boundedText(stored.branch, 512),
      localPath: boundedText(stored.localPath, 32 * 1024)
    };
    if (!mapping.teamId || !mapping.projectId || !mapping.branch) return null;
    if (options.requireLocalPath === true &&
        (!mapping.localPath || path.resolve(mapping.localPath) !== path.resolve(directory))) return null;
    return mapping;
  } catch (error) {
    if (typeof options.onInvalid === 'function' && error && error.code !== 'ENOENT') options.onInvalid(error);
    return null;
  }
}

module.exports = { MAX_TEAM_MAPPING_BYTES, readTeamMapping };
