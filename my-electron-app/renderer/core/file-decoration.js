export const FileDecorationLane = Object.freeze({
  SYNC: 'sync',
  SCM: 'scm',
  DIAGNOSTIC: 'diagnostic'
});

const POINT_BY_LANE = Object.freeze({
  [FileDecorationLane.SYNC]: 'fileDecorations.sync',
  [FileDecorationLane.SCM]: 'fileDecorations.scm',
  [FileDecorationLane.DIAGNOSTIC]: 'fileDecorations.diagnostic'
});

export function contributionPointForDecorationLane(lane) {
  const point = POINT_BY_LANE[lane];
  if (!point) throw new Error('Unknown file decoration lane: ' + lane);
  return point;
}

export function validateFileDecorationProvider(provider, point) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('File decoration provider must be an object.');
  }
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(provider.namespace || '')) {
    throw new Error('File decoration provider namespace must be globally namespaced.');
  }
  if (!POINT_BY_LANE[provider.lane]) {
    throw new Error('Unknown file decoration lane: ' + provider.lane);
  }
  if (point && POINT_BY_LANE[provider.lane] !== point) {
    throw new Error('File decoration lane "' + provider.lane + '" does not match contribution point "' + point + '".');
  }
  if (provider.priority !== undefined && (!Number.isInteger(provider.priority) || Math.abs(provider.priority) > 1000)) {
    throw new Error('File decoration priority must be an integer from -1000 to 1000.');
  }
  if (typeof provider.getDecoration !== 'function') {
    throw new TypeError('File decoration provider requires getDecoration(path, node).');
  }
  if (provider.onDidChange !== undefined && typeof provider.onDidChange !== 'function') {
    throw new TypeError('File decoration provider onDidChange must be a function.');
  }
  return provider;
}

export function normalizeFileDecoration(value) {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== 'object') throw new TypeError('File decoration must be an object or null.');
  if (typeof value.status !== 'string' || !value.status.trim()) {
    throw new Error('File decoration status must be a non-empty string.');
  }
  if (typeof value.badge !== 'string' || !value.badge.trim()) {
    throw new Error('File decoration badge must be a non-empty icon id.');
  }
  return Object.freeze({
    status: value.status,
    badge: value.badge,
    tooltip: typeof value.tooltip === 'string' ? value.tooltip : '',
    ariaLabel: typeof value.ariaLabel === 'string' ? value.ariaLabel : '',
    transient: value.transient === true
  });
}
