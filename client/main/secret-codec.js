'use strict';

const ENVELOPE_KEY = '__bobocloudEncryptedV1';

function createSecretCodec(safeStorage) {
  function isSealed(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
      typeof value[ENVELOPE_KEY] === 'string');
  }

  function available() {
    try {
      return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable() && typeof safeStorage.encryptString === 'function' &&
        typeof safeStorage.decryptString === 'function');
    } catch (_) {
      return false;
    }
  }

  function seal(value) {
    if (!available()) return value;
    const plaintext = JSON.stringify(value);
    const ciphertext = safeStorage.encryptString(plaintext);
    return { [ENVELOPE_KEY]: Buffer.from(ciphertext).toString('base64') };
  }

  function open(value) {
    if (!isSealed(value)) return value;
    if (!available()) {
      const error = new Error('Encrypted settings cannot be opened because secure storage is unavailable');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    const plaintext = safeStorage.decryptString(Buffer.from(value[ENVELOPE_KEY], 'base64'));
    return JSON.parse(plaintext);
  }

  return Object.freeze({ available, isSealed, open, seal });
}

module.exports = { ENVELOPE_KEY, createSecretCodec };
