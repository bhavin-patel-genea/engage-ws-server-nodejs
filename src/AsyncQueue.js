'use strict';

/**
 * AsyncQueue - A FIFO queue that supports both synchronous and
 * async (Promise-based) item retrieval, mirroring Python's queue.Queue API.
 */
class AsyncQueue {
  constructor() {
    this._items = [];
    this._waiters = []; // pending get() resolve callbacks
  }

  /**
   * Add an item to the queue. If a waiter is pending, resolve it immediately.
   * @param {*} item
   */
  put(item) {
    if (this._waiters.length > 0) {
      const { resolve, timer } = this._waiters.shift();
      if (timer) clearTimeout(timer);
      resolve(item);
    } else {
      this._items.push(item);
    }
  }

  /**
   * Retrieve an item from the queue.
   * - If block=false (default), returns the item immediately or null if empty.
   * - If block=true and timeout=0, waits indefinitely.
   * - If block=true and timeout>0, waits up to timeout seconds, then returns null.
   *
   * @param {boolean} block  Whether to wait for an item (default: false)
   * @param {number}  timeout  Seconds to wait when block=true (0 = indefinite)
   * @returns {*|null|Promise<*|null>}
   */
  get(block = false, timeout = 0) {
    if (this._items.length > 0) {
      return this._items.shift();
    }
    if (!block) {
      return null;
    }
    // Return a Promise that resolves when an item becomes available
    return new Promise((resolve) => {
      let timer = null;
      const waiter = { resolve, timer: null };

      if (timeout > 0) {
        timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          resolve(null);
        }, timeout * 1000);
        waiter.timer = timer;
      }

      this._waiters.push(waiter);
    });
  }

  /**
   * Return the number of items currently in the queue (does not count waiters).
   * @returns {number}
   */
  size() {
    return this._items.length;
  }

  /**
   * Return true if the queue is empty.
   * @returns {boolean}
   */
  empty() {
    return this._items.length === 0;
  }
}

module.exports = AsyncQueue;
