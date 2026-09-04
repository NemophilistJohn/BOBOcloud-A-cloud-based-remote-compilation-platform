'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('confirm dialog contracts keep overloads precise and the service workbench-private', () => {
  const source = [
    "import { CONFIRM_SERVICE_ID, createConfirmService } from '../src/confirm-dialog';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  ConfirmDependencies,',
    '  ConfirmDetailsOptions,',
    '  ConfirmDetailsResultDto,',
    '  ConfirmFacade,',
    '  ConfirmOptions,',
    '  ConfirmService,',
    '  RendererPlatform,',
    '  RendererPluginServiceMap,',
    '  RendererServiceMap',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    'type AssertFalse<Value extends false> = Value;',
    "type ServiceIsExact = AssertTrue<Equal<keyof ConfirmService, 'disposed' | 'confirm' | 'dispose'>>;",
    'type DefaultReturnIsBoolean = AssertTrue<Equal<ReturnType<ConfirmFacade>, Promise<boolean>>>;',
    "type FactoryIsNotAny = AssertFalse<IsAny<ReturnType<typeof createConfirmService>>>;",
    "type FacadeIsNotAny = AssertFalse<IsAny<ConfirmService['confirm']>>;",
    'type OptionsAreNotAny = AssertFalse<IsAny<ConfirmOptions>>;',
    "type ResultIsNotAny = AssertFalse<IsAny<ConfirmDetailsResultDto['confirmed']>>;",
    "type DependencyIsNotAny = AssertFalse<IsAny<ConfirmDependencies['document']>>;",
    "const serviceId: 'workbench.confirm' = CONFIRM_SERVICE_ID;",
    'declare const dependencies: ConfirmDependencies;',
    'const service: ConfirmService = createConfirmService(dependencies);',
    'const disposable: Disposable = service;',
    'const facade: ConfirmFacade = service.confirm;',
    'const baseOptions: ConfirmOptions = {};',
    'const detailOptions: ConfirmDetailsOptions = { returnDetails: true };',
    'const defaultResult: Promise<boolean> = facade();',
    "const optionResult: Promise<boolean> = facade({ title: 'Confirm', returnDetails: false });",
    'const detailResult: Promise<ConfirmDetailsResultDto> = facade(detailOptions);',
    '// @ts-expect-error Detailed confirmation never resolves to a bare boolean.',
    'const wrongBooleanResult: Promise<boolean> = facade({ returnDetails: true });',
    '// @ts-expect-error Default confirmation never resolves to a details DTO.',
    "const wrongDetailResult: Promise<ConfirmDetailsResultDto> = facade({ title: 'Confirm' });",
    'declare const details: ConfirmDetailsResultDto;',
    '// @ts-expect-error Confirmation result DTOs are immutable.',
    'details.confirmed = false;',
    '// @ts-expect-error Confirmation result DTOs are immutable.',
    'details.checkboxChecked = true;',
    '// @ts-expect-error The compatibility facade does not own service disposal.',
    'facade.dispose();',
    '// @ts-expect-error Service lifecycle state is immutable to consumers.',
    'service.disposed = false;',
    'declare const platform: RendererPlatform;',
    "const registered: RendererServiceMap['workbench.confirm'] = platform.services.require(CONFIRM_SERVICE_ID);",
    "type PluginVisible = 'workbench.confirm' extends keyof RendererPluginServiceMap ? true : false;",
    'const pluginVisible: PluginVisible = false;',
    '// @ts-expect-error Confirm dialogs remain private to the trusted workbench.',
    "platform.services.getForPlugin('workbench.confirm');",
    'disposable.dispose();',
    'void serviceId; void service; void facade; void baseOptions; void detailOptions;',
    'void defaultResult; void optionResult; void detailResult; void registered; void pluginVisible;',
    'void wrongBooleanResult; void wrongDetailResult;',
    'void (false as unknown as ServiceIsExact);',
    'void (false as unknown as DefaultReturnIsBoolean);',
    'void (false as unknown as FactoryIsNotAny);',
    'void (false as unknown as FacadeIsNotAny);',
    'void (false as unknown as OptionsAreNotAny);',
    'void (false as unknown as ResultIsNotAny);',
    'void (false as unknown as DependencyIsNotAny);'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__confirm-dialog-types-contract.ts',
    source
  });
});
