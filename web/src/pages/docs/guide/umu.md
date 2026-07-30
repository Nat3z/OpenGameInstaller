---
layout: ../../../layouts/BlogLayout.astro
title: UMU Launcher (Linux)
description: How OpenGameInstaller runs Windows games on Linux with UMU.
part: 6
section: User's Guide
---

On **Linux**, OpenGameInstaller uses **UMU** (Unified Launcher for Windows Games on Linux) to run Windows games and lets you **launch games directly from the OpenGameInstaller library** without adding them to Steam.

## What is UMU?

UMU is an open-source launcher from [Open-Wine-Components](https://github.com/Open-Wine-Components/umu-launcher). It manages Wine/Proton prefixes and runs Windows executables in a consistent way. OGI downloads and updates UMU automatically, so you don’t need to install it yourself.

## How it works

- **First-time setup**: When you install a Windows game on Linux, OGI configures it to use UMU. If UMU isn’t installed yet, OGI will download it the first time you launch a game or run setup.
- **Per-game prefixes**: Each game gets its own Wine prefix under `~/.ogi-wine-prefixes/`. This keeps game data and dependencies separate and avoids conflicts.
- **In-app library**: You can launch UMU-backed games from the OpenGameInstaller library. No need to add them to Steam or use Game Mode for the library.
- **Proton**: UMU handles the Proton runtime. Addons should usually avoid forcing a `PROTONPATH` override unless a game truly requires one.

## Do I need Steam?

For **new installations** on Linux, you do **not** need Steam. UMU is used by default and games run from OGI’s library.

Older games that used Steam/Proton can be migrated to an OGI-managed UMU prefix. OGI copies a compatible existing prefix when it can identify one and otherwise initializes a fresh prefix.

## Redistributables (vcredist, .NET, etc.)

Games often need Visual C++ runtimes, .NET, or other redistributables. For games using UMU, OGI can install these via UMU’s winetricks integration during or after setup. If a game fails to start, check the game’s settings in OGI and ensure any required redistributables are selected or run the setup again so they can be installed.

## Troubleshooting

### UMU won’t install or update

OGI downloads UMU from GitHub. If installation or update fails:

- Check your internet connection and any firewall/proxy that might block GitHub.
- Ensure the OGI app has write access to its install directory (e.g. the `bin/umu` folder next to the app).

### Game fails to launch with UMU

- Confirm the game’s executable and working directory are correct in the game settings.
- Ensure required redistributables are installed (see above).
- Check the log file (e.g. `update/latest.log` next to your Setup.AppImage or in the OGI data directory) for `[umu]` messages; they often indicate prefix or launch errors.

### I have an older Steam/Proton library entry

Some older games may initially be configured in **legacy mode**. Migrate those entries from the game configuration to use OGI-managed UMU launching. New Windows games are configured for UMU by default.

## Where are UMU files stored?

- **UMU launcher**: Installed by OGI in its own `bin/umu` directory (e.g. next to the app or in the OGI update folder). The `umu-run` binary is used to launch games.
- **Wine prefixes**: Under `~/.ogi-wine-prefixes/`. Each game has a subfolder (e.g. `umu-<id>`). You can back up or remove these folders to free space or reset a game’s Wine environment.

## Summary

| Topic           | Detail                                    |
| --------------- | ----------------------------------------- |
| Platform        | Linux only                                |
| Installation    | Automatic (downloaded by OGI when needed) |
| Game launch     | From OpenGameInstaller library            |
| Prefix location | `~/.ogi-wine-prefixes/`                   |
| Steam required? | No, for UMU-configured games              |

For general launch issues (e.g. wrong executable, crashes), see [Launching Games](/docs/guide/launching).
