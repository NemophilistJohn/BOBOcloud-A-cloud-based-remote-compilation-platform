'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVELOPE_KEY, createSecretCodec } = require('../main/secret-codec');

function fakeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  };
}

test('secret codec transparently seals and opens structured data', () => {
  const codec = createSecretCodec(fakeStorage());
  const value = { token: 'private', nested: { key: 'secret' } };
  const sealed = codec.seal(value);
  assert.equal(typeof sealed[ENVELOPE_KEY], 'string');
  assert.doesNotMatch(JSON.stringify(sealed), /private|secret/);
  assert.deepEqual(codec.open(sealed), value);
});

test('secret codec leaves data portable when secure storage is unavailable', () => {
  const codec = createSecretCodec({ isEncryptionAvailable: () => false });
  const value = { token: 'local' };
  assert.equal(codec.seal(value), value);
  assert.equal(codec.open(value), value);
  assert.throws(() => codec.open({ [ENVELOPE_KEY]: 'AA==' }), { code: 'SECURE_STORAGE_UNAVAILABLE' });
});
