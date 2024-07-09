export class DeferrableTask<T> {
  private task: () => Promise<any>;
  public finished: boolean = false;
  public failureMessage: string = '';

  public data: T | null;
  public id: string = Math.random().toString(36).substring(7);
  constructor(task: () => Promise<T>) {
    this.task = task;
  }

  public async run() {
    try {
      const result = await this.task();
      this.finished = true;
      this.data = result;
    } catch (error) {
      this.failureMessage = error;
      this.finished = true;
      this.data = null;
    }
  }
}