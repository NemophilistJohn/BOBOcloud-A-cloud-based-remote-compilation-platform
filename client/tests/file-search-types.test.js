'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('file search keeps its three-method facade and private disposable service contract', () => {
  const source = [
    "import { createFileSearchService, FILE_SEARCH_SERVICE_ID } from '../src/file-search';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, FileSearchDependencies, FileSearchFacade, FileSearchService, FileSearchFileDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type FacadeKeys = 'show' | 'hide' | 'refreshCache';",
    'type FacadeIsExact = AssertTrue<Equal<keyof FileSearchFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof FileSearchService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<FileSearchService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.fileSearch'], FileSearchService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.fileSearch' extends keyof RendererPluginServiceMap ? true : false>;",
    "const serviceId: 'workbench.fileSearch' = FILE_SEARCH_SERVICE_ID;",
    'declare const dependencies: FileSearchDependencies;',
    'const service: FileSearchService = createFileSearchService(dependencies);',
    'const facade: FileSearchFacade = service;',
    'declare const file: FileSearchFileDto;',
    'service.show(); service.hide(); service.refreshCache(true); service.dispose();',
    '// @ts-expect-error File search exposes a closed compatibility surface.',
    'service.openFile();',
    '// @ts-expect-error File search is intentionally absent from the downloaded-plugin service map.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.fileSearch');",
    'void serviceId; void facade; void file;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__file-search-types-contract.ts',
    source
  });
});
