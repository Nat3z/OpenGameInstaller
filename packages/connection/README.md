# @ogi-sdk/connect

`@ogi-sdk/connect` provides the typed WebSocket protocol primitives used by OpenGameInstaller addons, the addon server, and client SDKs. It defines shared event names, argument/response types, message builders, and a request/response socket wrapper so integrations can communicate without hand-writing protocol envelopes.

## Installation

```sh
bun add @ogi-sdk/connect
```

## Usage

```ts
import { defineProtocol, EventResponseSocket, upgradeToWebSocket } from '@ogi-sdk/connect';

const protocol = defineProtocol({
  clientToServer: {},
  serverToClient: {},
});

// Wrap a WebSocket-like object to send messages and await correlated responses.
const transport = new EventResponseSocket(socket, { responseEvent: 'response' });
await transport.send({ event: 'ping', args: {} });
```

For HTTP upgrade paths, use `upgradeToWebSocket`/`createWebSocketUpgradeListener` with your server and then wrap accepted sockets with `EventResponseSocket`.

## API overview

- `defineProtocol` declares typed protocol directions and derives event/message types.
- `EventResponseSocket` wraps standard WebSocket-like transports, parses JSON messages, dispatches event listeners, and correlates responses by message id.
- `upgradeToWebSocket` and related helpers adapt HTTP upgrade requests into WebSocket connections.

## Development

```sh
bun install
bun test
bun run build
```

See [lib/index.ts](./lib/index.ts) and the generated TypeScript declarations for fuller API details and integration examples used by the addon server and client kit.
