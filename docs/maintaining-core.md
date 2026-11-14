# Maintaining core and the client protocol

How to change the protocol and core without breaking the boundary. Read
`docs/client-protocol.md` first for the big picture.

## Where things go

| You are changing…                         | Edit                                             |
| ----------------------------------------- | ------------------------------------------------ |
| what a client can call or watch           | `packages/protocol/lib/groups/<group>.ts`        |
| how core answers it                       | `packages/core/lib/<area>/` (service + handlers) |
| something only the Electron app can do    | an adapter in `application/src/electron/server/` |
| what the desktop window shows             | the Svelte renderer (until it uses `OGIClient`)  |

Rule of thumb: **if any OGI host would do it the same way, it's core.** If it
depends on Electron, a window, or the app's own storage, it's an adapter.

## Recipe: add a method to an existing group

Example: `library.rename({ appID, name })`.

1. **Protocol.** Declare it; this is the whole contract.

   ```ts
   // packages/protocol/lib/groups/library.ts
   rename: call({
     params: Schema.Struct({ appID: Schema.Number, name: Schema.String }),
     result: Schema.Void,
   }),
   ```

   Every client already has `ogi.library.rename(...)` with these types. Until
   step 2 lands it answers `MethodNotFound`, so this can ship first.

2. **Core.** Implement it on the service, then route it.

   ```ts
   // packages/core/lib/library/handlers.ts
   rename: ({ appID, name }) =>
     Effect.flatMap(Library, (library) => library.rename(appID, name)),
   ```

   If the service needs something only a host can give, add it to that
   service's adapter (`LibraryStore` here), not to the handler.

3. **Test** it in `packages/core/lib/server/server.test.ts` through a real
   `OGIClient`: call it, assert the result, and assert the `library.watch`
   update if it changes state.

4. **Host.** If you added to an adapter, implement it in the app
   (`application/src/electron/services/library.ts` → `LibraryStoreFromDatabase`).

## Recipe: add a group

1. `packages/protocol/lib/groups/<name>.ts`: `export const XGroup = group('x', {...})`.
2. Add it to `Groups` in `packages/protocol/lib/index.ts`.
3. Add a typed property in `packages/client-kit/lib/ogi-client.ts`, on both
   `EffectOGIClient` and `OGIClient` (two lines each, copy `addons`).
4. `packages/core/lib/<name>/`: a `Context.Tag` service, its `Live` layer, and
   `XHandlers = implement(XGroup, {...})`. Export from `packages/core/lib/index.ts`.
5. Serve it: add `XHandlers` to `implementations` in
   `application/src/electron/server/client-server.ts`, and provide any adapter.

## Recipe: add an event (a notice with no state)

1. Add a `Schema.TaggedStruct('Name', {...})` to `AppEvent` in
   `packages/protocol/lib/groups/events.ts`.
2. Publish it from the app: `publishEvent({ _tag: 'Name', ... })`.
3. Until the renderer uses `OGIClient`, map it to its IPC channel in
   `eventToIpc` in `application/src/electron/server/events-bridge.ts`. The
   switch is exhaustive, so TypeScript reminds you.

If it describes something that **stays true** (a download's progress, a game
running), it is state, not an event. Put it on the owning group's `watch`.

## Recipe: ask the user something

```ts
const answer = yield* Effect.flatMap(Prompts, (prompts) =>
  prompts.ask({
    _tag: 'Confirm',
    title: 'Overwrite existing files?',
    message: '…',
    confirmLabel: 'Overwrite',
    cancelLabel: 'Keep',
  })
);
if (answer._tag === 'Confirm' && answer.confirmed) { … }
```

Every client sees it and the first answer wins. If the asking fiber is
interrupted, the prompt closes for everyone. Never use `dialog.*` in core or in
a handler; that only shows on one machine's window.

## Recipe: add an adapter

1. In core: a `Context.Tag` with a small `Shape` describing **what** core needs,
   not how (`LaunchHooks.run(game, stage)`, not "call the addon server").
2. Core code depends on the tag and nothing else.
3. In the app: `Layer.succeed(Tag, {...})` in `application/src/electron/server/`,
   provided where the server is built (`client-server.ts`).
4. In tests: a `Layer.succeed(Tag, fake)` that records calls (see
   `packages/core/lib/launch/launch.test.ts`).

Only add an adapter when there really is more than one implementation (an
engine, a host, a runtime). Otherwise write the code directly in core.

## Watching state: the one pattern

Every `watch` must **subscribe before reading the snapshot**:

```ts
watch: Effect.gen(function* () {
  const subscription = yield* PubSub.subscribe(changes); // 1. subscribe
  const snapshot = [...current.values()];                // 2. then read
  return { snapshot, updates: Stream.fromQueue(subscription) };
}),
```

The other way round, a change between the read and the subscribe is lost
forever. `Library`, `Downloads`, and `Prompts` all follow this; copy one.

## Changing the wire

- Adding a method, a group, an optional field, or a union case is **not**
  breaking. Older clients ignore it, and missing methods answer
  `MethodNotFound`.
- Removing or renaming anything, or changing what a field means, **is**
  breaking: bump `PROTOCOL_VERSION` in `packages/protocol/lib/envelope.ts`.
  Old clients then get `VersionMismatch` at `hello` instead of corrupt data.

## Tests that matter

| Test                                          | Guards                                   |
| --------------------------------------------- | ---------------------------------------- |
| `packages/core/lib/server/server.test.ts`     | the contract: real client ↔ real server  |
| `packages/core/lib/launch/launch.test.ts`     | launch order, hooks run once, prompts    |
| `application/tests/events-bridge.test.ts`     | renderer still gets the same IPC         |
| `application/tests/downloads-bridge.test.ts`  | engine messages → download state         |

Add contract tests for new methods. Don't add tests that only restate a
schema.

## Commands

```sh
bun run build                 # all packages (protocol before core before app)
bun run typecheck             # whole repo
cd packages/core && bun test  # core + contract tests
cd application && bun test    # app tests
```

A package change is only visible to the app after `bun run build` in that
package; `typecheck` from the root builds everything first.

## The bridges are temporary

`events-bridge.ts`, `prompts-bridge.ts`, and the IPC half of `emitDownload`
exist so the Svelte renderer keeps working unchanged. When the renderer moves
to `OGIClient`, delete them. Until then, don't add new logic to them; they
should only translate.
