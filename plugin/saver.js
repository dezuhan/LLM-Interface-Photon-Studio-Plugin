/*
 * Debounced writer, used to keep conversation saves off the per-message path.
 *
 * The chat store hands us the whole conversation on every append; writing ~700 KB of settings per
 * message is wasteful, so writes are coalesced into one after `delay` ms. `flush` forces the pending
 * payload out (dispose, explicit actions) and `hasPending` lets tests assert the coalescing.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonSaver = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function create(options) {
    const opts = options || {};
    if (typeof opts.save !== "function") throw new TypeError("create() needs a save function");
    const delay = typeof opts.delay === "number" ? opts.delay : 600;
    const scheduleTimer = opts.setTimer || ((callback, ms) => setTimeout(callback, ms));
    const cancelTimer = opts.clearTimer || ((handle) => clearTimeout(handle));

    let handle = null;
    let pending = null;
    let writing = Promise.resolve();
    let writes = 0;

    function write() {
      if (pending === null) return writing;
      const payload = pending;
      pending = null;
      writes += 1;
      // defer the call so a synchronous throw inside save() is caught too
      writing = Promise.resolve()
        .then(() => opts.save(payload))
        .catch(() => {});
      return writing;
    }

    function save(payload) {
      pending = payload;
      if (handle !== null) return writing;
      handle = scheduleTimer(() => {
        handle = null;
        void write();
      }, delay);
      return writing;
    }

    function flush() {
      if (handle !== null) {
        cancelTimer(handle);
        handle = null;
      }
      return write();
    }

    return {
      save,
      flush,
      hasPending: () => pending !== null,
      writeCount: () => writes,
      cancel() {
        if (handle !== null) {
          cancelTimer(handle);
          handle = null;
        }
        pending = null;
      },
    };
  }

  return { create };
});
