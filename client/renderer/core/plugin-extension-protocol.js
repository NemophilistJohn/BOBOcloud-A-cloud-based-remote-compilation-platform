// Cross-context protocol for installed BOBOCloud extensions. The renderer is
// the privileged side of this channel; extension code only sees its opaque
// MessagePort inside a sandboxed iframe.

export const EXTENSION_PROTOCOL_VERSION = 1;
export const PLUGIN_RPC_RESULT_MARKER = '__bobocloudPluginRpcResult';
export const PLUGIN_RPC_RESULT_VERSION = 1;

export const ExtensionMessageType = Object.freeze({
  CONNECT: 'bobocloud.extension.connect',
  INITIALIZE: 'initialize',
  ACTIVATED: 'activated',
  ACTIVATION_FAILED: 'activationFailed',
  REQUEST: 'request',
  RESPONSE: 'response',
  FATAL: 'fatal'
});

export const ExtensionHostMethod = Object.freeze({
  COMMAND_REGISTER: 'commands.register',
  COMMAND_DISPOSE: 'commands.dispose',
  COMMAND_EXECUTE: 'commands.execute',
  CONTRIBUTION_REGISTER: 'contributions.register',
  CONTRIBUTION_DISPOSE: 'contributions.dispose',
  SOURCE_CONTROL_REGISTER: 'sourceControl.register',
  SOURCE_CONTROL_SET_STATE: 'sourceControl.setState',
  SOURCE_CONTROL_CLEAR_STATE: 'sourceControl.clearState',
  SOURCE_CONTROL_DISPOSE: 'sourceControl.dispose',
  // SCM calls are intentionally a separate protocol method rather than a
  // general host.request escape hatch. The renderer validates the operation
  // and the main broker remains the authority for local Git execution.
  SCM_GIT_REQUEST: 'scm.git.request',
  FILE_DECORATIONS_SCM_REGISTER: 'fileDecorations.scm.register',
  FILE_DECORATIONS_SCM_SET: 'fileDecorations.scm.set',
  FILE_DECORATIONS_SCM_CLEAR: 'fileDecorations.scm.clear',
  FILE_DECORATIONS_SCM_DISPOSE: 'fileDecorations.scm.dispose',
  DOCUMENT_VIEW_REGISTER: 'documentViews.register',
  DOCUMENT_VIEW_DISPOSE: 'documentViews.dispose',
  AGENT_REGISTER: 'agents.register',
  AGENT_SET_STATE: 'agents.setState',
  AGENT_CLEAR_STATE: 'agents.clearState',
  AGENT_DISPOSE: 'agents.dispose',
  AGENT_BROKER_REQUEST: 'agent.broker.request',
  SERVICE_GET: 'services.get',
  BROKER_REQUEST: 'host.request'
});

export const ExtensionSandboxMethod = Object.freeze({
  COMMAND_INVOKE: 'command.invoke',
  I18N_CHANGED: 'i18n.changed',
  DEACTIVATE: 'extension.deactivate'
});

export const ExtensionErrorCode = Object.freeze({
  CANCELLED: 'EXTENSION_CANCELLED',
  DENIED: 'EXTENSION_PERMISSION_DENIED',
  INVALID_REQUEST: 'EXTENSION_INVALID_REQUEST',
  NOT_FOUND: 'EXTENSION_NOT_FOUND',
  PROTOCOL: 'EXTENSION_PROTOCOL_ERROR',
  TIMEOUT: 'EXTENSION_TIMEOUT',
  UNAVAILABLE: 'EXTENSION_UNAVAILABLE'
});

const MAX_DEPTH = 24;
const MAX_ITEMS = 4096;
const MAX_STRING_LENGTH = 512 * 1024;
const MAX_PLUGIN_RPC_ERROR_CODE_LENGTH = 160;
const MAX_PLUGIN_RPC_ERROR_MESSAGE_LENGTH = 8 * 1024;

export function createExtensionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function serializeExtensionError(error, fallbackCode = ExtensionErrorCode.UNAVAILABLE) {
  const code = error && typeof error.code === 'string' && error.code
    ? error.code
    : fallbackCode;
  const message = error && typeof error.message === 'string' && error.message
    ? error.message
    : 'Extension operation failed.';
  return Object.freeze({ code, message: message.slice(0, MAX_STRING_LENGTH) });
}

export function deserializeExtensionError(value, fallbackCode = ExtensionErrorCode.UNAVAILABLE) {
  if (value && typeof value === 'object') {
    return createExtensionError(
      typeof value.code === 'string' && value.code ? value.code : fallbackCode,
      typeof value.message === 'string' && value.message ? value.message : 'Extension operation failed.'
    );
  }
  return createExtensionError(fallbackCode, 'Extension operation failed.');
}

export function unwrapPluginRpcResult(result) {
  if (!isPlainObject(result) ||
      result[PLUGIN_RPC_RESULT_MARKER] !== PLUGIN_RPC_RESULT_VERSION ||
      typeof result.ok !== 'boolean') {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Plugin RPC returned an invalid response.');
  }
  if (result.ok) return result.value;
  const failure = result.error;
  if (!isPlainObject(failure) ||
      typeof failure.code !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9._-]*$/.test(failure.code) ||
      failure.code.length > MAX_PLUGIN_RPC_ERROR_CODE_LENGTH ||
      typeof failure.message !== 'string' ||
      !failure.message ||
      failure.message.length > MAX_PLUGIN_RPC_ERROR_MESSAGE_LENGTH) {
    throw createExtensionError(ExtensionErrorCode.PROTOCOL, 'Plugin RPC returned an invalid failure.');
  }
  throw createExtensionError(failure.code, failure.message);
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return true;

    // Values returned by Electron contextBridge or another JS realm have that
    // realm's Object.prototype. Identity comparison with the renderer's
    // Object.prototype rejects those records even though they contain only
    // structured-clone data. Accept only a genuine foreign Object prototype;
    // class instances and custom prototype chains still fail this check.
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || typeof constructor.value !== 'function') return false;
    return constructor.value.name === 'Object' &&
      /^function Object\(\) \{ \[native code\] \}$/.test(Function.prototype.toString.call(constructor.value));
  } catch (_) {
    return false;
  }
}

// Never let a trusted renderer object (or an accessor/function hidden inside
// it) cross the extension boundary. This is intentionally narrower than the
// structured-clone algorithm.
export function cloneExtensionData(value, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : MAX_DEPTH;
  const maxItems = Number.isInteger(options.maxItems) ? options.maxItems : MAX_ITEMS;
  const maxStringLength = Number.isInteger(options.maxStringLength) ? options.maxStringLength : MAX_STRING_LENGTH;
  const seen = new WeakSet();
  let itemCount = 0;

  function clone(current, depth) {
    itemCount += 1;
    if (itemCount > maxItems * 8) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload is too large.');
    }
    if (depth > maxDepth) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload exceeds the maximum depth.');
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (current.length > maxStringLength) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload contains an oversized string.');
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload contains a non-finite number.');
      }
      return current;
    }
    if (current === undefined) return undefined;
    if (typeof current !== 'object') {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload must contain data only.');
    }
    if (seen.has(current)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload cannot contain circular data.');
    }
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > maxItems) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload contains too many items.');
      }
      const result = current.map((item) => clone(item, depth + 1));
      seen.delete(current);
      return result;
    }
    if (!isPlainObject(current)) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload must contain plain objects only.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Object.keys(descriptors);
    if (keys.length > maxItems) {
      throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload contains too many properties.');
    }
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw createExtensionError(ExtensionErrorCode.INVALID_REQUEST, 'Extension payload cannot contain accessors.');
      }
      result[key] = clone(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return result;
  }

  return clone(value, 0);
}

export function isExtensionRequestId(value) {
  return (Number.isSafeInteger(value) && value >= 1) ||
    (typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value));
}

export function isExtensionMessage(value) {
  return isPlainObject(value) &&
    value.protocolVersion === EXTENSION_PROTOCOL_VERSION &&
    typeof value.type === 'string';
}

export function isNamespacedExtensionId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(value);
}

export function assertExtensionOwnedId(extensionId, value, label) {
  if (typeof value !== 'string' || !value.startsWith(extensionId + '.')) {
    throw createExtensionError(
      ExtensionErrorCode.INVALID_REQUEST,
      label + ' id must use the extension namespace "' + extensionId + '.".'
    );
  }
  return value;
}
