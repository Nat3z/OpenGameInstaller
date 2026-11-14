# Client protocol architecture

One backend, one protocol, any frontend. The backend owns every decision;
frontends render the state it sends and send commands back.

```
frontends   Svelte (Electron) · GPUI Deck · CLI · third-party
               │
            @ogi-sdk/client-kit   (TS)      ogi-client (Rust, later)
               │  WS 127.0.0.1:7654/client  · token from client.json
            @ogi-sdk/protocol     schemas + envelope (the contract)
               │
            @ogi-sdk/core         server · library · events · (pipeline, over time)
               │  adapters: LibraryStore, DownloadSource, SleepLock, Shell …
            application/          the Electron host
               │
            addon-server ─ ws /   bun addons (unchanged; `ogi dev` hosts it
                                  itself and the app joins as an SDK client)
```

## Why

Today the Svelte renderer runs about 5k lines of orchestration (download
services, setup pipeline, recovery, launch hooks). That means:

- closing the window mid-setup loses the setup,
- a Steam `--game-id` launch needs a window,
- any other frontend (a Deck UI, a CLI) would have to reimplement the pipeline.

Moving the logic into core and putting a protocol in front of it fixes all
three, and lets the server be rewritten later (Rust) without touching a
frontend.

## Packages

| Package              | Is                                   | README                          |
| -------------------- | ------------------------------------ | ------------------------------- |
| `@ogi-sdk/protocol`  | the contract, no runtime logic        | `packages/protocol/README.md`   |
| `@ogi-sdk/core`      | the engine plus adapters              | `packages/core/README.md`       |
| `@ogi-sdk/client-kit` | the client: `OGIClient` + addon `Connection` | `packages/client-kit/README.md` |

## Request lifecycle

```
OGIClient                     WS /client                       OGIServer (core)
connect          ── hello { token, protocol: 1 } ─────────▶   check token, version
                 ◀── welcome { groups: [library, events] } ──
library.list()   ── call  { id: 1, method: library.list } ─▶   Library.list
                 ◀── result { id: 1, result: [...] } ────────
library.watch()  ── subscribe { id: 2, ... } ───────────────▶   subscribe feed, read list
                 ◀── snapshot { id: 2, snapshot: [...] } ────
                 ◀── update   { id: 2, update: Saved } ──────   Library.save published
stop()           ── unsubscribe { id: 2 } ──────────────────▶   interrupt the fiber
```

## Status

| Step                                   | PR   | State |
| -------------------------------------- | ---- | ----- |
| protocol + core + `OGIClient` + library | #269 | done  |
| events: notices through core `Events`  | #270 | done  |
| prompts: first-answer-wins human input | #271 | done  |
| launch: `library.launch`, managed hooks | #272 | done  |
| download state: `downloads.watch`, controls | #273 | done |
| addons: proxied through core           | #274 | done  |
| headless: `electron . --headless`      | #275 | done  |
| `ogi dev`: `/client` under `--no-server` | #276 | done  |
| pipeline: `downloads.enqueue`, sources + setup | —  | next  |
| renderer on `OGIClient`; delete bridges | —   | after |
| bun host; Rust `ogi-client`; GPUI Deck | —    | later |

## Maintaining it

See `docs/maintaining-core.md` for recipes: adding a method, a group, an
event, an adapter; where tests go; and the rules that keep the boundary clean.
