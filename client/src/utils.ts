import type {
  DetectedLanguageIdDto,
  LocalPathSeparatorDto,
  ProjectKeyDto
} from '../types/utils';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'
]);

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+[\\/][^\\/]+/;
const FORWARD_UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/;

const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  java: 'Java', c: 'C', cpp: 'C++', go: 'Go', rust: 'Rust',
  json: 'JSON', markdown: 'Markdown', html: 'HTML', css: 'CSS',
  shell: 'Shell', plaintext: 'Plain Text', sql: 'SQL', xml: 'XML',
  yaml: 'YAML', php: 'PHP', ruby: 'Ruby'
});

export function detectLanguage(
  filename: string,
  content?: string | null
): DetectedLanguageIdDto {
  const normalizedFilename = filename.toLowerCase();
  if (normalizedFilename.endsWith('.ts')) return 'typescript';
  if (normalizedFilename.endsWith('.js')) return 'javascript';
  if (normalizedFilename.endsWith('.jsx')) return 'javascript';
  if (normalizedFilename.endsWith('.tsx')) return 'typescript';
  if (normalizedFilename.endsWith('.jsonc')) return 'json';
  if (normalizedFilename.endsWith('.py')) return 'python';
  if (
    normalizedFilename.endsWith('.cpp') ||
    normalizedFilename.endsWith('.cc') ||
    normalizedFilename.endsWith('.cxx')
  ) return 'cpp';
  if (normalizedFilename.endsWith('.c')) return 'c';
  if (normalizedFilename.endsWith('.java')) return 'java';
  if (normalizedFilename.endsWith('.json')) return 'json';
  if (normalizedFilename.endsWith('.md')) return 'markdown';
  if (normalizedFilename.endsWith('.html')) return 'html';
  if (normalizedFilename.endsWith('.css')) return 'css';
  if (
    normalizedFilename.endsWith('.scss') ||
    normalizedFilename.endsWith('.sass')
  ) return 'scss';
  if (normalizedFilename.endsWith('.less')) return 'less';
  if (
    normalizedFilename.endsWith('.sh') ||
    normalizedFilename.endsWith('.bash') ||
    normalizedFilename.endsWith('.zsh')
  ) return 'shell';
  if (normalizedFilename.endsWith('.go')) return 'go';
  if (normalizedFilename.endsWith('.rs')) return 'rust';
  if (normalizedFilename.endsWith('.sql')) return 'sql';
  if (normalizedFilename.endsWith('.xml')) return 'xml';
  if (
    normalizedFilename.endsWith('.yaml') ||
    normalizedFilename.endsWith('.yml')
  ) return 'yaml';

  if (content && content.startsWith('#!')) {
    if (content.indexOf('python') !== -1) return 'python';
    if (content.indexOf('node') !== -1) return 'javascript';
    if (content.indexOf('bash') !== -1 || content.indexOf('sh') !== -1) return 'shell';
    if (content.indexOf('go') !== -1) return 'go';
    if (content.indexOf('rust') !== -1) return 'rust';
  }
  return 'plaintext';
}

export function isImageFile(filename: string): boolean {
  const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.has(extension);
}

export function projectKey(workspaceRoot: string): ProjectKeyDto {
  const normalized = workspaceRoot
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/\/+$/, '');
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return ('p' + Math.abs(hash).toString(36)) as ProjectKeyDto;
}

export function isWindowsLocalPath(value?: unknown): boolean {
  const localPath = String(value || '');
  return WINDOWS_DRIVE_PATH_PATTERN.test(localPath) ||
    WINDOWS_UNC_PATH_PATTERN.test(localPath) ||
    FORWARD_UNC_PATH_PATTERN.test(localPath);
}

export function localPathSeparator(value?: unknown): LocalPathSeparatorDto {
  return isWindowsLocalPath(value) ? '\\' : '/';
}

export function langDisplayName(langId: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(LANGUAGE_DISPLAY_NAMES, langId);
  return typeof descriptor?.value === 'string' ? descriptor.value : langId;
}
