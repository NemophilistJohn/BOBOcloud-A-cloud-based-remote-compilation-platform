'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('renderer primitive contracts keep legacy facades typed and private', () => {
  const source = [
    "import { icons } from '../src/icons';",
    "import { createTabOrderService, TAB_ORDER_SERVICE_ID } from '../src/tab-order';",
    "import { createToastService, TOAST_SERVICE_ID } from '../src/toast';",
    "import type { Disposable } from '../types/lifecycle';",
    'import type {',
    '  RendererIconsFacade,',
    '  TabOrderFacade,',
    '  TabOrderService,',
    '  ToastDependencies,',
    '  ToastFacade,',
    '  ToastService',
    "} from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    "type IconKeys = 'plus' | 'close' | 'check' | 'trash' | 'send' | 'copy' | 'play' | 'stop' | 'settings' | 'search' | 'moreVertical' | 'eye' | 'eyeOff' | 'chevronDown' | 'chevronRight' | 'history' | 'clock' | 'cloud' | 'folder' | 'file' | 'fileText' | 'package' | 'user' | 'lock' | 'mail' | 'key' | 'logout' | 'shield' | 'folderOpen';",
    'type IconsAreExact = AssertTrue<Equal<keyof RendererIconsFacade, IconKeys>>;',
    "type ToastKeys = 'success' | 'error' | 'info';",
    'type ToastIsExact = AssertTrue<Equal<keyof ToastFacade, ToastKeys>>;',
    "type TabOrderKeys = 'reorder';",
    'type TabOrderIsExact = AssertTrue<Equal<keyof TabOrderFacade, TabOrderKeys>>;',
    'type ToastServiceIsDisposable = AssertTrue<ToastService extends Disposable ? true : false>;',
    'type TabOrderServiceIsDisposable = AssertTrue<TabOrderService extends Disposable ? true : false>;',
    "type ToastServiceIsPrivate = AssertFalse<'workbench.toast' extends keyof import('../types/renderer-platform').RendererPluginServiceMap ? true : false>;",
    "type TabOrderServiceIsPrivate = AssertFalse<'workbench.tabOrder' extends keyof import('../types/renderer-platform').RendererPluginServiceMap ? true : false>;",
    'const icon: string = icons.file;',
    'const tabOrder: TabOrderService = createTabOrderService();',
    'declare const dependencies: ToastDependencies;',
    'const toast: ToastService = createToastService(dependencies);',
    "const toastId: 'workbench.toast' = TOAST_SERVICE_ID;",
    "const tabOrderId: 'workbench.tabOrder' = TAB_ORDER_SERVICE_ID;",
    'toast.info("hello"); tabOrder.reorder([], "a", "b", "before"); toast.dispose(); tabOrder.dispose();',
    '// @ts-expect-error Primitive facades have a closed key surface.',
    'toast.warning("not part of the legacy facade");',
    'void icon; void toastId; void tabOrderId;'
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__renderer-primitives-types-contract.ts',
    source
  });
});
