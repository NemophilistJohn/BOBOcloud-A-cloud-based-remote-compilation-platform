import type { RendererPlatform } from '../../types/renderer-platform';
import { rendererPlatform as runtimeRendererPlatform } from './bootstrap.js';

// A compile-time view over the existing platform instance. This module creates
// no registry or lifecycle state of its own.
export const rendererPlatform = runtimeRendererPlatform as unknown as RendererPlatform;
