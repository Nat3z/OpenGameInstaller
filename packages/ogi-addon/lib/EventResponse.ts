export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;

  public defer() {
    this.deffered = true;
  }

  public resolve(data: T) {
    this.data = data;
  }
  
}