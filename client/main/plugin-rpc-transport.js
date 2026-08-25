'use strict';

const PLUGIN_RPC_RESULT_MARKER = '__bobocloudPluginRpcResult';
const PLUGIN_RPC_RESULT_VERSION = 1;
const MAX_ERROR_CODE_LENGTH = 160;
const MAX_ERROR_MESSAGE_LENGTH = 8 * 1024;
const FALLBACK_ERROR_CODE = 'EXTENSION_UNAVAILABLE';
const FALLBACK_ERROR_MESSAGE = 'Extension operation failed.';

function readErrorField(error, field) {
  try {
    return error && error[field];
  } catch (_) {
    return undefined;
  }
}

function normalizeErrorCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code || code.length > MAX_ERROR_CODE_LENGTH || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(code)) {
    return FALLBACK_ERROR_CODE;
  }
  return code;
}

function normalizeErrorMessage(error) {
  let value = readErrorField(error, 'message');
  if (typeof value !== 'string' && typeof error === 'string') value = error;
  const message = typeof value === 'string' ? value.trim() : '';
  return message ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) : FALLBACK_ERROR_MESSAGE;
}

function pluginRpcSuccess(value) {
  return Object.freeze({
    [PLUGIN_RPC_RESULT_MARKER]: PLUGIN_RPC_RESULT_VERSION,
    ok: true,
    value
  });
}

function pluginRpcFailure(error) {
  return Object.freeze({
    [PLUGIN_RPC_RESULT_MARKER]: PLUGIN_RPC_RESULT_VERSION,
    ok: false,
    error: Object.freeze({
      code: normalizeErrorCode(readErrorField(error, 'code')),
      message: normalizeErrorMessage(error)
    })
  });
}

async function capturePluginRpcResult(operation) {
  try {
    return pluginRpcSuccess(await operation());
  } catch (error) {
    return pluginRpcFailure(error);
  }
}

module.exports = {
  PLUGIN_RPC_RESULT_MARKER,
  PLUGIN_RPC_RESULT_VERSION,
  capturePluginRpcResult,
  pluginRpcFailure,
  pluginRpcSuccess
};
