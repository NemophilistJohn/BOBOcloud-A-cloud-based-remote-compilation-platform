import type {
  EnvironmentActivityActionDto,
  EnvironmentActivityDependencies,
  EnvironmentActivityEventDetailDto,
  EnvironmentActivityEventDto,
  EnvironmentActivityEventKindDto,
  EnvironmentActivityListener,
  EnvironmentActivityRecordDetailDto,
  EnvironmentActivityRecordDto,
  EnvironmentActivityScopeDto,
  EnvironmentActivityScopeKeyDto,
  EnvironmentActivityScopeOverridesDto,
  EnvironmentActivityService
} from '../types/environment-activity';
import type { Dispose } from '../types/lifecycle';

export const ENVIRONMENT_ACTIVITY_SERVICE_ID = 'workbench.environmentActivity';
export const ENVIRONMENT_ACTIVITY_STORAGE_KEY = 'bobocloud.environment.activity.v1';
export const ENVIRONMENT_ACTIVITY_EVENT_NAME = 'bobo:environment-activity';

const MAX_SCOPES = 80;

type ActivityTimestampField =
  | 'lastIndexedAt'
  | 'lastInstalledAt'
  | 'lastCompiledAt'
  | 'lastRepairAt'
  | 'lastRebuildAt';

const ACTION_FIELDS = Object.freeze(Object.assign(
  Object.create(null) as object,
  {
    index: 'lastIndexedAt',
    install: 'lastInstalledAt',
    compile: 'lastCompiledAt',
    repair: 'lastRepairAt',
    rebuild: 'lastRebuildAt'
  } satisfies Readonly<Record<EnvironmentActivityActionDto, ActivityTimestampField>>
));

interface MutableActivityRecord {
  lastIndexedAt?: number;
  lastInstalledAt?: number;
  lastCompiledAt?: number;
  lastRepairAt?: number;
  lastRebuildAt?: number;
  lastAction?: string;
  lastOutcome?: string;
  updatedAt?: number;
}

interface SubscriberRegistration {
  readonly callback: EnvironmentActivityListener;
  active: boolean;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function emptyRecords(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function stringHash(value: unknown): string {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createEnvironmentActivityService(
  dependencies: EnvironmentActivityDependencies
): EnvironmentActivityService {
  const state = dependencies.state;
  const storage = dependencies.storage;
  let disposed = false;
  let records = readRecords();
  const subscribers: SubscriberRegistration[] = [];

  function readRecords(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(storage?.getItem(ENVIRONMENT_ACTIVITY_STORAGE_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : emptyRecords();
    } catch (_) {
      return emptyRecords();
    }
  }

  function persist(): void {
    try {
      const keys = Object.keys(records);
      if (keys.length > MAX_SCOPES) {
        keys.sort((left, right) => (
          Number((records[right] as EnvironmentActivityRecordDto | undefined)?.updatedAt || 0) -
          Number((records[left] as EnvironmentActivityRecordDto | undefined)?.updatedAt || 0)
        ));
        keys.slice(MAX_SCOPES).forEach((key) => { delete records[key]; });
      }
      storage?.setItem(ENVIRONMENT_ACTIVITY_STORAGE_KEY, JSON.stringify(records));
    } catch (_) {}
  }

  function currentLanguage(): string {
    const tab = (state.tabs || []).find((item) => item.path === state.activeTabPath);
    if (tab?.language && tab.language !== 'image') return String(tab.language);
    const model = state.editor && typeof state.editor.getModel === 'function'
      ? state.editor.getModel()
      : null;
    return model && typeof model.getLanguageId === 'function'
      ? String(model.getLanguageId() || '')
      : '';
  }

  function identityPart(): unknown {
    const user = state.auth?.user;
    return user && (user.uid || user.id || user.userId || user.username) ||
      (state.auth?.mode === 'single' ? 'single' : 'anonymous');
  }

  function scopeDescriptor(
    overrides?: EnvironmentActivityScopeOverridesDto | null
  ): EnvironmentActivityScopeDto {
    const resolvedOverrides = overrides || {};
    const current = state.collaboration?.current;
    const workspaceRoot = hasOwn(resolvedOverrides, 'workspaceRoot')
      ? resolvedOverrides.workspaceRoot
      : state.workspaceRoot;
    const language = resolvedOverrides.language || currentLanguage() || 'unknown';
    const runtime = hasOwn(resolvedOverrides, 'runtime')
      ? resolvedOverrides.runtime
      : state.selectedRuntime || 'local';
    const workspace = current ? {
      kind: 'team' as const,
      teamId: String(current.teamId || ''),
      projectId: String(current.projectId || ''),
      branch: String(current.branch || '')
    } : {
      kind: 'personal' as const,
      folderKey: workspaceRoot ? dependencies.projectKey(workspaceRoot) : ''
    };
    return {
      server: stringHash(state.serverSettings?.ip || 'local'),
      user: stringHash(identityPart()),
      workspace,
      runtime: String(runtime || 'local'),
      language: String(language || 'unknown')
    };
  }

  function scopeKey(
    overrides?: EnvironmentActivityScopeOverridesDto | null
  ): EnvironmentActivityScopeKeyDto {
    const descriptor = scopeDescriptor(overrides);
    const workspace = descriptor.workspace;
    const workspaceIdentity = workspace.kind === 'team'
      ? ['team', workspace.teamId, workspace.projectId, workspace.branch].join(':')
      : ['personal', workspace.folderKey].join(':');
    return ('e1-' + stringHash([
      descriptor.server,
      descriptor.user,
      workspaceIdentity,
      descriptor.runtime,
      descriptor.language
    ].join('|'))) as EnvironmentActivityScopeKeyDto;
  }

  function copyRecord(value: unknown): EnvironmentActivityRecordDto {
    if (!value) return {};
    const record = value as Record<string, unknown>;
    return {
      lastIndexedAt: Number(record.lastIndexedAt || 0) || 0,
      lastInstalledAt: Number(record.lastInstalledAt || 0) || 0,
      lastCompiledAt: Number(record.lastCompiledAt || 0) || 0,
      lastRepairAt: Number(record.lastRepairAt || 0) || 0,
      lastRebuildAt: Number(record.lastRebuildAt || 0) || 0,
      lastAction: String(record.lastAction || ''),
      lastOutcome: String(record.lastOutcome || ''),
      updatedAt: Number(record.updatedAt || 0) || 0
    };
  }

  function read(
    overrides?: EnvironmentActivityScopeOverridesDto | null
  ): EnvironmentActivityRecordDto {
    return copyRecord(records[scopeKey(overrides)]);
  }

  function emit(
    kind: EnvironmentActivityEventKindDto,
    record: EnvironmentActivityRecordDto,
    detail: EnvironmentActivityEventDetailDto,
    resolvedScopeKey?: EnvironmentActivityScopeKeyDto
  ): void {
    const payload: EnvironmentActivityEventDto = {
      kind,
      scopeKey: resolvedScopeKey || scopeKey(detail.scope),
      record: copyRecord(record),
      detail
    };
    subscribers.slice().forEach((registration) => {
      try {
        const callback = registration.callback;
        callback(payload);
      } catch (error) {
        dependencies.reportSubscriberError(error);
      }
    });
    try {
      dependencies.dispatchEvent(payload);
    } catch (_) {}
  }

  function actionField(kind: unknown): ActivityTimestampField | undefined {
    const field = Reflect.get(ACTION_FIELDS, kind as PropertyKey) as unknown;
    return typeof field === 'string' ? field as ActivityTimestampField : undefined;
  }

  function record(
    kind: EnvironmentActivityActionDto,
    detail?: EnvironmentActivityRecordDetailDto | null
  ): boolean {
    if (disposed) return false;
    const resolvedDetail = (detail || {}) as EnvironmentActivityRecordDetailDto;
    let timestamp = Number(resolvedDetail.at || dependencies.now());
    if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = dependencies.now();
    const key = scopeKey(resolvedDetail.scope);
    const value: MutableActivityRecord = { ...copyRecord(records[key]) };
    const field = actionField(kind);
    if (!field) return false;
    const previousUpdatedAt = Number(value.updatedAt || 0) || 0;
    value[field] = Math.max(Number(value[field] || 0), timestamp);
    if (timestamp >= previousUpdatedAt) {
      value.lastAction = kind;
      value.lastOutcome = resolvedDetail.outcome === 'failed' ? 'failed' : 'completed';
    }
    value.updatedAt = Math.max(previousUpdatedAt, timestamp);
    records[key] = value;
    persist();
    emit(kind, value, resolvedDetail, key);
    return true;
  }

  function contextChanged(reason?: unknown): void {
    if (disposed) return;
    const key = scopeKey();
    emit(
      'context',
      copyRecord(records[key]),
      { reason: String(reason || 'changed') },
      key
    );
  }

  function subscribe(callback: EnvironmentActivityListener): Dispose {
    if (disposed || typeof callback !== 'function') return () => {};
    const registration: SubscriberRegistration = { callback, active: true };
    subscribers.push(registration);
    return () => {
      if (!registration.active) return;
      registration.active = false;
      const index = subscribers.indexOf(registration);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    subscribers.splice(0);
  }

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    read,
    record,
    contextChanged,
    subscribe,
    getScope: scopeDescriptor,
    getScopeKey: scopeKey,
    dispose
  });
}
