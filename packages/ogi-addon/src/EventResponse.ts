import { ConfigurationBuilder } from './main';

export default class EventResponse<T> {
  data: T | undefined = undefined;
  deffered: boolean = false;
  resolved: boolean = false;
  progress: number = 0;
  logs: string[] = [];
  failed: string | undefined = undefined;
  onInputAsked?: <U extends Record<string, string | number | boolean>>(
    screen: ConfigurationBuilder<U>,
    name: string,
    description: string
  ) => Promise<U>;

  constructor(
    onInputAsked?: <U extends Record<string, string | number | boolean>>(
      screen: ConfigurationBuilder<U>,
      name: string,
      description: string
    ) => Promise<U>
  ) {
    this.onInputAsked = onInputAsked;
  }

  public defer(promise?: () => Promise<void>) {
    this.deffered = true;
    // include this to make it easier to use the defer method with async functions
    if (promise) {
      promise();
    }
  }

  /**
   * Resolve the event with data. This acts like a promise resolve, and will stop the event from being processed further. **You must always call this method when you are done with the event.**
   * @param data {T}
   */
  public resolve(data: T) {
    this.resolved = true;
    this.data = data;
  }

  /**
   * Completes the event and resolves it, but does not return any data. **You must always call this method when you are done with the event.**
   */
  public complete() {
    this.resolved = true;
  }

  public fail(message: string) {
    this.resolved = true;
    this.failed = message;
  }

  /**
   * Logs a message to the event. This is useful for debugging and logging information to the user.
   * @param message {string}
   */
  public log(message: string) {
    this.logs.push(message);
  }

  /**
   * Send a screen to the client to ask for input. Use the `ConfigurationBuilder` system to build the screen. Once sent to the user, the addon cannot change the screen.
   * The return type is inferred from the ConfigurationBuilder's accumulated option types.
   * @async
   * @param name {string} The name/title of the input prompt.
   * @param description {string} The description of what input is needed.
   * @param screen {ConfigurationBuilder<U>} The configuration builder for the input form.
   * @returns {Promise<U>} The user's input with types matching the configuration options.
   */
  public async askForInput<U extends Record<string, string | number | boolean>>(
    name: string,
    description: string,
    screen: ConfigurationBuilder<U>
  ): Promise<U> {
    if (!this.onInputAsked) {
      throw new Error('No input asked callback');
    }
    return await this.onInputAsked(screen, name, description);
  }
}
