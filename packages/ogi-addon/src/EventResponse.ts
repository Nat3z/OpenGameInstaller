export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  progress: number = 0;
  logs: string[] = [];

  public defer() {
    this.deffered = true;
  }

  public resolve(data: T) {
    this.resolved = true;
    this.data = data;
  }

  public complete() {
    this.resolved = true;
  }

  public log(message: string) {
    this.logs.push(message);
  }

  
}