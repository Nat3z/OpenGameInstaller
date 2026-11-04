import { AddonServer } from '@ogi-sdk/addon-server';
import { Console, Effect } from 'effect';

export default class OgiMaker {
  start(port: number, enforceSecurity: boolean, securityKey: string) {
    return Effect.gen(function* () {
      yield* Console.log(
        `Server starting on port ${port} with security ${enforceSecurity ? 'enabled' : 'disabled'}`
      );

      const addon = new AddonServer({
        port,
        securityCheck: enforceSecurity,
        secret: securityKey,
      });
      yield* addon.start();
      yield* Console.log('Server started');
    }).pipe(Effect.runPromise);
  }
}
