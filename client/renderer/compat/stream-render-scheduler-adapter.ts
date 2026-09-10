import { createStreamRenderScheduler } from '../../src/stream-render-scheduler';
import type { StreamRenderSchedulerFacade } from '../../types/stream-render-scheduler';

const legacyWindow = window as Window & { BOBO?: StreamRenderSchedulerFacade };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};

// Keep the historical writable BOBO projection while AI UI callers migrate to
// the named TypeScript factory.
BOBO.createStreamRenderScheduler = createStreamRenderScheduler;
