// ── Simplified AsyncQueue ──────────────────────────────────────────
class AsyncQueue {
    constructor() {
        this._waiters = [];
    }

    put(item) {
        const { resolve } = this._waiters.shift(); // grab the parked resolve
        resolve(item);                              // wake it up with the value
    }

    get() {
        return new Promise((resolve) => {
            this._waiters.push({ resolve });          // park resolve, return Promise
        });
    }
}

// ── Demo ───────────────────────────────────────────────────────────
const queue = new AsyncQueue();

// CONSUMER — waits for a value
async function consumer() {
    console.log('1. consumer: calling get() — will suspend here');
    const value = await queue.get();             // suspended — nothing in queue
    console.log('4. consumer: woke up, got:', value);
}

// PRODUCER — delivers a value 2 seconds later
function producer() {
    setTimeout(() => {
        console.log('3. producer: calling put("hello")');
        queue.put('hello');                        // wakes up the consumer
    }, 2000);
}

consumer();                                    // starts, suspends at await
console.log('2. main: consumer is suspended, event loop is free');
producer();                                    // schedules the wakeup
