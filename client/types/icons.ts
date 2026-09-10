export const ICON_NAMES = [
  'plus', 'close', 'check', 'trash', 'send', 'copy', 'play', 'stop',
  'settings', 'search', 'moreVertical', 'eye', 'eyeOff', 'chevronDown',
  'chevronRight', 'history', 'clock', 'cloud', 'folder', 'file', 'fileText',
  'package', 'user', 'lock', 'mail', 'key', 'logout', 'shield', 'folderOpen'
] as const;

export type IconName = typeof ICON_NAMES[number];

/** The writable shape retained for legacy BOBO consumers. */
export type RendererIconsFacade = {
  -readonly [Name in IconName]: string;
};

export type RendererIconsSnapshot = Readonly<RendererIconsFacade>;
