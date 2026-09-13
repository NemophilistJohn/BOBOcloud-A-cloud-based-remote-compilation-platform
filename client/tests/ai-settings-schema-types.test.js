'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('AI settings schema keeps one typed cross-runtime contract and immutable metadata views', () => {
  const source = [
    "import { aiSettingsSchema } from '../renderer/compat/ai-settings-schema-adapter';",
    "import type { AiSettingsSchemaRuntime, AiSettingsSchemaRuntimePort, AiSettingsProviderDefinitionDto, AiProfileDto, AiSettingsDto, AiSettingsParameterDefaults } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    'type RuntimeAliasIsExact = AssertTrue<Equal<AiSettingsSchemaRuntimePort, AiSettingsSchemaRuntime>>;',
    'type ExportIsTyped = AssertTrue<Equal<typeof aiSettingsSchema, AiSettingsSchemaRuntime>>;',
    'type ExportIsNotAny = AssertFalse<IsAny<typeof aiSettingsSchema>>;',
    'declare const profile: AiProfileDto;',
    'declare const settings: AiSettingsDto;',
    'declare const defaults: AiSettingsParameterDefaults;',
    'declare const provider: AiSettingsProviderDefinitionDto;',
    'const normalizedProfile: AiProfileDto = aiSettingsSchema.normalizeProfile(profile, 0, "chat");',
    'const normalizedSettings: AiSettingsDto = aiSettingsSchema.normalizeSettings(settings);',
    'const normalizedParameters = aiSettingsSchema.normalizeParameters({}, defaults, aiSettingsSchema.MAX_MODEL_REQUEST_OUTPUT_TOKENS);',
    'const providerId = aiSettingsSchema.normalizeProviderId(provider.labelKey);',
    'const endpoint = aiSettingsSchema.defaultEndpointFor(providerId, { protocol: "chat-completions" });',
    'const regions = aiSettingsSchema.qwenRegionsForBillingPlan("standard");',
    'void normalizedProfile; void normalizedSettings; void normalizedParameters; void providerId; void endpoint; void regions;',
    '// @ts-expect-error Schema metadata is read-only at the typed boundary.',
    'aiSettingsSchema.SCHEMA_VERSION = 5;',
    '// @ts-expect-error Provider metadata is read-only at the typed boundary.',
    'aiSettingsSchema.PROVIDER_ORDER.push("custom");'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__ai-settings-schema-types-contract.ts',
    source
  });
});
