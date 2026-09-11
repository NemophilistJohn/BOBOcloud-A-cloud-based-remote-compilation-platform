'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('account profile keeps its five-key facade and private disposable service contract', () => {
  const source = [
    "import { createAccountProfileService, ACCOUNT_PROFILE_SERVICE_ID } from '../src/account-profile';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AccountProfileActivityDayWireDto, AccountProfileDependencies, AccountProfileFacade, AccountProfileServerRequestMap, AccountProfileService, AccountProfileUserDto } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'open' | 'close' | 'reset' | 'renderActivity';",
    'type FacadeIsExact = AssertTrue<Equal<keyof AccountProfileFacade, FacadeKeys>>;',
    "type ServiceIsExact = AssertTrue<Equal<keyof AccountProfileService, FacadeKeys | 'dispose' | 'disposed'>>;",
    'type ServiceIsDisposable = AssertTrue<AccountProfileService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.accountProfile'], AccountProfileService>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.accountProfile' extends keyof RendererPluginServiceMap ? true : false>;",
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAccountProfileService>>>;',
    "const serviceId: 'workbench.accountProfile' = ACCOUNT_PROFILE_SERVICE_ID;",
    'declare const dependencies: AccountProfileDependencies;',
    'declare const user: AccountProfileUserDto;',
    'declare const day: AccountProfileActivityDayWireDto;',
    'const service: AccountProfileService = createAccountProfileService(dependencies);',
    'const facade: AccountProfileFacade = service;',
    'const payload: AccountProfileServerRequestMap["updateProfile"] = { name: "Builder", avatar: "graphite" };',
    'service.init(); service.open("activity"); service.close(); service.reset(); service.renderActivity(); service.dispose();',
    '// @ts-expect-error Account profile exposes a closed compatibility surface.',
    'service.save();',
    '// @ts-expect-error Account profile service is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.accountProfile');",
    '// @ts-expect-error Account profile user DTOs are immutable at the typed boundary.',
    'user.name = "replacement";',
    '// @ts-expect-error Activity wire DTOs are immutable at the typed boundary.',
    'day.count = 10;',
    'void serviceId; void facade; void payload;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__account-profile-types-contract.ts',
    source
  });
});

