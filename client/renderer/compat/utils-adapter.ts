import {
  detectLanguage,
  isImageFile,
  isWindowsLocalPath,
  langDisplayName,
  projectKey
} from '../../src/utils';
import type {
  LocalPathSeparatorDto,
  RendererUtilitiesFacade
} from '../../types/utils';

type LegacyBoboUtilities = {
  -readonly [Key in keyof RendererUtilitiesFacade]?: RendererUtilitiesFacade[Key];
};

const legacyWindow = window as Window & { BOBO?: LegacyBoboUtilities };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Keep these properties writable while legacy modules migrate to named imports.
BOBO.detectLanguage = detectLanguage;
BOBO.isImageFile = isImageFile;
BOBO.projectKey = projectKey;
BOBO.isWindowsLocalPath = isWindowsLocalPath;
BOBO.localPathSeparator = (value?: unknown): LocalPathSeparatorDto => (
  BOBO.isWindowsLocalPath!(value) ? '\\' : '/'
);
BOBO.langDisplayName = langDisplayName;
