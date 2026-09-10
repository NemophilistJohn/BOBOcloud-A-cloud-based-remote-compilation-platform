import {
  createTabOrderService,
  TAB_ORDER_SERVICE_ID
} from '../../src/tab-order';
import type { TabOrderFacade } from '../../types/tab-order';
import { rendererPlatform } from '../core/bootstrap';

type LegacyTabOrderNamespace = {
  tabOrder?: TabOrderFacade;
};

const legacyWindow = window as Window & { BOBO?: LegacyTabOrderNamespace };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const tabOrder = createTabOrderService();

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  TAB_ORDER_SERVICE_ID,
  tabOrder,
  { owner: 'core.tab-order', exposeToPlugins: false }
));

BOBO.tabOrder = Object.freeze({ reorder: tabOrder.reorder });
