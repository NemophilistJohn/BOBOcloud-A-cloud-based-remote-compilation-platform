import type {
  FileIconNameMap,
  FileIconService,
  FileIconServiceOptions
} from '../types/file-icons';

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
}) satisfies Readonly<FileIconNameMap>;

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
}) satisfies Readonly<FileIconNameMap>;

const DEFAULT_FOLDER_ICON_MAP = Object.freeze({
  '.git': 'git'
}) satisfies Readonly<FileIconNameMap>;

function ownIconName(map: FileIconNameMap, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function createFileIconService(options: FileIconServiceOptions = {}): FileIconService {
  const iconDirectory = typeof options.iconDirectory === 'string' && options.iconDirectory
    ? options.iconDirectory.replace(/[\\/]$/, '')
    : 'ico';
  const iconPathPrefix = iconDirectory + '/file_type_';
  const extensionMap: FileIconNameMap = { ...DEFAULT_EXTENSION_MAP, ...(options.extensionMap || {}) };
  const filenameMap: FileIconNameMap = { ...DEFAULT_FILENAME_MAP, ...(options.filenameMap || {}) };
  const folderIconMap: FileIconNameMap = { ...DEFAULT_FOLDER_ICON_MAP, ...(options.folderIconMap || {}) };
  let iconCache = new Map<string, string | null>();

  function buildPath(iconName: string | undefined): string | null {
    return iconName ? iconPathPrefix + iconName + '.svg' : null;
  }

  function getFileIcon(fileName?: string | null): string | null {
    if (!fileName) return null;
    const cached = iconCache.get(fileName);
    if (cached !== undefined) return cached;

    const lower = fileName.toLowerCase();
    let iconName = ownIconName(filenameMap, lower);
    if (!iconName) {
      const dot = lower.lastIndexOf('.');
      if (dot !== -1) iconName = ownIconName(extensionMap, lower.substring(dot));
    }

    const result = buildPath(iconName);
    iconCache.set(fileName, result);
    return result;
  }

  function getFolderIcon(folderName?: string | null): string | null {
    if (!folderName) return null;
    return buildPath(ownIconName(folderIconMap, folderName.toLowerCase()));
  }

  function clearIconCache(): void {
    iconCache = new Map<string, string | null>();
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
