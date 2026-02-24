---
layout: ../../../layouts/BlogLayout.astro
title: UMU Launcher (Linux)
description: How OpenGameInstaller runs Windows games on Linux with UMU.
part: 6
section: User's Guide
---

On **Linux**, OpenGameInstaller uses **UMU** (Unified Launcher for Windows Games on Linux) to run Windows games. UMU replaces the previous Steam + Proton + SteamTinkerLaunch workflow and lets you **launch games directly from the OpenGameInstaller library** without adding them to Steam.

## What is UMU?

UMU is an open-source launcher from [Open-Wine-Components](https://github.com/Open-Wine-Components/umu-launcher). It manages Wine/Proton prefixes and runs Windows executables in a consistent way. OGI downloads and updates UMU automatically, so you don’t need to install it yourself.

## How it works

- **First-time setup**: When you install a Windows game on Linux, OGI configures it to use UMU. If UMU isn’t installed yet, OGI will download it the first time you launch a game or run setup.
- **Per-game prefixes**: Each game gets its own Wine prefix under `~/.ogi-wine-prefixes/`. This keeps game data and dependencies separate and avoids conflicts.
- **In-app library**: You can launch UMU-backed games from the OpenGameInstaller library. No need to add them to Steam or use Game Mode for the library.
- **Proton**: UMU uses Proton (e.g. **UMU-Latest**) to run the game. OGI sets the prefix and environment for you.

## Do I need Steam or SteamTinkerLaunch?

For **new installations** on Linux, you do **not** need Steam or SteamTinkerLaunch. UMU is used by default and games run from OGI’s library.

If you have older games that were set up with the **legacy** Steam/Proton flow, those will keep using Steam until you reinstall or migrate them. Manual setup steps (e.g. installing Wine via Flatpak or SteamTinkerLaunch) are only needed if you use or support that legacy flow.

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

### I want to use Steam/Proton instead (legacy)

Some games may still be configured in **legacy mode**, which uses Steam and Proton outside of UMU. If you need to use that flow, you would need to set up Steam, Proton, and (historically) SteamTinkerLaunch as described in the [Installation](/docs/guide/installation) guide under the Linux-only sections. New games are configured for UMU by default.

## Where are UMU files stored?

- **UMU launcher**: Installed by OGI in its own `bin/umu` directory (e.g. next to the app or in the OGI update folder). The `umu-run` binary is used to launch games.
- **Wine prefixes**: Under `~/.ogi-wine-prefixes/`. Each game has a subfolder (e.g. `umu-<id>`). You can back up or remove these folders to free space or reset a game’s Wine environment.

## Summary

| Topic | Detail |
| ----- | ------ |
| Platform | Linux only |
| Installation | Automatic (downloaded by OGI when needed) |
| Game launch | From OpenGameInstaller library |
| Prefix location | `~/.ogi-wine-prefixes/` |
| Steam required? | No, for UMU-configured games |

For general launch issues (e.g. wrong executable, crashes), see [Launching Games](/docs/guide/launching).
