import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { LibraryInfo, OGIAddonSDKEventListener } from '@ogi-sdk/connect';
import { Effect } from 'effect';

mock.module('@/frontend/lib/config/client', () => ({
  getConfigClientOption: () => null,
}));

let installedAddonUrls: string[] = [];
let restartAddonServerCalls = 0;
let onRestartAddonServer = () => {};

mock.module('@/frontend/lib/electron-rpc', () => ({
  electronRpc: {
    installAddons: (addons: string[]) =>
      Effect.sync(() => {
        installedAddonUrls = addons;
        return addons;
      }),
    restartAddonServer: () =>
      Effect.sync(() => {
        restartAddonServerCalls++;
        onRestartAddonServer();
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
  public readonly launchCalls: Array<{
    addonId: string;
    launchType: 'pre' | 'post';
  }> = [];

  public constructor(
    private readonly addons: MockAddon[],
    private readonly onClose?: () => Promise<void>
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

  public addon(addonId: string) {
    return {
      launchApp: async ({
        launchType,
      }: {
        libraryInfo: LibraryInfo;
        launchType: 'pre' | 'post';
      }) => {
        if (!this.open) {
          throw new Error('Websocket is not open (readyState: 3)');
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
});

beforeEach(() => {
  restartAddonServerCalls = 0;
  onRestartAddonServer = () => {};
  connectFailuresRemaining = 0;
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
    connections = [new MockConnection([{ id: 'installed' }])];

    const connectedAddons = await Effect.runPromise(
      addons.installAddonsAndReconnect(['https://example.com/installed'])
    );

    expect(installedAddonUrls).toEqual(['https://example.com/installed']);
    expect(connectedAddons).toEqual([{ id: 'installed' }]);
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
    await ipc.addonServer.close();

    const result = await Effect.runPromise(
      addons.runLaunchAppAddons({ appID: 1 } as LibraryInfo, 'pre')
    );

    expect(result).toEqual({ success: true });
    expect(reconnected.launchCalls).toEqual([
      { addonId: 'launch-addon', launchType: 'pre' },
    ]);
  });

  test('play hooks restart an unhealthy addon runtime', async () => {
    const restarted = new MockConnection([
      {
        id: 'launch-addon',
        name: 'Launch Addon',
        eventsAvailable: ['launch-app'],
      },
    ]);
    connections = [restarted];
    connectFailuresRemaining = Number.POSITIVE_INFINITY;
    onRestartAddonServer = () => {
      connectFailuresRemaining = 0;
    };
    await ipc.addonServer.close();

    const result = await Effect.runPromise(
      addons.runLaunchAppAddons({ appID: 1 } as LibraryInfo, 'pre')
    );

    expect(result).toEqual({ success: true });
    expect(restartAddonServerCalls).toBe(1);
    expect(restarted.launchCalls).toEqual([
      { addonId: 'launch-addon', launchType: 'pre' },
    ]);
  });
});
