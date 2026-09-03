import type {
  PluginApiVersionDto,
  PluginManifestDto,
  PluginManifestEnginesDto,
  PluginManifestRegistrationDto,
  PluginPermissionDto,
  PluginRuntimeActivationValue,
  PluginRuntimeAgentProvider,
  PluginRuntimeCommandHandler,
  PluginRuntimeCommandMetadataDto,
  PluginRuntimeContext,
  PluginRuntimeContract,
  PluginRuntimeContributionOptionsDto,
  PluginRuntimeContributionPointDto,
  PluginRuntimeContributionRegistrationDto,
  PluginRuntimeErrorSourceDto,
  PluginRuntimeI18n,
  PluginRuntimeI18nChangeListener,
  PluginRuntimeI18nValuesDto,
  PluginRuntimeLocalizationRegistrationDto,
  PluginRuntimeModule,
  PluginRuntimeObservedErrorEvent,
  PluginRuntimeOperationResultDto,
  PluginRuntimeOptions,
  PluginRuntimeSnapshotDto,
  PluginRuntimeSourceControlProvider,
  PluginRuntimeStatusDto
} from '../../types/plugin-runtime';
import type {
  AgentDescriptorRegistrationDto,
  AgentStateHandle,
  AgentStateRegistrationDto,
  AgentStateStoreContract
} from '../../types/agent';
import type { DocumentViewDescriptorRegistrationDto } from '../../types/document-view';
import type { Disposable, MaybeAsyncDisposable } from '../../types/lifecycle';
import type {
  SourceControlStateHandle,
  SourceControlDescriptorRegistrationDto,
  SourceControlStateRegistrationDto,
  SourceControlStateStoreContract
} from '../../types/source-control';
import { DisposableStore } from './disposable.js';
import { ContributionPoint } from './contribution-registry';
import { SourceControlStateStore, validateSourceControlDescriptor } from './source-control.js';
import { validateDocumentViewDescriptor } from './document-view.js';
import { validateAgentDescriptor } from './agent.js';
import pluginSemver from '../../shared/plugin-semver.js';

interface PluginSemverModule {
  isValidSemver(value: unknown): boolean;
  satisfiesVersionRange(version: unknown, range: unknown): boolean;
}

interface PluginRuntimeRecord<PluginServices extends object> {
  readonly manifest: PluginManifestDto;
  readonly module: PluginRuntimeModule<PluginServices>;
  readonly subscriptions: DisposableStore;
  status: PluginRuntimeStatusDto;
  activationWork: Promise<void> | null;
  activationPromise: Promise<PluginRuntimeOperationResultDto> | null;
  activationError: unknown;
  activationFailed: boolean;
  deactivateRequested: boolean;
  deactivationPromise: Promise<PluginRuntimeOperationResultDto> | null;
  cleanupPromise: Promise<void> | null;
  cleaned: boolean;
}

const { isValidSemver, satisfiesVersionRange } = pluginSemver as PluginSemverModule;

export const PLUGIN_API_VERSION: PluginApiVersionDto = '1.6.0';

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
} as const satisfies Readonly<Record<string, PluginPermissionDto>>);

const KNOWN_PERMISSIONS: ReadonlySet<PluginPermissionDto> = new Set(Object.values(PluginPermission));
// `sourceControl` is intentionally not available through the generic
// contributions API: it has its own user-visible permission and structural
// validation. Installed packages use the isolated extension host; this legacy
// runtime mirrors the same contribution ownership boundary for core callers.
const KNOWN_CONTRIBUTION_POINTS: ReadonlySet<string> = new Set(
  Object.values(ContributionPoint).filter((point) => (
    point !== ContributionPoint.SOURCE_CONTROL &&
    point !== ContributionPoint.DOCUMENT_VIEWS &&
    point !== ContributionPoint.AGENTS
  ))
);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCompatibleApiRange(range: unknown): range is string {
  return typeof range === 'string' && satisfiesVersionRange(PLUGIN_API_VERSION, range);
}

function manifestIdForReport(manifest: unknown): string | undefined {
  if (!manifest || (typeof manifest !== 'object' && typeof manifest !== 'function')) return undefined;
  try {
    const id = (manifest as { readonly id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  } catch (_) {
    return undefined;
  }
}

function clonePluginContributes(value: object): Readonly<Record<string, unknown>> {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new TypeError('Plugin contributes must serialize to an object.');
  }
  return Object.freeze(cloned as Record<string, unknown>);
}

export function validatePluginManifest(manifest: unknown): PluginManifestDto {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('Plugin manifest must be an object.');
  const source = manifest as Record<string, unknown>;
  const manifestId = source.id;
  if (
    typeof manifestId !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]*\.[a-z0-9][a-z0-9.-]*$/.test(manifestId)
  ) {
    throw new Error('Plugin id must be namespaced, for example publisher.plugin-name.');
  }
  const manifestVersion = source.version;
  if (typeof manifestVersion !== 'string' || !isValidSemver(manifestVersion)) {
    throw new Error('Plugin version must be valid semver.');
  }
  if (!source.engines) {
    throw new Error('Plugin requires an incompatible or missing engines.pluginApi range.');
  }
  const pluginApi = (source.engines as Record<string, unknown>).pluginApi;
  if (!isCompatibleApiRange(pluginApi)) {
    throw new Error('Plugin requires an incompatible or missing engines.pluginApi range.');
  }

  const permissions = Array.isArray(source.permissions) ? source.permissions : [];
  for (const permission of permissions) {
    if (!KNOWN_PERMISSIONS.has(permission as PluginPermissionDto)) {
      throw new Error('Unknown renderer plugin permission: ' + permission);
    }
  }

  const displayName = source.displayName;
  return Object.freeze({
    id: manifestId,
    version: manifestVersion,
    displayName: isNonEmptyString(displayName) ? displayName : manifestId,
    engines: Object.freeze({
      ...(source.engines as Record<string, unknown>),
      pluginApi
    }) as PluginManifestEnginesDto,
    permissions: Object.freeze([...new Set(permissions)]) as readonly PluginPermissionDto[],
    contributes: source.contributes && typeof source.contributes === 'object'
      ? clonePluginContributes(source.contributes)
      : Object.freeze({})
  }) as PluginManifestDto;
}

export class PluginRuntime<PluginServices extends object = Record<string, unknown>>
implements PluginRuntimeContract<PluginServices> {
  declare private readonly _services: PluginRuntimeOptions<PluginServices>['services'];
  declare private readonly _commands: PluginRuntimeOptions<PluginServices>['commands'];
  declare private readonly _contributions: PluginRuntimeOptions<PluginServices>['contributions'];
  declare private readonly _sourceControls: SourceControlStateStoreContract;
  declare private readonly _ownsSourceControls: boolean;
  declare private readonly _agents: AgentStateStoreContract | undefined;
  declare private readonly _getPluginI18n: NonNullable<PluginRuntimeOptions<PluginServices>['getPluginI18n']>;
  declare private readonly _onError: (event: PluginRuntimeObservedErrorEvent) => void;
  declare private readonly _plugins: Map<string, PluginRuntimeRecord<PluginServices>>;
  declare private _disposed: boolean;
  declare private _disposePromise: Promise<void> | null;

  constructor(options: PluginRuntimeOptions<PluginServices>) {
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
    this._plugins = new Map<string, PluginRuntimeRecord<PluginServices>>();
    this._disposed = false;
    this._disposePromise = null;
  }

  async activate(
    manifest: PluginManifestRegistrationDto,
    pluginModule: PluginRuntimeModule<PluginServices>
  ): Promise<PluginRuntimeOperationResultDto>;
  async activate(manifest: unknown, pluginModule: unknown): Promise<PluginRuntimeOperationResultDto> {
    if (this._disposed) {
      const error = new Error('PluginRuntime has been disposed.');
      this._report('plugin-lifecycle', manifestIdForReport(manifest), error);
      return { ok: false, error };
    }
    let normalized: PluginManifestDto;
    let normalizedModule: PluginRuntimeModule<PluginServices>;
    try {
      normalized = validatePluginManifest(manifest);
      if (this._plugins.has(normalized.id)) throw new Error('Plugin is already active: ' + normalized.id);
      if (!pluginModule || typeof (pluginModule as { readonly activate?: unknown }).activate !== 'function') {
        throw new TypeError('Plugin module must export activate(context).');
      }
      normalizedModule = pluginModule as PluginRuntimeModule<PluginServices>;
    } catch (error) {
      this._report('plugin-validate', manifestIdForReport(manifest), error);
      return { ok: false, error };
    }

    const subscriptions = new DisposableStore({
      onError: (event) => this._report('plugin-dispose', normalized.id, event.error)
    });
    const permissions = new Set<PluginPermissionDto>(normalized.permissions);
    const context = this._createContext(normalized, permissions, subscriptions);
    const record: PluginRuntimeRecord<PluginServices> = {
      manifest: normalized,
      module: normalizedModule,
      subscriptions,
      status: 'activating',
      activationWork: null,
      activationPromise: null,
      activationError: null,
      activationFailed: false,
      deactivateRequested: false,
      deactivationPromise: null,
      cleanupPromise: null,
      cleaned: false
    };
    this._plugins.set(normalized.id, record);

    record.activationWork = Promise.resolve().then(async () => {
      try {
        const activationResult: PluginRuntimeActivationValue = await normalizedModule.activate(context);
        if (typeof activationResult === 'function') {
          subscriptions.add({ dispose: activationResult });
        } else if (
          activationResult &&
          typeof (activationResult as { readonly dispose?: unknown }).dispose === 'function'
        ) {
          subscriptions.add(activationResult as MaybeAsyncDisposable);
        }
      } catch (error) {
        record.activationError = error;
        record.activationFailed = true;
        throw error;
      }
    });

    record.activationPromise = (async (): Promise<PluginRuntimeOperationResultDto> => {
      try {
        await record.activationWork;
        if (record.deactivateRequested || this._disposed) {
          await this._beginDeactivation(record);
          return { ok: false, error: new Error('Plugin activation was cancelled: ' + normalized.id) };
        }
        record.status = 'active';
        return { ok: true, id: normalized.id };
      } catch (error) {
        await this._cleanupRecord(record);
        this._report('plugin-activate', normalized.id, error);
        return { ok: false, error };
      }
    })();
    return record.activationPromise;
  }

  async deactivate(id: string): Promise<PluginRuntimeOperationResultDto> {
    const record = this._plugins.get(id);
    if (!record) return { ok: false, error: new Error('Plugin is not active: ' + id) };
    return this._beginDeactivation(record);
  }

  list(): readonly PluginRuntimeSnapshotDto[] {
    return Array.from(this._plugins.values(), (record) => Object.freeze({
      id: record.manifest.id,
      version: record.manifest.version,
      displayName: record.manifest.displayName,
      status: record.status
    }));
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = (async () => {
      const records = Array.from(this._plugins.values()).reverse();
      for (const record of records) await this._beginDeactivation(record);
      if (this._ownsSourceControls) this._sourceControls.dispose();
    })();
    return this._disposePromise;
  }

  private _createContext(
    manifest: PluginManifestDto,
    permissions: ReadonlySet<PluginPermissionDto>,
    subscriptions: DisposableStore
  ): PluginRuntimeContext<PluginServices> {
    const requirePermission = (permission: PluginPermissionDto): void => {
      if (!permissions.has(permission)) {
        throw new Error('Plugin "' + manifest.id + '" did not declare permission: ' + permission);
      }
    };

    return Object.freeze({
      apiVersion: PLUGIN_API_VERSION,
      plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
      subscriptions: Object.freeze({
        add: <Value extends MaybeAsyncDisposable>(disposable: Value): Value => subscriptions.add(disposable)
      }),
      services: Object.freeze({
        get: <Id extends string>(id: Id): Id extends keyof PluginServices ? PluginServices[Id] : unknown => {
          requirePermission(PluginPermission.SERVICES_READ);
          return this._services.getForPluginDynamic(id);
        }
      }),
      commands: Object.freeze({
        register: (
          id: string,
          handler: PluginRuntimeCommandHandler,
          metadata: PluginRuntimeCommandMetadataDto = {}
        ): Disposable => {
          requirePermission(PluginPermission.COMMANDS_REGISTER);
          this._requireOwnedId(manifest.id, id, 'Command');
          const disposable = this._commands.registerDynamic(id, handler, { ...metadata, owner: manifest.id });
          subscriptions.add(disposable);
          return disposable;
        },
        execute: (id: string, ...args: unknown[]): Promise<unknown> => {
          requirePermission(PluginPermission.COMMANDS_EXECUTE);
          return this._commands.executeDynamic(id, ...args);
        }
      }),
      contributions: Object.freeze({
        register: (
          point: PluginRuntimeContributionPointDto,
          contribution: PluginRuntimeContributionRegistrationDto,
          options: PluginRuntimeContributionOptionsDto = {}
        ): Disposable => {
          requirePermission(PluginPermission.CONTRIBUTIONS_REGISTER);
          if (!KNOWN_CONTRIBUTION_POINTS.has(point)) {
            throw new Error('Unsupported plugin contribution point: ' + point);
          }
          this._requireOwnedId(manifest.id, options.id || contribution.id, 'Contribution');
          const disposable = this._contributions.registerDynamic(point, contribution, {
            ...options,
            owner: manifest.id
          });
          subscriptions.add(disposable);
          return disposable;
        }
      }),
      sourceControl: Object.freeze({
        register: async (
          descriptor: SourceControlDescriptorRegistrationDto
        ): Promise<PluginRuntimeSourceControlProvider> => {
          requirePermission(PluginPermission.SOURCE_CONTROL_REGISTER);
          const normalizedDescriptor = validateSourceControlDescriptor(descriptor);
          this._requireOwnedId(manifest.id, normalizedDescriptor.id, 'Source-control descriptor');
          if (normalizedDescriptor.openCommand) {
            this._requireOwnedId(manifest.id, normalizedDescriptor.openCommand, 'Source-control open command');
          }
          const disposable = this._contributions.registerDynamic(ContributionPoint.SOURCE_CONTROL, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          let stateHandle: SourceControlStateHandle;
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
          const provider: PluginRuntimeSourceControlProvider = Object.freeze({
            id: normalizedDescriptor.id,
            async setState(state: SourceControlStateRegistrationDto) {
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
        register: (descriptor: DocumentViewDescriptorRegistrationDto): Disposable => {
          requirePermission(PluginPermission.DOCUMENT_VIEWS_REGISTER);
          requirePermission(PluginPermission.DOCUMENTS_READ);
          const normalizedDescriptor = validateDocumentViewDescriptor(descriptor, manifest.id);
          const declared = Array.isArray(manifest.contributes.documentViewers)
            ? manifest.contributes.documentViewers.find((candidate) => (
                (candidate as { readonly id?: unknown }).id === normalizedDescriptor.id
              ))
            : null;
          if (!declared) throw new Error('Document viewer is not declared in the plugin manifest.');
          const disposable = this._contributions.registerDynamic(ContributionPoint.DOCUMENT_VIEWS, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          subscriptions.add(disposable);
          return disposable;
        }
      }),
      agents: Object.freeze({
        register: (descriptor: AgentDescriptorRegistrationDto): PluginRuntimeAgentProvider => {
          requirePermission(PluginPermission.AGENTS_REGISTER);
          if (!this._agents) throw new Error('Agent state store is unavailable.');
          const normalizedDescriptor = validateAgentDescriptor(descriptor, manifest.id);
          const contributionDisposable = this._contributions.registerDynamic(ContributionPoint.AGENTS, normalizedDescriptor, {
            id: normalizedDescriptor.id,
            owner: manifest.id
          });
          let stateHandle: AgentStateHandle;
          try {
            stateHandle = this._agents.register(normalizedDescriptor, { owner: manifest.id });
          } catch (error) {
            contributionDisposable.dispose();
            throw error;
          }
          const provider: PluginRuntimeAgentProvider = Object.freeze({
            id: normalizedDescriptor.id,
            setState: (state: AgentStateRegistrationDto) => stateHandle.setState(state),
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

  private _createPluginI18n(manifest: PluginManifestDto): PluginRuntimeI18n {
    let source: PluginRuntimeLocalizationRegistrationDto | null | undefined;
    try {
      source = this._getPluginI18n(manifest);
    } catch (_) {
      source = null;
    }
    const locale = source && typeof source.locale === 'string' && source.locale ? source.locale : 'en';
    const messages: Readonly<Record<string, unknown>> = source && source.messages && typeof source.messages === 'object'
      ? source.messages
      : Object.create(null) as Record<string, unknown>;
    const listeners = new Set<PluginRuntimeI18nChangeListener>();
    const t = (key: unknown, values?: PluginRuntimeI18nValuesDto | null): string => {
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
      onDidChange(listener: PluginRuntimeI18nChangeListener): Disposable {
        if (typeof listener !== 'function') throw new TypeError('Plugin i18n listener must be a function.');
        listeners.add(listener);
        return { dispose() { listeners.delete(listener); } };
      }
    });
  }

  private _report(source: PluginRuntimeErrorSourceDto, id: string | undefined, error: unknown): void {
    try {
      this._onError({ source, id, error });
    } catch (_) {
      // Error reporting cannot be allowed to break host lifecycle cleanup.
    }
  }

  private _beginDeactivation(
    record: PluginRuntimeRecord<PluginServices>
  ): Promise<PluginRuntimeOperationResultDto> {
    if (record.deactivationPromise) return record.deactivationPromise;
    record.deactivateRequested = true;
    record.status = 'deactivating';
    record.deactivationPromise = (async () => {
      try {
        await record.activationWork;
      } catch (_) {
        // Activation reports its own error and still needs deterministic cleanup.
      }

      let deactivateError: unknown = null;
      let deactivateFailed = false;
      if (!record.activationFailed) {
        try {
          if (typeof record.module.deactivate === 'function') await record.module.deactivate();
        } catch (error) {
          deactivateError = error;
          deactivateFailed = true;
          this._report('plugin-deactivate', record.manifest.id, error);
        }
      }
      await this._cleanupRecord(record);
      return deactivateFailed
        ? { ok: false, error: deactivateError }
        : { ok: true, id: record.manifest.id };
    })();
    return record.deactivationPromise;
  }

  private _cleanupRecord(record: PluginRuntimeRecord<PluginServices>): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleaned = true;
    record.cleanupPromise = Promise.resolve().then(async () => {
      try {
        await record.subscriptions.disposeAsync();
      } finally {
        this._commands.disposeOwner(record.manifest.id);
        this._contributions.disposeOwner(record.manifest.id);
        this._sourceControls.disposeOwner(record.manifest.id);
        if (this._agents) this._agents.disposeOwner(record.manifest.id);
        this._services.disposeOwner(record.manifest.id);
        if (this._plugins.get(record.manifest.id) === record) this._plugins.delete(record.manifest.id);
      }
    });
    return record.cleanupPromise;
  }

  private _requireOwnedId(pluginId: string, id: unknown, label: string): void {
    if (typeof id !== 'string' || !id.startsWith(pluginId + '.')) {
      throw new Error(label + ' id must use the plugin namespace "' + pluginId + '.".');
    }
  }
}
