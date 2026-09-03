import type { Disposable } from './lifecycle';

export type CommandPaletteCommandHandler = () => unknown;

export interface CommandPaletteCommandDto {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly category: string;
}

export interface CommandPaletteRegistrationPort {
  readonly supportsDisposables: true;
  register(
    id: string,
    label: string,
    hint: string,
    category: string,
    handler: CommandPaletteCommandHandler
  ): Disposable | null | undefined;
  unregister?(id: string): unknown;
}

export interface CommandPaletteFacade extends CommandPaletteRegistrationPort {
  register(
    id: string,
    label: string,
    hint: string,
    category: string,
    handler: CommandPaletteCommandHandler
  ): Disposable;
  unregister(id: string): boolean;
  has(id: string): boolean;
  show(): void;
  hide(): void;
}

export interface CommandPaletteService extends CommandPaletteFacade, Disposable {
  readonly disposed: boolean;
}

export interface CommandPaletteI18n {
  t(source: string): string;
}

export interface CommandPaletteDependencies {
  readonly document: Document;
  readonly eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly getI18n: () => CommandPaletteI18n | null | undefined;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}
