/**
 * Small per-surface render scheduler.
 *
 * One instance owns one pending timer for one UI surface. Use flushNow() for
 * state-boundary renders (start/completion/error), and requestRender() for
 * animation/progress deltas that can be coalesced on the cadence.
 */
export class RenderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly flush: () => void,
    private readonly cadenceMs: number,
  ) {}

  requestRender(): void {
    if (this.disposed || this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.cadenceMs);
  }

  flushNow(): void {
    if (this.disposed) return;

    this.clear();
    this.flush();
  }

  clear(): void {
    if (!this.timer) return;

    clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
