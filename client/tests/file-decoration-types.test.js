'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('file decoration contracts separate provider input, normalized DTOs, and host service ownership', () => {
  const source = [
    "import { FileDecorationLane, contributionPointForDecorationLane, decorationLaneForContributionPoint, normalizeFileDecoration, validateFileDecorationProvider } from '../renderer/core/file-decoration';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  FileDecorationChangeEvent,',
    '  FileDecorationColorDto,',
    '  FileDecorationDto,',
    '  FileDecorationLaneDto,',
    '  FileDecorationPointId,',
    '  FileDecorationProvider,',
    '  FileDecorationProviderDto,',
    '  FileDecorationProviderResult,',
    '  FileDecorationRegistrationDto,',
    '  FileDecorationService,',
    '  RendererPlatform',
    "} from '../types/renderer-platform';",
    "const lane: FileDecorationLaneDto = FileDecorationLane.SYNC;",
    "const point: FileDecorationPointId = contributionPointForDecorationLane(lane);",
    "const reverseLane: FileDecorationLaneDto | null = decorationLaneForContributionPoint(point);",
    'const input: FileDecorationRegistrationDto = {',
    "  status: 'queued', badge: 'cloud-upload', tooltip: 'Queued'",
    '};',
    'const normalized: FileDecorationDto = normalizeFileDecoration(input)!;',
    "const color: FileDecorationColorDto | '' = normalized.color;",
    'const transient: boolean = normalized.transient;',
    '// @ts-expect-error A normalized decoration contains every defaulted field.',
    "const incomplete: FileDecorationDto = { status: 'queued', badge: 'cloud-upload' };",
    "const provider: FileDecorationProvider<'sync'> = {",
    "  namespace: 'acme.sync', lane: 'sync', priority: 10,",
    '  getDecoration: () => input,',
    '  onDidChange: (listener) => { listener([\'src/app.ts\']); return { dispose() {} }; }',
    '};',
    "const legacyProvider: FileDecorationProviderDto<'sync'> = provider;",
    "const validated: FileDecorationProvider<'sync'> = validateFileDecorationProvider(provider, 'fileDecorations.sync');",
    '// @ts-expect-error The returned provider lane is derived from the contribution point.',
    "const forgedLane: FileDecorationProvider<'diagnostic'> = validateFileDecorationProvider(provider, 'fileDecorations.sync');",
    'const result: FileDecorationProviderResult = provider.getDecoration(\'src/app.ts\', null);',
    '// @ts-expect-error Decoration providers are deliberately synchronous.',
    "const asyncProvider: FileDecorationProvider<'sync'> = { namespace: 'acme.async', lane: 'sync', getDecoration: async () => null };",
    'function inspectChange(event: FileDecorationChangeEvent): void {',
    "  if (event.reason === 'provider') event.paths?.map((entry) => entry.toUpperCase());",
    "  if (event.reason === 'registry') event.providerId.toUpperCase();",
    "  if (event.reason === 'language') {",
    '    // @ts-expect-error Language refreshes have no provider identity.',
    '    event.providerId;',
    '  }',
    '}',
    'declare const platform: RendererPlatform;',
    "const service: FileDecorationService = platform.services.require('workbench.fileDecorations');",
    "const decoration: FileDecorationDto | null = service.get('sync', 'src/app.ts', null);",
    'const subscription: Disposable = service.onDidChange(inspectChange);',
    '// @ts-expect-error The host-only aggregation service is not exposed to plugins.',
    "platform.services.getForPlugin('workbench.fileDecorations');",
    '// @ts-expect-error Frozen service methods cannot be rebound.',
    'service.get = () => null;',
    'subscription.dispose(); service.dispose();',
    'void point; void reverseLane; void color; void transient; void incomplete;',
    'void legacyProvider; void validated; void forgedLane; void result; void asyncProvider; void decoration;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__file-decoration-types-contract.ts',
    source
  });
});
