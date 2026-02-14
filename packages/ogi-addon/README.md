# OGI-Addon

A library to interface with OpenGameInstaller's addon system.

## Installation

```bash
bun add ogi-addon
```

## Documentation

- [First addon guide](https://ogi.nat3z.com/docs/first-addon)
- [Configuration setup](https://ogi.nat3z.com/docs/first-addon/adding-configs)
- [Discover catalogs and carousel](https://ogi.nat3z.com/docs/first-addon/adding-discover-catalogs)
- [Action buttons and tasks](https://ogi.nat3z.com/docs/first-addon/action-buttons-and-tasks)
- [Game update support](https://ogi.nat3z.com/docs/first-addon/adding-game-updates)
- [Migration guide (v2.0.x to v2.1)](https://ogi.nat3z.com/docs/updates/2.0-to-2.1)

## Example Addon

See `test-addon` for an end-to-end example:
[test-addon](https://github.com/Nat3z/OpenGameInstaller/tree/main/test-addon)

## `addon.json` Boilerplate

Your addon should include an `addon.json` file that describes setup and runtime scripts.

```ts
interface AddonFileConfigurationSchema {
  author: string;
  scripts: {
    setup?: string;
    run: string;
    preSetup?: string;
    postSetup?: string;
  };
}
```

## Local Development in OGI

In OpenGameInstaller, go to `Settings > General` and use the `local:` prefix to point to your addon path.

Example:

```text
local:C:\Users\[you]\Documents\Addon\
```

### Disable Signature Requirement (Debug Only)

If you need to debug outside normal launch flow, you can disable signature checks.

Warning: this is unsafe and allows unsigned programs to connect to the addon server.

To disable, go to `Settings > Developer`, select `Disable Server Secret Check`, and restart OGI.
