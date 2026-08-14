import { DisposableStore } from './disposable.js';
import { ContributionPoint } from './contribution-registry.js';

export const PLUGIN_API_VERSION = '1.0.0';

export const PluginPermission = Object.freeze({
  COMMANDS_REGISTER: 'commands.register',
  COMMANDS_EXECUTE: 'commands.execute',
  CONTRIBUTIONS_REGISTER: 'contributions.register',
  SERVICES_READ: 'services.read'
});

const KNOWN_PERMISSIONS = new Set(Object.values(PluginPermission));
const KNOWN_CONTRIBUTION_POINTS = new Set(Object.values(ContributionPoint));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseVersion(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isValidSemver(value) {
  const match = String(value || '').match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
  );
  if (!match) return false;
  return !match[4] || match[4].split('.').every((identifier) => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function parsePartialVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length > 3 || parts.some((part) => !/^(?:0|[1-9]\d*|x|X|\*)$/.test(part))) return null;
  const numbers = [];
  let wildcard = false;
  for (const part of parts) {
    if (part === 'x' || part === 'X' || part === '*') {
      wildcard = true;
      numbers.push(null);
    } else {
      if (wildcard) return null;
      numbers.push(Number(part));
    }
  }
  while (numbers.length < 3) numbers.push(null);
  return { numbers, specified: parts.length };
}

function partialBounds(partial) {
  const firstMissing = partial.numbers.indexOf(null);
  if (firstMissing === 0) return { any: true };
  const lower = partial.numbers.map((value) => value == null ? 0 : value);
  if (firstMissing < 0) return { lower, upper: null, exact: true };
  const upper = [...lower];
  const bumpIndex = firstMissing - 1;
  upper[bumpIndex] += 1;
  for (let index = bumpIndex + 1; index < 3; index += 1) upper[index] = 0;
  return { lower, upper, exact: false };
}

function satisfiesToken(version, token) {
  if (token === '*' || token === 'x' || token === 'X') return true;
  const special = token.match(/^([\^~])(.+)$/);
  if (special) {
    const partial = parsePartialVersion(special[2]);
    if (!partial || partial.numbers[0] == null) return false;
    const lower = partial.numbers.map((value) => value == null ? 0 : value);
    let upper;
    if (special[1] === '~') {
      const bumpIndex = partial.specified <= 1 ? 0 : 1;
      upper = [...lower];
      upper[bumpIndex] += 1;
      for (let index = bumpIndex + 1; index < 3; index += 1) upper[index] = 0;
    } else if (lower[0] > 0) {
      upper = [lower[0] + 1, 0, 0];
    } else if (lower[1] > 0) {
      upper = [0, lower[1] + 1, 0];
    } else {
      upper = [0, 0, lower[2] + 1];
    }
    return compareVersion(version, lower) >= 0 && compareVersion(version, upper) < 0;
  }

  const comparator = token.match(/^(<=|>=|<|>|=)?(.+)$/);
  if (!comparator) return false;
  const operator = comparator[1] || '';
  const partial = parsePartialVersion(comparator[2]);
  if (!partial) return false;
  const bounds = partialBounds(partial);
  if (bounds.any) return operator === '' || operator === '=';
  if (operator) {
    const comparison = compareVersion(version, bounds.lower);
    if (operator === '=') {
      return bounds.exact
        ? comparison === 0
        : comparison >= 0 && compareVersion(version, bounds.upper) < 0;
    }
    if (operator === '>') return bounds.exact ? comparison > 0 : compareVersion(version, bounds.upper) >= 0;
    if (operator === '>=') return comparison >= 0;
    if (operator === '<') return comparison < 0;
    if (operator === '<=') return bounds.exact ? comparison <= 0 : compareVersion(version, bounds.upper) < 0;
    return false;
  }
  if (bounds.exact) return compareVersion(version, bounds.lower) === 0;
  return compareVersion(version, bounds.lower) >= 0 && compareVersion(version, bounds.upper) < 0;
}

function isCompatibleApiRange(range) {
  if (!isNonEmptyString(range)) return false;
  const current = parseVersion(PLUGIN_API_VERSION);
  const clauses = range.trim().split(/\s*\|\|\s*/);
  if (clauses.some((clause) => !clause)) return false;
  return clauses.some((clause) => {
    const tokens = clause.trim().split(/\s+/);
    return tokens.length > 0 && tokens.every((token) => satisfiesToken(current, token));
  });
}

export function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('Plugin manifest must be an object.');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(manifest.id || '')) {
    throw new Error('Plugin id must be namespaced, for example publisher.plugin-name.');
  }
  if (!isValidSemver(manifest.version)) {
    throw new Error('Plugin version must be valid semver.');
  }
  if (!manifest.engines || !isCompatibleApiRange(manifest.engines.pluginApi)) {
    throw new Error('Plugin requires an incompatible or missing engines.pluginApi range.');
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of permissions) {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      throw new Error('Unknown renderer plugin permission: ' + permission);
    }
  }

  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    displayName: isNonEmptyString(manifest.displayName) ? manifest.displayName : manifest.id,
    engines: Object.freeze({ ...manifest.engines }),
    permissions: Object.freeze([...new Set(permissions)])
  });
}

export class PluginRuntime {
  constructor(options) {
    if (!options || !options.services || !options.commands || !options.contributions) {
      throw new TypeError('PluginRuntime requires service, command, and contribution registries.');
    }
    this._services = options.services;
    this._commands = options.commands;
    this._contributions = options.contributions;
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._plugins = new Map();
    this._disposed = false;
    this._disposePromise = null;
  }

  async activate(manifest, pluginModule) {
    if (this._disposed) {
      const error = new Error('PluginRuntime has been disposed.');
      this._report('plugin-lifecycle', manifest && manifest.id, error);
      return { ok: false, error };
    }
    let normalized;
    try {
      normalized = validatePluginManifest(manifest);
      if (this._plugins.has(normalized.id)) throw new Error('Plugin is already active: ' + normalized.id);
      if (!pluginModule || typeof pluginModule.activate !== 'function') {
        throw new TypeError('Plugin module must export activate(context).');
      }
    } catch (error) {
      this._report('plugin-validate', manifest && manifest.id, error);
      return { ok: false, error };
    }

    const subscriptions = new DisposableStore({
      onError: (event) => this._report('plugin-dispose', normalized.id, event.error)
    });
    const permissions = new Set(normalized.permissions);
    const context = this._createContext(normalized, permissions, subscriptions);
    const record = {
      manifest: normalized,
      module: pluginModule,
      subscriptions,
      status: 'activating',
      activationWork: null,
      activationPromise: null,
      activationError: null,
      deactivateRequested: false,
      deactivationPromise: null,
      cleaned: false
    };
    this._plugins.set(normalized.id, record);

    record.activationWork = Promise.resolve().then(async () => {
      try {
        const activationResult = await pluginModule.activate(context);
        if (typeof activationResult === 'function') {
          subscriptions.add({ dispose: activationResult });
        } else if (activationResult && typeof activationResult.dispose === 'function') {
          subscriptions.add(activationResult);
        }
      } catch (error) {
        record.activationError = error;
        throw error;
      }
    });

    record.activationPromise = (async () => {
      try {
        await record.activationWork;
        if (record.deactivateRequested || this._disposed) {
          await this._beginDeactivation(record);
          return { ok: false, error: new Error('Plugin activation was cancelled: ' + normalized.id) };
        }
        record.status = 'active';
        return { ok: true, id: normalized.id };
      } catch (error) {
        this._cleanupRecord(record);
        this._report('plugin-activate', normalized.id, error);
        return { ok: false, error };
      }
    })();
    return record.activationPromise;
  }

  async deactivate(id) {
    const record = this._plugins.get(id);
    if (!record) return { ok: false, error: new Error('Plugin is not active: ' + id) };
    return this._beginDeactivation(record);
  }

  list() {
    return Array.from(this._plugins.values(), (record) => Object.freeze({
      id: record.manifest.id,
      version: record.manifest.version,
      displayName: record.manifest.displayName,
      status: record.status
    }));
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = (async () => {
      const records = Array.from(this._plugins.values()).reverse();
      for (const record of records) await this._beginDeactivation(record);
    })();
    return this._disposePromise;
  }

  _createContext(manifest, permissions, subscriptions) {
    const requirePermission = (permission) => {
      if (!permissions.has(permission)) {
        throw new Error('Plugin "' + manifest.id + '" did not declare permission: ' + permission);
      }
    };

    return Object.freeze({
      apiVersion: PLUGIN_API_VERSION,
      plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
      subscriptions: Object.freeze({ add: (disposable) => subscriptions.add(disposable) }),
      services: Object.freeze({
        get: (id) => {
          requirePermission(PluginPermission.SERVICES_READ);
          return this._services.getForPlugin(id);
        }
      }),
      commands: Object.freeze({
        register: (id, handler, metadata = {}) => {
          requirePermission(PluginPermission.COMMANDS_REGISTER);
          this._requireOwnedId(manifest.id, id, 'Command');
          const disposable = this._commands.register(id, handler, { ...metadata, owner: manifest.id });
          subscriptions.add(disposable);
          return disposable;
        },
        execute: (id, ...args) => {
          requirePermission(PluginPermission.COMMANDS_EXECUTE);
          return this._commands.execute(id, ...args);
        }
      }),
      contributions: Object.freeze({
        register: (point, contribution, options = {}) => {
          requirePermission(PluginPermission.CONTRIBUTIONS_REGISTER);
          if (!KNOWN_CONTRIBUTION_POINTS.has(point)) {
            throw new Error('Unsupported plugin contribution point: ' + point);
          }
          this._requireOwnedId(manifest.id, options.id || contribution.id, 'Contribution');
          const disposable = this._contributions.register(point, contribution, {
            ...options,
            owner: manifest.id
          });
          subscriptions.add(disposable);
          return disposable;
        }
      })
    });
  }

  _report(source, id, error) {
    try {
      this._onError({ source, id, error });
    } catch (_) {
      // Error reporting cannot be allowed to break host lifecycle cleanup.
    }
  }

  _beginDeactivation(record) {
    if (record.deactivationPromise) return record.deactivationPromise;
    record.deactivateRequested = true;
    record.status = 'deactivating';
    record.deactivationPromise = (async () => {
      try {
        await record.activationWork;
      } catch (_) {
        // Activation reports its own error and still needs deterministic cleanup.
      }

      let deactivateError = null;
      if (!record.activationError) {
        try {
          if (typeof record.module.deactivate === 'function') await record.module.deactivate();
        } catch (error) {
          deactivateError = error;
          this._report('plugin-deactivate', record.manifest.id, error);
        }
      }
      this._cleanupRecord(record);
      return deactivateError
        ? { ok: false, error: deactivateError }
        : { ok: true, id: record.manifest.id };
    })();
    return record.deactivationPromise;
  }

  _cleanupRecord(record) {
    if (record.cleaned) return;
    record.cleaned = true;
    if (this._plugins.get(record.manifest.id) === record) this._plugins.delete(record.manifest.id);
    record.subscriptions.dispose();
    this._commands.disposeOwner(record.manifest.id);
    this._contributions.disposeOwner(record.manifest.id);
    this._services.disposeOwner(record.manifest.id);
  }

  _requireOwnedId(pluginId, id, label) {
    if (typeof id !== 'string' || !id.startsWith(pluginId + '.')) {
      throw new Error(label + ' id must use the plugin namespace "' + pluginId + '.".');
    }
  }
}
