# @ogi-sdk/protocol

The contract between OpenGameInstaller frontends and backends. It contains no
runtime logic: only Effect Schemas for every method and stream, the wire
envelope, and `PROTOCOL_VERSION`.

```
frontends ── @ogi-sdk/client-kit ──┐
                                   ├── speak @ogi-sdk/protocol over WS /client
backend   ── @ogi-sdk/core ────────┘
```

## Defining methods

A group is a set of methods addressed as `<group>.<method>` on the wire.

```ts
export const LibraryGroup = group('library', {
  // request -> response
  list: call({ params: Schema.Void, result: Schema.Array(LibraryEntry) }),
  // one snapshot, then updates until either side ends it
  watch: stream({
    params: Schema.Void,
    snapshot: Schema.Array(LibraryEntry),
    update: LibraryChange,
  }),
});
```

That one definition types the server handlers (`implement(LibraryGroup, …)`
in core), the client methods (`client.library.list()` in client-kit), and
later the Rust types.

## Wire envelope (`lib/envelope.ts`)

Every frame is one JSON object with a `_tag`. This is the only part a non-TS
client has to implement by hand.

```jsonc
// client -> server
{ "_tag": "hello",       "token": "…", "protocol": 1 }
{ "_tag": "call",        "id": 1, "method": "library.get", "params": { "appID": 7 } }
{ "_tag": "subscribe",   "id": 2, "method": "library.watch" }
{ "_tag": "unsubscribe", "id": 2 }

// server -> client
{ "_tag": "welcome",  "protocol": 1, "groups": ["library", "events"] }
{ "_tag": "result",   "id": 1, "result": { … } }
{ "_tag": "error",    "id": 1, "error": { "_tag": "GameNotFound", "message": "…" } }
{ "_tag": "snapshot", "id": 2, "snapshot": [ … ] }
{ "_tag": "update",   "id": 2, "update": { "_tag": "Saved", "entry": { … } } }
{ "_tag": "end",      "id": 2 }
```

Rules:

- The first client frame must be `hello`. A bad token or version closes the socket.
- `id`s are picked by the client and unique per connection.
- A subscription always starts with exactly one `snapshot`, so a reconnecting
  client just subscribes again; nothing needs replaying.
- Errors are `{ _tag, message }`. `_tag` is the server-side error name, so
  clients can still branch on `GameNotFound` and similar.
- Methods a server has not implemented answer `MethodNotFound`. `welcome.groups`
  lists the groups it does implement.

## Groups

| Group       | Status                                   | File                  |
| ----------- | ---------------------------------------- | --------------------- |
| `library`   | `list`, `get`, `watch` served by core     | `groups/library.ts`   |
| `events`    | `watch` served by core (notifications)    | `groups/events.ts`    |
| `downloads` | schema draft, not served                  | `groups/downloads.ts` |
| `prompts`   | schema draft, not served                  | `groups/prompts.ts`   |
| `addons`    | schema draft, not served                  | `groups/addons.ts`    |

## What to build next

1. **Firm up the drafts as their pass lands in core.** `downloads.enqueue`
   takes `result: Schema.Unknown`; give it a real `SearchResult` schema when
   the download pipeline moves (`@ogi-sdk/connect` has the TS type).
2. **Schema-ify the addon payloads** (`addons.*`, `prompts.Input.config`).
   Port `ConfigurationFile`, `SearchResult`, `StoreData`, and `CatalogResponse`
   from `@ogi-sdk/connect/lib/protocol-base.ts` to Schemas here, then have
   `connect` re-export the types so there is one source.
3. **JSON Schema export.** Add `scripts/export-json-schema.ts` that walks
   `Groups` and writes `build/protocol.schema.json` with Effect's
   `JSONSchema.make`. That file is the input for non-TS clients and for
   `typify` in the Rust `ogi-client` crate.
4. **Version bumps.** Adding a method or an optional field is not a bump.
   Removing or renaming anything, or changing a field's meaning, bumps
   `PROTOCOL_VERSION`.

## Development

```sh
bun run build
bun run typecheck
```
