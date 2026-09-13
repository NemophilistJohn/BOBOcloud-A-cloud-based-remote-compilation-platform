import runtimeSchema from '../../src/ai-settings-schema.js';
import type { AiSettingsSchemaRuntime } from '../../types/ai-settings-schema';

interface LegacyBobo {
  aiSettingsSchema?: AiSettingsSchemaRuntime;
}

type LegacyWindow = Window & { BOBO?: LegacyBobo };

const legacyWindow = window as LegacyWindow;
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// The shared UMD module is intentionally the single implementation. This
// adapter only gives the renderer a checked contract and preserves its
// historical global projection for the still-legacy AI presentation modules.
const aiSettingsSchema = runtimeSchema as unknown as AiSettingsSchemaRuntime;
BOBO.aiSettingsSchema = aiSettingsSchema;

export { aiSettingsSchema };
