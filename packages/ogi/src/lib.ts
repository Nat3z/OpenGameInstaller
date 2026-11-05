import { AddonServer } from '@ogi-sdk/addon-server';
import { Console, Effect } from 'effect';

export default class OgiMaker {
  /** Starts an addon server and resolves with it once it's listening. */
  start(
    port: number,
    enforceSecurity: boolean,
    securityKey: string,
    localOnly: boolean = false
  ): Promise<AddonServer> {
    return Effect.gen(function* () {
      yield* Console.log(
        `Server starting on port ${port} with security ${enforceSecurity ? 'enabled' : 'disabled'}`
      );

      const addon = new AddonServer({
        port,
        securityCheck: enforceSecurity,
        secret: securityKey,
        localOnly,
      });
      yield* addon.start();
      yield* Console.log('Server started');
      return addon;
    }).pipe(Effect.runPromise);
  }
}
