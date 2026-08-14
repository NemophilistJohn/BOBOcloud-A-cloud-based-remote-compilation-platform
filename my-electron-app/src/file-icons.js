export const FILE_ICONS_SERVICE_ID = 'workbench.fileIcons';

const DEFAULT_EXTENSION_MAP = Object.freeze({
  '.py': 'python', '.pyw': 'python', '.pyx': 'python',
  '.js': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'typescript',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.lua': 'lua',
  '.html': 'html', '.htm': 'html', '.css': 'css',
  '.scss': 'scss', '.sass': 'scss', '.less': 'scss',
  '.vue': 'vue', '.xml': 'xml', '.svg': 'xml',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.sql': 'sql', '.md': 'markdown', '.mdx': 'markdown',
  '.angular': 'angular'
});

const DEFAULT_FILENAME_MAP = Object.freeze({
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'makefile': 'c',
  'license': 'yaml',
  'readme.md': 'markdown'
});

const DEFAULT_FOLDER_ICON_MAP = Object.freeze({
  '.git': 'git'
});

export function createFileIconService(options = {}) {
  const iconDirectory = typeof options.iconDirectory === 'string' && options.iconDirectory
    ? options.iconDirectory.replace(/[\\/]$/, '')
    : 'ico';
  const extensionMap = { ...DEFAULT_EXTENSION_MAP, ...(options.extensionMap || {}) };
  const filenameMap = { ...DEFAULT_FILENAME_MAP, ...(options.filenameMap || {}) };
  const folderIconMap = { ...DEFAULT_FOLDER_ICON_MAP, ...(options.folderIconMap || {}) };
  let iconCache = new Map();

  function buildPath(iconName) {
    return iconName ? iconDirectory + '/file_type_' + iconName + '.svg' : null;
  }

  function getFileIcon(fileName) {
    if (!fileName) return null;
    if (iconCache.has(fileName)) return iconCache.get(fileName);

    const lower = fileName.toLowerCase();
    let iconName = filenameMap[lower];
    if (!iconName) {
      const dot = lower.lastIndexOf('.');
      if (dot !== -1) iconName = extensionMap[lower.substring(dot)];
    }

    const result = buildPath(iconName);
    iconCache.set(fileName, result);
    return result;
  }

  function getFolderIcon(folderName) {
    if (!folderName) return null;
    return buildPath(folderIconMap[folderName.toLowerCase()]);
  }

  function clearIconCache() {
    iconCache = new Map();
  }

  return Object.freeze({
    getFileIcon,
    getFolderIcon,
    clearIconCache,
    // Mutable maps preserve the legacy extension hook during migration.
    extensionMap,
    filenameMap,
    folderIconMap
  });
}
