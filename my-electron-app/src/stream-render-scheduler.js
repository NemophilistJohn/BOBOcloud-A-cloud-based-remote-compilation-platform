// Batches expensive streaming renders while preserving an immediate final flush.
(function(root, factory) {
  var createStreamRenderScheduler = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = createStreamRenderScheduler;
  if (root) {
    root.BOBO = root.BOBO || {};
    root.BOBO.createStreamRenderScheduler = createStreamRenderScheduler;
  }
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  return function createStreamRenderScheduler(render, options) {
    options = options || {};
    var interval = Math.max(16, Number(options.interval) || 100);
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var requestFrame = options.requestAnimationFrame || (root && root.requestAnimationFrame);
    var cancelFrame = options.cancelAnimationFrame || (root && root.cancelAnimationFrame);
    var timer = null;
    var frame = null;
    var dirty = false;

    function clearHandles() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (frame !== null && cancelFrame) {
        cancelFrame(frame);
        frame = null;
      }
    }

    function flush() {
      var shouldRender = dirty;
      clearHandles();
      dirty = false;
      if (shouldRender) render();
    }

    function schedule() {
      dirty = true;
      if (timer !== null || frame !== null) return;
      timer = setTimer(function() {
        timer = null;
        if (requestFrame) {
          frame = requestFrame(function() {
            frame = null;
            flush();
          });
        } else {
          flush();
        }
      }, interval);
    }

    function cancel() {
      clearHandles();
      dirty = false;
    }

    return {
      schedule: schedule,
      flush: flush,
      cancel: cancel,
      pending: function() { return dirty; }
    };
  };
});
