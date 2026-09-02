import type { Disposable, Dispose } from './lifecycle';
import type {
  SourceControlCommandPayloadDto,
  SourceControlStateStoreContract
} from './source-control';

export interface SourceControlViewI18n {
  t(key: string, values?: Readonly<Record<string, string | number>>): string;
  onChange?(listener: () => void): Dispose | void;
}

export interface SourceControlViewWorkbench {
  registerPrimaryView(view: string): Disposable;
  setPrimaryVisible(visible: boolean): void;
  setPrimaryView(view: string): void;
}

export type SourceControlViewCommandResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface SourceControlViewCommandPort {
  executeDynamicIsolated(
    id: string,
    payload: SourceControlCommandPayloadDto
  ): Promise<SourceControlViewCommandResult>;
}

export interface SourceControlViewDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly i18n: SourceControlViewI18n;
  readonly workbench: SourceControlViewWorkbench;
  readonly sourceControls: SourceControlStateStoreContract;
  readonly commands: SourceControlViewCommandPort;
}

export interface SourceControlViewService extends Disposable {
  init(): void;
  refresh(): void;
}
