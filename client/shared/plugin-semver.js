'use strict';

const semver = require('semver');

const MAX_RANGE_LENGTH = 160;

function isValidSemver(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  if (!/^(?:0|[1-9]\d*)\./.test(value)) return false;
  return semver.valid(value, { loose: false }) !== null;
}

function isValidSemverRange(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_RANGE_LENGTH) return false;
  const clauses = value.trim().split(/\s*\|\|\s*/);
  if (clauses.some((clause) => clause.length === 0)) return false;
  return semver.validRange(value, { loose: false }) !== null;
}

function satisfiesVersionRange(version, range) {
  if (!isValidSemver(version) || !isValidSemverRange(range)) return false;
  return semver.satisfies(version, range, { loose: false });
}

function compareSemver(left, right) {
  if (!isValidSemver(left) || !isValidSemver(right)) return null;
  return semver.compare(left, right, { loose: false });
}

module.exports = Object.freeze({
  compareSemver,
  isValidSemver,
  isValidSemverRange,
  satisfiesVersionRange
});
