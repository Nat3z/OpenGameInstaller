# @ogi-sdk/executor

Execution utilities for OpenGameInstaller addons. This package contains helpers for addon setup, launch, Git-based addon loading, and addon configuration validation.

## Installation

```sh
bun add @ogi-sdk/executor
```

## Usage

```ts
import { Addon } from '@ogi-sdk/executor';

const addon = new Addon({
  name: 'my-addon',
  path: './my-addon',
  port: 3000,
  secret: 'dev-secret',
});

await addon.setup.runSetup();
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
