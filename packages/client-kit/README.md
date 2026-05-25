# @ogi-sdk/client-kit

Client-side kit for OpenGameInstaller integrations. It provides typed helpers for connecting to addon servers and calling generated addon methods over the shared OGI protocol.

## Installation

```sh
bun add @ogi-sdk/client-kit
```

## Usage

```ts
import { Connection } from '@ogi-sdk/client-kit';

const connection = new Connection({ url: 'ws://localhost:3000' });
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
