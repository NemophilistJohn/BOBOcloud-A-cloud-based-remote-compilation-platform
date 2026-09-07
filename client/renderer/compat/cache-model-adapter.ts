import {
  CATEGORY_ORDER,
  HISTORY_STATES,
  SCHEMA_VERSION,
  compareEntries,
  groupInventory,
  isCurrentEnvironmentEntry,
  isServiceCategory,
  normalizeEntry,
  normalizeInventory,
  workspaceMatches
} from '../../src/cache-model';
import type { CacheModelFacade } from '../../types/cache-model';

interface LegacyBobo {
  cacheModel?: CacheModelFacade;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

BOBO.cacheModel = {
  SCHEMA_VERSION,
  CATEGORY_ORDER: CATEGORY_ORDER.slice(),
  HISTORY_STATES,
  normalizeEntry,
  normalizeInventory,
  groupInventory,
  compareEntries,
  workspaceMatches,
  isCurrentEnvironmentEntry,
  isServiceCategory
};
