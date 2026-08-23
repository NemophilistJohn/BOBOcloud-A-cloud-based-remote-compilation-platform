const MAX_VIEWER_EXTENSIONS = 32;
const MAX_VIEWER_RESOURCES = 16;

function requiredString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new TypeError(label + ' must be a bounded non-empty string.');
  }
  return value.trim();
}

function normalizedPath(value, label) {
  const result = requiredString(value, label, 240);
  if (result.includes('\\') || result.startsWith('/') || result.startsWith('.') ||
      result.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new TypeError(label + ' must be a package-relative POSIX path.');
  }
  return result;
}

export function validateDocumentViewDescriptor(value, pluginId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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
  if (new Set(extensions).size !== extensions.length || extensions.some((extension) => !/^\.[a-z0-9][a-z0-9+_-]{0,15}$/.test(extension))) {
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
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw new TypeError('Document viewer priority must be an integer from -1000 to 1000.');
  }
  return Object.freeze({
    id,
    title,
    extensions: Object.freeze(extensions),
    entry,
    resources: Object.freeze(normalizedResources),
    priority
  });
}

export function selectDocumentView(entries, fileName) {
  const normalizedName = String(fileName || '').toLowerCase();
  const matches = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const descriptor = entry && entry.contribution;
    if (!descriptor || !Array.isArray(descriptor.extensions)) continue;
    const extension = descriptor.extensions.find((candidate) => normalizedName.endsWith(candidate));
    if (!extension) continue;
    matches.push({ entry, extension });
  }
  matches.sort((left, right) => (
    right.extension.length - left.extension.length ||
    right.entry.contribution.priority - left.entry.contribution.priority ||
    left.entry.id.localeCompare(right.entry.id)
  ));
  return matches.length ? matches[0].entry : null;
}
