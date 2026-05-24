/**
 * Bounded async queue with backpressure.
 *
 * - `push` waits when the buffer is full until a consumer pops.
 * - `pop` waits when the buffer is empty until a producer pushes or the queue closes.
 * - `close` signals end-of-stream to consumers; pending pops resolve to `done: true`,
 *   pending pushes reject.
 * - Implements `AsyncIterable<T>` for `for await (const x of queue)` consumption.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private closed = false;
  private waitingPush: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private waitingPop: Array<(result: IteratorResult<T>) => void> = [];

  constructor(public readonly maxSize: number = 50) {
    if (maxSize < 1) throw new Error("AsyncQueue maxSize must be >= 1");
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Push an item. Resolves when there's room. Rejects if the queue closes while waiting. */
  async push(item: T): Promise<void> {
    if (this.closed) throw new Error("queue is closed");
    if (this.waitingPop.length > 0) {
      const waiter = this.waitingPop.shift()!;
      waiter({ value: item, done: false });
      return;
    }
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(item);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waitingPush.push({ resolve, reject });
    });
    if (this.closed) throw new Error("queue closed while waiting to push");
    this.buffer.push(item);
  }

  /** Pop an item. Returns `{ value, done: false }` or `{ done: true }` when drained + closed. */
  async pop(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      const w = this.waitingPush.shift();
      if (w) w.resolve();
      return { value, done: false };
    }
    if (this.closed) {
      return { value: undefined as unknown as T, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waitingPop.push(resolve);
    });
  }

  /** Close the queue. Idempotent. Wakes all pending pops with `done: true`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waitingPop.length > 0) {
      const waiter = this.waitingPop.shift()!;
      waiter({ value: undefined as unknown as T, done: true });
    }
    while (this.waitingPush.length > 0) {
      const waiter = this.waitingPush.shift()!;
      waiter.reject(new Error("queue closed"));
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.pop();
      if (result.done) return;
      yield result.value;
    }
  }
}

/**
 * Map an async iterable into a new AsyncQueue, applying `fn` to each item.
 * Concurrency limits how many `fn` invocations run in parallel.
 * The returned queue closes when the input is exhausted and all in-flight tasks complete.
 */
export function mapAsync<TIn, TOut>(
  input: AsyncIterable<TIn>,
  fn: (item: TIn) => Promise<TOut>,
  options: { concurrency: number; outputBufferSize?: number } = { concurrency: 3 },
): AsyncQueue<TOut> {
  const out = new AsyncQueue<TOut>(options.outputBufferSize ?? 50);
  const concurrency = Math.max(1, options.concurrency);

  (async () => {
    const inFlight = new Set<Promise<void>>();
    try {
      for await (const item of input) {
        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
        const task = (async () => {
          try {
            const result = await fn(item);
            await out.push(result);
          } catch (err) {
            console.error("[mapAsync] task failed:", err);
            // failures are isolated — other tasks proceed
          }
        })();
        const tracked = task.finally(() => inFlight.delete(tracked));
        inFlight.add(tracked);
      }
      await Promise.allSettled(Array.from(inFlight));
    } finally {
      out.close();
    }
  })();

  return out;
}

/** Tap into an async iterable without consuming it: returns a new iterable that
 *  yields the same items while calling `sideEffect` for each. */
export async function* tap<T>(
  input: AsyncIterable<T>,
  sideEffect: (item: T) => void | Promise<void>,
): AsyncIterable<T> {
  for await (const item of input) {
    await sideEffect(item);
    yield item;
  }
}

/** Collect an async iterable into an array. For tests and short streams only. */
export async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of input) out.push(item);
  return out;
}
