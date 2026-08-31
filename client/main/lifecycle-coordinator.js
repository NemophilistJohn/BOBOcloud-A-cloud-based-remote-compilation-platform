'use strict';

const DEFAULT_TIMEOUT_MS = 10_000;

function createLifecycleCoordinator(options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const handlers = new Map();
  let activeRun = null;

  function register(name, handler) {
    if (typeof name !== 'string' || !name || typeof handler !== 'function') {
      throw new TypeError('Lifecycle registrations require a name and handler');
    }
    if (handlers.has(name)) throw new Error('Duplicate lifecycle registration: ' + name);
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }

  async function execute(reason) {
    const tasks = [...handlers].map(async ([name, handler]) => {
      try {
        await handler(reason);
        return { name, status: 'fulfilled' };
      } catch (error) {
        onError(name, error);
        return { name, status: 'rejected', error };
      }
    });
    const settled = Promise.all(tasks);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, results: [] }), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const result = await Promise.race([
      settled.then((results) => ({ timedOut: false, results })),
      timeout
    ]);
    clearTimeout(timer);
    return result;
  }

  function run(reason) {
    if (activeRun) return activeRun;
    activeRun = execute(String(reason || 'lifecycle-transition'))
      .finally(() => { activeRun = null; });
    return activeRun;
  }

  return Object.freeze({ register, run });
}

module.exports = { DEFAULT_TIMEOUT_MS, createLifecycleCoordinator };
