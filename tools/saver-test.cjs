#!/usr/bin/env node
/*
 * Tests for the debounced settings writer:  node tools/saver-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Saver = require(path.join(__dirname, "..", "plugin", "saver.js"));

/** Manual clock so the tests never wait on real timers. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("create() requires a save function", () => {
  assert.throws(() => Saver.create({}), /needs a save function/);
});

test("many saves inside the window collapse into one write", async () => {
  const clock = fakeClock();
  const written = [];
  const saver = Saver.create({
    delay: 600,
    save: (payload) => written.push(payload),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  saver.save("a");
  saver.save("b");
  saver.save("c");
  assert.equal(written.length, 0, "nothing written yet");
  assert.equal(saver.hasPending(), true);

  clock.advance(600);
  await Promise.resolve();
  assert.deepEqual(written, ["c"], "only the newest payload is written");
  assert.equal(saver.hasPending(), false);
  assert.equal(saver.writeCount(), 1);
  assert.equal(clock.pendingTimers(), 0);
});

test("a later window schedules another write", async () => {
  const clock = fakeClock();
  const written = [];
  const saver = Saver.create({
    delay: 600,
    save: (payload) => written.push(payload),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  saver.save("first");
  clock.advance(600);
  await Promise.resolve();
  saver.save("second");
  clock.advance(600);
  await Promise.resolve();
  assert.deepEqual(written, ["first", "second"]);
  assert.equal(saver.writeCount(), 2);
});

test("flush writes immediately and cancels the timer", async () => {
  const clock = fakeClock();
  const written = [];
  const saver = Saver.create({
    delay: 600,
    save: (payload) => written.push(payload),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  saver.save("pending");
  await saver.flush();
  assert.deepEqual(written, ["pending"]);
  assert.equal(clock.pendingTimers(), 0);
  await saver.flush();
  assert.deepEqual(written, ["pending"], "a second flush has nothing to do");
});

test("cancel drops the pending payload", async () => {
  const clock = fakeClock();
  const written = [];
  const saver = Saver.create({
    delay: 600,
    save: (payload) => written.push(payload),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  saver.save("gone");
  saver.cancel();
  clock.advance(1000);
  await Promise.resolve();
  assert.deepEqual(written, []);
  assert.equal(saver.hasPending(), false);
});

test("a failing save does not break the next write", async () => {
  const clock = fakeClock();
  const written = [];
  const saver = Saver.create({
    delay: 100,
    save: (payload) => {
      if (payload === "bad") throw new Error("disk full");
      written.push(payload);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  saver.save("bad");
  clock.advance(100);
  await Promise.resolve();
  saver.save("good");
  clock.advance(100);
  await Promise.resolve();
  assert.deepEqual(written, ["good"]);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (error) {
      failed += 1;
      console.log("  FAIL " + name + "\n       " + (error && error.message));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " tests passed");
  process.exit(failed ? 1 : 0);
})();
