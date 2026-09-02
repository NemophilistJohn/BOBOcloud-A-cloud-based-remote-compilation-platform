import type { ServerTransportService, ServerTransportSettings } from '../types/server-runtime';

function settingsRecord(value: unknown): ServerTransportSettings {
  return value !== null && typeof value === 'object'
    ? value as ServerTransportSettings
    : {};
}

export function normalizedPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

export function normalizeHost(value: unknown): string {
  const host = String(value || '').trim();
  if (!host) return '';
  return host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
}

export function endpoint(settings: unknown, kind?: unknown): string {
  const value = settingsRecord(settings);
  const host = normalizeHost(value.ip);
  if (!host) return '';
  const secure = value.secureTransport === true;
  const port = kind === 'ws'
    ? normalizedPort(value.wsPort, 3101)
    : kind === 'dap-child'
      ? normalizedPort(value.dapChildWsPort, 3102)
      : normalizedPort(value.httpPort, 3100);
  return (secure ? 'https' : 'http') + '://' + host + ':' + port;
}

export function websocket(settings: unknown, path?: unknown, kind?: unknown): string {
  const base = endpoint(settings, kind || 'ws');
  if (!base) return '';
  return base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + ((path || '/ws') as string);
}

export function createServerTransport(): Readonly<ServerTransportService> {
  return { endpoint, websocket, normalizeHost, normalizedPort };
}
