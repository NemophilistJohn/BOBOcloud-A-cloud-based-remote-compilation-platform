import type { Disposable } from './lifecycle';

export type FileDecorationLaneDto = 'sync' | 'scm' | 'diagnostic';
export type FileDecorationPointId = `fileDecorations.${FileDecorationLaneDto}`;
export type FileDecorationLaneForPoint<Point extends FileDecorationPointId> =
  Point extends `fileDecorations.${infer Lane extends FileDecorationLaneDto}` ? Lane : never;
export type FileDecorationColorDto = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface FileDecorationRegistrationDto {
  readonly status: string;
  readonly badge: string;
  readonly color?: FileDecorationColorDto;
  readonly tooltip?: string;
  readonly ariaLabel?: string;
  readonly transient?: boolean;
  readonly [key: string]: unknown;
}

export interface FileDecorationDto {
  readonly status: string;
  readonly badge: string;
  readonly color: FileDecorationColorDto | '';
  readonly tooltip: string;
  readonly ariaLabel: string;
  readonly transient: boolean;
}

export type FileDecorationProviderResult =
  FileDecorationRegistrationDto | null | false | undefined;

export type FileDecorationProviderChangeListener = (
  paths?: readonly string[]
) => void;

export interface FileDecorationProvider<
  Lane extends FileDecorationLaneDto = FileDecorationLaneDto
> {
  readonly id?: string;
  readonly namespace: string;
  readonly lane: Lane;
  readonly priority?: number;
  readonly getDecoration: (
    resourcePath: string,
    node: unknown
  ) => FileDecorationProviderResult;
  readonly onDidChange?: (
    listener: FileDecorationProviderChangeListener
  ) => Disposable | null | void;
}

/** @deprecated Use FileDecorationProvider; retained while callers migrate. */
export type FileDecorationProviderDto<
  Lane extends FileDecorationLaneDto = FileDecorationLaneDto
> = FileDecorationProvider<Lane>;

export type FileDecorationChangeEvent =
  | {
      readonly lane: FileDecorationLaneDto;
      readonly reason: 'provider';
      readonly providerId: string;
      readonly paths: readonly string[] | undefined;
    }
  | {
      readonly lane: FileDecorationLaneDto;
      readonly reason: 'registry';
      readonly providerId: string;
      readonly paths: undefined;
    }
  | {
      readonly lane: FileDecorationLaneDto;
      readonly reason: 'language';
    };

export type FileDecorationChangeListener = (
  event: FileDecorationChangeEvent
) => void;

export interface FileDecorationService extends Disposable {
  readonly get: (
    lane: FileDecorationLaneDto,
    resourcePath: string,
    node: unknown
  ) => FileDecorationDto | null;
  readonly onDidChange: (
    listener: FileDecorationChangeListener
  ) => Disposable;
  readonly dispose: () => void;
}
