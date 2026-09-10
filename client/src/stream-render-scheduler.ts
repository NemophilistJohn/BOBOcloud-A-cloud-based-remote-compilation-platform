import type {
  StreamRenderScheduler,
  StreamRenderSchedulerFactory,
  StreamRenderSchedulerOptions
} from '../types/stream-render-scheduler';

const rendererWindow = typeof window !== 'undefined' ? window : undefined;

/**
 * Batch expensive streaming renders while retaining an immediate final flush.
 *
 * The scheduler is deliberately platform-neutral: tests and embedders can
 * inject timer/frame ports, while the browser path uses the native globals.
 */
export const createStreamRenderScheduler: StreamRenderSchedulerFactory = (
  render: () => void,
  options: StreamRenderSchedulerOptions = {}
): StreamRenderScheduler => {
  const interval = Math.max(16, Number(options.interval) || 100);
  const setTimer = options.setTimeout ?? ((callback: () => void, delay: number) => (
    globalThis.setTimeout(callback, delay)
  ));
  const clearTimer = options.clearTimeout ?? ((handle: unknown) => {
    globalThis.clearTimeout(handle as number);
  });
  const requestFrame = options.requestAnimationFrame ?? (
    rendererWindow?.requestAnimationFrame
      ? (callback: (timestamp: number) => void) => rendererWindow.requestAnimationFrame(callback)
      : undefined
  );
  const cancelFrame = options.cancelAnimationFrame ?? (
    rendererWindow?.cancelAnimationFrame
      ? (handle: unknown) => rendererWindow.cancelAnimationFrame(handle as number)
      : undefined
  );

  let timer: unknown = null;
  let frame: unknown = null;
  let dirty = false;

  const clearHandles = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (frame !== null) {
      if (cancelFrame) cancelFrame(frame);
      // Clear the local handle even when a host only supplied a frame request
      // port. This prevents a missing optional cancel port from permanently
      // suppressing subsequent schedules.
      frame = null;
    }
  };

  const flush = (): void => {
    const shouldRender = dirty;
    clearHandles();
    dirty = false;
    if (shouldRender) render();
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== null || frame !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (requestFrame) {
        frame = requestFrame(() => {
          frame = null;
          flush();
        });
      } else {
        flush();
      }
    }, interval);
  };

  const cancel = (): void => {
    clearHandles();
    dirty = false;
  };

  return { schedule, flush, cancel, pending: () => dirty };
};

export default createStreamRenderScheduler;
