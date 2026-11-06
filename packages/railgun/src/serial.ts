/**
 * Runs async jobs one at a time. The RAILGUN session is a Rust object behind
 * wasm-bindgen: touching it (even a getter) while an async call holds its
 * borrow throws "recursive use of an object detected". Every session access
 * goes through one queue.
 */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(job, job);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
