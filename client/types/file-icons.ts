export type FileIconNameMap = Record<string, string>;

export interface FileIconServiceOptions {
  readonly iconDirectory?: string | null;
  readonly extensionMap?: Readonly<FileIconNameMap> | null;
  readonly filenameMap?: Readonly<FileIconNameMap> | null;
  readonly folderIconMap?: Readonly<FileIconNameMap> | null;
}

export interface FileIconLookupService {
  readonly getFileIcon: (fileName?: string | null) => string | null;
  readonly getFolderIcon: (folderName?: string | null) => string | null;
}

export interface FileIconService extends FileIconLookupService {
  readonly clearIconCache: () => void;
  readonly extensionMap: FileIconNameMap;
  readonly filenameMap: FileIconNameMap;
  readonly folderIconMap: FileIconNameMap;
}

export interface FileIconPluginView extends FileIconLookupService {}
