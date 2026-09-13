'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('editor rules expose typed completion, diagnostics, and registry DTOs', () => {
  const source = [
    "import type { Disposable } from '../types/lifecycle';",
    "import type { DiagnosticsSettings } from '../types/diagnostics';",
    "import type { EditorRuleCompletionItemDto, EditorRuleCompletionProvider, EditorRuleLanguagePlugin, EditorRuleMarkerDto, EditorRuleMonacoPort, EditorRulePositionDto, EditorRuleProviderRegistration, EditorRuleRegistryPort, EditorRuleSymbolDto, EditorRuleTextModelPort } from '../types/renderer-platform';",
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    'type RegistrationIsDisposable = AssertTrue<EditorRuleProviderRegistration extends Disposable ? true : false>;',
    'type RegistryIsNotAny = AssertFalse<IsAny<EditorRuleRegistryPort>>;',
    'declare const registry: EditorRuleRegistryPort;',
    'declare const monaco: EditorRuleMonacoPort;',
    'declare const model: EditorRuleTextModelPort;',
    'declare const position: EditorRulePositionDto;',
    'declare const settings: DiagnosticsSettings;',
    'const plugins: readonly EditorRuleLanguagePlugin[] = registry.listLanguageRulePlugins();',
    'const markers: readonly EditorRuleMarkerDto[] = registry.getSyntaxMarkers(model, monaco, { largeFile: false });',
    'const item: EditorRuleCompletionItemDto = registry.helpers.createPlain("label", "insert", monaco.languages.CompletionItemKind.Variable);',
    'const provider: EditorRuleCompletionProvider | null | undefined = plugins[0]?.createCompletionProvider?.(monaco, registry.helpers);',
    'const symbols: readonly EditorRuleSymbolDto[] = [];',
    'registry.setDiagnosticsSettings(settings);',
    'provider?.provideCompletionItems(model, position, { triggerCharacter: "." }, { isCancellationRequested: false });',
    'void plugins; void markers; void item; void symbols;',
    '// @ts-expect-error Editor-rule completion DTO labels are immutable at the typed boundary.',
    'item.label = "changed";'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__editor-rules-types-contract.ts',
    source
  });
});
