'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('SCM contracts correlate operations, permissions, arguments, decorations, and disposal', () => {
  const source = [
    "import { createScmFileDecorationProvider, normalizeScmDecorationEntries } from '../renderer/core/scm-file-decoration';",
    "import { ScmGitOperation, normalizeScmGitRequest, scmGitPermissionForOperation } from '../renderer/core/scm-git';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  ScmDecorationEntryDto,',
    '  ScmFileDecorationProvider,',
    '  ScmGitRequestDto,',
    '  ScmGitRequestRegistrationDto',
    "} from '../types/renderer-platform';",
    'const entries: readonly ScmDecorationEntryDto[] = normalizeScmDecorationEntries([',
    "  { path: 'src/main.ts', status: 'modified' }",
    ']);',
    'const provider: ScmFileDecorationProvider = createScmFileDecorationProvider({',
    "  id: 'acme.scm.decorations', namespace: 'acme.scm', localize: key => key",
    '});',
    'const disposable: Disposable = provider;',
    "provider.set([{ path: 'src/main.ts', status: 'added' }]);",
    "provider.clear(['src/main.ts']);",
    "provider.getDecoration('src/main.ts');",
    'const status = normalizeScmGitRequest({',
    "  operation: ScmGitOperation.STATUS, args: { repositoryId: 'scm-1234567890abcdef', limit: 50 }",
    '});',
    "const statusOperation: 'status' = status.operation;",
    "const readPermission: 'scm.git.read' = status.permission;",
    'const statusLimit: number | undefined = status.args.limit;',
    "const writePermission: 'scm.git.write' = scmGitPermissionForOperation('commit');",
    "const request: ScmGitRequestRegistrationDto<'push'> = {",
    "  operation: 'push', args: { repositoryId: 'scm-1234567890abcdef', remote: 'origin' }",
    '};',
    "const normalizedPush: ScmGitRequestDto<'push'> = normalizeScmGitRequest(request);",
    '// @ts-expect-error Status cannot carry commit-only arguments.',
    "normalizeScmGitRequest({ operation: 'status', args: { repositoryId: 'scm-1234567890abcdef', message: 'no' } });",
    '// @ts-expect-error Detect has no repositoryId argument.',
    "const invalidDetect: ScmGitRequestRegistrationDto<'detect'> = { operation: 'detect', args: { repositoryId: 'no' } };",
    '// @ts-expect-error Unknown operations are rejected before reaching the broker.',
    "scmGitPermissionForOperation('shell');",
    '// @ts-expect-error SCM presentation status is a finite host-owned set.',
    "provider.set([{ path: 'src/main.ts', status: 'purple' }]);",
    'disposable.dispose();',
    'void entries; void statusOperation; void readPermission; void statusLimit;',
    'void writePermission; void normalizedPush; void invalidDetect;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__scm-types-contract.ts',
    source
  });
});
