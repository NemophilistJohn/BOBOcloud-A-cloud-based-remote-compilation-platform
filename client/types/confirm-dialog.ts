import type { Disposable } from './lifecycle';

export interface ConfirmOptions {
  readonly title?: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly checkboxLabel?: string;
  readonly checkboxChecked?: boolean;
  readonly returnDetails?: false;
}

export interface ConfirmDetailsOptions extends Omit<ConfirmOptions, 'returnDetails'> {
  readonly returnDetails: true;
}

export interface ConfirmDetailsResultDto {
  readonly confirmed: boolean;
  readonly checkboxChecked: boolean;
}

export interface ConfirmFacade {
  (options: ConfirmDetailsOptions): Promise<ConfirmDetailsResultDto>;
  (options?: ConfirmOptions): Promise<boolean>;
}

export interface ConfirmService extends Disposable {
  readonly disposed: boolean;
  readonly confirm: ConfirmFacade;
}

export interface ConfirmDependencies {
  readonly document: Document;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
}
