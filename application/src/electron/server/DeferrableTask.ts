export class DeferrableTask<T> {
  private task: () => Promise<any>;
  public finished: boolean = false;

  public data: T | null;
  public id: string = Math.random().toString(36).substring(7);
  public addonOwner = '';
  public logs: string[] = [];
  public progress = 0;
  public failed: string | undefined = undefined;
  constructor(task: () => Promise<T>, addonOwner: string) {
    this.task = task;
    this.addonOwner = addonOwner;
  }

  public async run() {
    try {
      const result = await this.task();
      this.finished = true;
      this.data = result;
    } catch (error) {
      this.failed = error;
      this.data = null;
      this.finished = true;
    }
  }
}