import type { I18nService } from './i18n';
import type { Disposable } from './lifecycle';

type RequiredLanguagePacksPanelI18n = Pick<
  I18nService,
  | 'listPacks'
  | 'getActive'
  | 'setLocale'
  | 'install'
  | 'remove'
  | 'openFolder'
  | 'refresh'
>;

export interface LanguagePacksPanelI18n extends RequiredLanguagePacksPanelI18n {
  readonly init?: I18nService['init'];
  readonly t?: I18nService['t'];
  readonly getErrors?: I18nService['getErrors'];
  readonly onChange?: I18nService['onChange'];
}

export interface LanguagePackPanelViewDto {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly name: string;
  readonly nativeName: string;
  readonly version: string;
  readonly builtIn: boolean;
  readonly removable: boolean;
}

export interface LanguagePacksPanelRenderOptions {
  readonly quiet?: boolean;
  readonly preserveStatus?: boolean;
}

export interface LanguagePacksPanelDependencies {
  readonly document: Document;
  readonly getI18n: () => LanguagePacksPanelI18n | null | undefined;
  readonly getTrashIcon: () => string | null | undefined;
  readonly confirm: (message: string) => boolean;
}

export interface LanguagePacksPanelFacade {
  init(): Promise<boolean>;
  render(options?: LanguagePacksPanelRenderOptions): Promise<readonly LanguagePackPanelViewDto[]>;
  refresh(): Promise<void>;
}

export interface LanguagePacksPanelService extends LanguagePacksPanelFacade, Disposable {
  readonly disposed: boolean;
}
