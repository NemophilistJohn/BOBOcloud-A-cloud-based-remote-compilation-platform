'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'manifest.json';
const MESSAGES_FILE = 'messages.json';
const MANIFEST_LIMIT = 32 * 1024;
const MESSAGES_LIMIT = 512 * 1024;
const MAX_MESSAGES = 5000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, field, options) {
  const opts = options || {};
  if (typeof value !== 'string') throw new Error(field + ' must be a string');
  if (!opts.allowEmpty && value.length === 0) throw new Error(field + ' cannot be empty');
  if (value.length > (opts.maxLength || 160)) throw new Error(field + ' is too long');
  if (/\0|[\r\n]/.test(value)) throw new Error(field + ' contains invalid characters');
  return value;
}

function validateId(value, field, allowEmpty) {
  assertString(value, field, { allowEmpty: !!allowEmpty, maxLength: 64 });
  if (allowEmpty && value === '') return value;
  if (!ID_PATTERN.test(value)) throw new Error(field + ' has an invalid identifier');
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class LanguagePackManager {
  constructor(options) {
    if (!options || !options.builtinRoot || !options.userDataPath) {
      throw new Error('LanguagePackManager requires builtinRoot and userDataPath');
    }

    this.builtinRoot = path.resolve(options.builtinRoot);
    this.userDataPath = path.resolve(options.userDataPath);
    this.userRoot = path.join(this.userDataPath, 'language-packs');
    this.settingsPath = path.join(this.userDataPath, 'language-settings.json');
    this.isPackaged = Boolean(options.isPackaged);
    this.onDidChange = typeof options.onDidChange === 'function' ? options.onDidChange : null;
    this.registry = new Map();
    this.errors = [];
    this.activeId = 'en';
    this.watchers = new Map();
    this.watchTimer = null;
    this.verificationTimer = null;
    this.started = false;
  }

  startup() {
    if (this.started) return this._startupPayload();
    fs.mkdirSync(this.userRoot, { recursive: true });
    this._scan(false);
    this.activeId = this._resolveActiveId(this._readSettings().activeId);
    this._writeSettingsIfNeeded();
    this.started = true;
    this._syncWatchers();
    return this._startupPayload();
  }

  list() {
    this._ensureStarted();
    return {
      activeId: this.activeId,
      packs: this._packList(),
      errors: clone(this.errors)
    };
  }

  load(id) {
    this._ensureStarted();
    validateId(id, 'language pack id');
    const pack = this.registry.get(id);
    if (!pack) throw new Error('Language pack not found: ' + id);
    return this._publicPack(pack, true);
  }

  setActive(id) {
    this._ensureStarted();
    validateId(id, 'language pack id');
    if (!this.registry.has(id)) throw new Error('Language pack not found: ' + id);
    if (id === this.activeId) return this._startupPayload();
    this.activeId = id;
    this._writeSettings();
    this._emitChange('active');
    return this._startupPayload();
  }

  installDirectory(sourceDirectory) {
    this._ensureStarted();
    if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim()) {
      throw new Error('A language pack directory is required');
    }

    const source = fs.realpathSync(path.resolve(sourceDirectory));
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory()) throw new Error('Selected language pack path is not a directory');
    const pack = this._readPackDirectory(source, 'user', false);
    const target = this._safeUserPackPath(pack.manifest.id);
    const suffix = process.pid + '-' + Date.now();
    const staging = this._safeUserPackPath('.install-' + pack.manifest.id + '-' + suffix, true);
    const backup = this._safeUserPackPath('.backup-' + pack.manifest.id + '-' + suffix, true);
    let movedExisting = false;

    fs.mkdirSync(staging);
    try {
      fs.writeFileSync(path.join(staging, MANIFEST_FILE), JSON.stringify(pack.manifest, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(staging, MESSAGES_FILE), JSON.stringify(pack.messages, null, 2) + '\n', 'utf8');

      const existing = this._lstat(target);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new Error('Refusing to overwrite an unsafe language pack path');
        }
        fs.renameSync(target, backup);
        movedExisting = true;
      }
      fs.renameSync(staging, target);
      if (movedExisting) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      try {
        if (!this._lstat(target) && movedExisting && this._lstat(backup)) fs.renameSync(backup, target);
      } catch (_) {}
      try { if (this._lstat(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }

    return this.refresh('install');
  }

  remove(id) {
    this._ensureStarted();
    validateId(id, 'language pack id');
    const pack = this.registry.get(id);
    if (!pack || pack.source !== 'user') {
      throw new Error('Only installed user language packs can be removed');
    }

    const target = this._safeUserPackPath(id);
    const stat = this._lstat(target);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Language pack directory is missing or unsafe');
    }
    fs.rmSync(target, { recursive: true, force: true });
    return this.refresh('remove');
  }

  openFolderPath() {
    fs.mkdirSync(this.userRoot, { recursive: true });
    return this.userRoot;
  }

  refresh(reason) {
    this._ensureStarted();
    const previousActive = this.activeId;
    this._scan(reason === 'filesystem');
    this.activeId = this._resolveActiveId(previousActive);
    if (this.activeId !== previousActive) this._writeSettings();
    this._syncWatchers();
    this._emitChange(reason || 'refresh');
    return this._startupPayload();
  }

  t(sourceEnglish, replacements) {
    if (typeof sourceEnglish !== 'string') return '';
    if (!this.started) return sourceEnglish;

    let translated;
    const visited = new Set();
    let id = this.activeId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const pack = this.registry.get(id);
      if (!pack) break;
      if (Object.prototype.hasOwnProperty.call(pack.messages, sourceEnglish)) {
        translated = pack.messages[sourceEnglish];
        break;
      }
      id = pack.manifest.fallback;
    }
    if (translated === undefined) translated = sourceEnglish;
    if (!isPlainObject(replacements)) return translated;
    return translated.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(replacements, key) ? String(replacements[key]) : match
    ));
  }

  dispose() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.watchTimer = null;
    this.verificationTimer = null;
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (_) {}
    }
    this.watchers.clear();
    this.started = false;
  }

  _ensureStarted() {
    if (!this.started) this.startup();
  }

  _scan(preserveInvalid) {
    const previous = this.registry;
    const next = new Map();
    this.errors = [];
    this._scanRoot(this.builtinRoot, 'builtin', next, previous, preserveInvalid);
    this._scanRoot(this.userRoot, 'user', next, previous, preserveInvalid);
    this.registry = next;
  }

  _scanRoot(root, source, next, previous, preserveInvalid) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') this.errors.push({ source, directory: root, error: error.message });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      try {
        const pack = this._readPackDirectory(directory, source, true);
        next.set(pack.manifest.id, pack);
      } catch (error) {
        const prior = previous.get(entry.name);
        const canPreserve = preserveInvalid && prior && prior.source === source &&
          path.resolve(prior.directory) === path.resolve(directory);
        if (canPreserve) next.set(entry.name, Object.assign({}, prior, { stale: true }));
        this.errors.push({
          source,
          directory: entry.name,
          error: error.message,
          preserved: Boolean(canPreserve)
        });
      }
    }
  }

  _readPackDirectory(directory, source, requireDirectoryMatch) {
    const manifestRaw = this._readJsonFile(directory, MANIFEST_FILE, MANIFEST_LIMIT);
    const manifest = this._validateManifest(manifestRaw);
    if (requireDirectoryMatch && path.basename(directory) !== manifest.id) {
      throw new Error('manifest id must match its directory name');
    }
    const messagesRaw = this._readJsonFile(directory, MESSAGES_FILE, MESSAGES_LIMIT);
    const messages = this._validateMessages(messagesRaw);
    const manifestSize = fs.statSync(path.join(directory, MANIFEST_FILE)).size;
    const messagesSize = fs.statSync(path.join(directory, MESSAGES_FILE)).size;
    return {
      manifest,
      messages,
      source,
      directory,
      byteSize: manifestSize + messagesSize
    };
  }

  _readJsonFile(directory, filename, sizeLimit) {
    const filePath = path.join(directory, filename);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(filename + ' must be a regular file');
    if (stat.size <= 0 || stat.size > sizeLimit) {
      throw new Error(filename + ' exceeds the allowed size');
    }
    let text = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > sizeLimit) {
      throw new Error(filename + ' exceeds the allowed size');
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(filename + ' is not valid JSON: ' + error.message);
    }
  }

  _validateManifest(value) {
    if (!isPlainObject(value)) throw new Error('manifest.json must contain an object');
    if (!Number.isInteger(value.schemaVersion) || value.schemaVersion !== 1) {
      throw new Error('manifest.schemaVersion is unsupported; expected 1');
    }
    const manifest = {
      schemaVersion: value.schemaVersion,
      id: validateId(value.id, 'manifest.id'),
      name: assertString(value.name, 'manifest.name', { maxLength: 100 }),
      nativeName: assertString(value.nativeName, 'manifest.nativeName', { maxLength: 100 }),
      locale: assertString(value.locale, 'manifest.locale', { maxLength: 48 }),
      version: assertString(value.version, 'manifest.version', { maxLength: 32 }),
      direction: assertString(value.direction, 'manifest.direction', { maxLength: 3 }),
      monacoLocale: assertString(value.monacoLocale, 'manifest.monacoLocale', { allowEmpty: true, maxLength: 48 }),
      fallback: validateId(value.fallback, 'manifest.fallback', true)
    };
    if (!LOCALE_PATTERN.test(manifest.locale)) throw new Error('manifest.locale is invalid');
    if (manifest.monacoLocale && !LOCALE_PATTERN.test(manifest.monacoLocale)) {
      throw new Error('manifest.monacoLocale is invalid');
    }
    if (manifest.direction !== 'ltr' && manifest.direction !== 'rtl') {
      throw new Error('manifest.direction must be ltr or rtl');
    }
    if (!/^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)) {
      throw new Error('manifest.version is invalid');
    }
    return manifest;
  }

  _validateMessages(value) {
    if (!isPlainObject(value)) throw new Error('messages.json must contain an object');
    const keys = Object.keys(value);
    if (keys.length > MAX_MESSAGES) throw new Error('messages.json has too many entries');
    const messages = Object.create(null);
    for (const key of keys) {
      if (!key || key.length > 256 || BLOCKED_KEYS.has(key) || /\0/.test(key)) {
        throw new Error('messages.json contains an invalid key');
      }
      const message = value[key];
      if (typeof message !== 'string') throw new Error('messages.json values must be strings');
      if (message.length > 8192 || /\0/.test(message)) throw new Error('messages.json contains an invalid value');
      const sourcePlaceholders = (key.match(/\{[A-Za-z0-9_.-]+\}/g) || []).sort();
      const translatedPlaceholders = (message.match(/\{[A-Za-z0-9_.-]+\}/g) || []).sort();
      if (sourcePlaceholders.join('\0') !== translatedPlaceholders.join('\0')) {
        throw new Error('messages.json placeholders must match their source keys');
      }
      messages[key] = message;
    }
    return messages;
  }

  _readSettings() {
    try {
      const stat = fs.lstatSync(this.settingsPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) return {};
      const value = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      if (!isPlainObject(value)) return {};
      if (typeof value.activeId !== 'string' || !ID_PATTERN.test(value.activeId)) return {};
      return { activeId: value.activeId };
    } catch (_) {
      return {};
    }
  }

  _writeSettingsIfNeeded() {
    const settings = this._readSettings();
    if (settings.activeId !== this.activeId) this._writeSettings();
  }

  _writeSettings() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const temporary = this.settingsPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ activeId: this.activeId }, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(temporary, this.settingsPath);
    } catch (_) {
      fs.copyFileSync(temporary, this.settingsPath);
      fs.unlinkSync(temporary);
    }
  }

  _resolveActiveId(candidate) {
    if (candidate && this.registry.has(candidate)) return candidate;
    if (this.registry.has('en')) return 'en';
    const first = Array.from(this.registry.keys()).sort()[0];
    return first || 'en';
  }

  _startupPayload() {
    const pack = this.registry.has(this.activeId) ? this._publicPack(this.registry.get(this.activeId), true) : null;
    return {
      activeId: this.activeId,
      packs: this._packList(),
      pack,
      errors: clone(this.errors)
    };
  }

  _packList() {
    return Array.from(this.registry.values())
      .map((pack) => this._publicPack(pack, false))
      .sort((left, right) => left.manifest.nativeName.localeCompare(right.manifest.nativeName));
  }

  _publicPack(pack, includeMessages) {
    const value = {
      manifest: clone(pack.manifest),
      source: pack.source,
      removable: pack.source === 'user',
      byteSize: pack.byteSize,
      stale: Boolean(pack.stale)
    };
    if (includeMessages) value.messages = clone(pack.messages);
    return value;
  }

  _safeUserPackPath(id, internal) {
    if (internal) {
      if (!/^\.(?:install|backup)-[A-Za-z0-9._-]+-[0-9]+-[0-9]+$/.test(id)) {
        throw new Error('Invalid internal language pack path');
      }
    } else {
      validateId(id, 'language pack id');
    }
    const target = path.resolve(this.userRoot, id);
    const relative = path.relative(this.userRoot, target);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Language pack path escapes the user language directory');
    }
    return target;
  }

  _syncWatchers() {
    const desired = new Set([this.userRoot]);
    const recursiveRoots = new Set([this.userRoot]);
    for (const directory of this._childDirectories(this.userRoot)) desired.add(directory);
    if (!this.isPackaged) {
      desired.add(this.builtinRoot);
      recursiveRoots.add(this.builtinRoot);
      for (const directory of this._childDirectories(this.builtinRoot)) desired.add(directory);
    }

    for (const [watchedPath, watcher] of this.watchers) {
      if (!desired.has(watchedPath)) {
        try { watcher.close(); } catch (_) {}
        this.watchers.delete(watchedPath);
      }
    }
    for (const watchedPath of desired) {
      if (this.watchers.has(watchedPath)) continue;
      try {
        let watcher;
        try {
          watcher = fs.watch(watchedPath, {
            persistent: false,
            recursive: recursiveRoots.has(watchedPath)
          }, () => this._scheduleWatchedRefresh());
        } catch (error) {
          if (!recursiveRoots.has(watchedPath)) throw error;
          watcher = fs.watch(watchedPath, { persistent: false }, () => this._scheduleWatchedRefresh());
        }
        watcher.on('error', () => {
          this.watchers.delete(watchedPath);
          try { watcher.close(); } catch (_) {}
          this._scheduleWatchedRefresh();
        });
        watcher.on('close', () => {
          if (!this.started || this.watchers.get(watchedPath) !== watcher) return;
          this.watchers.delete(watchedPath);
          this._scheduleWatchedRefresh();
        });
        this.watchers.set(watchedPath, watcher);
      } catch (_) {}
    }
  }

  _childDirectories(root) {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name));
    } catch (_) {
      return [];
    }
  }

  _scheduleWatchedRefresh() {
    // Use a trailing delay without resetting it for every event. On Windows a
    // removed watched directory can emit a continuous rename burst; resetting
    // the timer would starve the refresh indefinitely.
    if (this.watchTimer) return;
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.verificationTimer = null;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      try {
        const payload = this.refresh('filesystem');
        if (payload.errors.some((error) => error.preserved)) {
          // A directory watcher can fire while an atomic save or directory removal is
          // still in progress. Recheck once, retaining the snapshot if it is still invalid.
          this.verificationTimer = setTimeout(() => {
            this.verificationTimer = null;
            try { this.refresh('filesystem'); } catch (error) {
              console.error('[language-packs] verification refresh failed:', error.message);
            }
          }, 450);
        }
      } catch (error) {
        console.error('[language-packs] refresh failed:', error.message);
      }
    }, 180);
  }

  _emitChange(reason) {
    if (!this.onDidChange) return;
    this.onDidChange({
      activeId: this.activeId,
      packs: this._packList(),
      errors: clone(this.errors),
      reason
    });
  }

  _lstat(target) {
    try { return fs.lstatSync(target); } catch (_) { return null; }
  }
}

module.exports = { LanguagePackManager };
