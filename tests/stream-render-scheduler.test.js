'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const createStreamRenderScheduler = require('../src/stream-render-scheduler');

function harness() {
  const timers = new Map();
  const frames = new Map();
  let nextHandle = 1;
  const options = {
    interval: 100,
    setTimeout(callback) {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) { frames.delete(handle); }
  };
  return { timers, frames, options };
}

test('burst chunks schedule one render and final flush renders immediately', () => {
  const clock = harness();
  let renderCount = 0;
  const scheduler = createStreamRenderScheduler(() => { renderCount += 1; }, clock.options);

  for (let index = 0; index < 500; index += 1) scheduler.schedule();
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.frames.size, 0);
  assert.equal(renderCount, 0);

  const [timerHandle, timerCallback] = Array.from(clock.timers.entries())[0];
  clock.timers.delete(timerHandle);
  timerCallback();
  assert.equal(clock.frames.size, 1);
  const [frameHandle, frameCallback] = Array.from(clock.frames.entries())[0];
  clock.frames.delete(frameHandle);
  frameCallback();
  assert.equal(renderCount, 1);
  assert.equal(scheduler.pending(), false);

  for (let index = 0; index < 100; index += 1) scheduler.schedule();
  scheduler.flush();
  assert.equal(renderCount, 2);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.frames.size, 0);
});

test('cancel drops a pending render after conversation replacement', () => {
  const clock = harness();
  let renderCount = 0;
  const scheduler = createStreamRenderScheduler(() => { renderCount += 1; }, clock.options);
  scheduler.schedule();
  scheduler.cancel();
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.pending(), false);
  assert.equal(renderCount, 0);
});
