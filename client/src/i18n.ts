import type {
  I18nChangeEvent,
  I18nChangeListener,
  I18nInterpolationParams,
  I18nService,
  I18nServiceDependencies,
  I18nSnapshot,
  I18nTextBindingOptions,
  I18nTranslatedAttribute,
  LanguagePackDto,
  LanguagePackErrorDto,
  LanguagePackInstallCanceledDto,
  LanguagePackInstallResultDto,
  LanguagePackMessagesDto,
  LanguagePacksListDto,
  LanguagePacksStartupDto,
  LanguagePackSummaryDto
} from '../types/i18n';
import type { LanguagePacksInvalidationHint } from '../types/i18n';
import type { Disposable, Dispose } from '../types/lifecycle';

const DEFAULT_LOCALE = 'en';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;
const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const MAX_PACKS = 1024;
const MAX_ERRORS = 1024;
const MAX_MESSAGES = 5000;
const MAX_DTO_EXTRA_KEYS = 8;
const MESSAGES_LIMIT = 512 * 1024;
const MAX_FALLBACK_DEPTH = 16;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/;
const BLOCKED_MESSAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SKIP_SELECTOR = [
  '[data-i18n-skip]',
  '#container',
  '#file-tree',
  '#run-log',
  '#terminal-output',
  '#terminal-host',
  '#history-detail-output',
  '#ai-chat-messages',
  '#workspace-label',
  '#sidebar-workspace-name',
  '#team-sidebar-project',
  '#team-sidebar-branch',
  '#collab-account-id',
  '#profile-name',
  '#profile-uid',
  '.monaco-editor',
  '.tab-title',
  '.team-diff-output',
  '.commit-hash',
  'pre',
  'code',
  'script',
  'style'
].join(',');
const TRANSLATED_ATTRIBUTES: readonly I18nTranslatedAttribute[] = [
  'title',
  'aria-label',
  'placeholder'
];

interface ElementBinding {
  readonly source: string;
  readonly params: I18nInterpolationParams | null;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly attribute?: I18nTranslatedAttribute;
}

interface ElementBindings {
  text: ElementBinding | null;
  readonly attributes: Partial<Record<I18nTranslatedAttribute, ElementBinding>>;
}

function emptyMessages(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

type OwnDataRecord = Record<string, unknown>;

const MANIFEST_FIELDS = new Set([
  'schemaVersion', 'id', 'name', 'nativeName', 'locale', 'version', 'direction',
  'monacoLocale', 'fallback'
]);
const PACK_SUMMARY_FIELDS = new Set(['manifest', 'source', 'removable', 'byteSize', 'stale']);
const LOADED_PACK_FIELDS = new Set([...PACK_SUMMARY_FIELDS, 'messages']);
const PACK_ERROR_FIELDS = new Set(['source', 'directory', 'error', 'preserved']);
const PACK_LIST_FIELDS = new Set(['activeId', 'packs', 'errors']);
const PACK_STARTUP_FIELDS = new Set([...PACK_LIST_FIELDS, 'pack']);
const PACK_INSTALL_FIELDS = new Set([...PACK_STARTUP_FIELDS, 'canceled']);
const OPEN_FOLDER_FIELDS = new Set(['success', 'path']);

function isPlainPrototype(prototype: object | null): boolean {
  if (prototype === null) return true;
  try {
    if (prototype === Object.prototype) return true;
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    return Boolean(
      constructor &&
      'value' in constructor &&
      typeof constructor.value === 'function' &&
      constructor.value.name === 'Object' &&
      constructor.value.prototype === prototype &&
      /^function Object\(\) \{ \[native code\] \}$/.test(
        Function.prototype.toString.call(constructor.value)
      )
    );
  } catch (_) {
    return false;
  }
}

function isArrayPrototype(prototype: object | null): boolean {
  if (!prototype) return false;
  try {
    if (prototype === Array.prototype) return true;
    if (!isPlainPrototype(Object.getPrototypeOf(prototype) as object | null)) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    return Boolean(
      constructor &&
      'value' in constructor &&
      typeof constructor.value === 'function' &&
      constructor.value.name === 'Array' &&
      constructor.value.prototype === prototype &&
      /^function Array\(\) \{ \[native code\] \}$/.test(
        Function.prototype.toString.call(constructor.value)
      )
    );
  } catch (_) {
    return false;
  }
}

function ownDataRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string> | null,
  maxKeys = (allowedKeys?.size || 0) + MAX_DTO_EXTRA_KEYS
): OwnDataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be a plain object');
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch (_) {
    throw new TypeError(label + ' cannot be inspected safely');
  }
  if (!isPlainPrototype(prototype)) throw new TypeError(label + ' has an unsafe prototype');
  if (ownKeys.length > maxKeys) throw new RangeError(label + ' has too many fields');
  const result = Object.create(null) as OwnDataRecord;
  for (const key of ownKeys) {
    if (typeof key !== 'string') throw new TypeError(label + ' cannot contain symbol keys');
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (_) {
      throw new TypeError(label + '.' + key + ' cannot be inspected safely');
    }
    if (!descriptor) throw new TypeError(label + '.' + key + ' is unavailable');
    if (!('value' in descriptor)) throw new TypeError(label + '.' + key + ' must be a data property');
    if (!allowedKeys || allowedKeys.has(key)) result[key] = descriptor.value;
  }
  return result;
}

function ownDataArray(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(label + ' must be an array');
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch (_) {
    throw new TypeError(label + ' cannot be inspected safely');
  }
  if (!isArrayPrototype(prototype)) throw new TypeError(label + ' has an unsafe array prototype');
  if (ownKeys.length > maxLength + 1) throw new RangeError(label + ' exceeds the supported length');
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of ownKeys) {
    if (typeof key !== 'string') throw new TypeError(label + ' cannot contain symbol keys');
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (_) {
      throw new TypeError(label + '.' + key + ' cannot be inspected safely');
    }
    if (!descriptor || !('value' in descriptor)) throw new TypeError(label + '.' + key + ' must be a data property');
    descriptors.set(key, descriptor);
  }
  const lengthDescriptor = descriptors.get('length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new RangeError(label + ' exceeds the supported length');
  }
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError(label + ' cannot contain symbol keys');
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw new TypeError(label + ' cannot contain custom array properties');
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors.get(String(index));
    if (!descriptor || !('value' in descriptor)) throw new TypeError(label + ' must not contain holes');
    result.push(descriptor.value);
  }
  return result;
}

function stringField(
  record: OwnDataRecord,
  field: string,
  label: string,
  options: { allowEmpty?: boolean; maxLength?: number; pattern?: RegExp } = {}
): string {
  const value = record[field];
  if (typeof value !== 'string') throw new TypeError(label + '.' + field + ' must be a string');
  if (!options.allowEmpty && value.length === 0) throw new TypeError(label + '.' + field + ' cannot be empty');
  if (value.length > (options.maxLength || 160) || /\0|[\r\n]/.test(value)) {
    throw new TypeError(label + '.' + field + ' is invalid');
  }
  if (options.pattern && !options.pattern.test(value)) throw new TypeError(label + '.' + field + ' is invalid');
  return value;
}

function booleanField(record: OwnDataRecord, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new TypeError(label + '.' + field + ' must be a boolean');
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function normalizeManifest(value: unknown, label: string) {
  const record = ownDataRecord(value, label, MANIFEST_FIELDS);
  if (record.schemaVersion !== 1) throw new TypeError(label + '.schemaVersion is unsupported');
  const direction = stringField(record, 'direction', label, { maxLength: 3 });
  if (direction !== 'ltr' && direction !== 'rtl') throw new TypeError(label + '.direction is invalid');
  return Object.freeze({
    schemaVersion: 1 as const,
    id: stringField(record, 'id', label, { maxLength: 64, pattern: ID_PATTERN }),
    name: stringField(record, 'name', label, { maxLength: 100 }),
    nativeName: stringField(record, 'nativeName', label, { maxLength: 100 }),
    locale: stringField(record, 'locale', label, { maxLength: 48, pattern: LOCALE_PATTERN }),
    version: stringField(record, 'version', label, { maxLength: 32, pattern: VERSION_PATTERN }),
    direction,
    monacoLocale: stringField(record, 'monacoLocale', label, {
      allowEmpty: true,
      maxLength: 48,
      pattern: /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)?$/
    }),
    fallback: stringField(record, 'fallback', label, {
      allowEmpty: true,
      maxLength: 64,
      pattern: /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/
    })
  });
}

function normalizePackSummary(value: unknown, label: string): LanguagePackSummaryDto {
  const record = ownDataRecord(value, label, PACK_SUMMARY_FIELDS);
  const source = stringField(record, 'source', label, { maxLength: 16 });
  if (source !== 'builtin' && source !== 'user') throw new TypeError(label + '.source is invalid');
  const byteSize = record.byteSize;
  if (!Number.isSafeInteger(byteSize) || (byteSize as number) < 0) {
    throw new TypeError(label + '.byteSize must be a non-negative integer');
  }
  return Object.freeze({
    manifest: normalizeManifest(record.manifest, label + '.manifest'),
    source,
    removable: booleanField(record, 'removable', label),
    byteSize: byteSize as number,
    stale: booleanField(record, 'stale', label)
  });
}

function normalizeMessages(value: unknown, label: string): LanguagePackMessagesDto {
  const record = ownDataRecord(value, label, null, MAX_MESSAGES);
  const keys = Object.keys(record);
  if (keys.length > MAX_MESSAGES) throw new RangeError(label + ' has too many messages');
  const result = emptyMessages();
  let byteSize = 2;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] || '';
    const message = record[key];
    if (!key || key.length > 256 || BLOCKED_MESSAGE_KEYS.has(key) || /\0/.test(key)) {
      throw new TypeError(label + ' contains an invalid key');
    }
    if (typeof message !== 'string' || message.length > 8192 || /\0/.test(message)) {
      throw new TypeError(label + '.' + key + ' must be a valid string');
    }
    byteSize += (index > 0 ? 1 : 0) + utf8ByteLength(JSON.stringify(key)) + 1 +
      utf8ByteLength(JSON.stringify(message));
    if (byteSize > MESSAGES_LIMIT) throw new RangeError(label + ' exceeds the allowed size');
    const sourcePlaceholders = (key.match(/\{[A-Za-z0-9_.-]+\}/g) || []).sort();
    const translatedPlaceholders = (message.match(/\{[A-Za-z0-9_.-]+\}/g) || []).sort();
    if (sourcePlaceholders.join('\0') !== translatedPlaceholders.join('\0')) {
      throw new TypeError(label + '.' + key + ' has inconsistent placeholders');
    }
    result[key] = message;
  }
  return Object.freeze(result);
}

function normalizeLoadedPack(value: unknown, label: string, expectedId?: string): LanguagePackDto {
  const record = ownDataRecord(value, label, LOADED_PACK_FIELDS);
  const summary = normalizePackSummary(record, label);
  if (expectedId && summary.manifest.id !== expectedId) {
    throw new TypeError(label + ' does not match requested language pack id');
  }
  return Object.freeze({ ...summary, messages: normalizeMessages(record.messages, label + '.messages') });
}

function normalizeErrors(value: unknown, label: string): readonly LanguagePackErrorDto[] {
  const rawErrors = ownDataArray(value, label, MAX_ERRORS);
  return Object.freeze(rawErrors.map((entry, index) => {
    const entryLabel = label + '[' + index + ']';
    const record = ownDataRecord(entry, entryLabel, PACK_ERROR_FIELDS);
    const normalized = {
      source: stringField(record, 'source', entryLabel, { maxLength: 160 }),
      directory: stringField(record, 'directory', entryLabel, { maxLength: 512 }),
      error: stringField(record, 'error', entryLabel, { maxLength: 4096 })
    };
    return Object.freeze(record.preserved === undefined ? normalized : {
      ...normalized,
      preserved: booleanField(record, 'preserved', entryLabel)
    });
  }));
}

function normalizeSummaries(value: unknown, label: string): readonly LanguagePackSummaryDto[] {
  const rawPacks = ownDataArray(value, label, MAX_PACKS);
  const seen = new Set<string>();
  const normalized = rawPacks.map((entry, index) => {
    const pack = normalizePackSummary(entry, label + '[' + index + ']');
    if (seen.has(pack.manifest.id)) throw new TypeError(label + ' contains duplicate pack ids');
    seen.add(pack.manifest.id);
    return pack;
  });
  return Object.freeze(normalized);
}

export function normalizeLanguagePacksStartup(value: unknown): LanguagePacksStartupDto {
  const record = ownDataRecord(value, 'language pack startup', PACK_STARTUP_FIELDS);
  const activeId = stringField(record, 'activeId', 'language pack startup', {
    maxLength: 64,
    pattern: ID_PATTERN
  });
  const pack = record.pack === null ? null : normalizeLoadedPack(
    record.pack,
    'language pack startup.pack',
    activeId
  );
  return Object.freeze({
    activeId,
    packs: normalizeSummaries(record.packs, 'language pack startup.packs'),
    pack,
    errors: normalizeErrors(record.errors, 'language pack startup.errors')
  });
}

export function normalizeLanguagePacksList(
  value: unknown
): LanguagePacksListDto | readonly LanguagePackSummaryDto[] {
  if (Array.isArray(value)) return normalizeSummaries(value, 'language pack list');
  const record = ownDataRecord(value, 'language pack list', PACK_LIST_FIELDS);
  return Object.freeze({
    activeId: stringField(record, 'activeId', 'language pack list', {
      maxLength: 64,
      pattern: ID_PATTERN
    }),
    packs: normalizeSummaries(record.packs, 'language pack list.packs'),
    errors: normalizeErrors(record.errors, 'language pack list.errors')
  });
}

function normalizeInstallResult(value: unknown): LanguagePackInstallResultDto {
  if (value === null) return null;
  const record = ownDataRecord(value, 'language pack install result', PACK_INSTALL_FIELDS);
  if (record.canceled === true) return Object.freeze({ canceled: true });
  return normalizeLanguagePacksStartup(value);
}

function normalizeOpenFolderResult(value: unknown) {
  const record = ownDataRecord(value, 'language pack open-folder result', OPEN_FOLDER_FIELDS);
  if (record.success !== true) throw new TypeError('language pack open-folder result is unsuccessful');
  return Object.freeze({
    success: true as const,
    path: stringField(record, 'path', 'language pack open-folder result', { maxLength: 32768 })
  });
}

function defaultPack(): LanguagePackDto {
  return Object.freeze({
    manifest: Object.freeze({
      schemaVersion: 1,
      id: DEFAULT_LOCALE,
      name: 'English',
      nativeName: 'English',
      locale: DEFAULT_LOCALE,
      version: '1.0.0',
      direction: 'ltr',
      monacoLocale: '',
      fallback: ''
    }),
    source: 'builtin',
    removable: false,
    byteSize: 0,
    stale: false,
    messages: Object.freeze(emptyMessages())
  });
}

function isInstallCanceled(
  result: LanguagePackInstallResultDto
): result is LanguagePackInstallCanceledDto {
  return Boolean(result && 'canceled' in result && result.canceled === true);
}

function isLanguagePacksList(
  result: LanguagePacksListDto | readonly LanguagePackSummaryDto[]
): result is LanguagePacksListDto {
  return !Array.isArray(result);
}

export function createI18nService(dependencies: I18nServiceDependencies): I18nService {
  const host = dependencies.host || null;
  const document = dependencies.document;
  const eventTarget = dependencies.eventTarget;
  const logger = dependencies.logger || console;
  const safeLogError = (...values: unknown[]): void => {
    try { logger.error(...values); } catch (_) {}
  };
  const createMutationObserver = dependencies.createMutationObserver || (
    (callback: MutationCallback) => new MutationObserver(callback)
  );
  const setTimer = dependencies.setTimer || (
    (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs)
  );
  const clearTimer = dependencies.clearTimer || (
    (timer: number) => globalThis.clearTimeout(timer)
  );

  let initialized = false;
  let disposed = false;
  let initPromise: Promise<I18nSnapshot> | null = null;
  let activeId = DEFAULT_LOCALE;
  let activePack: LanguagePackDto | null = null;
  let packs: readonly LanguagePackSummaryDto[] = [];
  let errors: readonly LanguagePackErrorDto[] = [];
  let messages: LanguagePackMessagesDto = emptyMessages();
  let fallbackMessages: LanguagePackMessagesDto = emptyMessages();
  let originalText = new WeakMap<Node, string>();
  let originalAttributes = new WeakMap<Element, Partial<Record<I18nTranslatedAttribute, string | null>>>();
  let elementBindings = new WeakMap<Element, ElementBindings>();
  const boundElements = new Set<Element>();
  const pendingRoots = new Set<Node>();
  const subscribers = new Set<I18nChangeListener>();
  let observer: MutationObserver | null = null;
  let applyTimer: number | null = null;
  let hostSubscription: Disposable | null = null;
  let loadedMonacoLocale = '';
  let monacoBaselineCaptured = false;
  let adoptionEpoch = 0;
  let hostRefreshRunning = false;
  let hostRefreshDirty = false;
  let hostRefreshShouldNotify = false;
  let hostRefreshPromise: Promise<void> | null = null;
  let currentLocalMutationEpoch: number | null = null;
  let initializing = false;

  function interpolate(value: string, params?: I18nInterpolationParams | null): string {
    if (!params) return value;
    return String(value).replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key: string) => (
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    ));
  }

  function t(source: unknown, params?: I18nInterpolationParams | null): string {
    const key = String(source == null ? '' : source);
    const value = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key]
      : Object.prototype.hasOwnProperty.call(fallbackMessages, key) ? fallbackMessages[key]
      : key;
    return interpolate(value ?? key, params);
  }

  function shouldSkip(element: Element | null | undefined): boolean {
    return !element || Boolean(element.closest?.(SKIP_SELECTOR));
  }

  function cloneParams(
    params?: I18nInterpolationParams | null
  ): I18nInterpolationParams | null {
    return params && typeof params === 'object' ? Object.assign({}, params) : null;
  }

  function applyBinding(element: Element | null | undefined, binding: ElementBinding | null): void {
    if (!element || !binding) return;
    const value = String(binding.prefix || '') + t(binding.source, binding.params) + String(binding.suffix || '');
    if (binding.attribute) {
      if (element.getAttribute(binding.attribute) !== value) element.setAttribute(binding.attribute, value);
    } else if (element.textContent !== value) {
      element.textContent = value;
    }
  }

  function bindText<ElementType extends Element>(
    element: ElementType | null | undefined,
    source: unknown,
    params?: I18nInterpolationParams | null,
    options: I18nTextBindingOptions = {}
  ): ElementType | null | undefined {
    if (!element || disposed) return element;
    const bindings = elementBindings.get(element) || {
      text: null,
      attributes: Object.create(null) as Partial<Record<I18nTranslatedAttribute, ElementBinding>>
    };
    bindings.text = {
      source: String(source == null ? '' : source),
      params: cloneParams(params),
      prefix: options.prefix || '',
      suffix: options.suffix || ''
    };
    elementBindings.set(element, bindings);
    boundElements.add(element);
    element.setAttribute('data-i18n-bound', '');
    applyBinding(element, bindings.text);
    return element;
  }

  function bindAttribute<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute: I18nTranslatedAttribute,
    source: unknown,
    params?: I18nInterpolationParams | null
  ): ElementType | null | undefined {
    if (!element || disposed || !TRANSLATED_ATTRIBUTES.includes(attribute)) return element;
    const bindings = elementBindings.get(element) || {
      text: null,
      attributes: Object.create(null) as Partial<Record<I18nTranslatedAttribute, ElementBinding>>
    };
    bindings.attributes[attribute] = {
      attribute,
      source: String(source == null ? '' : source),
      params: cloneParams(params)
    };
    elementBindings.set(element, bindings);
    boundElements.add(element);
    element.setAttribute('data-i18n-bound', '');
    applyBinding(element, bindings.attributes[attribute] || null);
    return element;
  }

  function unbind<ElementType extends Element>(
    element: ElementType | null | undefined,
    attribute?: I18nTranslatedAttribute
  ): ElementType | null | undefined {
    const bindings = element && elementBindings.get(element);
    if (!element || !bindings) return element;
    if (attribute) delete bindings.attributes[attribute];
    else bindings.text = null;
    if (!bindings.text && Object.keys(bindings.attributes).length === 0) {
      boundElements.delete(element);
      elementBindings.delete(element);
      element.removeAttribute('data-i18n-bound');
    }
    return element;
  }

  function applyElementBindings(element: Element): void {
    const bindings = elementBindings.get(element);
    if (!bindings) return;
    boundElements.add(element);
    if (bindings.text) applyBinding(element, bindings.text);
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      applyBinding(element, bindings.attributes[attribute] || null);
    }
  }

  function applyAllBindings(): void {
    for (const element of boundElements) {
      if (typeof element.isConnected === 'boolean' && !element.isConnected) {
        boundElements.delete(element);
        continue;
      }
      applyElementBindings(element);
    }
  }

  function releaseBoundTree(root: Node): void {
    if (root.nodeType !== ELEMENT_NODE) return;
    const element = root as Element;
    boundElements.delete(element);
    for (const descendant of element.querySelectorAll('[data-i18n-bound]')) {
      boundElements.delete(descendant);
    }
  }

  function translatedText(original: string): string {
    const leading = original.match(/^\s*/)?.[0] || '';
    const trailing = original.match(/\s*$/)?.[0] || '';
    const source = original.slice(leading.length, original.length - trailing.length);
    if (!source || (!Object.prototype.hasOwnProperty.call(messages, source) &&
        !Object.prototype.hasOwnProperty.call(fallbackMessages, source))) return original;
    return leading + t(source) + trailing;
  }

  function translateTextNode(node: Node): void {
    if (!node.parentElement || shouldSkip(node.parentElement)) return;
    if (!originalText.has(node)) originalText.set(node, node.nodeValue || '');
    const original = originalText.get(node) || '';
    const translated = translatedText(original);
    if (node.nodeValue !== translated) node.nodeValue = translated;
  }

  function translateElement(element: Element): void {
    if (shouldSkip(element)) return;
    const bindings = elementBindings.get(element);
    applyElementBindings(element);

    const explicit = element.getAttribute('data-i18n');
    if (explicit && !bindings?.text) element.textContent = t(explicit);

    let originals = originalAttributes.get(element);
    if (!originals) {
      originals = Object.create(null) as Partial<Record<I18nTranslatedAttribute, string | null>>;
      originalAttributes.set(element, originals);
    }
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      if (!element.hasAttribute(attribute) || bindings?.attributes[attribute]) continue;
      if (!Object.prototype.hasOwnProperty.call(originals, attribute)) {
        originals[attribute] = element.getAttribute(attribute);
      }
      const source = originals[attribute];
      const translated = source !== null && source !== undefined && (
        Object.prototype.hasOwnProperty.call(messages, source) ||
        Object.prototype.hasOwnProperty.call(fallbackMessages, source)
      ) ? t(source) : source;
      if (translated !== undefined && element.getAttribute(attribute) !== translated) {
        element.setAttribute(attribute, translated || '');
      }
    }
  }

  function walk(root: Node): void {
    if (disposed) return;
    if (root.nodeType === TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== ELEMENT_NODE && root.nodeType !== DOCUMENT_FRAGMENT_NODE &&
        root.nodeType !== DOCUMENT_NODE) return;
    if (root.nodeType === ELEMENT_NODE) translateElement(root as Element);
    if (root.nodeType === ELEMENT_NODE && shouldSkip(root as Element)) return;
    const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node: Node): number {
        if (node.nodeType === ELEMENT_NODE && shouldSkip(node as Element)) return FILTER_REJECT;
        return FILTER_ACCEPT;
      }
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === ELEMENT_NODE) translateElement(node as Element);
      else translateTextNode(node);
    }
  }

  function observe(): void {
    if (disposed || !document.body) return;
    if (!observer) {
      observer = createMutationObserver((mutations: MutationRecord[]) => {
        if (disposed) return;
        let needsApply = false;
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            Array.from(mutation.removedNodes || []).forEach(releaseBoundTree);
            for (const node of Array.from(mutation.addedNodes || [])) {
              if (node.nodeType !== ELEMENT_NODE && node.nodeType !== TEXT_NODE &&
                  node.nodeType !== DOCUMENT_FRAGMENT_NODE) continue;
              pendingRoots.add(node);
              needsApply = true;
            }
            continue;
          }
          if (mutation.type === 'characterData') {
            const target = mutation.target;
            if (target.parentElement?.hasAttribute('data-i18n-bound')) continue;
            if (originalText.has(target) && target.nodeValue === translatedText(originalText.get(target) || '')) {
              continue;
            }
            originalText.set(target, target.nodeValue || '');
            pendingRoots.add(target);
            needsApply = true;
            continue;
          }
          if (mutation.type === 'attributes' && mutation.attributeName &&
              TRANSLATED_ATTRIBUTES.includes(mutation.attributeName as I18nTranslatedAttribute)) {
            const target = mutation.target as Element;
            const attribute = mutation.attributeName as I18nTranslatedAttribute;
            const bindings = elementBindings.get(target);
            if (bindings?.attributes[attribute]) continue;
            const knownOriginals = originalAttributes.get(target);
            const currentValue = target.getAttribute(attribute);
            if (knownOriginals && Object.prototype.hasOwnProperty.call(knownOriginals, attribute)) {
              const sourceValue = knownOriginals[attribute];
              const translatedValue = sourceValue !== null && sourceValue !== undefined && (
                Object.prototype.hasOwnProperty.call(messages, sourceValue) ||
                Object.prototype.hasOwnProperty.call(fallbackMessages, sourceValue)
              ) ? t(sourceValue) : sourceValue;
              if (currentValue === translatedValue) continue;
            }
            const map = knownOriginals || (
              Object.create(null) as Partial<Record<I18nTranslatedAttribute, string | null>>
            );
            map[attribute] = currentValue;
            originalAttributes.set(target, map);
            pendingRoots.add(target);
            needsApply = true;
          }
        }
        if (needsApply) scheduleApply();
      });
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATED_ATTRIBUTES]
    });
  }

  function applyDocument(): void {
    if (disposed || !document.body) return;
    if (applyTimer !== null) {
      clearTimer(applyTimer);
      applyTimer = null;
    }
    pendingRoots.clear();
    observer?.disconnect();
    document.documentElement.lang = activePack?.manifest.locale || activeId;
    document.documentElement.dir = activePack?.manifest.direction || 'ltr';
    walk(document.body);
    applyAllBindings();
    observe();
  }

  function applyPending(): void {
    applyTimer = null;
    if (disposed || pendingRoots.size === 0) return;
    const snapshot = new Set(pendingRoots);
    pendingRoots.clear();
    const roots = Array.from(snapshot).filter((candidate) => {
      if (typeof candidate.isConnected === 'boolean' && !candidate.isConnected) return false;
      let ancestor = candidate.parentNode;
      while (ancestor) {
        if (snapshot.has(ancestor)) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    });
    observer?.disconnect();
    roots.forEach(walk);
    observe();
  }

  function scheduleApply(): void {
    if (disposed || applyTimer !== null) return;
    applyTimer = setTimer(applyPending, 16);
  }

  function getMonacoLocale(): string {
    return activePack?.manifest.monacoLocale || '';
  }

  function getSnapshot(): I18nSnapshot {
    return Object.freeze({
      initialized,
      activeId,
      pack: activePack,
      packs: Object.freeze(packs.slice()),
      errors: Object.freeze(errors.slice()),
      monacoLocale: getMonacoLocale()
    });
  }

  function emit(reason: string): void {
    const detail: I18nChangeEvent = Object.freeze({ ...getSnapshot(), reason: reason || 'change' });
    for (const callback of Array.from(subscribers)) {
      try {
        callback(detail);
      } catch (error) {
        safeLogError('language pack subscriber:', error);
      }
    }
    try {
      eventTarget.dispatchEvent(new CustomEvent<I18nChangeEvent>('bobo:language-changed', { detail }));
    } catch (_) {}
  }

  function nextAdoptionEpoch(): number {
    adoptionEpoch += 1;
    return adoptionEpoch;
  }

  function isCurrentAdoption(epoch: number): boolean {
    return !disposed && epoch === adoptionEpoch;
  }

  function hasCurrentLocalMutation(): boolean {
    return currentLocalMutationEpoch !== null && currentLocalMutationEpoch === adoptionEpoch;
  }

  async function loadFallbackFor(
    nextActiveId: string,
    nextActivePack: LanguagePackDto | null,
    nextMessages: LanguagePackMessagesDto,
    epoch: number
  ): Promise<LanguagePackMessagesDto> {
    if (!host) return nextActiveId === DEFAULT_LOCALE ? nextMessages : emptyMessages();
    const chain: LanguagePackMessagesDto[] = [];
    const visited = new Set<string>([nextActiveId]);
    let fallbackId = nextActivePack?.manifest.fallback;
    let depth = 0;
    while (fallbackId && !visited.has(fallbackId) && depth < MAX_FALLBACK_DEPTH &&
        isCurrentAdoption(epoch)) {
      visited.add(fallbackId);
      depth += 1;
      try {
        const fallbackValue = await host.load(fallbackId) as unknown;
        if (!isCurrentAdoption(epoch)) break;
        const fallback = normalizeLoadedPack(
          fallbackValue,
          'language pack fallback',
          fallbackId
        );
        if (!fallback) break;
        chain.push(fallback.messages || emptyMessages());
        fallbackId = fallback.manifest?.fallback;
      } catch (_) {
        break;
      }
    }
    const resolved = emptyMessages();
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      Object.assign(resolved, chain[index]);
    }
    return Object.freeze(resolved);
  }

  async function adopt(
    startup: LanguagePacksStartupDto,
    reason: string,
    epoch: number,
    markInitialized = false
  ): Promise<boolean> {
    if (!startup) throw new Error('Language pack service returned no data');
    const nextPacks = Object.freeze(Array.isArray(startup.packs) ? startup.packs.slice() : packs.slice());
    const nextErrors = Object.freeze(Array.isArray(startup.errors) ? startup.errors.slice() : []);
    const nextActiveId = startup.activeId || activeId || DEFAULT_LOCALE;
    let nextActivePack = startup.pack;
    if (!nextActivePack && host) {
      const loaded = await host.load(nextActiveId) as unknown;
      if (!isCurrentAdoption(epoch)) return false;
      nextActivePack = normalizeLoadedPack(loaded, 'active language pack', nextActiveId);
    }
    const nextMessages = nextActivePack?.messages || emptyMessages();
    const nextFallbackMessages = await loadFallbackFor(
      nextActiveId,
      nextActivePack,
      nextMessages,
      epoch
    );
    if (!isCurrentAdoption(epoch)) return false;
    packs = nextPacks;
    errors = nextErrors;
    activeId = nextActiveId;
    activePack = nextActivePack;
    messages = nextMessages;
    fallbackMessages = nextFallbackMessages;
    if (markInitialized) initialized = true;
    applyDocument();
    emit(reason);
    return true;
  }

  function runHostRefreshLoop(): Promise<void> {
    if (!host || disposed) return Promise.resolve();
    if (hostRefreshPromise) return hostRefreshPromise;
    hostRefreshRunning = true;
    const run = async (): Promise<void> => {
      while (hostRefreshDirty && !disposed && !hasCurrentLocalMutation()) {
        hostRefreshDirty = false;
        const shouldNotify = hostRefreshShouldNotify;
        hostRefreshShouldNotify = false;
        const epoch = nextAdoptionEpoch();
        try {
          const value = await host.startup() as unknown;
          if (!isCurrentAdoption(epoch)) {
            hostRefreshShouldNotify = hostRefreshShouldNotify || shouldNotify;
            continue;
          }
          const latest = normalizeLanguagePacksStartup(value);
          const committed = await adopt(latest, 'hot-reload', epoch, initializing && !initialized);
          if (!committed) hostRefreshShouldNotify = hostRefreshShouldNotify || shouldNotify;
          if (committed && shouldNotify && !disposed) {
            try {
              dependencies.getToast?.()?.info(t('Language pack reloaded'));
            } catch (error) {
              safeLogError('language pack hot reload notification:', error);
            }
          }
        } catch (error) {
          hostRefreshShouldNotify = hostRefreshShouldNotify || shouldNotify;
          if (isCurrentAdoption(epoch)) safeLogError('language pack hot reload:', error);
        }
      }
    };
    const attempt = run().catch((error: unknown) => {
      if (!disposed) safeLogError('language pack refresh loop:', error);
    }).finally(() => {
      if (hostRefreshPromise === attempt) hostRefreshPromise = null;
      hostRefreshRunning = false;
      if (hostRefreshDirty && !disposed && !hasCurrentLocalMutation()) {
        void runHostRefreshLoop();
      }
    });
    hostRefreshPromise = attempt;
    return attempt;
  }

  function invalidateFromHost(hint: LanguagePacksInvalidationHint): void {
    if (disposed) return;
    hostRefreshDirty = true;
    if (hint.reason === 'filesystem') hostRefreshShouldNotify = true;
    if (!hasCurrentLocalMutation() && hostRefreshRunning) adoptionEpoch += 1;
    if (!hasCurrentLocalMutation() && !hostRefreshRunning) void runHostRefreshLoop();
  }

  function installHostSubscription(): void {
    if (!host || hostSubscription || disposed) return;
    try {
      const subscription = host.onDidChange(invalidateFromHost);
      if (disposed) subscription.dispose();
      else hostSubscription = subscription;
    } catch (error) {
      safeLogError('language pack subscription:', error);
    }
  }

  function releaseHostSubscription(): void {
    const subscription = hostSubscription;
    hostSubscription = null;
    try {
      subscription?.dispose();
    } catch (error) {
      safeLogError('language pack subscription disposal:', error);
    }
  }

  async function runLocalMutation<Value>(
    epoch: number,
    operation: () => Promise<Value>
  ): Promise<Value> {
    currentLocalMutationEpoch = epoch;
    try {
      return await operation();
    } finally {
      if (currentLocalMutationEpoch === epoch) {
        currentLocalMutationEpoch = null;
        if (hostRefreshDirty && !disposed) {
          await runHostRefreshLoop();
        }
      }
    }
  }

  function init(): Promise<I18nSnapshot> {
    if (disposed || initialized) return Promise.resolve(getSnapshot());
    if (initPromise) return initPromise;
    const epoch = nextAdoptionEpoch();
    initializing = true;
    const attempt = (async (): Promise<I18nSnapshot> => {
      try {
        if (!host) {
          if (isCurrentAdoption(epoch)) {
            activePack = defaultPack();
            messages = activePack.messages;
            fallbackMessages = messages;
            initialized = true;
            applyDocument();
          }
          return getSnapshot();
        }
        await runLocalMutation(epoch, async () => {
          installHostSubscription();
          const startupValue = await host.startup() as unknown;
          if (!isCurrentAdoption(epoch)) return;
          const startup = normalizeLanguagePacksStartup(startupValue);
          await adopt(startup, 'startup', epoch, true);
        });
      } catch (error) {
        if (!disposed && !initialized) {
          safeLogError('i18n init:', error);
          activeId = DEFAULT_LOCALE;
          activePack = defaultPack();
          messages = activePack.messages;
          fallbackMessages = messages;
          initialized = false;
          applyDocument();
          releaseHostSubscription();
        }
      } finally {
        initializing = false;
        if (!monacoBaselineCaptured) {
          loadedMonacoLocale = getMonacoLocale();
          monacoBaselineCaptured = true;
        }
      }
      return getSnapshot();
    })();
    initPromise = attempt;
    const clearAttempt = (): void => {
      if (initPromise === attempt) initPromise = null;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  async function listPacks(): Promise<readonly LanguagePackSummaryDto[]> {
    await init();
    if (!host || disposed) return Object.freeze(packs.slice());
    const observedEpoch = adoptionEpoch;
    const value = await host.list() as unknown;
    if (disposed || observedEpoch !== adoptionEpoch) return Object.freeze(packs.slice());
    const result = normalizeLanguagePacksList(value);
    if (!disposed && observedEpoch === adoptionEpoch) {
      packs = isLanguagePacksList(result)
        ? Object.freeze(Array.isArray(result.packs) ? result.packs.slice() : [])
        : Object.freeze(result.slice());
      errors = Object.freeze(
        isLanguagePacksList(result) && Array.isArray(result.errors) ? result.errors.slice() : []
      );
    }
    return Object.freeze(packs.slice());
  }

  function requireHost(): NonNullable<typeof host> {
    if (disposed) throw new Error('Language pack service has been disposed');
    if (!host) throw new Error('Language pack host is unavailable');
    return host;
  }

  async function setLocale(id: string) {
    await init();
    const languagePacks = requireHost();
    const epoch = nextAdoptionEpoch();
    await runLocalMutation(epoch, async () => {
      const value = await languagePacks.setActive(id) as unknown;
      if (!isCurrentAdoption(epoch)) return;
      const result = normalizeLanguagePacksStartup(value);
      if (result.activeId !== id) throw new TypeError('language pack selection returned a different active id');
      await adopt(result, 'selection', epoch);
    });
    return Object.freeze({
      snapshot: getSnapshot(),
      editorReloadRecommended: loadedMonacoLocale !== getMonacoLocale()
    });
  }

  async function install(): Promise<LanguagePackInstallResultDto> {
    await init();
    const languagePacks = requireHost();
    const epoch = nextAdoptionEpoch();
    let result: LanguagePackInstallResultDto = null;
    await runLocalMutation(epoch, async () => {
      const installValue = await languagePacks.install() as unknown;
      if (!isCurrentAdoption(epoch)) return;
      result = normalizeInstallResult(installValue);
      if (isInstallCanceled(result)) return;
      const startupValue = await languagePacks.startup() as unknown;
      if (!isCurrentAdoption(epoch)) return;
      await adopt(normalizeLanguagePacksStartup(startupValue), 'install', epoch);
    });
    return result;
  }

  async function remove(id: string): Promise<LanguagePacksStartupDto> {
    await init();
    const languagePacks = requireHost();
    const epoch = nextAdoptionEpoch();
    let result: LanguagePacksStartupDto | null = null;
    await runLocalMutation(epoch, async () => {
      const removeValue = await languagePacks.remove(id) as unknown;
      if (!isCurrentAdoption(epoch)) return;
      result = normalizeLanguagePacksStartup(removeValue);
      const startupValue = await languagePacks.startup() as unknown;
      if (!isCurrentAdoption(epoch)) return;
      await adopt(normalizeLanguagePacksStartup(startupValue), 'remove', epoch);
    });
    if (!result) throw new Error('Language pack removal was superseded or disposed before completion');
    return result;
  }

  async function refresh(): Promise<I18nSnapshot> {
    await init();
    const languagePacks = requireHost();
    const epoch = nextAdoptionEpoch();
    await runLocalMutation(epoch, async () => {
      const refreshValue = await languagePacks.refresh() as unknown;
      if (!isCurrentAdoption(epoch)) return;
      normalizeLanguagePacksStartup(refreshValue);
      const startupValue = await languagePacks.startup() as unknown;
      if (!isCurrentAdoption(epoch)) return;
      await adopt(normalizeLanguagePacksStartup(startupValue), 'refresh', epoch);
    });
    return getSnapshot();
  }

  async function openFolder() {
    await init();
    const value = await requireHost().openFolder() as unknown;
    if (disposed) throw new Error('Language pack service has been disposed');
    return normalizeOpenFolderResult(value);
  }

  function onChange(callback: I18nChangeListener): Dispose {
    if (typeof callback !== 'function' || disposed) return () => {};
    subscribers.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(callback);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    initialized = false;
    adoptionEpoch += 1;
    currentLocalMutationEpoch = null;
    hostRefreshDirty = false;
    hostRefreshShouldNotify = false;
    const subscription = hostSubscription;
    hostSubscription = null;
    const currentObserver = observer;
    observer = null;
    const currentTimer = applyTimer;
    applyTimer = null;
    pendingRoots.clear();
    boundElements.clear();
    subscribers.clear();
    originalText = new WeakMap<Node, string>();
    originalAttributes = new WeakMap<Element, Partial<Record<I18nTranslatedAttribute, string | null>>>();
    elementBindings = new WeakMap<Element, ElementBindings>();
    try {
      subscription?.dispose();
    } catch (error) {
      safeLogError('language pack subscription disposal:', error);
    }
    try {
      currentObserver?.disconnect();
    } catch (error) {
      safeLogError('language pack observer disposal:', error);
    }
    if (currentTimer !== null) {
      try {
        clearTimer(currentTimer);
      } catch (error) {
        safeLogError('language pack timer disposal:', error);
      }
    }
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    init,
    t,
    bindText,
    bindAttribute,
    unbind,
    apply: applyDocument,
    listPacks,
    getActive: () => activeId,
    getErrors: () => Object.freeze(errors.slice()),
    getSnapshot,
    getMonacoLocale,
    setLocale,
    install,
    remove,
    openFolder,
    refresh,
    onChange,
    dispose
  });
}
