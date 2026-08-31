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

const MAX_ERROR_CODE_LENGTH = 160;
const MAX_ERROR_MESSAGE_LENGTH = 8 * 1024;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function createExtensionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function serializeExtensionError(error, fallbackCode = ExtensionErrorCode.UNAVAILABLE) {
  const safeFallback = typeof fallbackCode === 'string' &&
      ERROR_CODE_PATTERN.test(fallbackCode) && fallbackCode.length <= MAX_ERROR_CODE_LENGTH
    ? fallbackCode
    : ExtensionErrorCode.UNAVAILABLE;
  const code = error && typeof error.code === 'string' &&
      ERROR_CODE_PATTERN.test(error.code) && error.code.length <= MAX_ERROR_CODE_LENGTH
    ? error.code
    : safeFallback;
  const message = error && typeof error.message === 'string' && error.message
    ? error.message
    : 'Extension operation failed.';
  return Object.freeze({ code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) });
}

export function deserializeExtensionError(value, fallbackCode = ExtensionErrorCode.UNAVAILABLE) {
  const serialized = normalizeSerializedExtensionError(value, fallbackCode);
  return createExtensionError(serialized.code, serialized.message);
}

function normalizeSerializedExtensionError(value, fallbackCode = ExtensionErrorCode.UNAVAILABLE) {
  const fallback = typeof fallbackCode === 'string' &&
      ERROR_CODE_PATTERN.test(fallbackCode) && fallbackCode.length <= MAX_ERROR_CODE_LENGTH
    ? fallbackCode
    : ExtensionErrorCode.UNAVAILABLE;
  if (!isSerializedExtensionError(value)) return { code: fallback, message: 'Extension operation failed.' };
  return { code: value.code, message: value.message };
}

export function isSerializedExtensionError(value) {
  if (!isPlainObject(value)) return false;
  return hasExactStringKeys(value, ['code', 'message']) &&
    typeof value.code === 'string' && ERROR_CODE_PATTERN.test(value.code) &&
    value.code.length <= MAX_ERROR_CODE_LENGTH && typeof value.message === 'string' &&
    value.message.length > 0 && value.message.length <= MAX_ERROR_MESSAGE_LENGTH;
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
      failure.code.length > MAX_ERROR_CODE_LENGTH ||
      typeof failure.message !== 'string' ||
      !failure.message ||
      failure.message.length > MAX_ERROR_MESSAGE_LENGTH) {
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

// This factory is embedded verbatim into the isolated Worker. Capture every
// intrinsic once, before downloaded code runs, instead of freezing the
// plugin's JavaScript realm or consulting mutable globals at request time.
export function createExtensionDataCloner() {
  const SafeError = Error;
  const SafeWeakSet = WeakSet;
  const safeApply = Reflect.apply;
  const safeArrayIsArray = Array.isArray;
  const safeFunctionToString = Function.prototype.toString;
  const safeHasOwn = Object.prototype.hasOwnProperty;
  const safeNumberIsFinite = Number.isFinite;
  const safeNumberIsInteger = Number.isInteger;
  const safeObjectCreate = Object.create;
  const safeObjectDefineProperty = Object.defineProperty;
  const safeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const safeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const safeObjectGetPrototypeOf = Object.getPrototypeOf;
  const safeObjectPrototype = Object.prototype;
  const safeOwnKeys = Reflect.ownKeys;
  const safeRegExpTest = RegExp.prototype.test;
  const safeWeakSetAdd = WeakSet.prototype.add;
  const safeWeakSetDelete = WeakSet.prototype.delete;
  const safeWeakSetHas = WeakSet.prototype.has;
  const arrayIndexPattern = /^(0|[1-9][0-9]*)$/;
  const nativeObjectPattern = /^function Object\(\) \{ \[native code\] \}$/;

  function apply(method, receiver, args) {
    return safeApply(method, receiver, args);
  }

  function hasOwn(value, key) {
    return apply(safeHasOwn, value, [key]);
  }

  function matches(pattern, value) {
    return apply(safeRegExpTest, pattern, [value]);
  }

  function option(options, name, fallback) {
    if (!options || typeof options !== 'object' || !hasOwn(options, name)) return fallback;
    return safeNumberIsInteger(options[name]) ? options[name] : fallback;
  }

  // Never let a trusted renderer object (or an accessor/function hidden
  // inside it) cross the extension boundary. This is intentionally narrower
  // than the structured-clone algorithm.
  return function cloneExtensionData(value, options = {}) {
    const maxDepth = option(options, 'maxDepth', 24);
    const maxItems = option(options, 'maxItems', 4096);
    const maxStringLength = option(options, 'maxStringLength', 512 * 1024);
    const maxBytes = option(options, 'maxBytes', 2 * 1024 * 1024);
    const seen = new SafeWeakSet();
    let itemCount = 0;
    let byteCount = 0;

    function invalid(message) {
      const error = new SafeError(message);
      error.code = 'EXTENSION_INVALID_REQUEST';
      return error;
    }

    function plainObject(current) {
      if (!current || typeof current !== 'object') return false;
      try {
        const prototype = safeObjectGetPrototypeOf(current);
        if (prototype === safeObjectPrototype || prototype === null) return true;
        if (safeObjectGetPrototypeOf(prototype) !== null) return false;
        const constructor = safeObjectGetOwnPropertyDescriptor(prototype, 'constructor');
        if (!constructor || typeof constructor.value !== 'function') return false;
        return constructor.value.name === 'Object' &&
          matches(nativeObjectPattern, apply(safeFunctionToString, constructor.value, []));
      } catch (_) {
        return false;
      }
    }

    function countBytes(bytes) {
      byteCount += bytes;
      if (byteCount > maxBytes) throw invalid('Extension payload exceeds the total size limit.');
    }

    function descriptorValue(descriptor) {
      if (!descriptor || !hasOwn(descriptor, 'value')) {
        throw invalid('Extension payload cannot contain accessors.');
      }
      return descriptor.value;
    }

    function cloneArray(current, depth) {
      if (current.length > maxItems) {
        throw invalid('Extension payload contains too many items.');
      }
      countBytes(current.length * 4);
      const descriptors = safeObjectGetOwnPropertyDescriptors(current);
      const keys = safeOwnKeys(descriptors);
      const result = [];
      result.length = current.length;
      for (let position = 0; position < keys.length; position += 1) {
        const key = keys[position];
        if (typeof key !== 'string') {
          throw invalid('Extension payload cannot contain symbol properties.');
        }
        if (key === 'length') continue;
        if (!matches(arrayIndexPattern, key) || +key >= current.length) {
          throw invalid('Extension arrays cannot contain custom properties.');
        }
        safeObjectDefineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptorValue(descriptors[key]), depth + 1),
          writable: true
        });
      }
      return result;
    }

    function clone(current, depth) {
      itemCount += 1;
      if (itemCount > maxItems * 8) {
        throw invalid('Extension payload is too large.');
      }
      if (depth > maxDepth) {
        throw invalid('Extension payload exceeds the maximum depth.');
      }
      if (current === null || typeof current === 'boolean') {
        countBytes(4);
        return current;
      }
      if (typeof current === 'string') {
        if (current.length > maxStringLength) {
          throw invalid('Extension payload contains an oversized string.');
        }
        countBytes(current.length * 2);
        return current;
      }
      if (typeof current === 'number') {
        if (!safeNumberIsFinite(current)) {
          throw invalid('Extension payload contains a non-finite number.');
        }
        countBytes(8);
        return current;
      }
      if (current === undefined) {
        countBytes(1);
        return undefined;
      }
      if (typeof current !== 'object') {
        throw invalid('Extension payload must contain data only.');
      }
      if (apply(safeWeakSetHas, seen, [current])) {
        throw invalid('Extension payload cannot contain circular data.');
      }
      apply(safeWeakSetAdd, seen, [current]);
      let result;
      if (safeArrayIsArray(current)) {
        result = cloneArray(current, depth);
      } else {
        if (!plainObject(current)) {
          throw invalid('Extension payload must contain plain objects only.');
        }
        const descriptors = safeObjectGetOwnPropertyDescriptors(current);
        const keys = safeOwnKeys(descriptors);
        if (keys.length > maxItems) {
          throw invalid('Extension payload contains too many properties.');
        }
        result = safeObjectCreate(null);
        for (let position = 0; position < keys.length; position += 1) {
          const key = keys[position];
          if (typeof key !== 'string') {
            throw invalid('Extension payload cannot contain symbol properties.');
          }
          if (key.length > maxStringLength) throw invalid('Extension payload contains an oversized property name.');
          countBytes(key.length * 2);
          result[key] = clone(descriptorValue(descriptors[key]), depth + 1);
        }
      }
      apply(safeWeakSetDelete, seen, [current]);
      return result;
    }

    return clone(value, 0);
  };
}

export const cloneExtensionData = createExtensionDataCloner();

export function isExtensionRequestId(value) {
  return (Number.isSafeInteger(value) && value >= 1) ||
    (typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value));
}

function hasExactStringKeys(value, allowed) {
  const keys = Reflect.ownKeys(value);
  return keys.length === allowed.length &&
    !keys.some((key) => typeof key !== 'string') &&
    keys.every((key) => allowed.includes(key));
}

export function isExtensionMessage(value) {
  if (!isPlainObject(value) || value.protocolVersion !== EXTENSION_PROTOCOL_VERSION || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === ExtensionMessageType.ACTIVATED) {
    return hasExactStringKeys(value, ['protocolVersion', 'type']);
  }
  if (value.type === ExtensionMessageType.ACTIVATION_FAILED || value.type === ExtensionMessageType.FATAL) {
    return hasExactStringKeys(value, ['protocolVersion', 'type', 'error']) && isSerializedExtensionError(value.error);
  }
  if (value.type === ExtensionMessageType.REQUEST) {
    return hasExactStringKeys(value, ['protocolVersion', 'type', 'id', 'method', 'args']) &&
      isExtensionRequestId(value.id) && typeof value.method === 'string' &&
      value.method.length > 0 && value.method.length <= 160;
  }
  if (value.type === ExtensionMessageType.RESPONSE) {
    if (!isExtensionRequestId(value.id) || typeof value.ok !== 'boolean') return false;
    return value.ok === true
      ? hasExactStringKeys(value, ['protocolVersion', 'type', 'id', 'ok', 'value'])
      : hasExactStringKeys(value, ['protocolVersion', 'type', 'id', 'ok', 'error']) && isSerializedExtensionError(value.error);
  }
  return false;
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
