import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Effect } from 'effect';

mock.module('@/frontend/lib/config/client', () => ({
  getConfigClientOption: () => null,
}));

type MockResponse = {
  statusError?: string;
  args: { addons: { id: string }[] };
};

class MockConnection {
  private open = true;

  public constructor(
    private readonly addons: { id: string }[],
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

  public async close(): Promise<void> {
    this.open = false;
    await this.onClose?.();
  }
}

let closeStarted: Promise<void>;
let releaseClose: () => void;
let connections: MockConnection[];

mock.module('@ogi-sdk/client-kit', () => ({
  Connection: {
    make: () => Promise.resolve(connections.shift()!),
  },
}));

let ipc: typeof import('../src/frontend/lib/core/ipc.js');

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
});
