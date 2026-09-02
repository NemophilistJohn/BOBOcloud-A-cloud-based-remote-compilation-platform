import type {
  FileDecorationColorDto,
  FileDecorationDto,
  FileDecorationLaneForPoint,
  FileDecorationLaneDto,
  FileDecorationPointId,
  FileDecorationProvider
} from '../../types/file-decoration';

export const FileDecorationLane = Object.freeze({
  SYNC: 'sync',
  SCM: 'scm',
  DIAGNOSTIC: 'diagnostic'
} as const);

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/;

export function contributionPointForDecorationLane(lane: unknown): FileDecorationPointId {
  switch (lane) {
    case FileDecorationLane.SYNC:
      return 'fileDecorations.sync';
    case FileDecorationLane.SCM:
      return 'fileDecorations.scm';
    case FileDecorationLane.DIAGNOSTIC:
      return 'fileDecorations.diagnostic';
    default:
      throw new Error('Unknown file decoration lane: ' + String(lane));
  }
}

export function decorationLaneForContributionPoint(point: unknown): FileDecorationLaneDto | null {
  switch (point) {
    case 'fileDecorations.sync':
      return FileDecorationLane.SYNC;
    case 'fileDecorations.scm':
      return FileDecorationLane.SCM;
    case 'fileDecorations.diagnostic':
      return FileDecorationLane.DIAGNOSTIC;
    default:
      return null;
  }
}

export function validateFileDecorationProvider<Point extends FileDecorationPointId>(
  provider: unknown,
  point: Point
): FileDecorationProvider<FileDecorationLaneForPoint<Point>>;
export function validateFileDecorationProvider(
  provider: unknown,
  point?: string
): FileDecorationProvider;
export function validateFileDecorationProvider(
  provider: unknown,
  point?: string
): FileDecorationProvider {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('File decoration provider must be an object.');
  }

  const candidate = provider as Record<string, unknown>;
  if (
    candidate.id !== undefined &&
    (typeof candidate.id !== 'string' || !candidate.id.trim())
  ) {
    throw new TypeError('File decoration provider id must be a non-empty string.');
  }
  if (typeof candidate.namespace !== 'string' || !NAMESPACE_PATTERN.test(candidate.namespace)) {
    throw new Error('File decoration provider namespace must be globally namespaced.');
  }

  const providerPoint = contributionPointForDecorationLane(candidate.lane);
  if (point && providerPoint !== point) {
    throw new Error(
      'File decoration lane "' + String(candidate.lane) +
      '" does not match contribution point "' + point + '".'
    );
  }
  if (
    candidate.priority !== undefined &&
    (!Number.isInteger(candidate.priority) || Math.abs(candidate.priority as number) > 1000)
  ) {
    throw new Error('File decoration priority must be an integer from -1000 to 1000.');
  }
  if (typeof candidate.getDecoration !== 'function') {
    throw new TypeError('File decoration provider requires getDecoration(path, node).');
  }
  if (candidate.onDidChange !== undefined && typeof candidate.onDidChange !== 'function') {
    throw new TypeError('File decoration provider onDidChange must be a function.');
  }
  return provider as FileDecorationProvider;
}

function normalizeColor(value: unknown): FileDecorationColorDto | '' {
  switch (value) {
    case 'success':
    case 'warning':
    case 'danger':
    case 'info':
    case 'muted':
      return value;
    default:
      return '';
  }
}

export function normalizeFileDecoration(value: unknown): FileDecorationDto | null {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('File decoration must be an object or null.');
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.status !== 'string' || !candidate.status.trim()) {
    throw new Error('File decoration status must be a non-empty string.');
  }
  if (typeof candidate.badge !== 'string' || !candidate.badge.trim()) {
    throw new Error('File decoration badge must be a non-empty icon id.');
  }

  return Object.freeze({
    status: candidate.status,
    badge: candidate.badge,
    // Presentation tokens are host-controlled. Consumers map these fixed
    // tokens to theme variables instead of accepting arbitrary CSS values.
    color: normalizeColor(candidate.color),
    tooltip: typeof candidate.tooltip === 'string' ? candidate.tooltip : '',
    ariaLabel: typeof candidate.ariaLabel === 'string' ? candidate.ariaLabel : '',
    transient: candidate.transient === true
  });
}
