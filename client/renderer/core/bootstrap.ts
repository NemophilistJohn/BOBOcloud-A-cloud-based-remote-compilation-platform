import { createRendererPlatform } from './platform';
import type { RendererPlatform } from '../../types/renderer-platform';

/**
 * The renderer and its lazy presentation bundles are separate esbuild entry
 * points.  Keep one platform instance on the page so a lazy bundle can use
 * the same typed service registry instead of silently creating a second one.
 */
const RENDERER_PLATFORM_KEY = '__boboRendererPlatform__';
type RendererGlobal = typeof globalThis & {
  [RENDERER_PLATFORM_KEY]?: RendererPlatform;
};

const rendererGlobal = globalThis as RendererGlobal;
export const rendererPlatform: RendererPlatform =
  rendererGlobal[RENDERER_PLATFORM_KEY] ||
  (rendererGlobal[RENDERER_PLATFORM_KEY] = createRendererPlatform());
