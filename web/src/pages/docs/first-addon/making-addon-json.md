---
layout: ../../../layouts/BlogLayout.astro
title: Making your addon.json
description: A guide on how to make your first addon for OpenGameInstaller.
part: 1
section: Your First Addon
---

To let OpenGameInstaller know **how** to launch your addon, you need to create an `addon.json` file. This file must contain two scripts, `setup` and `run`.

In the root of your addon's folder, create a file called `addon.json` using the following structure:

```ts
{
  author: string,
  scripts: {
    preSetup: string,
    setup: string,
    postSetup: string,
    run: string
  }
}
```

| Script Name | Key       | Description                                                                                      |
| ----------- | --------- | ------------------------------------------------------------------------------------------------ |
| Pre Setup   | preSetup  | A script which runs before running the setup script. Use this as a tool to install dependencies. |
| Setup       | setup     | A script which is used to setup your addon. Use this as the initializer for important files.     |
| Post Setup  | postSetup | A script which runs after running the setup script. Use this to verify your addon is ready.      |
| Run         | run       | A script which runs your addon. OGI provides an `--addonSecret` to let addon connect.            |

Example:

```json
{
  "author": "OpenGameInstaller Devs",
  "scripts": {
    "preSetup": "bun install --frozen-lockfile",
    "setup": "bun run setup.ts",
    "postSetup": "bun run cleanup.ts",
    "run": "bun run main.ts"
  }
}
```
