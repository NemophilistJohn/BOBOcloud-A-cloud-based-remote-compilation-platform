import type { Disposable } from './lifecycle';

export type SourceControlIconDto = 'git-branch';

export type SourceControlPhaseDto =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error';

export type SourceControlActionKindDto = 'primary' | 'secondary' | 'danger';
export type SourceControlActionPlacementDto = 'button' | 'toolbar' | 'menu';
export type SourceControlActionIconDto =
  | 'refresh'
  | 'commit'
  | 'pull'
  | 'push'
  | 'branch'
  | 'publish'
  | 'remote'
  | 'stage-all'
  | 'visibility';

export type SourceControlFormFieldTypeDto =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox';

export interface SourceControlDescriptorRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly icon?: SourceControlIconDto;
  readonly order?: number;
  readonly openCommand?: string | null;
}

export interface SourceControlDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly icon: SourceControlIconDto;
  readonly order: number;
  readonly openCommand: string | null;
}

export interface SourceControlSummaryItemRegistrationDto {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
}

export interface SourceControlSummaryItemDto {
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
}

export interface SourceControlSummaryRegistrationDto {
  readonly title?: string | null;
  readonly items?: readonly SourceControlSummaryItemRegistrationDto[];
}

export interface SourceControlSummaryDto {
  readonly title: string | null;
  readonly items: readonly SourceControlSummaryItemDto[];
}

export interface SourceControlSectionItemRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly meta?: string | null;
  readonly badge?: string | null;
  readonly command?: string | null;
  readonly disabled?: boolean;
}

export interface SourceControlSectionItemDto {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly meta: string | null;
  readonly badge: string | null;
  readonly command: string | null;
  readonly disabled: boolean;
}

export interface SourceControlLoadMoreRegistrationDto {
  readonly command: string;
  readonly label?: string | null;
  readonly disabled?: boolean;
}

export interface SourceControlLoadMoreDto {
  readonly command: string;
  readonly label: string | null;
  readonly disabled: boolean;
}

export interface SourceControlSectionRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly items?: readonly SourceControlSectionItemRegistrationDto[];
  readonly emptyMessage?: string | null;
  readonly collapsed?: boolean;
  readonly loadMore?: SourceControlLoadMoreRegistrationDto | null;
}

export interface SourceControlSectionDto {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly emptyMessage: string | null;
  readonly collapsed: boolean;
  readonly items: readonly SourceControlSectionItemDto[];
  readonly loadMore: SourceControlLoadMoreDto | null;
}

export interface SourceControlSelectOptionRegistrationDto {
  readonly value: string;
  readonly label: string;
}

export interface SourceControlSelectOptionDto {
  readonly value: string;
  readonly label: string;
}

interface SourceControlFormFieldRegistrationBaseDto {
  readonly id: string;
  readonly label: string;
  readonly description?: string | null;
  readonly placeholder?: string | null;
  readonly required?: boolean;
  readonly maxLength?: number;
}

export interface SourceControlTextFormFieldRegistrationDto
  extends SourceControlFormFieldRegistrationBaseDto {
  readonly type?: 'text';
  readonly value?: string;
  readonly options?: never;
}

export interface SourceControlTextareaFormFieldRegistrationDto
  extends SourceControlFormFieldRegistrationBaseDto {
  readonly type: 'textarea';
  readonly value?: string;
  readonly options?: never;
}

export interface SourceControlSelectFormFieldRegistrationDto
  extends SourceControlFormFieldRegistrationBaseDto {
  readonly type: 'select';
  readonly value?: string;
  readonly options: readonly SourceControlSelectOptionRegistrationDto[];
}

export interface SourceControlCheckboxFormFieldRegistrationDto
  extends SourceControlFormFieldRegistrationBaseDto {
  readonly type: 'checkbox';
  readonly value?: boolean;
  readonly options?: never;
}

export type SourceControlFormFieldRegistrationDto =
  | SourceControlTextFormFieldRegistrationDto
  | SourceControlTextareaFormFieldRegistrationDto
  | SourceControlSelectFormFieldRegistrationDto
  | SourceControlCheckboxFormFieldRegistrationDto;

interface SourceControlFormFieldBaseDto {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface SourceControlTextFormFieldDto extends SourceControlFormFieldBaseDto {
  readonly type: 'text';
  readonly value: string;
  readonly options: readonly [];
}

export interface SourceControlTextareaFormFieldDto extends SourceControlFormFieldBaseDto {
  readonly type: 'textarea';
  readonly value: string;
  readonly options: readonly [];
}

export interface SourceControlSelectFormFieldDto extends SourceControlFormFieldBaseDto {
  readonly type: 'select';
  readonly value: string;
  readonly options: readonly SourceControlSelectOptionDto[];
}

export interface SourceControlCheckboxFormFieldDto extends SourceControlFormFieldBaseDto {
  readonly type: 'checkbox';
  readonly value: boolean;
  readonly options: readonly [];
}

export type SourceControlFormFieldDto =
  | SourceControlTextFormFieldDto
  | SourceControlTextareaFormFieldDto
  | SourceControlSelectFormFieldDto
  | SourceControlCheckboxFormFieldDto;

export interface SourceControlFormRegistrationDto {
  readonly title?: string | null;
  readonly submitLabel?: string | null;
  readonly fields: readonly SourceControlFormFieldRegistrationDto[];
}

export interface SourceControlFormDto {
  readonly title: string | null;
  readonly submitLabel: string | null;
  readonly fields: readonly SourceControlFormFieldDto[];
}

interface SourceControlActionRegistrationBaseDto {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly command: string;
  readonly kind?: SourceControlActionKindDto;
  readonly disabled?: boolean;
  readonly form?: SourceControlFormRegistrationDto | null;
}

export interface SourceControlButtonActionRegistrationDto
  extends SourceControlActionRegistrationBaseDto {
  readonly placement?: 'button';
  readonly icon?: SourceControlActionIconDto;
}

export interface SourceControlToolbarActionRegistrationDto
  extends SourceControlActionRegistrationBaseDto {
  readonly placement: 'toolbar';
  readonly icon: SourceControlActionIconDto;
}

export interface SourceControlMenuActionRegistrationDto
  extends SourceControlActionRegistrationBaseDto {
  readonly placement: 'menu';
  readonly icon?: SourceControlActionIconDto;
}

export type SourceControlActionRegistrationDto =
  | SourceControlButtonActionRegistrationDto
  | SourceControlToolbarActionRegistrationDto
  | SourceControlMenuActionRegistrationDto;

interface SourceControlActionBaseDto {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly command: string;
  readonly kind: SourceControlActionKindDto;
  readonly disabled: boolean;
  readonly form: SourceControlFormDto | null;
}

export interface SourceControlButtonActionDto extends SourceControlActionBaseDto {
  readonly placement: 'button';
  readonly icon: SourceControlActionIconDto | undefined;
}

export interface SourceControlToolbarActionDto extends SourceControlActionBaseDto {
  readonly placement: 'toolbar';
  readonly icon: SourceControlActionIconDto;
}

export interface SourceControlMenuActionDto extends SourceControlActionBaseDto {
  readonly placement: 'menu';
  readonly icon: SourceControlActionIconDto | undefined;
}

export type SourceControlActionDto =
  | SourceControlButtonActionDto
  | SourceControlToolbarActionDto
  | SourceControlMenuActionDto;

export interface SourceControlStateRegistrationDto {
  readonly phase?: SourceControlPhaseDto;
  readonly title?: string | null;
  readonly message?: string | null;
  readonly summary?: SourceControlSummaryRegistrationDto | null;
  readonly sections?: readonly SourceControlSectionRegistrationDto[];
  readonly actions?: readonly SourceControlActionRegistrationDto[];
}

export interface SourceControlStateDto {
  readonly phase: SourceControlPhaseDto;
  readonly title: string | null;
  readonly message: string | null;
  readonly summary: SourceControlSummaryDto | null;
  readonly sections: readonly SourceControlSectionDto[];
  readonly actions: readonly SourceControlActionDto[];
}

export interface SourceControlVersionDto {
  readonly version: number;
}

interface SourceControlSnapshotBase {
  readonly id: string;
  readonly owner: string;
  readonly descriptor: SourceControlDescriptorDto;
  readonly version: number;
}

export interface SourceControlSnapshot extends SourceControlSnapshotBase {
  readonly state: SourceControlStateDto | null;
}

interface SourceControlChangeEventBase extends SourceControlSnapshotBase {
  readonly type: SourceControlChangeType;
}

export type SourceControlChangeType = 'added' | 'state' | 'cleared' | 'removed';

export interface SourceControlAddedEvent extends SourceControlChangeEventBase {
  readonly type: 'added';
  readonly state: null;
}

export interface SourceControlStateChangedEvent extends SourceControlChangeEventBase {
  readonly type: 'state';
  readonly state: SourceControlStateDto;
}

export interface SourceControlClearedEvent extends SourceControlChangeEventBase {
  readonly type: 'cleared';
  readonly state: null;
}

export interface SourceControlRemovedEvent extends SourceControlChangeEventBase {
  readonly type: 'removed';
  readonly state: SourceControlStateDto | null;
}

export type SourceControlChangeEvent =
  | SourceControlAddedEvent
  | SourceControlStateChangedEvent
  | SourceControlClearedEvent
  | SourceControlRemovedEvent;

export type SourceControlChangeListener = (event: SourceControlChangeEvent) => void;

export interface SourceControlStateHandle extends Disposable {
  readonly id: string;
  setState(state: SourceControlStateRegistrationDto): SourceControlVersionDto;
  clearState(): SourceControlVersionDto;
}

export interface SourceControlRegistrationOptions {
  readonly owner?: string;
  readonly commandPrefix?: string;
}

export interface SourceControlStateStoreErrorEvent {
  readonly source: 'source-control-listener';
  readonly id: string;
  readonly owner: string;
  readonly error: unknown;
}

export interface SourceControlStateStoreOptions {
  readonly onError?: (event: SourceControlStateStoreErrorEvent) => void;
}

export interface SourceControlStateStoreContract extends Disposable {
  register(
    descriptor: SourceControlDescriptorRegistrationDto,
    options?: SourceControlRegistrationOptions
  ): SourceControlStateHandle;
  list(): readonly SourceControlSnapshot[];
  get(id: string): SourceControlSnapshot | null;
  onDidChange(listener: SourceControlChangeListener): Disposable;
  disposeOwner(owner: string): void;
}

export type SourceControlRawFormValues = Readonly<Record<string, unknown>>;
export type SourceControlFormValues = Readonly<Record<string, string | boolean>>;

export interface SourceControlCommandDetailsDto {
  readonly sectionId?: string;
  readonly itemId?: string;
  readonly kind?: string;
}

export interface SourceControlCommandPayloadDto {
  readonly sourceControlId: string;
  readonly actionId: string;
  readonly values: SourceControlFormValues;
  readonly sectionId?: string;
  readonly itemId?: string;
  readonly kind?: string;
}
