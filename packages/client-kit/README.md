# @ogi-sdk/client-kit

The client SDK for OpenGameInstaller. Frontends use it to talk to an OGI
backend (`@ogi-sdk/core`) over `@ogi-sdk/protocol`. It is the client half
only: it sends commands and renders state, and never runs the pipeline itself.

It has two clients:

| Client                         | Talks to                         | Use it for                    |
| ------------------------------ | -------------------------------- | ----------------------------- |
| `OGIClient` / `EffectOGIClient` | core at `ws://127.0.0.1:7654/client` | library, downloads, prompts, events |
| `Connection` (existing)         | the addon server at `/sdk`       | calling addons directly       |

## Installation

```sh
bun add @ogi-sdk/client-kit
```

## OGIClient

The desktop app writes the URL and a per-launch token to `client.json` in its
data directory (`~/.local/share/OpenGameInstaller` on Linux).

### Promise API (no Effect needed)

```ts
import { OGIClient } from '@ogi-sdk/client-kit';

const { url, token } = JSON.parse(await Bun.file(clientJsonPath).text());
const ogi = await OGIClient.connect({ url, token });

const games = await ogi.library.list(); // typed LibraryEntry[]
const game = await ogi.library.get({ appID: 7 });

// Streams take a callback and return an unsubscribe function.
const stop = ogi.library.watch((event) => {
  if (event._tag === 'Snapshot') render(event.value); // full list, once
  else apply(event.value); // { _tag: 'Saved' | 'Removed' | 'Launched' | 'Exited' }
});

stop();
await ogi.close();
```

### Effect API

```ts
import { EffectOGIClient } from '@ogi-sdk/client-kit';

const program = Effect.gen(function* () {
  const ogi = yield* EffectOGIClient.connect({ url, token }); // closes with the scope
  const games = yield* ogi.library.list();
  yield* ogi.events.watch().pipe(
    Stream.runForEach((event) => Effect.log(event))
  );
});
Effect.runPromise(Effect.scoped(program));
```

### Errors

Every failure is a `ProtocolError` with a `tag`: the server's error name
(`GameNotFound`) or a protocol one (`Unauthorized`, `MethodNotFound`,
`InvalidParams`, `Disconnected`). All groups are on the client, but a server
only implements some of them; check `ogi.effect.serverGroups`, or expect
`MethodNotFound`.

## What to build next

1. **Reconnect.** Give `OGIClient` an option to reconnect with backoff and
   re-subscribe active streams. Subscriptions start with a snapshot, so
   resubscribing is enough and nothing needs replaying.
2. **Token discovery helper.** `OGIClient.local()` reads `client.json` from the
   platform data dir (same rules as `application/src/electron/manager/manager.paths.ts`).
3. **Svelte adapter.** A `readable` store per stream, e.g.
   `libraryStore(ogi)`, so the renderer can swap `electronRpc` calls for
   protocol calls one view at a time.
4. **Electron transport (optional).** If the renderer should skip the socket,
   add an IPC transport behind the same `EffectOGIClient` API.

## Addon Connection (existing)

```ts
import { Connection } from '@ogi-sdk/client-kit';

const connection = new Connection({ url: 'ws://localhost:7654' });
const addon = connection.addon('my-addon-id');
```

## Development

```sh
bun install
bun run build
bun run typecheck
```

## Release

```sh
bun run release
# or publish a future/beta tag
bun run release-beta
```
