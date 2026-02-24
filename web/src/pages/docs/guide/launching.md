---
layout: ../../../layouts/BlogLayout.astro
title: Launching Games
description: How to launch games in OpenGameInstaller
part: 4
section: User's Guide
---

Games installed on OpenGameInstaller are automatically configured to work with the library. You can launch them from the built-in library in the app.

## Linux: UMU vs legacy

On **Linux**, new games use **UMU** (Unified Launcher for Windows Games on Linux). They are **launched directly from the OpenGameInstaller library**—no need to add them to Steam or use Game Mode for the library. For details, see [UMU Launcher (Linux)](/docs/guide/umu).

Older games that were set up with the legacy Steam + Proton flow still launch from Steam. If you don’t see a game in the library on Linux, it may be a legacy Steam game; check Steam (and Game Mode if you use it) and ensure the client has been restarted if needed.

## Troubleshooting

### My game isn't launching

- **Linux (UMU games)**: Confirm the game’s executable and working directory in the game settings. Ensure [UMU](/docs/guide/umu) is installed (OGI installs it automatically on first use). Check that any required redistributables (e.g. vcredist, .NET) are installed via the game’s setup or settings.
- **Linux (legacy Steam games)**: Make sure the game appears in Steam and that you’ve entered Game Mode or fully restarted the Steam client if needed.
- **Windows**: Make sure the game is installed in the correct directory and the game’s executable is set correctly in the settings. If it still doesn’t launch, try reinstalling or checking the game’s installation directory.

### My game is crashing

Check that all dependencies are installed. On **Linux with UMU**, ensure the game’s Wine prefix has the required redistributables (vcredist, dotnet, etc.); you can run setup again or use the game’s settings to install them. On **Linux with legacy Steam/Proton**, ensure the game is compatible with Proton, the correct Proton version is selected in Steam, and the Wine prefix has the needed redistributables. On **Windows**, ensure all required libraries and frameworks are installed.

If you still have issues on Linux with a **legacy** Steam game, try editing the game’s launch options in Steam and removing the line that sets `STEAM_COMPAT_DATA_PATH=...`.
