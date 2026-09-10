/** Timer and animation ports used by the streaming renderer scheduler. */
export interface StreamRenderSchedulerOptions {
  readonly interval?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly requestAnimationFrame?: (callback: (timestamp: number) => void) => unknown;
  readonly cancelAnimationFrame?: (handle: unknown) => void;
}

/** The intentionally small lifecycle surface consumed by the AI chat panel. */
export interface StreamRenderScheduler {
  schedule(): void;
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export type StreamRenderSchedulerFactory = (
  render: () => void,
  options?: StreamRenderSchedulerOptions
) => StreamRenderScheduler;

/** Writable legacy projection retained for the lazy AI UI bundle. */
export interface StreamRenderSchedulerFacade {
  createStreamRenderScheduler?: StreamRenderSchedulerFactory;
}
