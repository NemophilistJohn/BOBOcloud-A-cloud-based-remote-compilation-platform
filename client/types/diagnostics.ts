import type { Disposable } from './lifecycle';

export type DiagnosticsCheckId =
  | 'missingSemicolon'
  | 'strayTokens'
  | 'unmatchedBrackets'
  | 'unclosedStrings'
  | 'assignmentInCondition'
  | 'unsafeFunctions'
  | 'trailingWhitespace'
  | 'mixedIndent'
  | 'longLines'
  | 'todoComments'
  | 'cppModernize'
  | 'styleHints';

export type DiagnosticsCheckOn = 'type' | 'save';
export type DiagnosticsSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagnosticsCheckSettings {
  readonly enabled: boolean;
  readonly severity: DiagnosticsSeverity;
  readonly maxLineLength?: number;
}

/** Closed renderer-domain settings after the wire DTO has been normalized. */
export interface DiagnosticsSettings {
  readonly enabled: boolean;
  readonly checkOn: DiagnosticsCheckOn;
  readonly debounceMs: number;
  readonly checks: Readonly<Record<DiagnosticsCheckId, DiagnosticsCheckSettings>>;
}

/** Values guaranteed by the current main-process persistence boundary. */
export interface DiagnosticsCheckDto {
  readonly enabled: boolean;
  readonly severity: string;
  readonly maxLineLength?: number;
}

export interface DiagnosticsSettingsDto {
  readonly enabled: boolean;
  readonly checkOn: string;
  readonly debounceMs: number;
  readonly checks: Readonly<Record<DiagnosticsCheckId, DiagnosticsCheckDto>>;
}

export interface DiagnosticsCheckWriteDto {
  readonly enabled?: boolean;
  readonly severity?: string;
  readonly maxLineLength?: number;
}

/** Existing callers may persist only the settings they currently expose. */
export interface DiagnosticsSettingsWriteDto {
  readonly enabled?: boolean;
  readonly checkOn?: string;
  readonly debounceMs?: number;
  readonly checks?: Readonly<Partial<Record<DiagnosticsCheckId, DiagnosticsCheckWriteDto>>>;
}

export interface DiagnosticsBasicSettingsUpdateDto {
  readonly enabled?: boolean;
  readonly checkOn?: DiagnosticsCheckOn;
}

export type DiagnosticsOpenListener = () => void;

export interface DiagnosticsHost {
  readSettings(): Promise<DiagnosticsSettingsDto>;
  writeSettings(settings: DiagnosticsSettingsWriteDto): Promise<boolean>;
  onOpen(listener: DiagnosticsOpenListener): Disposable;
}

export interface DiagnosticsSettingsService extends Disposable {
  init(): void;
  open(): void;
  close(): void;
  load(): Promise<boolean>;
  persist(settings: DiagnosticsSettingsWriteDto): Promise<boolean>;
  updateBasic(update: DiagnosticsBasicSettingsUpdateDto): Promise<boolean>;
}
