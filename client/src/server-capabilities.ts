import type { Disposable } from '../types/lifecycle';
import type {
  CompatibleServerCapabilitySnapshot,
  IncompatibleServerCapabilitySnapshot,
  ServerCapabilityChange,
  ServerCapabilityDependencies,
  ServerCapabilityRefreshResult,
  ServerCapabilityRefreshSuccess,
  ServerCapabilityService,
  ServerCapabilitySnapshot,
  ServerCapabilityState
} from '../types/server-runtime';

const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_PROTOCOL_NAME = 'bobocloud';
const SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_LIST_ITEMS = 64;
const MAX_TEXT_LENGTH = 160;
const REFRESH_TTL_MS = 5_000;

interface RefreshRecord {
  readonly key: string;
  expiresAt: number;
  result: ServerCapabilityRefreshSuccess | null;
  promise: Promise<ServerCapabilityRefreshResult> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cleanText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function boundedInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function uniqueTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = cleanText(item);
    if (text && !result.includes(text) && result.length < MAX_LIST_ITEMS) result.push(text);
  }
  return result;
}

function normalizedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const path = cleanText(item);
    if (
      path
      && path.startsWith('/')
      && !path.includes('://')
      && !result.includes(path)
      && result.length < MAX_LIST_ITEMS
    ) {
      result.push(path);
    }
  }
  return result;
}

function normalizedTransportEndpoint(value: unknown, permittedSchemes: readonly string[]) {
  const endpoint = isRecord(value) ? value : {};
  let scheme = cleanText(endpoint.scheme, 12).toLowerCase();
  if (!permittedSchemes.includes(scheme)) scheme = '';
  return { scheme, paths: normalizedPaths(endpoint.paths) };
}

function normalizedLimitGroup(value: unknown) {
  const limit = isRecord(value) ? value : {};
  return {
    maxSessions: boundedInteger(limit.maxSessions),
    maxPerUser: boundedInteger(limit.maxPerUser)
  };
}

export function legacySnapshot(): ServerCapabilitySnapshot {
  return {
    state: 'legacy',
    compatible: true,
    schemaVersion: 0,
    protocol: { name: '', version: 0 },
    release: { version: '' },
    transport: {
      http: { scheme: '', paths: [] },
      websocket: { scheme: '', paths: [] }
    },
    capabilities: null,
    limits: null,
    catalogRevisions: { lsp: 0, dap: '' },
    catalogFingerprints: { lsp: '', dap: '' },
    secureTransportRequired: false
  };
}

export function incompatibleSnapshot(reason: string): IncompatibleServerCapabilitySnapshot {
  return {
    ...legacySnapshot(),
    state: 'incompatible',
    compatible: false,
    reason,
    capabilities: null,
    limits: null
  };
}

export function normalizeDescriptor(value: unknown): ServerCapabilitySnapshot {
  if (!isRecord(value)) return incompatibleSnapshot('invalid_descriptor');
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return incompatibleSnapshot('unsupported_schema');

  const protocol = isRecord(value.protocol) ? value.protocol : {};
  if (protocol.name !== SUPPORTED_PROTOCOL_NAME || protocol.version !== SUPPORTED_PROTOCOL_VERSION) {
    return incompatibleSnapshot('unsupported_protocol');
  }

  const transport = isRecord(value.transport) ? value.transport : {};
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const limits = isRecord(value.limits) ? value.limits : {};
  const revisions = isRecord(value.catalogRevisions) ? value.catalogRevisions : {};
  const fingerprints = isRecord(value.catalogFingerprints) ? value.catalogFingerprints : {};
  const release = isRecord(value.release) ? value.release : {};
  const lsp = isRecord(capabilities.lsp) ? capabilities.lsp : {};
  const dap = isRecord(capabilities.dap) ? capabilities.dap : {};
  const normalizedTransport = {
    http: normalizedTransportEndpoint(transport.http, ['http', 'https']),
    websocket: normalizedTransportEndpoint(transport.websocket, ['ws', 'wss'])
  };

  const snapshot: CompatibleServerCapabilitySnapshot = {
    state: 'compatible',
    compatible: true,
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    protocol: { name: SUPPORTED_PROTOCOL_NAME, version: SUPPORTED_PROTOCOL_VERSION },
    release: { version: cleanText(release.version) },
    transport: normalizedTransport,
    capabilities: {
      run: capabilities.run === true,
      tasks: capabilities.tasks === true,
      terminal: capabilities.terminal === true,
      projectEnvironment: capabilities.projectEnvironment === true,
      collaboration: capabilities.collaboration === true,
      lsp: { enabled: lsp.enabled === true, languages: uniqueTextList(lsp.languages) },
      dap: { enabled: dap.enabled === true }
    },
    limits: {
      runMaxConcurrent: boundedInteger(limits.runMaxConcurrent),
      terminalMaxSessionSeconds: boundedInteger(limits.terminalMaxSessionSeconds),
      lsp: normalizedLimitGroup(limits.lsp),
      dap: normalizedLimitGroup(limits.dap)
    },
    catalogRevisions: {
      lsp: boundedInteger(revisions.lsp),
      dap: cleanText(revisions.dap)
    },
    catalogFingerprints: {
      lsp: cleanText(fingerprints.lsp),
      dap: cleanText(fingerprints.dap)
    },
    secureTransportRequired: normalizedTransport.http.scheme === 'https'
      || normalizedTransport.websocket.scheme === 'wss'
  };
  return snapshot;
}

export function inspectServerInfo(response: unknown): ServerCapabilitySnapshot {
  const responseValue = response as { readonly data?: unknown } | null | undefined;
  const data = responseValue && isRecord(responseValue.data) ? responseValue.data : null;
  if (!data || !hasOwn(data, 'serverCapabilities')) return legacySnapshot();
  return normalizeDescriptor(data.serverCapabilities);
}

export function requiresSecureTransport(
  snapshot: ServerCapabilitySnapshot | null | undefined,
  settings: unknown
): boolean {
  const serverSettings = isRecord(settings) ? settings : null;
  return Boolean(
    snapshot
    && snapshot.secureTransportRequired
    && (!serverSettings || serverSettings.secureTransport !== true)
  );
}

export function createServerCapabilities(
  dependencies: ServerCapabilityDependencies
): ServerCapabilityService {
  if (!dependencies || typeof dependencies.getState !== 'function') {
    throw new TypeError('Server capabilities require getState().');
  }
  if (typeof dependencies.getSendToServer !== 'function') {
    throw new TypeError('Server capabilities require getSendToServer().');
  }

  const subscribers: Array<(change: ServerCapabilityChange) => void> = [];
  const now = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const logger = dependencies.logger || console;
  let refreshRecord: RefreshRecord | null = null;
  let disposed = false;

  function state(): ServerCapabilityState | undefined {
    return dependencies.getState() || undefined;
  }

  function refreshIdentityKey(): string {
    const current = state() || {};
    const server = current.serverSettings || {};
    const auth = current.auth || {};
    const user = auth.user || {};
    const fingerprints = Array.isArray(server.certificateFingerprints)
      ? server.certificateFingerprints.map(String)
      : [String(server.certificateFingerprint || '')];
    return JSON.stringify({
      ip: String(server.ip || ''),
      httpPort: Number(server.httpPort || 0),
      wsPort: Number(server.wsPort || 0),
      secureTransport: server.secureTransport === true,
      fingerprints,
      authMode: String(auth.mode || ''),
      userId: String(user.id || user.uid || user.username || ''),
      authEpoch: Number(current.runIdentityEpoch || 0)
    });
  }

  function invalidateRefresh(): void {
    refreshRecord = null;
  }

  function publish(
    snapshot: ServerCapabilitySnapshot | null,
    reason: unknown
  ): ServerCapabilitySnapshot | null {
    if (disposed) return snapshot;
    const currentState = state();
    const previous = currentState?.serverCapabilities || null;
    if (currentState) currentState.serverCapabilities = snapshot;
    const detail: ServerCapabilityChange = {
      previous,
      current: snapshot,
      reason: cleanText(reason, 64)
    };
    for (const listener of subscribers.slice()) {
      try {
        listener(detail);
      } catch (error) {
        try {
          logger.error('server capability subscriber:', error);
        } catch {
          // Subscriber isolation must not depend on logging being healthy.
        }
      }
    }
    try {
      dependencies.emitChange?.(detail);
    } catch {
      // The compatibility DOM event is best effort, matching the legacy path.
    }
    return snapshot;
  }

  function applyServerInfo(response: unknown, reason?: unknown): ServerCapabilitySnapshot {
    invalidateRefresh();
    const snapshot = inspectServerInfo(response);
    publish(snapshot, reason || 'server-info');
    return snapshot;
  }

  function clear(reason?: unknown): void {
    invalidateRefresh();
    publish(null, reason || 'clear');
  }

  function notify(reason?: unknown): ServerCapabilitySnapshot | null {
    return publish(state()?.serverCapabilities || null, reason || 'state-change');
  }

  function subscribe(listener: (change: ServerCapabilityChange) => void): () => void {
    if (disposed || typeof listener !== 'function') return () => {};
    subscribers.push(listener);
    return () => {
      const index = subscribers.indexOf(listener);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  function onDidChange(listener: (change: ServerCapabilityChange) => void): Disposable {
    const unsubscribe = subscribe(listener);
    return { dispose: unsubscribe };
  }

  // Catalog refresh remains independent from auth. The identity key and
  // record ownership checks prevent late probes from crossing server/users.
  function refresh(options?: { readonly reason?: unknown }): Promise<ServerCapabilityRefreshResult> {
    const currentState = state();
    const settings = currentState?.serverSettings;
    const sendToServer = dependencies.getSendToServer();
    if (disposed) return Promise.resolve({ success: false, stale: true, reason: 'disposed' });
    if (!sendToServer || !settings || !settings.ip) {
      return Promise.resolve({ success: false, reason: 'server_unavailable' });
    }

    const key = refreshIdentityKey();
    const currentTime = now();
    if (refreshRecord?.key === key) {
      if (refreshRecord.promise) return refreshRecord.promise;
      if (refreshRecord.expiresAt > currentTime && refreshRecord.result) {
        return Promise.resolve({
          ...refreshRecord.result,
          cached: true,
          refreshed: false
        });
      }
    }

    const reason = cleanText(options?.reason, 64) || 'capability-refresh';
    const record: RefreshRecord = { key, expiresAt: 0, result: null, promise: null };
    const pending = Promise.resolve()
      .then(() => {
        if (disposed) return undefined;
        const currentSender = dependencies.getSendToServer();
        if (!currentSender) throw new TypeError('Server transport became unavailable.');
        return currentSender('serverInfo', {}, { quiet: true });
      })
      .then((response): ServerCapabilityRefreshResult => {
        if (disposed) return { success: false, stale: true, reason: 'disposed' };
        if (refreshRecord !== record || refreshIdentityKey() !== key) {
          return { success: false, stale: true, reason: 'identity_changed' };
        }
        if (!response || (response as { readonly success?: unknown }).success !== true) {
          return { success: false, reason: 'probe_failed' };
        }

        let snapshot = inspectServerInfo(response);
        if (requiresSecureTransport(snapshot, state()?.serverSettings)) {
          snapshot = incompatibleSnapshot('secure_transport_required');
        }
        publish(snapshot, reason);
        record.expiresAt = now() + REFRESH_TTL_MS;
        record.result = {
          success: true,
          refreshed: true,
          cached: false,
          snapshot
        };
        return record.result;
      })
      .catch((error: unknown): ServerCapabilityRefreshResult => ({
        success: false,
        reason: 'probe_failed',
        error
      }))
      .finally(() => {
        if (refreshRecord === record) record.promise = null;
      });
    record.promise = pending;
    refreshRecord = record;
    return pending;
  }

  function supports(feature: unknown, snapshot?: ServerCapabilitySnapshot | null): boolean {
    const current = snapshot || state()?.serverCapabilities;
    if (!current) return false;
    if (current.state === 'legacy') return true;
    if (current.state !== 'compatible' || !current.capabilities) return false;
    if (feature === 'lsp') return current.capabilities.lsp.enabled;
    if (feature === 'dap') return current.capabilities.dap.enabled;
    if (
      feature === 'run'
      || feature === 'tasks'
      || feature === 'terminal'
      || feature === 'projectEnvironment'
      || feature === 'collaboration'
    ) {
      return current.capabilities[feature];
    }
    return false;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    invalidateRefresh();
    subscribers.length = 0;
  }

  return {
    inspectServerInfo,
    applyServerInfo,
    clear,
    notify,
    subscribe,
    onDidChange,
    refresh,
    requiresSecureTransport,
    supports,
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
    dispose
  };
}
