import { toDisposable } from './disposable.js';

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
});

export const SourceControlPhase = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error'
});

export const SourceControlActionKind = Object.freeze({
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  DANGER: 'danger'
});

// The extension supplies only a semantic icon token and layout intent. The
// trusted workbench owns the SVG, keyboard behavior, menus, and form DOM.
export const SourceControlActionPlacement = Object.freeze({
  BUTTON: 'button',
  TOOLBAR: 'toolbar',
  MENU: 'menu'
});

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
});

export const SourceControlFormFieldType = Object.freeze({
  TEXT: 'text',
  TEXTAREA: 'textarea',
  SELECT: 'select',
  CHECKBOX: 'checkbox'
});

const KNOWN_SOURCE_CONTROL_ICONS = new Set(Object.values(SourceControlIcon));
const KNOWN_PHASES = new Set(Object.values(SourceControlPhase));
const KNOWN_ACTION_KINDS = new Set(Object.values(SourceControlActionKind));
const KNOWN_ACTION_PLACEMENTS = new Set(Object.values(SourceControlActionPlacement));
const KNOWN_ACTION_ICONS = new Set(Object.values(SourceControlActionIcon));
const KNOWN_FORM_FIELD_TYPES = new Set(Object.values(SourceControlFormFieldType));
const ALLOWED_DESCRIPTOR_FIELDS = new Set(['id', 'title', 'icon', 'order', 'openCommand']);
const ALLOWED_STATE_FIELDS = new Set(['phase', 'title', 'message', 'summary', 'sections', 'actions']);
const ALLOWED_SUMMARY_FIELDS = new Set(['title', 'items']);
const ALLOWED_SUMMARY_ITEM_FIELDS = new Set(['label', 'value', 'detail']);
const ALLOWED_SECTION_FIELDS = new Set(['id', 'title', 'description', 'items', 'emptyMessage', 'collapsed', 'loadMore']);
const ALLOWED_SECTION_ITEM_FIELDS = new Set(['id', 'title', 'description', 'meta', 'badge', 'command', 'disabled']);
const ALLOWED_LOAD_MORE_FIELDS = new Set(['command', 'label', 'disabled']);
const ALLOWED_ACTION_FIELDS = new Set(['id', 'title', 'description', 'command', 'kind', 'disabled', 'form', 'placement', 'icon']);
const ALLOWED_FORM_FIELDS = new Set(['title', 'submitLabel', 'fields']);
const ALLOWED_FORM_FIELD_FIELDS = new Set(['id', 'label', 'type', 'description', 'placeholder', 'required', 'value', 'maxLength', 'options']);
const ALLOWED_SELECT_OPTION_FIELDS = new Set(['value', 'label']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(label + ' must be a plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) throw new TypeError(label + ' includes an unsupported field: ' + key);
    if (!Object.prototype.hasOwnProperty.call(descriptors[key], 'value')) {
      throw new TypeError(label + ' cannot contain accessors.');
    }
  }
  return value;
}

function requireNonEmptyString(value, label, maxLength) {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string.');
  const result = value.trim();
  if (!result) throw new TypeError(label + ' must not be empty.');
  if (result.length > maxLength) throw new TypeError(label + ' exceeds the maximum length.');
  return result;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, label, maxLength);
}

function requireNamespacedId(value, label) {
  const id = requireNonEmptyString(value, label, MAX_ID_LENGTH);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw new TypeError(label + ' must be a namespaced id.');
  }
  return id;
}

function requireScopedId(value, label, maxLength = 96) {
  const id = requireNonEmptyString(value, label, maxLength);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id)) {
    throw new TypeError(label + ' contains unsupported characters.');
  }
  return id;
}

function requireCommandId(value, label, commandPrefix) {
  const id = requireNonEmptyString(value, label, MAX_COMMAND_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new TypeError(label + ' contains unsupported characters.');
  }
  if (commandPrefix && !id.startsWith(commandPrefix)) {
    throw new TypeError(label + ' must use the owning extension namespace.');
  }
  return id;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeSummaryItem(value) {
  assertAllowedFields(value, ALLOWED_SUMMARY_ITEM_FIELDS, 'Source-control summary item');
  return Object.freeze({
    label: requireNonEmptyString(value.label, 'Source-control summary item label', 128),
    value: requireNonEmptyString(value.value, 'Source-control summary item value', 256),
    detail: optionalString(value.detail, 'Source-control summary item detail', 512)
  });
}

function normalizeSummary(value) {
  if (value === undefined || value === null) return null;
  assertAllowedFields(value, ALLOWED_SUMMARY_FIELDS, 'Source-control summary');
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items) || items.length > MAX_SUMMARY_ITEMS) {
    throw new TypeError('Source-control summary items must be a bounded array.');
  }
  return deepFreeze({
    title: optionalString(value.title, 'Source-control summary title', 128),
    items: items.map(normalizeSummaryItem)
  });
}

function normalizeSectionItem(value, commandPrefix) {
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

function normalizeLoadMore(value, commandPrefix) {
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

function normalizeSection(value, commandPrefix) {
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

function normalizeSelectOption(value) {
  assertAllowedFields(value, ALLOWED_SELECT_OPTION_FIELDS, 'Source-control select option');
  return Object.freeze({
    value: requireNonEmptyString(value.value, 'Source-control select option value', 160),
    label: requireNonEmptyString(value.label, 'Source-control select option label', 160)
  });
}

function normalizeFormField(value) {
  assertAllowedFields(value, ALLOWED_FORM_FIELD_FIELDS, 'Source-control form field');
  const type = value.type === undefined ? SourceControlFormFieldType.TEXT : value.type;
  if (!KNOWN_FORM_FIELD_TYPES.has(type)) throw new TypeError('Source-control form field type is not supported.');
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new TypeError('Source-control form field required must be a boolean.');
  }
  const defaultLimit = type === SourceControlFormFieldType.TEXTAREA ? 4096 : 512;
  const maxLength = value.maxLength === undefined ? defaultLimit : value.maxLength;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4096) {
    throw new TypeError('Source-control form field maxLength must be an integer from 1 through 4096.');
  }
  let options = [];
  if (type === SourceControlFormFieldType.SELECT) {
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_SELECT_OPTIONS) {
      throw new TypeError('Source-control select fields require a bounded option list.');
    }
    options = value.options.map(normalizeSelectOption);
    if (new Set(options.map((option) => option.value)).size !== options.length) {
      throw new TypeError('Source-control select option values must be unique.');
    }
  } else if (value.options !== undefined) {
    throw new TypeError('Only source-control select fields can include options.');
  }
  let defaultValue;
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
      defaultValue = options[0].value;
    }
  }
  return deepFreeze({
    id: requireScopedId(value.id, 'Source-control form field id', 64),
    label: requireNonEmptyString(value.label, 'Source-control form field label', 128),
    type,
    description: optionalString(value.description, 'Source-control form field description', 512),
    placeholder: optionalString(value.placeholder, 'Source-control form field placeholder', 160),
    required: value.required === true,
    value: defaultValue,
    maxLength,
    options
  });
}

function normalizeForm(value) {
  if (value === undefined || value === null) return null;
  assertAllowedFields(value, ALLOWED_FORM_FIELDS, 'Source-control action form');
  if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > MAX_FORM_FIELDS) {
    throw new TypeError('Source-control action form fields must be a bounded non-empty array.');
  }
  const fields = value.fields.map(normalizeFormField);
  if (new Set(fields.map((field) => field.id)).size !== fields.length) {
    throw new TypeError('Source-control action form field ids must be unique.');
  }
  return deepFreeze({
    title: optionalString(value.title, 'Source-control action form title', 128),
    submitLabel: optionalString(value.submitLabel, 'Source-control action form submit label', 96),
    fields
  });
}

function normalizeAction(value, commandPrefix) {
  assertAllowedFields(value, ALLOWED_ACTION_FIELDS, 'Source-control action');
  const kind = value.kind === undefined ? SourceControlActionKind.SECONDARY : value.kind;
  if (!KNOWN_ACTION_KINDS.has(kind)) throw new TypeError('Source-control action kind is not supported.');
  const placement = value.placement === undefined ? SourceControlActionPlacement.BUTTON : value.placement;
  if (!KNOWN_ACTION_PLACEMENTS.has(placement)) throw new TypeError('Source-control action placement is not supported.');
  if (value.icon !== undefined && !KNOWN_ACTION_ICONS.has(value.icon)) {
    throw new TypeError('Source-control action icon is not supported.');
  }
  if (placement === SourceControlActionPlacement.TOOLBAR && value.icon === undefined) {
    throw new TypeError('Source-control toolbar actions require a supported icon.');
  }
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    throw new TypeError('Source-control action disabled must be a boolean.');
  }
  return deepFreeze({
    id: requireScopedId(value.id, 'Source-control action id'),
    title: requireNonEmptyString(value.title, 'Source-control action title', 128),
    description: optionalString(value.description, 'Source-control action description', 512),
    command: requireCommandId(value.command, 'Source-control action command', commandPrefix),
    kind,
    placement,
    icon: value.icon,
    disabled: value.disabled === true,
    form: normalizeForm(value.form)
  });
}

/**
 * Validates the static data-only descriptor consumed by the trusted source
 * control sidebar. Dynamic state is kept in a separate lifecycle-owned store.
 */
export function validateSourceControlDescriptor(value) {
  assertAllowedFields(value, ALLOWED_DESCRIPTOR_FIELDS, 'Source-control descriptor');
  const id = requireNamespacedId(value.id, 'Source-control descriptor id');
  const title = requireNonEmptyString(value.title, 'Source-control descriptor title', MAX_TITLE_LENGTH);
  const icon = value.icon === undefined
    ? SourceControlIcon.GIT_BRANCH
    : requireNonEmptyString(value.icon, 'Source-control descriptor icon', 48);
  if (!KNOWN_SOURCE_CONTROL_ICONS.has(icon)) {
    throw new TypeError('Source-control descriptor icon is not supported by the host.');
  }
  const order = value.order === undefined ? 0 : value.order;
  if (!Number.isInteger(order) || order < -1000 || order > 1000) {
    throw new TypeError('Source-control descriptor order must be an integer from -1000 to 1000.');
  }
  const openCommand = value.openCommand === undefined || value.openCommand === null
    ? null
    : requireCommandId(value.openCommand, 'Source-control descriptor open command');

  return Object.freeze({ id, title, icon, order, openCommand });
}

/**
 * Validates the bounded state rendered by the host. Strings have already been
 * localized by the plugin through context.i18n; they are always inserted as
 * text nodes, never interpreted as markup.
 */
export function validateSourceControlState(value, options = {}) {
  assertAllowedFields(value, ALLOWED_STATE_FIELDS, 'Source-control state');
  const phase = value.phase === undefined ? SourceControlPhase.READY : value.phase;
  if (!KNOWN_PHASES.has(phase)) throw new TypeError('Source-control state phase is not supported.');
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
export function normalizeSourceControlFormValues(form, rawValues) {
  if (!form) return Object.freeze({});
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    throw new TypeError('Source-control form values must be a plain object.');
  }
  const values = Object.create(null);
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

export function createSourceControlCommandPayload(descriptorId, actionId, values, details = {}) {
  const sourceControlId = requireNamespacedId(descriptorId, 'Source-control descriptor id');
  const normalizedAction = requireScopedId(actionId, 'Source-control action id');
  assertAllowedFields(details, new Set(['sectionId', 'itemId', 'kind']), 'Source-control command details');
  const payload = {
    sourceControlId,
    actionId: normalizedAction,
    values: values && typeof values === 'object' ? values : Object.freeze({})
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
export class SourceControlStateStore {
  constructor(options = {}) {
    this._records = new Map();
    this._listeners = new Set();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register(descriptor, options = {}) {
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
    const record = {
      id: normalizedDescriptor.id,
      owner,
      descriptor: normalizedDescriptor,
      commandPrefix,
      state: null,
      version: 0
    };
    this._records.set(record.id, record);
    this._emit('added', record);
    let active = true;
    return Object.freeze({
      id: record.id,
      setState: (state) => {
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

  list() {
    return Array.from(this._records.values())
      .sort((left, right) => left.descriptor.order - right.descriptor.order || left.id.localeCompare(right.id))
      .map((record) => deepFreeze({
        id: record.id,
        owner: record.owner,
        descriptor: record.descriptor,
        state: record.state,
        version: record.version
      }));
  }

  get(id) {
    const record = this._records.get(id);
    return record ? deepFreeze({
      id: record.id,
      owner: record.owner,
      descriptor: record.descriptor,
      state: record.state,
      version: record.version
    }) : null;
  }

  onDidChange(listener) {
    if (this._disposed) throw new Error('Source-control state store has been disposed.');
    if (typeof listener !== 'function') throw new TypeError('Source-control state listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  disposeOwner(owner) {
    for (const record of Array.from(this._records.values())) {
      if (record.owner === owner) this._remove(record);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const record of Array.from(this._records.values()).reverse()) this._remove(record);
    this._listeners.clear();
  }

  _setState(record, state) {
    if (this._records.get(record.id) !== record) throw new Error('Source-control state provider is no longer registered.');
    record.state = validateSourceControlState(state, { commandPrefix: record.commandPrefix });
    record.version += 1;
    this._emit('state', record);
    return Object.freeze({ version: record.version });
  }

  _clearState(record) {
    if (this._records.get(record.id) !== record) return Object.freeze({ version: record.version });
    if (record.state === null) return Object.freeze({ version: record.version });
    record.state = null;
    record.version += 1;
    this._emit('cleared', record);
    return Object.freeze({ version: record.version });
  }

  _remove(record) {
    if (this._records.get(record.id) !== record) return;
    this._records.delete(record.id);
    this._emit('removed', record);
  }

  _emit(type, record) {
    const event = deepFreeze({
      type,
      id: record.id,
      owner: record.owner,
      descriptor: record.descriptor,
      state: record.state,
      version: record.version
    });
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch (error) {
        try { this._onError({ source: 'source-control-listener', id: record.id, owner: record.owner, error }); } catch (_) {}
      }
    }
  }
}
