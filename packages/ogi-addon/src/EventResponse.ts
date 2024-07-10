export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  public defer() {
    this.deffered = true;
  }

  public resolve(data: T) {
    this.resolved = true;
    this.data = data;
  }
  
}