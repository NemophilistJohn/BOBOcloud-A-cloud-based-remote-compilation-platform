import type { Disposable } from './lifecycle';

export type CloudFeatureName =
  | 'run'
  | 'tasks'
  | 'terminal'
  | 'projectEnvironment'
  | 'collaboration'
  | 'lsp'
  | 'dap';

export interface ServerTransportSettings {
  readonly ip?: unknown;
  readonly httpPort?: unknown;
  readonly wsPort?: unknown;
  readonly dapChildWsPort?: unknown;
  readonly secureTransport?: unknown;
  readonly [key: string]: unknown;
}

export interface ServerTransportService {
  normalizedPort(value: unknown, fallback: number): number;
  normalizeHost(value: unknown): string;
  endpoint(settings: unknown, kind?: unknown): string;
  websocket(settings: unknown, path?: unknown, kind?: unknown): string;
}

export interface ServerProtocolSnapshot {
  readonly name: string;
  readonly version: number;
}

export interface ServerReleaseSnapshot {
  readonly version: string;
}

export interface ServerTransportEndpointSnapshot {
  readonly scheme: string;
  readonly paths: readonly string[];
}

export interface ServerTransportSnapshot {
  readonly http: ServerTransportEndpointSnapshot;
  readonly websocket: ServerTransportEndpointSnapshot;
}

export interface ServerFeatureCapability {
  readonly enabled: boolean;
}

export interface ServerLanguageFeatureCapability extends ServerFeatureCapability {
  readonly languages: readonly string[];
}

export interface NegotiatedServerCapabilities {
  readonly run: boolean;
  readonly tasks: boolean;
  readonly terminal: boolean;
  readonly projectEnvironment: boolean;
  readonly collaboration: boolean;
  readonly lsp: ServerLanguageFeatureCapability;
  readonly dap: ServerFeatureCapability;
}

export interface ServerSessionLimits {
  readonly maxSessions: number;
  readonly maxPerUser: number;
}

export interface NegotiatedServerLimits {
  readonly runMaxConcurrent: number;
  readonly terminalMaxSessionSeconds: number;
  readonly lsp: ServerSessionLimits;
  readonly dap: ServerSessionLimits;
}

export interface ServerCatalogRevisions {
  readonly lsp: number;
  readonly dap: string;
}

export interface ServerCatalogFingerprints {
  readonly lsp: string;
  readonly dap: string;
}

interface ServerCapabilitySnapshotBase {
  readonly compatible: boolean;
  readonly schemaVersion: number;
  readonly protocol: ServerProtocolSnapshot;
  readonly release: ServerReleaseSnapshot;
  readonly transport: ServerTransportSnapshot;
  readonly catalogRevisions: ServerCatalogRevisions;
  readonly catalogFingerprints: ServerCatalogFingerprints;
  readonly secureTransportRequired: boolean;
}

export interface LegacyServerCapabilitySnapshot extends ServerCapabilitySnapshotBase {
  readonly state: 'legacy';
  readonly compatible: true;
  readonly capabilities: null;
  readonly limits: null;
}

export interface CompatibleServerCapabilitySnapshot extends ServerCapabilitySnapshotBase {
  readonly state: 'compatible';
  readonly compatible: true;
  readonly schemaVersion: 1;
  readonly capabilities: NegotiatedServerCapabilities;
  readonly limits: NegotiatedServerLimits;
}

export interface IncompatibleServerCapabilitySnapshot extends ServerCapabilitySnapshotBase {
  readonly state: 'incompatible';
  readonly compatible: false;
  readonly capabilities: null;
  readonly limits: null;
  readonly reason: string;
}

export type ServerCapabilitySnapshot =
  | LegacyServerCapabilitySnapshot
  | CompatibleServerCapabilitySnapshot
  | IncompatibleServerCapabilitySnapshot;

export interface ServerCapabilityChange {
  readonly previous: ServerCapabilitySnapshot | null;
  readonly current: ServerCapabilitySnapshot | null;
  readonly reason: string;
}

export type ServerCapabilityListener = (change: ServerCapabilityChange) => void;

export interface ServerCapabilityRefreshOptions {
  readonly reason?: unknown;
}

export interface ServerCapabilityRefreshSuccess {
  readonly success: true;
  readonly cached: boolean;
  readonly refreshed: boolean;
  readonly snapshot: ServerCapabilitySnapshot;
}

export interface ServerCapabilityRefreshFailure {
  readonly success: false;
  readonly reason: 'server_unavailable' | 'probe_failed';
  readonly error?: unknown;
}

export interface ServerCapabilityRefreshStale {
  readonly success: false;
  readonly stale: true;
  readonly reason: 'identity_changed' | 'disposed';
}

export type ServerCapabilityRefreshResult =
  | ServerCapabilityRefreshSuccess
  | ServerCapabilityRefreshFailure
  | ServerCapabilityRefreshStale;

export interface ServerCapabilityAuthUser {
  readonly id?: unknown;
  readonly uid?: unknown;
  readonly username?: unknown;
  readonly [key: string]: unknown;
}

export interface ServerCapabilityAuthState {
  readonly mode?: unknown;
  readonly user?: ServerCapabilityAuthUser | null;
  readonly [key: string]: unknown;
}

export interface ServerCapabilityState {
  serverCapabilities?: ServerCapabilitySnapshot | null;
  readonly serverSettings?: ServerTransportSettings | null;
  readonly auth?: ServerCapabilityAuthState | null;
  readonly runIdentityEpoch?: unknown;
  readonly [key: string]: unknown;
}

export type ServerInfoSender = (
  action: 'serverInfo',
  data: Record<string, never>,
  options: { readonly quiet: true }
) => unknown;

export interface ServerCapabilityDependencies {
  readonly getState: () => ServerCapabilityState | null | undefined;
  readonly getSendToServer: () => ServerInfoSender | null | undefined;
  readonly emitChange?: (change: ServerCapabilityChange) => void;
  readonly now?: () => number;
  readonly logger?: Pick<Console, 'error'>;
}

export interface ServerCapabilityService extends Disposable {
  inspectServerInfo(response: unknown): ServerCapabilitySnapshot;
  applyServerInfo(response: unknown, reason?: unknown): ServerCapabilitySnapshot;
  clear(reason?: unknown): void;
  notify(reason?: unknown): ServerCapabilitySnapshot | null;
  subscribe(listener: ServerCapabilityListener): () => void;
  onDidChange(listener: ServerCapabilityListener): Disposable;
  refresh(options?: ServerCapabilityRefreshOptions): Promise<ServerCapabilityRefreshResult>;
  requiresSecureTransport(snapshot: ServerCapabilitySnapshot | null | undefined, settings: unknown): boolean;
  supports(feature: unknown, snapshot?: ServerCapabilitySnapshot | null): boolean;
  readonly supportedSchemaVersion: number;
  readonly supportedProtocolVersion: number;
}

export interface CloudFeatureDecision {
  readonly feature: string;
  readonly available: boolean;
  readonly state: string;
  readonly reason: string;
  readonly language?: string;
}

export interface CloudFeatureEvaluationOptions {
  readonly snapshot?: ServerCapabilitySnapshot | null;
  readonly language?: unknown;
}

export interface CloudFeaturePolicyDependencies {
  readonly getSnapshot: () => ServerCapabilitySnapshot | null | undefined;
}

export interface CloudFeaturePolicyService {
  evaluate(feature: unknown, options?: CloudFeatureEvaluationOptions | null): CloudFeatureDecision;
  allows(feature: unknown, options?: CloudFeatureEvaluationOptions | null): boolean;
  canonicalLanguage(value: unknown): string;
  languages(snapshot?: ServerCapabilitySnapshot | null): string[];
}
