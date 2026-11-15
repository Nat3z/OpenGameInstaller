import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EffectOGIClient, OGIClient } from '@ogi-sdk/client-kit';
import type { LibraryInfo } from '@ogi-sdk/connect';
import { ProtocolError } from '@ogi-sdk/protocol';
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from 'effect';
import { Addons, AddonsHandlers } from '../addons/addons';
import {
  DownloadControl,
  Downloads,
  DownloadsHandlers,
  DownloadsLive,
} from '../downloads/downloads';
import { Events, EventsHandlers, EventsLive } from '../events/events';
import {
  GameRunner,
  LaunchHandlers,
  LaunchHooks,
  LaunchLive,
} from '../launch/launch';
import { LibraryHandlers } from '../library/handlers';
import { Library, LibraryLive, LibraryStore } from '../library/library';
import { Prompts, PromptsHandlers, PromptsLive } from '../prompts/prompts';
import { OGIServer } from './server';
import type { ServerSocket } from './socket';

// Contract test: the real client against the real server over a real socket.
// No mocks of either side; the only fake is the storage adapter.

const game = (appID: number): LibraryInfo => ({
  appID,
  name: `Game ${appID}`,
  version: '1',
  cwd: `relative/${appID}`, // relative, so no manifest is written
  launchExecutable: 'game.exe',
  capsuleImage: '',
  coverImage: '',
  storefront: 'steam',
  addonsource: 'test',
});

const memoryStore = () => {
  const rows = new Map<number, LibraryInfo>([[1, game(1)]]);
  return Layer.succeed(LibraryStore, {
    get: (appID) => Effect.succeed(rows.get(appID) ?? null),
    list: Effect.sync(() => [...rows.values()]),
    save: (info) => Effect.sync(() => void rows.set(info.appID, info)),
    markLaunched: () => Effect.void,
    stageRemoval: (appID) =>
      Effect.sync(() => {
        const row = rows.get(appID)!;
        rows.delete(appID);
        return { commit: () => {}, rollback: () => rows.set(appID, row) };
      }),
  });
};

const TOKEN = 'test-token';
const steamAddon = {
  id: 'steam',
  name: 'Steam',
  storefronts: ['steam'],
  events: ['search', 'game-details'],
};
const launched: number[] = [];
const library = LibraryLive.pipe(Layer.provide(memoryStore()));
const launch = LaunchLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(LaunchHooks, { run: () => Effect.void }),
      Layer.succeed(GameRunner, {
        start: (appID) => Effect.sync(() => void launched.push(appID)),
      })
    )
  ),
  Layer.provideMerge(library)
);
/** The ProtocolError a call rejected with. */
const failure = (call: Promise<unknown>): Promise<ProtocolError> =>
  call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: ProtocolError) => error
  );
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    launch,
    EventsLive,
    PromptsLive,
    // One Downloads instance shared by the handlers and the fake engine.
    Layer.effect(
      DownloadControl,
      Effect.map(Downloads, (downloads) => ({
        pause: (id: string) => downloads.report(id, { status: 'paused' }),
        resume: () => Effect.void,
        cancel: (id: string) => downloads.remove(id),
      }))
    ).pipe(Layer.provideMerge(DownloadsLive)),
    // One fake addon: supports search, not catalog.
    Layer.succeed(Addons, {
      list: Effect.succeed([steamAddon]),
      describe: (id) =>
        Effect.succeed(id === steamAddon.id ? steamAddon : null),
      call: (_, event, args) =>
        Effect.succeed(
          event === 'search'
            ? [{ name: 'Direct', args }]
            : { name: 'Store page' }
        ),
    })
  )
);
let server: ReturnType<typeof Bun.serve>;
let url = '';
const scope = Effect.runSync(Scope.make());

beforeAll(async () => {
  const ogi = await runtime.runPromise(
    OGIServer.make({
      token: TOKEN,
      implementations: [
        LibraryHandlers,
        LaunchHandlers,
        EventsHandlers,
        PromptsHandlers,
        DownloadsHandlers,
        AddonsHandlers,
      ],
    }).pipe(Scope.extend(scope))
  );
  // Bun's ServerWebSocket pushes messages to the server-level handler, so
  // each connection keeps its own listeners in `data`.
  type Data = { message?: (text: string) => void; close?: () => void };
  server = Bun.serve<Data, never>({
    port: 0,
    fetch: (req, srv) =>
      srv.upgrade(req, { data: {} })
        ? undefined
        : new Response('no', { status: 400 }),
    websocket: {
      open(ws) {
        const socket: ServerSocket = {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          onMessage: (listener) => (ws.data.message = listener),
          onClose: (listener) => (ws.data.close = listener),
        };
        ogi.serve(socket);
      },
      message: (ws, message) => ws.data.message?.(String(message)),
      close: (ws) => ws.data.close?.(),
    },
  });
  url = `ws://127.0.0.1:${server.port}/client`;
});

afterAll(async () => {
  server.stop(true);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
});

describe('OGIServer <-> OGIClient', () => {
  test('rejects a bad token', async () => {
    const error = await OGIClient.connect({ url, token: 'nope' }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).tag).toBe('Unauthorized');
  });

  /**
   * A server that accepts the socket and never closes it itself; `reply` is
   * what it sends on `hello`, if anything. Resolves `closed` when the client
   * hangs up.
   */
  const handshakeServer = (reply?: string) => {
    let hungUp!: () => void;
    let helloed!: () => void;
    const closed = new Promise<void>((resolve) => (hungUp = resolve));
    const hello = new Promise<void>((resolve) => (helloed = resolve));
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) =>
        srv.upgrade(req) ? undefined : new Response('no', { status: 400 }),
      websocket: {
        message(ws) {
          helloed();
          if (reply) ws.send(reply);
        },
        close() {
          hungUp();
        },
      },
    });
    return {
      url: `ws://127.0.0.1:${server.port}/client`,
      server,
      closed,
      hello,
    };
  };

  test('a server that never answers hello times out and is hung up on', async () => {
    const silent = handshakeServer();
    const error = await OGIClient.connect({
      url: silent.url,
      token: TOKEN,
      handshakeTimeout: '50 millis',
    }).catch((e: unknown) => e);
    expect((error as ProtocolError).tag).toBe('Disconnected');
    await silent.closed;
    silent.server.stop(true);
  });

  test('cancelling a pending handshake hangs up', async () => {
    const silent = handshakeServer();
    const fiber = Effect.runFork(
      Effect.scoped(EffectOGIClient.connect({ url: silent.url, token: TOKEN }))
    );
    // Interrupt only once the socket is open and `hello` is in flight.
    await silent.hello;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await silent.closed;
    silent.server.stop(true);
  });

  test('disconnected settles when the connection goes away', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    await client.close();
    expect(typeof (await client.disconnected)).toBe('string');
  });

  test('a rejected hello hangs up even if the server keeps the socket', async () => {
    const rude = handshakeServer(
      JSON.stringify({
        _tag: 'error',
        id: null,
        error: { _tag: 'Unauthorized', message: 'no' },
      })
    );
    const error = await OGIClient.connect({
      url: rude.url,
      token: TOKEN,
    }).catch((e: unknown) => e);
    expect((error as ProtocolError).tag).toBe('Unauthorized');
    await rude.closed;
    rude.server.stop(true);
  });

  test('calls return decoded results', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    expect(client.effect.serverGroups).toEqual([
      'library',
      'events',
      'prompts',
      'downloads',
      'addons',
    ]);
    expect((await client.library.list()).map((g) => g.appID)).toEqual([1]);
    expect((await client.library.get({ appID: 1 }))?.name).toBe('Game 1');
    expect(await client.library.get({ appID: 9 })).toBeNull();
    await client.close();
  });

  test('library.launch reaches the launcher', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    await client.library.launch({ appID: 1 });
    expect(launched).toEqual([1]);
    await client.close();
  });

  test('unimplemented methods fail with MethodNotFound', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    const error = await client.library
      .uninstall({ appID: 1, deleteFiles: false })
      .catch((e) => e);
    expect(error.tag).toBe('MethodNotFound');
    // The pipeline is not served here, so its methods are missing too.
    const enqueue = await client.downloads
      .enqueue({ appID: 1, addonSource: 'x', result: {} })
      .catch((e) => e);
    expect(enqueue.tag).toBe('MethodNotFound');
    await client.close();
  });

  test('watch sends a snapshot, then live changes', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    const events: string[] = [];
    const snapshotSeen = Promise.withResolvers<void>();
    const changeSeen = Promise.withResolvers<void>();

    const stop = client.library.watch((event) => {
      if (event._tag === 'Snapshot') {
        events.push(`snapshot:${event.value.map((g) => g.appID).join(',')}`);
        snapshotSeen.resolve();
      } else {
        events.push(event.value._tag);
        if (events.length === 3) changeSeen.resolve();
      }
    });
    await snapshotSeen.promise;

    // Mutations go through core's Library, exactly like the app's handlers.
    await runtime.runPromise(
      Effect.gen(function* () {
        const library = yield* Library;
        yield* library.save(game(2));
        const removal = yield* library.stageRemoval(1);
        removal.commit();
      })
    );
    await changeSeen.promise;
    expect(events).toEqual(['snapshot:1', 'Saved', 'Removed']);
    stop();
    await client.close();
  });

  test('events.watch delivers published events in order', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    const seen: string[] = [];
    const subscribed = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const stop = client.events.watch((event) => {
      if (event._tag === 'Snapshot') return subscribed.resolve();
      seen.push(event.value._tag);
      if (seen.length === 2) done.resolve();
    });
    await subscribed.promise;
    await runtime.runPromise(
      Effect.flatMap(Events, (events) =>
        Effect.andThen(
          events.publish({ _tag: 'AddonsStarted' }),
          events.publish({ _tag: 'ShowChangelog', version: '5.0.0' })
        )
      )
    );
    await done.promise;
    expect(seen).toEqual(['AddonsStarted', 'ShowChangelog']);
    stop();
    await client.close();
  });

  test('a prompt reaches every client and the first answer wins', async () => {
    const a = await OGIClient.connect({ url, token: TOKEN });
    const b = await OGIClient.connect({ url, token: TOKEN });
    // Both clients see the prompt open, then close for everyone.
    const opened = (client: OGIClient) => {
      const seen = Promise.withResolvers<string>();
      const closed = Promise.withResolvers<void>();
      const stop = client.prompts.watch((event) => {
        if (event._tag !== 'Update') return;
        if (event.value._tag === 'Opened') seen.resolve(event.value.prompt.id);
        else closed.resolve();
      });
      return { seen: seen.promise, closed: closed.promise, stop };
    };
    const onA = opened(a);
    const onB = opened(b);
    await Bun.sleep(50);

    // Core asks; the answer comes back through whoever replies first.
    const asked = runtime.runPromise(
      Effect.flatMap(Prompts, (prompts) =>
        prompts.ask({
          _tag: 'Confirm',
          title: 'Close Steam?',
          message: 'Steam must close briefly',
          confirmLabel: 'Close',
          cancelLabel: 'Cancel',
        })
      )
    );
    const id = await onA.seen;
    expect(await onB.seen).toBe(id);

    const first = await b.prompts.reply({
      id,
      answer: { _tag: 'Confirm', confirmed: true },
    });
    const second = await a.prompts.reply({
      id,
      answer: { _tag: 'Confirm', confirmed: false },
    });
    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: false });
    expect(await asked).toEqual({ _tag: 'Confirm', confirmed: true });
    await Promise.all([onA.closed, onB.closed]);

    onA.stop();
    onB.stop();
    await Promise.all([a.close(), b.close()]);
  });

  test('a late subscriber gets open prompts in the snapshot', async () => {
    const asking = runtime.runFork(
      Effect.flatMap(Prompts, (prompts) =>
        prompts.ask({
          _tag: 'Input',
          title: 'Login',
          description: '',
          config: {},
        })
      )
    );
    await Bun.sleep(20);
    const client = await OGIClient.connect({ url, token: TOKEN });
    const snapshot = Promise.withResolvers<number>();
    const stop = client.prompts.watch((event) => {
      if (event._tag === 'Snapshot') snapshot.resolve(event.value.length);
    });
    expect(await snapshot.promise).toBe(1);
    stop();
    await client.close();
    await Effect.runPromise(Fiber.interrupt(asking));
  });

  test('downloads.watch merges engine reports; controls reach the engine', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    const report = (patch: Record<string, unknown>) =>
      runtime.runPromise(
        Effect.flatMap(Downloads, (d) => d.report('dl-1', patch))
      );
    await report({ name: 'Game', status: 'downloading', progress: 0.1 });

    const updates: string[] = [];
    const snapshot = Promise.withResolvers<number>();
    const paused = Promise.withResolvers<void>();
    const stop = client.downloads.watch((event) => {
      if (event._tag === 'Snapshot')
        return snapshot.resolve(event.value.length);
      const change = event.value;
      updates.push(
        change._tag === 'Upsert'
          ? `${change.download.status}:${change.download.progress}:${change.download.name}`
          : `removed:${change.id}`
      );
      if (change._tag === 'Upsert' && change.download.status === 'paused')
        paused.resolve();
    });
    expect(await snapshot.promise).toBe(1);

    await report({ progress: 0.5 }); // partial: name and status survive
    await client.downloads.pause({ id: 'dl-1' });
    await paused.promise;
    // A paused download is still in flight: it can't be cleared yet.
    const early = await client.downloads.clear({ id: 'dl-1' }).catch((e) => e);
    expect(early.tag).toBe('DownloadError');
    await report({ status: 'completed', progress: 1 });
    await client.downloads.clear({ id: 'dl-1' });
    const missing = await client.downloads
      .pause({ id: 'dl-1' })
      .catch((e) => e);

    expect(updates).toEqual([
      'downloading:0.5:Game',
      'paused:0.5:Game',
      'completed:1:Game',
      'removed:dl-1',
    ]);
    expect(missing.tag).toBe('DownloadError');
    stop();
    await client.close();
  });

  test('addon calls are proxied through core', async () => {
    const client = await OGIClient.connect({ url, token: TOKEN });
    expect((await client.addons.list()).map((addon) => addon.id)).toEqual([
      'steam',
    ]);
    // Core fills in the addon protocol's `for`, so clients don't need to.
    expect(
      await client.addons.search({
        addonId: 'steam',
        appID: 7,
        storefront: 'steam',
      })
    ).toEqual([
      { name: 'Direct', args: { appID: 7, storefront: 'steam', for: 'game' } },
    ]);
    const unsupported = await failure(
      client.addons.catalog({ addonId: 'steam' })
    );
    expect(unsupported.tag).toBe('AddonError');
    expect(unsupported.message).toContain('does not support catalog');
    const missing = await failure(client.addons.catalog({ addonId: 'nope' }));
    expect(missing.message).toContain('not running');
    await client.close();
  });
});
