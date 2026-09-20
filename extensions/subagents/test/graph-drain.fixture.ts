import { setImmediate } from "node:timers/promises";
import { expect } from "vitest";

export function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A cancellation request must remain pending until the fixture physically settles. */
export async function releaseAfterPending(work: Promise<unknown>, release: () => void): Promise<void> {
  let settled = false;
  void work.then(() => { settled = true; }, () => { settled = true; });
  await setImmediate();
  try { expect(settled).toBe(false); }
  finally { release(); }
}
