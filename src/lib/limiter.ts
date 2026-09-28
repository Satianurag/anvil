/** Counting semaphore: caps how many jobs run a resource at once; callers queue in FIFO order. */
export class Semaphore {
  private free: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.free = max;
  }

  async acquire() {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
}

export async function withLimit<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}
