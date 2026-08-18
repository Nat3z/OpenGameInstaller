export class RendererEventReadiness {
  private ready = false;
  private readonly waiters = new Set<() => void>();

  public isReady(): boolean {
    return this.ready;
  }

  public markReady(): void {
    this.ready = true;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  public reset(): void {
    this.ready = false;
  }

  public wait(timeoutMs: number, onTimeout: () => void): Promise<void> {
    if (this.ready) return Promise.resolve();

    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout);
        this.waiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.waiters.delete(finish);
        onTimeout();
        resolve();
      }, timeoutMs);
      this.waiters.add(finish);
    });
  }
}
