import type {
  DocumentViewContributionEntryDto,
  DocumentViewDescriptorDto
} from '../../types/document-view';

const MAX_VIEWER_EXTENSIONS = 32;
const MAX_VIEWER_RESOURCES = 16;
const MAX_EXTENSION_LENGTH = 17;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new TypeError(label + ' must be a bounded non-empty string.');
  }
  return value.trim();
}

function normalizedPath(value: unknown, label: string): string {
  const result = requiredString(value, label, 240);
  if (result.includes('\\') || result.startsWith('/') || result.startsWith('.') ||
      result.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new TypeError(label + ' must be a package-relative POSIX path.');
  }
  return result;
}

function isDocumentViewExtension(value: string): boolean {
  return value.length <= MAX_EXTENSION_LENGTH &&
    /^\.[a-z0-9][a-z0-9+_-]*(?:\.[a-z0-9][a-z0-9+_-]*)*$/.test(value);
}

export function validateDocumentViewDescriptor(
  value: unknown,
  pluginId?: string | null
): DocumentViewDescriptorDto {
  if (!isRecord(value)) {
    throw new TypeError('Document viewer descriptor must be an object.');
  }
  const allowed = new Set(['id', 'title', 'extensions', 'entry', 'resources', 'priority']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Document viewer descriptor contains unsupported fields.');
  }
  const id = requiredString(value.id, 'Document viewer id', 180);
  if (pluginId && !id.startsWith(pluginId + '.')) {
    throw new TypeError('Document viewer id must use the plugin namespace.');
  }
  const title = requiredString(value.title, 'Document viewer title', 120);
  if (!Array.isArray(value.extensions) || value.extensions.length < 1 || value.extensions.length > MAX_VIEWER_EXTENSIONS) {
    throw new TypeError('Document viewer extensions must be a non-empty bounded array.');
  }
  const extensions = value.extensions.map((extension) => String(extension || '').toLowerCase());
  if (new Set(extensions).size !== extensions.length || extensions.some((extension) => !isDocumentViewExtension(extension))) {
    throw new TypeError('Document viewer extensions must be unique lowercase file extensions.');
  }
  const entry = normalizedPath(value.entry, 'Document viewer entry');
  if (!/\.(?:js|mjs)$/.test(entry)) throw new TypeError('Document viewer entry must be JavaScript.');
  const resources = value.resources === undefined ? [] : value.resources;
  if (!Array.isArray(resources) || resources.length > MAX_VIEWER_RESOURCES) {
    throw new TypeError('Document viewer resources must be a bounded array.');
  }
  const normalizedResources = resources.map((resource) => normalizedPath(resource, 'Document viewer resource'));
  if (new Set(normalizedResources).size !== normalizedResources.length) {
    throw new TypeError('Document viewer resources must be unique.');
  }
  const priority = value.priority === undefined ? 0 : value.priority;
  if (!Number.isInteger(priority) || (priority as number) < -1000 || (priority as number) > 1000) {
    throw new TypeError('Document viewer priority must be an integer from -1000 to 1000.');
  }
  return Object.freeze({
    id,
    title,
    extensions: Object.freeze(extensions),
    entry,
    resources: Object.freeze(normalizedResources),
    priority: priority as number
  });
}

export function selectDocumentView<Entry extends DocumentViewContributionEntryDto>(
  entries: readonly Entry[] | null | undefined,
  fileName: unknown
): Entry | null {
  const normalizedName = String(fileName || '').toLowerCase();
  let bestEntry: Entry | null = null;
  let bestExtensionLength = -1;
  let bestPriority = Number.NEGATIVE_INFINITY;
  let bestId = '';

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const descriptor = entry.contribution;
    if (!descriptor || !Array.isArray(descriptor.extensions)) continue;

    let longestExtensionLength = -1;
    for (const rawExtension of descriptor.extensions) {
      if (typeof rawExtension !== 'string') continue;
      const extension = rawExtension.toLowerCase();
      if (extension.length > longestExtensionLength && normalizedName.endsWith(extension)) {
        longestExtensionLength = extension.length;
      }
    }
    if (longestExtensionLength < 0) continue;

    const priority = Number.isFinite(descriptor.priority) ? descriptor.priority : 0;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const isBetter = bestEntry === null ||
      longestExtensionLength > bestExtensionLength ||
      (longestExtensionLength === bestExtensionLength && priority > bestPriority) ||
      (longestExtensionLength === bestExtensionLength && priority === bestPriority && id.localeCompare(bestId) < 0);
    if (!isBetter) continue;

    bestEntry = entry;
    bestExtensionLength = longestExtensionLength;
    bestPriority = priority;
    bestId = id;
  }
  return bestEntry;
}
