export type DetectedLanguageIdDto =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'python'
  | 'cpp'
  | 'c'
  | 'java'
  | 'markdown'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'shell'
  | 'go'
  | 'rust'
  | 'sql'
  | 'xml'
  | 'yaml'
  | 'plaintext';

export type LocalPathSeparatorDto = '\\' | '/';
export type ProjectKeyDto = `p${string}`;

export interface RendererUtilitiesFacade {
  readonly detectLanguage: (
    filename: string,
    content?: string | null
  ) => DetectedLanguageIdDto;
  readonly isImageFile: (filename: string) => boolean;
  readonly projectKey: (workspaceRoot: string) => ProjectKeyDto;
  readonly isWindowsLocalPath: (value?: unknown) => boolean;
  readonly localPathSeparator: (value?: unknown) => LocalPathSeparatorDto;
  readonly langDisplayName: (langId: string) => string;
}
