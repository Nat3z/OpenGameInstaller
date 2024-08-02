import { ConfigurationBuilder } from "./main";

export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  progress: number = 0;
  logs: string[] = [];
  onInputAsked?: (screen: ConfigurationBuilder, name: string, description: string) => Promise<{ [key: string]: boolean | string | number }>;

  constructor(onInputAsked?: (screen: ConfigurationBuilder, name: string, description: string) => Promise<{ [key: string]: boolean | string | number }>) {
    this.onInputAsked = onInputAsked;
  }
  

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

  public async askForInput(name: string, description: string, screen: ConfigurationBuilder) {
    if (!this.onInputAsked) {
      throw new Error('No input asked callback');
    }
    return await this.onInputAsked(screen, name, description);
  }

  
}