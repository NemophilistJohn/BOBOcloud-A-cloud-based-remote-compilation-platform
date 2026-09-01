import { DisposableStore } from './disposable.js';
import { ContributionPoint } from './contribution-registry.js';
import { SourceControlStateStore, validateSourceControlDescriptor } from './source-control.js';
import { validateDocumentViewDescriptor } from './document-view.js';
import { validateAgentDescriptor } from './agent.js';
import pluginSemver from '../../shared/plugin-semver.js';

const { isValidSemver, satisfiesVersionRange } = pluginSemver;

export const PLUGIN_API_VERSION = '1.6.0';

export const PluginPermission = Object.freeze({
  COMMANDS_REGISTER: 'commands.register',
  COMMANDS_EXECUTE: 'commands.execute',
  CONTRIBUTIONS_REGISTER: 'contributions.register',
  SERVICES_READ: 'services.read',
  SOURCE_CONTROL_REGISTER: 'sourceControl.register',
  SCM_GIT_READ: 'scm.git.read',
  SCM_GIT_WRITE: 'scm.git.write',
  FILE_DECORATIONS_SCM: 'fileDecorations.scm',
  DOCUMENT_VIEWS_REGISTER: 'documentViews.register',
  DOCUMENTS_READ: 'documents.read',
  AGENTS_REGISTER: 'agents.register',
  MODELS_GENERATE: 'models.generate',
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_WRITE: 'workspace.write',
  PROCESS_EXECUTE: 'process.execute',
  SKILLS_READ: 'skills.read',
  STORAGE_LOCAL: 'storage.local'
});

const KNOWN_PERMISSIONS = new Set(Object.values(PluginPermission));
// `sourceControl` is intentionally not available through the generic
// contributions API: it has its own user-visible permission and structural
// validation. Installed packages use the isolated extension host; this legacy
// runtime mirrors the same contribution ownership boundary for core callers.
const KNOWN_CONTRIBUTION_POINTS = new Set(
  Object.values(ContributionPoint).filter((point) => (
    point !== ContributionPoint.SOURCE_CONTROL &&
    point !== ContributionPoint.DOCUMENT_VIEWS &&
    point !== ContributionPoint.AGENTS
  ))
);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCompatibleApiRange(range) {
  return satisfiesVersionRange(PLUGIN_API_VERSION, range);
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
    permissions: Object.freeze([...new Set(permissions)]),
    contributes: manifest.contributes && typeof manifest.contributes === 'object'
      ? Object.freeze(JSON.parse(JSON.stringify(manifest.contributes)))
      : Object.freeze({})
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
    this._sourceControls = options.sourceControls || new SourceControlStateStore({ onError: options.onError });
    this._ownsSourceControls = !options.sourceControls;
    this._agents = options.agents;
    this._getPluginI18n = typeof options.getPluginI18n === 'function'
      ? options.getPluginI18n
      : () => ({ locale: 'en', messages: Object.create(null) });
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
      if (this._ownsSourceControls) this._sourceControls.dispose();
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
      }),
      sourceControl: Object.freeze({
        async register(descriptor) {
          requirePermission(PluginPermission.SOURCE_CONTROL_REGISTER);
          const normalizedDescriptor = validateSourceControlDescriptor(descriptor);
          this._requireOwnedId(manifest.id, normalizedDescriptor.id, 'Source-control descriptor');
          if (normalizedDescriptor.openCommand) {
            this._requireOwnedId(manifest.id, normalizedDescriptor.openCommand, 'Source-control open command');
          }
          const disposable = this._contributions.register(ContributionPoint.SOURCE_CONTROL, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          let stateHandle;
          try {
            stateHandle = this._sourceControls.register(normalizedDescriptor, {
              owner: manifest.id,
              commandPrefix: manifest.id + '.'
            });
          } catch (error) {
            disposable.dispose();
            throw error;
          }
          let active = true;
          const provider = Object.freeze({
            id: normalizedDescriptor.id,
            async setState(state) {
              if (!active) throw new Error('Source-control state provider has been disposed.');
              return stateHandle.setState(state);
            },
            async clearState() {
              return active ? stateHandle.clearState() : { version: 0 };
            },
            dispose: () => {
              if (!active) return;
              active = false;
              stateHandle.dispose();
              disposable.dispose();
            }
          });
          subscriptions.add(provider);
          return provider;
        }
      }),
      documentViews: Object.freeze({
        register: (descriptor) => {
          requirePermission(PluginPermission.DOCUMENT_VIEWS_REGISTER);
          requirePermission(PluginPermission.DOCUMENTS_READ);
          const normalizedDescriptor = validateDocumentViewDescriptor(descriptor, manifest.id);
          const declared = Array.isArray(manifest.contributes.documentViewers)
            ? manifest.contributes.documentViewers.find((candidate) => candidate.id === normalizedDescriptor.id)
            : null;
          if (!declared) throw new Error('Document viewer is not declared in the plugin manifest.');
          const disposable = this._contributions.register(ContributionPoint.DOCUMENT_VIEWS, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          subscriptions.add(disposable);
          return disposable;
        }
      }),
      agents: Object.freeze({
        register: (descriptor) => {
          requirePermission(PluginPermission.AGENTS_REGISTER);
          if (!this._agents) throw new Error('Agent state store is unavailable.');
          const normalizedDescriptor = validateAgentDescriptor(descriptor, manifest.id);
          const contributionDisposable = this._contributions.register(ContributionPoint.AGENTS, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          let stateHandle;
          try {
            stateHandle = this._agents.register(normalizedDescriptor, { owner: manifest.id });
          } catch (error) {
            contributionDisposable.dispose();
            throw error;
          }
          const provider = Object.freeze({
            id: normalizedDescriptor.id,
            setState: (state) => stateHandle.setState(state),
            clearState: () => stateHandle.clearState(),
            dispose: () => {
              stateHandle.dispose();
              contributionDisposable.dispose();
            }
          });
          subscriptions.add(provider);
          return provider;
        }
      }),
      i18n: this._createPluginI18n(manifest)
    });
  }

  _createPluginI18n(manifest) {
    let source;
    try {
      source = this._getPluginI18n(manifest);
    } catch (_) {
      source = null;
    }
    const locale = source && typeof source.locale === 'string' && source.locale ? source.locale : 'en';
    const messages = source && source.messages && typeof source.messages === 'object' ? source.messages : Object.create(null);
    const listeners = new Set();
    const t = (key, values) => {
      const sourceKey = String(key == null ? '' : key);
      const template = Object.prototype.hasOwnProperty.call(messages, sourceKey) ? String(messages[sourceKey]) : sourceKey;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return template;
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ));
    };
    return Object.freeze({
      locale,
      t,
      onDidChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('Plugin i18n listener must be a function.');
        listeners.add(listener);
        return { dispose() { listeners.delete(listener); } };
      }
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
    this._sourceControls.disposeOwner(record.manifest.id);
    if (this._agents) this._agents.disposeOwner(record.manifest.id);
    this._services.disposeOwner(record.manifest.id);
  }

  _requireOwnedId(pluginId, id, label) {
    if (typeof id !== 'string' || !id.startsWith(pluginId + '.')) {
      throw new Error(label + ' id must use the plugin namespace "' + pluginId + '.".');
    }
  }
}
