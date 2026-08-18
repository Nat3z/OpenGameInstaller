import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { Effect } from 'effect';

mock.module('@/frontend/lib/config/client', () => ({
  getConfigClientOption: () => null,
  fetchAddonsWithConfigure: () =>
    Effect.gen(function* () {
      const connectedAddons = yield* ipc.queryConnectedAddons<MockAddon>();
      const server = yield* ipc.getAddonServer();
      yield* Effect.forEach(
        connectedAddons,
        (addon) =>
          Effect.promise(() => server.addon(addon.id).configUpdate({})),
        { concurrency: 'unbounded', discard: true }
      );
      return connectedAddons;
    }),
}));

let installedAddonUrls: string[] = [];
let restartAddonServerCalls = 0;
let onRestartAddonServer = () => {};
let ensureAddonsSpawnedCalls = 0;
let onEnsureAddonsSpawned = () => {};
let onInstallAddons = async () => {};
let connectionMakeCalls = 0;

mock.module('@/frontend/lib/electron-rpc', () => ({
  electronRpc: {
    installAddons: (addons: string[]) =>
      Effect.promise(async () => {
        installedAddonUrls = addons;
        await onInstallAddons();
        return addons;
      }),
    restartAddonServer: () =>
      Effect.sync(() => {
        restartAddonServerCalls++;
        onRestartAddonServer();
      }),
    ensureAddonsSpawned: () =>
      Effect.sync(() => {
        ensureAddonsSpawnedCalls++;
        onEnsureAddonsSpawned();
      }),
  },
}));

type MockResponse = {
  statusError?: string;
  args: { addons: MockAddon[] };
};

type MockAddon = {
  id: string;
  name?: string;
  eventsAvailable?: OGIAddonSDKEventListener[];
};

class MockConnection {
  private open = true;
  public readonly configUpdateCalls: string[] = [];
  public readonly launchCalls: Array<{
    addonId: string;
    launchType: 'pre' | 'post';
  }> = [];

  public constructor(
    private readonly addons: MockAddon[],
    private readonly onClose?: () => Promise<void>,
    private configured = true
  ) {}

  public on(): Promise<void> {
    return Promise.resolve();
  }

  public async request(): Promise<MockResponse> {
    if (!this.open) {
      throw new Error('Websocket is not open (readyState: 3)');
    }
    return { args: { addons: this.addons } };
  }

  public replaceAddons(addons: MockAddon[], configured: boolean): void {
    this.addons.splice(0, this.addons.length, ...addons);
    this.configured = configured;
  }

  public addon(addonId: string) {
    return {
      configUpdate: async () => {
        if (!this.open) {
          throw new Error('Websocket is not open (readyState: 3)');
        }
        this.configUpdateCalls.push(addonId);
        this.configured = true;
      },
      launchApp: async ({
        launchType,
      }: {
        libraryInfo: LibraryInfo;
        launchType: 'pre' | 'post';
      }) => {
        if (!this.open) {
          throw new Error('Websocket is not open (readyState: 3)');
        }
        if (!this.configured) {
          throw new Error('Addon has not received config-update');
        }
        this.launchCalls.push({ addonId, launchType });
      },
    };
  }

  public async close(): Promise<void> {
    this.open = false;
    await this.onClose?.();
  }
}

let closeStarted: Promise<void>;
let releaseClose: () => void;
let connections: Array<MockConnection | Error>;
let connectFailuresRemaining = 0;

mock.module('@ogi-sdk/client-kit', () => ({
  Connection: {
    make: () => {
      connectionMakeCalls++;
      if (connectFailuresRemaining > 0) {
        connectFailuresRemaining--;
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:7654'));
      }
      const connection = connections.shift();
      return connection instanceof Error
        ? Promise.reject(connection)
        : Promise.resolve(connection!);
    },
  },
}));

let ipc: typeof import('../src/frontend/lib/core/ipc.js');
let addons: typeof import('../src/frontend/lib/core/addons.js');

beforeAll(async () => {
  let markCloseStarted: () => void;
  closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  connections = [
    new MockConnection([{ id: 'old' }], async () => {
      markCloseStarted();
      await closeGate;
    }),
    new MockConnection([{ id: 'new' }]),
  ];
  ipc = await import('../src/frontend/lib/core/ipc.js');
  addons = await import('../src/frontend/lib/core/addons.js');
  await Effect.runPromise(ipc.getAddonServer());
});

beforeEach(() => {
  restartAddonServerCalls = 0;
  onRestartAddonServer = () => {};
  ensureAddonsSpawnedCalls = 0;
  onEnsureAddonsSpawned = () => {};
  onInstallAddons = async () => {};
  connectFailuresRemaining = 0;
  connectionMakeCalls = 0;
});

describe('addon client reconnect', () => {
  test('queries wait for an in-flight reconnect', async () => {
    const reconnect = Effect.runPromise(ipc.reconnectClientSdk());
    await closeStarted;

    const query = Effect.runPromise(ipc.queryConnectedAddons<{ id: string }>());
    releaseClose();

    await reconnect;
    expect(await query).toEqual([{ id: 'new' }]);
  });

  test('install completion returns addons from the restarted server', async () => {
    const installed = new MockConnection(
      [{ id: 'installed' }],
      undefined,
      false
    );
    connections = [installed];
    onInstallAddons = async () =>
      (await Effect.runPromise(ipc.getAddonServer())).close();

    const connectedAddons = await Effect.runPromise(
      addons.installAddonsAndReconnect(['https://example.com/installed'])
    );

    expect(installedAddonUrls).toEqual(['https://example.com/installed']);
    expect(connectedAddons).toEqual([{ id: 'installed' }]);
    expect(installed.configUpdateCalls).toEqual(['installed']);
    expect(connectionMakeCalls).toBe(1);
  });

  test('concurrent stale queries share one reconnect', async () => {
    connections = [new MockConnection([{ id: 'shared' }])];
    await (await Effect.runPromise(ipc.getAddonServer())).close();
    connectionMakeCalls = 0;

    const [first, second] = await Promise.all([
      Effect.runPromise(ipc.queryConnectedAddons<{ id: string }>()),
      Effect.runPromise(ipc.queryConnectedAddons<{ id: string }>()),
    ]);

    expect(first).toEqual([{ id: 'shared' }]);
    expect(second).toEqual([{ id: 'shared' }]);
    expect(connectionMakeCalls).toBe(1);
  });

  test('play hooks recover from a stale addon connection', async () => {
    const reconnected = new MockConnection([
      {
        id: 'launch-addon',
        name: 'Launch Addon',
        eventsAvailable: ['launch-app'],
      },
    ]);
    connections = [
      new Error('connect ECONNREFUSED 127.0.0.1:7654'),
      reconnected,
    ];
    await (await Effect.runPromise(ipc.getAddonServer())).close();

    const result = await Effect.runPromise(
      addons.runLaunchAppAddons({ appID: 1 } as LibraryInfo, 'pre')
    );

    expect(result).toEqual({ success: true });
    expect(reconnected.launchCalls).toEqual([
      { addonId: 'launch-addon', launchType: 'pre' },
    ]);
  });

  test('play hooks spawn addons before configuration and launch', async () => {
    const server = await Effect.runPromise(ipc.getAddonServer());
    server.configUpdateCalls.length = 0;
    server.launchCalls.length = 0;
    server.replaceAddons([], true);
    onEnsureAddonsSpawned = () => {
      server.replaceAddons(
        [
          {
            id: 'spawned-addon',
            name: 'Spawned Addon',
            eventsAvailable: ['launch-app'],
          },
        ],
        false
      );
    };

    const result = await Effect.runPromise(
      addons.runLaunchAppAddons({ appID: 1 } as LibraryInfo, 'pre')
    );

    expect(result).toEqual({ success: true });
    expect(ensureAddonsSpawnedCalls).toBe(1);
    expect(server.configUpdateCalls).toEqual(['spawned-addon']);
    expect(server.launchCalls).toEqual([
      { addonId: 'spawned-addon', launchType: 'pre' },
    ]);
  });

  test('play hooks restart an unhealthy addon runtime', async () => {
    const restarted = new MockConnection(
      [
        {
          id: 'launch-addon',
          name: 'Launch Addon',
          eventsAvailable: ['launch-app'],
        },
      ],
      undefined,
      false
    );
    connections = [restarted];
    connectFailuresRemaining = Number.POSITIVE_INFINITY;
    onRestartAddonServer = () => {
      connectFailuresRemaining = 0;
    };
    await (await Effect.runPromise(ipc.getAddonServer())).close();

    const result = await Effect.runPromise(
      addons.runLaunchAppAddons({ appID: 1 } as LibraryInfo, 'pre')
    );

    expect(result).toEqual({ success: true });
    expect(restartAddonServerCalls).toBe(1);
    expect(restarted.configUpdateCalls).toEqual(['launch-addon']);
    expect(restarted.launchCalls).toEqual([
      { addonId: 'launch-addon', launchType: 'pre' },
    ]);
  });
});
