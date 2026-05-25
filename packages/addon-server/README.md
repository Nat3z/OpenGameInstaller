# @ogi-sdk/addon-server

Addon server runtime for [OpenGameInstaller](https://ogi.nat3z.com/). It exposes the HTTP/WebSocket bridge used by OGI to talk to addon code and shares protocol types with the rest of the OGI SDK.

## Installation

```sh
bun add @ogi-sdk/addon-server
```

## Usage

```ts
import { AddonServer } from '@ogi-sdk/addon-server';

const server = new AddonServer({ port: 3000, securityCheck: true });
await server.start();
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
