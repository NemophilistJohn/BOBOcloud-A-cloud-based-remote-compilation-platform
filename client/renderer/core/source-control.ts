import { toDisposable } from './disposable.js';
import type {
  SourceControlActionDto,
  SourceControlActionIconDto,
  SourceControlActionKindDto,
  SourceControlActionPlacementDto,
  SourceControlChangeEvent,
  SourceControlChangeListener,
  SourceControlChangeType,
  SourceControlCommandDetailsDto,
  SourceControlCommandPayloadDto,
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto,
  SourceControlFormDto,
  SourceControlFormFieldDto,
  SourceControlFormFieldTypeDto,
  SourceControlFormValues,
  SourceControlIconDto,
  SourceControlLoadMoreDto,
  SourceControlPhaseDto,
  SourceControlRawFormValues,
  SourceControlRegistrationOptions,
  SourceControlSectionDto,
  SourceControlSectionItemDto,
  SourceControlSelectOptionDto,
  SourceControlSnapshot,
  SourceControlStateDto,
  SourceControlStateHandle,
  SourceControlStateRegistrationDto,
  SourceControlStateStoreContract,
  SourceControlStateStoreErrorEvent,
  SourceControlStateStoreOptions,
  SourceControlSummaryDto,
  SourceControlSummaryItemDto,
  SourceControlVersionDto
} from '../../types/source-control';

const MAX_ID_LENGTH = 180;
const MAX_TITLE_LENGTH = 96;
const MAX_COMMAND_LENGTH = 180;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_SECTION_COUNT = 8;
const MAX_SUMMARY_ITEMS = 12;
const MAX_SECTION_ITEMS = 160;
const MAX_ACTIONS = 16;
const MAX_FORM_FIELDS = 12;
const MAX_SELECT_OPTIONS = 80;

// Source-control providers describe a trusted host-rendered activity-bar view.
// They never supply HTML, styles, a renderer callback, URL, path, or workbench
// object. The host owns all DOM creation and command dispatch.
export const SourceControlIcon = Object.freeze({
  GIT_BRANCH: 'git-branch'
} as const);

export const SourceControlPhase = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error'
} as const);

export const SourceControlActionKind = Object.freeze({
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  DANGER: 'danger'
} as const);

// The extension supplies only a semantic icon token and layout intent. The
// trusted workbench owns the SVG, keyboard behavior, menus, and form DOM.
export const SourceControlActionPlacement = Object.freeze({
  BUTTON: 'button',
  TOOLBAR: 'toolbar',
  MENU: 'menu'
} as const);

export const SourceControlActionIcon = Object.freeze({
  REFRESH: 'refresh',
  COMMIT: 'commit',
  PULL: 'pull',
  PUSH: 'push',
  BRANCH: 'branch',
  PUBLISH: 'publish',
  REMOTE: 'remote',
  STAGE_ALL: 'stage-all',
  VISIBILITY: 'visibility'
} as const);

export const SourceControlFormFieldType = Object.freeze({
  TEXT: 'text',
  TEXTAREA: 'textarea',
  SELECT: 'select',
  CHECKBOX: 'checkbox'
} as const);

const KNOWN_SOURCE_CONTROL_ICONS: ReadonlySet<string> = new Set(Object.values(SourceControlIcon));
const KNOWN_PHASES: ReadonlySet<string> = new Set(Object.values(SourceControlPhase));
const KNOWN_ACTION_KINDS: ReadonlySet<string> = new Set(Object.values(SourceControlActionKind));
const KNOWN_ACTION_PLACEMENTS: ReadonlySet<string> = new Set(Object.values(SourceControlActionPlacement));
const KNOWN_ACTION_ICONS: ReadonlySet<string> = new Set(Object.values(SourceControlActionIcon));
const KNOWN_FORM_FIELD_TYPES: ReadonlySet<string> = new Set(Object.values(SourceControlFormFieldType));
const ALLOWED_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'icon', 'order', 'openCommand']);
const ALLOWED_STATE_FIELDS: ReadonlySet<string> = new Set(['phase', 'title', 'message', 'summary', 'sections', 'actions']);
const ALLOWED_SUMMARY_FIELDS: ReadonlySet<string> = new Set(['title', 'items']);
const ALLOWED_SUMMARY_ITEM_FIELDS: ReadonlySet<string> = new Set(['label', 'value', 'detail']);
const ALLOWED_SECTION_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'description', 'items', 'emptyMessage', 'collapsed', 'loadMore']);
const ALLOWED_SECTION_ITEM_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'description', 'meta', 'badge', 'command', 'disabled']);
const ALLOWED_LOAD_MORE_FIELDS: ReadonlySet<string> = new Set(['command', 'label', 'disabled']);
const ALLOWED_ACTION_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'description', 'command', 'kind', 'disabled', 'form', 'placement', 'icon']);
const ALLOWED_FORM_FIELDS: ReadonlySet<string> = new Set(['title', 'submitLabel', 'fields']);
const ALLOWED_FORM_FIELD_FIELDS: ReadonlySet<string> = new Set(['id', 'label', 'type', 'description', 'placeholder', 'required', 'value', 'maxLength', 'options']);
const ALLOWED_SELECT_OPTION_FIELDS: ReadonlySet<string> = new Set(['value', 'label']);
const ALLOWED_COMMAND_DETAIL_FIELDS: ReadonlySet<string> = new Set(['sectionId', 'itemId', 'kind']);

type PlainObject = Record<string, unknown>;

interface SourceControlRecord {
  readonly id: string;
  readonly owner: string;
  readonly descriptor: SourceControlDescriptorDto;
  readonly commandPrefix: string;
  state: SourceControlStateDto | null;
  version: number;
}

interface MutableSourceControlCommandPayload {
  sourceControlId: string;
  actionId: string;
  values: SourceControlFormValues;
  sectionId?: string;
  itemId?: string;
  kind?: string;
}

function isPlainObject(value: unknown): value is PlainObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): asserts value is PlainObject {
  if (!isPlainObject(value)) throw new TypeError(label + ' must be a plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(label + ' includes an unsupported field: ' + key);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(label + ' cannot contain accessors.');
    }
  }
}

function requireNonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string.');
  const result = value.trim();
  if (!result) throw new TypeError(label + ' must not be empty.');
  if (result.length > maxLength) throw new TypeError(label + ' exceeds the maximum length.');
  return result;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, label, maxLength);
}

function requireNamespacedId(value: unknown, label: string): string {
  const id = requireNonEmptyString(value, label, MAX_ID_LENGTH);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw new TypeError(label + ' must be a namespaced id.');
  }
  return id;
}

function requireScopedId(value: unknown, label: string, maxLength = 96): string {
  const id = requireNonEmptyString(value, label, maxLength);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) {
    throw new TypeError(label + ' contains unsupported characters.');
  }
  return id;
}

function requireCommandId(value: unknown, label: string, commandPrefix = ''): string {
  const id = requireNonEmptyString(value, label, MAX_COMMAND_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new TypeError(label + ' contains unsupported characters.');
  }
  if (commandPrefix && !id.startsWith(commandPrefix)) {
    throw new TypeError(label + ' must use the owning extension namespace.');
  }
  return id;
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as PlainObject)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeSummaryItem(value: unknown): SourceControlSummaryItemDto {
  assertAllowedFields(value, ALLOWED_SUMMARY_ITEM_FIELDS, 'Source-control summary item');
  return Object.freeze({
    label: requireNonEmptyString(value.label, 'Source-control summary item label', 128),
    value: requireNonEmptyString(value.value, 'Source-control summary item value', 256),
    detail: optionalString(value.detail, 'Source-control summary item detail', 512)
  });
}

function normalizeSummary(value: unknown): SourceControlSummaryDto | null {
  if (value === undefined || value === null) return null;
  assertAllowedFields(value, ALLOWED_SUMMARY_FIELDS, 'Source-control summary');
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items) || items.length > MAX_SUMMARY_ITEMS) {
    throw new TypeError('Source-control summary items must be a bounded array.');
  }
  return deepFreeze({
    title: optionalString(value.title, 'Source-control summary title', 128),
    items: items.map((item) => normalizeSummaryItem(item))
  });
}

function normalizeSectionItem(value: unknown, commandPrefix: string): SourceControlSectionItemDto {
  assertAllowedFields(value, ALLOWED_SECTION_ITEM_FIELDS, 'Source-control section item');
  const command = value.command === undefined || value.command === null
    ? null
    : requireCommandId(value.command, 'Source-control section item command', commandPrefix);
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    throw new TypeError('Source-control section item disabled must be a boolean.');
  }
  return Object.freeze({
    id: requireScopedId(value.id, 'Source-control section item id'),
    title: requireNonEmptyString(value.title, 'Source-control section item title', 256),
    description: optionalString(value.description, 'Source-control section item description', 512),
    meta: optionalString(value.meta, 'Source-control section item metadata', 160),
    badge: optionalString(value.badge, 'Source-control section item badge', 32),
    command,
    disabled: value.disabled === true
  });
}

function normalizeLoadMore(value: unknown, commandPrefix: string): SourceControlLoadMoreDto | null {
  if (value === undefined || value === null) return null;
  assertAllowedFields(value, ALLOWED_LOAD_MORE_FIELDS, 'Source-control load-more action');
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    throw new TypeError('Source-control load-more disabled must be a boolean.');
  }
  return Object.freeze({
    command: requireCommandId(value.command, 'Source-control load-more command', commandPrefix),
    label: optionalString(value.label, 'Source-control load-more label', 96),
    disabled: value.disabled === true
  });
}

function normalizeSection(value: unknown, commandPrefix: string): SourceControlSectionDto {
  assertAllowedFields(value, ALLOWED_SECTION_FIELDS, 'Source-control section');
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items) || items.length > MAX_SECTION_ITEMS) {
    throw new TypeError('Source-control section items must be a bounded array.');
  }
  if (value.collapsed !== undefined && typeof value.collapsed !== 'boolean') {
    throw new TypeError('Source-control section collapsed must be a boolean.');
  }
  return deepFreeze({
    id: requireScopedId(value.id, 'Source-control section id'),
    title: requireNonEmptyString(value.title, 'Source-control section title', 128),
    description: optionalString(value.description, 'Source-control section description', 512),
    emptyMessage: optionalString(value.emptyMessage, 'Source-control section empty message', 512),
    collapsed: value.collapsed === true,
    items: items.map((item) => normalizeSectionItem(item, commandPrefix)),
    loadMore: normalizeLoadMore(value.loadMore, commandPrefix)
  });
}

function normalizeSelectOption(value: unknown): SourceControlSelectOptionDto {
  assertAllowedFields(value, ALLOWED_SELECT_OPTION_FIELDS, 'Source-control select option');
  return Object.freeze({
    value: requireNonEmptyString(value.value, 'Source-control select option value', 160),
    label: requireNonEmptyString(value.label, 'Source-control select option label', 160)
  });
}

function normalizeFormField(value: unknown): SourceControlFormFieldDto {
  assertAllowedFields(value, ALLOWED_FORM_FIELD_FIELDS, 'Source-control form field');
  const rawType = value.type === undefined ? SourceControlFormFieldType.TEXT : value.type;
  if (typeof rawType !== 'string' || !KNOWN_FORM_FIELD_TYPES.has(rawType)) {
    throw new TypeError('Source-control form field type is not supported.');
  }
  const type = rawType as SourceControlFormFieldTypeDto;
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new TypeError('Source-control form field required must be a boolean.');
  }
  const defaultLimit = type === SourceControlFormFieldType.TEXTAREA ? 4096 : 512;
  const rawMaxLength = value.maxLength === undefined ? defaultLimit : value.maxLength;
  if (typeof rawMaxLength !== 'number' || !Number.isInteger(rawMaxLength) || rawMaxLength < 1 || rawMaxLength > 4096) {
    throw new TypeError('Source-control form field maxLength must be an integer from 1 through 4096.');
  }
  const maxLength = rawMaxLength;
  let options: SourceControlSelectOptionDto[] = [];
  if (type === SourceControlFormFieldType.SELECT) {
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_SELECT_OPTIONS) {
      throw new TypeError('Source-control select fields require a bounded option list.');
    }
    options = value.options.map((option) => normalizeSelectOption(option));
    if (new Set(options.map((option) => option.value)).size !== options.length) {
      throw new TypeError('Source-control select option values must be unique.');
    }
  } else if (value.options !== undefined) {
    throw new TypeError('Only source-control select fields can include options.');
  }
  let defaultValue: string | boolean;
  if (type === SourceControlFormFieldType.CHECKBOX) {
    if (value.value !== undefined && typeof value.value !== 'boolean') {
      throw new TypeError('Source-control checkbox default value must be a boolean.');
    }
    defaultValue = value.value === true;
  } else {
    if (value.value !== undefined && typeof value.value !== 'string') {
      throw new TypeError('Source-control form field default value must be a string.');
    }
    defaultValue = value.value === undefined ? '' : value.value;
    if (defaultValue.length > maxLength) throw new TypeError('Source-control form field default value exceeds maxLength.');
    if (type === SourceControlFormFieldType.SELECT && !options.some((option) => option.value === defaultValue)) {
      defaultValue = options[0]!.value;
    }
  }
  const id = requireScopedId(value.id, 'Source-control form field id', 64);
  const label = requireNonEmptyString(value.label, 'Source-control form field label', 128);
  const description = optionalString(value.description, 'Source-control form field description', 512);
  const placeholder = optionalString(value.placeholder, 'Source-control form field placeholder', 160);
  const required = value.required === true;
  if (type === SourceControlFormFieldType.CHECKBOX) {
    return deepFreeze({
      id, label, type, description, placeholder, required,
      value: defaultValue as boolean,
      maxLength,
      options: [] as const
    });
  }
  if (type === SourceControlFormFieldType.SELECT) {
    return deepFreeze({
      id, label, type, description, placeholder, required,
      value: defaultValue as string,
      maxLength,
      options
    });
  }
  if (type === SourceControlFormFieldType.TEXTAREA) {
    return deepFreeze({
      id, label, type, description, placeholder, required,
      value: defaultValue as string,
      maxLength,
      options: [] as const
    });
  }
  return deepFreeze({
    id,
    label,
    type: SourceControlFormFieldType.TEXT,
    description,
    placeholder,
    required,
    value: defaultValue as string,
    maxLength,
    options: [] as const
  });
}

function normalizeForm(value: unknown): SourceControlFormDto | null {
  if (value === undefined || value === null) return null;
  assertAllowedFields(value, ALLOWED_FORM_FIELDS, 'Source-control action form');
  if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > MAX_FORM_FIELDS) {
    throw new TypeError('Source-control action form fields must be a bounded non-empty array.');
  }
  const fields = value.fields.map((field) => normalizeFormField(field));
  if (new Set(fields.map((field) => field.id)).size !== fields.length) {
    throw new TypeError('Source-control action form field ids must be unique.');
  }
  return deepFreeze({
    title: optionalString(value.title, 'Source-control action form title', 128),
    submitLabel: optionalString(value.submitLabel, 'Source-control action form submit label', 96),
    fields
  });
}

function normalizeAction(value: unknown, commandPrefix: string): SourceControlActionDto {
  assertAllowedFields(value, ALLOWED_ACTION_FIELDS, 'Source-control action');
  const rawKind = value.kind === undefined ? SourceControlActionKind.SECONDARY : value.kind;
  if (typeof rawKind !== 'string' || !KNOWN_ACTION_KINDS.has(rawKind)) {
    throw new TypeError('Source-control action kind is not supported.');
  }
  const kind = rawKind as SourceControlActionKindDto;
  const rawPlacement = value.placement === undefined ? SourceControlActionPlacement.BUTTON : value.placement;
  if (typeof rawPlacement !== 'string' || !KNOWN_ACTION_PLACEMENTS.has(rawPlacement)) {
    throw new TypeError('Source-control action placement is not supported.');
  }
  const placement = rawPlacement as SourceControlActionPlacementDto;
  if (value.icon !== undefined && (typeof value.icon !== 'string' || !KNOWN_ACTION_ICONS.has(value.icon))) {
    throw new TypeError('Source-control action icon is not supported.');
  }
  if (placement === SourceControlActionPlacement.TOOLBAR && value.icon === undefined) {
    throw new TypeError('Source-control toolbar actions require a supported icon.');
  }
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    throw new TypeError('Source-control action disabled must be a boolean.');
  }
  const id = requireScopedId(value.id, 'Source-control action id');
  const title = requireNonEmptyString(value.title, 'Source-control action title', 128);
  const description = optionalString(value.description, 'Source-control action description', 512);
  const command = requireCommandId(value.command, 'Source-control action command', commandPrefix);
  const icon = value.icon as SourceControlActionIconDto | undefined;
  const disabled = value.disabled === true;
  const form = normalizeForm(value.form);
  if (placement === SourceControlActionPlacement.TOOLBAR) {
    return deepFreeze({
      id, title, description, command, kind, placement,
      icon: icon as SourceControlActionIconDto,
      disabled,
      form
    });
  }
  if (placement === SourceControlActionPlacement.MENU) {
    return deepFreeze({
      id, title, description, command, kind, placement, icon, disabled, form
    });
  }
  return deepFreeze({
    id,
    title,
    description,
    command,
    kind,
    placement: SourceControlActionPlacement.BUTTON,
    icon,
    disabled,
    form
  });
}

/**
 * Validates the static data-only descriptor consumed by the trusted source
 * control sidebar. Dynamic state is kept in a separate lifecycle-owned store.
 */
export function validateSourceControlDescriptor(value: unknown): SourceControlDescriptorDto {
  assertAllowedFields(value, ALLOWED_DESCRIPTOR_FIELDS, 'Source-control descriptor');
  const id = requireNamespacedId(value.id, 'Source-control descriptor id');
  const title = requireNonEmptyString(value.title, 'Source-control descriptor title', MAX_TITLE_LENGTH);
  const icon = value.icon === undefined
    ? SourceControlIcon.GIT_BRANCH
    : requireNonEmptyString(value.icon, 'Source-control descriptor icon', 48);
  if (!KNOWN_SOURCE_CONTROL_ICONS.has(icon)) {
    throw new TypeError('Source-control descriptor icon is not supported by the host.');
  }
  const rawOrder = value.order === undefined ? 0 : value.order;
  if (typeof rawOrder !== 'number' || !Number.isInteger(rawOrder) || rawOrder < -1000 || rawOrder > 1000) {
    throw new TypeError('Source-control descriptor order must be an integer from -1000 to 1000.');
  }
  const order = rawOrder;
  const openCommand = value.openCommand === undefined || value.openCommand === null
    ? null
    : requireCommandId(value.openCommand, 'Source-control descriptor open command');

  return Object.freeze({
    id,
    title,
    icon: icon as SourceControlIconDto,
    order,
    openCommand
  });
}

/**
 * Validates the bounded state rendered by the host. Strings have already been
 * localized by the plugin through context.i18n; they are always inserted as
 * text nodes, never interpreted as markup.
 */
export function validateSourceControlState(
  value: unknown,
  options: { readonly commandPrefix?: string } = {}
): SourceControlStateDto {
  assertAllowedFields(value, ALLOWED_STATE_FIELDS, 'Source-control state');
  const rawPhase = value.phase === undefined ? SourceControlPhase.READY : value.phase;
  if (typeof rawPhase !== 'string' || !KNOWN_PHASES.has(rawPhase)) {
    throw new TypeError('Source-control state phase is not supported.');
  }
  const phase = rawPhase as SourceControlPhaseDto;
  const commandPrefix = typeof options.commandPrefix === 'string' ? options.commandPrefix : '';
  const sections = value.sections === undefined ? [] : value.sections;
  const actions = value.actions === undefined ? [] : value.actions;
  if (!Array.isArray(sections) || sections.length > MAX_SECTION_COUNT) {
    throw new TypeError('Source-control state sections must be a bounded array.');
  }
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) {
    throw new TypeError('Source-control state actions must be a bounded array.');
  }
  const normalizedSections = sections.map((section) => normalizeSection(section, commandPrefix));
  const normalizedActions = actions.map((action) => normalizeAction(action, commandPrefix));
  if (new Set(normalizedSections.map((section) => section.id)).size !== normalizedSections.length) {
    throw new TypeError('Source-control state section ids must be unique.');
  }
  if (new Set(normalizedActions.map((action) => action.id)).size !== normalizedActions.length) {
    throw new TypeError('Source-control state action ids must be unique.');
  }
  return deepFreeze({
    phase,
    title: optionalString(value.title, 'Source-control state title', MAX_TITLE_LENGTH),
    message: optionalString(value.message, 'Source-control state message', MAX_MESSAGE_LENGTH),
    summary: normalizeSummary(value.summary),
    sections: normalizedSections,
    actions: normalizedActions
  });
}

/**
 * Re-validates form values collected by a trusted host UI before they are sent
 * to a plugin command. Unknown fields are ignored and values remain bounded.
 */
export function normalizeSourceControlFormValues(
  form: SourceControlFormDto | null,
  rawValues: SourceControlRawFormValues
): SourceControlFormValues {
  if (!form) return Object.freeze({});
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    throw new TypeError('Source-control form values must be a plain object.');
  }
  const values: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  for (const field of form.fields) {
    const raw = rawValues[field.id];
    if (field.type === SourceControlFormFieldType.CHECKBOX) {
      values[field.id] = raw === true;
      continue;
    }
    const text = raw === undefined || raw === null ? '' : String(raw);
    if (text.length > field.maxLength) throw new TypeError('Source-control form value exceeds its maximum length.');
    if (field.required && !text.trim()) throw new TypeError('A required source-control form value is missing.');
    if (field.type === SourceControlFormFieldType.SELECT && !field.options.some((option) => option.value === text)) {
      throw new TypeError('Source-control select value is invalid.');
    }
    values[field.id] = text;
  }
  return deepFreeze(values);
}

function normalizeSourceControlCommandValues(value: unknown): SourceControlFormValues {
  if (value === undefined || value === null || typeof value !== 'object') {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    throw new TypeError('Source-control command values must be a plain object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > MAX_FORM_FIELDS) {
    throw new TypeError('Source-control command values must be a bounded object.');
  }
  const normalized: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('Source-control command values cannot contain accessors.');
    }
    const fieldId = requireScopedId(key, 'Source-control command value id', 64);
    const fieldValue = descriptor.value;
    if (typeof fieldValue !== 'string' && typeof fieldValue !== 'boolean') {
      throw new TypeError('Source-control command values must contain only strings and booleans.');
    }
    if (typeof fieldValue === 'string' && fieldValue.length > 4096) {
      throw new TypeError('Source-control command value exceeds the maximum length.');
    }
    normalized[fieldId] = fieldValue;
  }
  return deepFreeze(normalized);
}

export function createSourceControlCommandPayload(
  descriptorId: string,
  actionId: string,
  values: SourceControlFormValues | null | undefined,
  details?: SourceControlCommandDetailsDto
): SourceControlCommandPayloadDto;
export function createSourceControlCommandPayload(
  descriptorId: string,
  actionId: string,
  values: unknown,
  details: unknown = {}
): SourceControlCommandPayloadDto {
  const sourceControlId = requireNamespacedId(descriptorId, 'Source-control descriptor id');
  const normalizedAction = requireScopedId(actionId, 'Source-control action id');
  assertAllowedFields(details, ALLOWED_COMMAND_DETAIL_FIELDS, 'Source-control command details');
  const payload: MutableSourceControlCommandPayload = {
    sourceControlId,
    actionId: normalizedAction,
    values: normalizeSourceControlCommandValues(values)
  };
  if (details.sectionId !== undefined) payload.sectionId = requireScopedId(details.sectionId, 'Source-control section id');
  if (details.itemId !== undefined) payload.itemId = requireScopedId(details.itemId, 'Source-control section item id');
  if (details.kind !== undefined) payload.kind = requireScopedId(details.kind, 'Source-control action kind', 32);
  return deepFreeze(payload);
}

/**
 * Holds mutable source-control state on the trusted renderer side. The plugin
 * owns only its returned state handle; disabling or uninstalling destroys the
 * record and removes the activity view without leaving stale DOM behind.
 */
export class SourceControlStateStore implements SourceControlStateStoreContract {
  private readonly _records = new Map<string, SourceControlRecord>();
  private readonly _listeners = new Set<SourceControlChangeListener>();
  private readonly _onError: (event: SourceControlStateStoreErrorEvent) => void;
  private _orderedRecords: SourceControlRecord[] | null = null;
  private _disposed = false;

  constructor(options: SourceControlStateStoreOptions = {}) {
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
  }

  register(
    descriptor: SourceControlDescriptorRegistrationDto,
    options: SourceControlRegistrationOptions = {}
  ): SourceControlStateHandle {
    if (this._disposed) throw new Error('Source-control state store has been disposed.');
    const normalizedDescriptor = validateSourceControlDescriptor(descriptor);
    const owner = requireNamespacedId(options.owner || normalizedDescriptor.id, 'Source-control owner');
    if (options.owner && !normalizedDescriptor.id.startsWith(owner + '.')) {
      throw new TypeError('Source-control descriptor id must use the owning extension namespace.');
    }
    const commandPrefix = typeof options.commandPrefix === 'string' && options.commandPrefix
      ? options.commandPrefix
      : owner + '.';
    if (normalizedDescriptor.openCommand && !normalizedDescriptor.openCommand.startsWith(commandPrefix)) {
      throw new TypeError('Source-control open command must use the owning extension namespace.');
    }
    if (this._records.has(normalizedDescriptor.id)) {
      throw new Error('Source-control provider already registered: ' + normalizedDescriptor.id);
    }
    const record: SourceControlRecord = {
      id: normalizedDescriptor.id,
      owner,
      descriptor: normalizedDescriptor,
      commandPrefix,
      state: null,
      version: 0
    };
    this._records.set(record.id, record);
    this._orderedRecords = null;
    this._emit('added', record);
    let active = true;
    return Object.freeze({
      id: record.id,
      setState: (state: SourceControlStateRegistrationDto) => {
        if (!active) throw new Error('Source-control state handle has been disposed.');
        return this._setState(record, state);
      },
      clearState: () => {
        if (!active) return Object.freeze({ version: record.version });
        return this._clearState(record);
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this._remove(record);
      }
    });
  }

  list(): SourceControlSnapshot[] {
    if (!this._orderedRecords) {
      this._orderedRecords = Array.from(this._records.values())
        .sort((left, right) => left.descriptor.order - right.descriptor.order || left.id.localeCompare(right.id));
    }
    return this._orderedRecords.map((record) => this._snapshot(record));
  }

  get(id: string): SourceControlSnapshot | null {
    const record = this._records.get(id);
    return record ? this._snapshot(record) : null;
  }

  onDidChange(listener: SourceControlChangeListener) {
    if (this._disposed) throw new Error('Source-control state store has been disposed.');
    if (typeof listener !== 'function') throw new TypeError('Source-control state listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  disposeOwner(owner: string): void {
    for (const record of Array.from(this._records.values())) {
      if (record.owner === owner) this._remove(record);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const record of Array.from(this._records.values()).reverse()) this._remove(record);
    this._listeners.clear();
  }

  private _setState(
    record: SourceControlRecord,
    state: SourceControlStateRegistrationDto
  ): SourceControlVersionDto {
    if (this._records.get(record.id) !== record) throw new Error('Source-control state provider is no longer registered.');
    record.state = validateSourceControlState(state, { commandPrefix: record.commandPrefix });
    record.version += 1;
    this._emit('state', record);
    return Object.freeze({ version: record.version });
  }

  private _clearState(record: SourceControlRecord): SourceControlVersionDto {
    if (this._records.get(record.id) !== record) return Object.freeze({ version: record.version });
    if (record.state === null) return Object.freeze({ version: record.version });
    record.state = null;
    record.version += 1;
    this._emit('cleared', record);
    return Object.freeze({ version: record.version });
  }

  private _remove(record: SourceControlRecord): void {
    if (this._records.get(record.id) !== record) return;
    this._records.delete(record.id);
    this._orderedRecords = null;
    this._emit('removed', record);
  }

  private _snapshot(record: SourceControlRecord): SourceControlSnapshot {
    return deepFreeze({
      id: record.id,
      owner: record.owner,
      descriptor: record.descriptor,
      state: record.state,
      version: record.version
    });
  }

  private _event(type: SourceControlChangeType, record: SourceControlRecord): SourceControlChangeEvent {
    const { id, owner, descriptor, version } = record;
    if (type === 'added') return deepFreeze({ type, id, owner, descriptor, state: null, version });
    if (type === 'cleared') return deepFreeze({ type, id, owner, descriptor, state: null, version });
    if (type === 'state') {
      if (!record.state) throw new Error('Source-control state event requires active state.');
      return deepFreeze({ type, id, owner, descriptor, state: record.state, version });
    }
    return deepFreeze({ type, id, owner, descriptor, state: record.state, version });
  }

  private _emit(type: SourceControlChangeType, record: SourceControlRecord): void {
    const event = this._event(type, record);
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch (error) {
        try { this._onError({ source: 'source-control-listener', id: record.id, owner: record.owner, error }); } catch (_) {}
      }
    }
  }
}
