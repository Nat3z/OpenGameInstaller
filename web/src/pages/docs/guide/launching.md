---
layout: ../../../layouts/BlogLayout.astro
title: Launching Games
description: How to launch games in OpenGameInstaller
part: 3
section: User's Guide
---

Games when installed on OpenGameInstaller are automatically configured to work with the library system. If you are on Linux, games installed will be set up to work with Steam and Proton and will not be accessible through the library feature.

## Troubleshooting

### My game isn't launching

If you are playing on Linux, games are automatically setup and configured to work on Steam with Proton. The built-in library feature is currently not supported for Linux. If you don't see the game on Steam, make sure that you either entered into Game Mode or fully restarted the Steam client.

If you are on Windows, make sure that the game is installed in the correct directory and that the game's executable is set correctly in the settings. If the game is still not launching, try to reinstall the game or check the game's installation directory for any issues.

### My game is crashing

Check if all dependencies are installed correctly. If you are on Linux, make sure that the game is compatible with Proton and that you have the correct version of Proton selected in the game's properties on Steam and that the Wine Prefix created has the Common Redistributables installed (ex. vcredist, dotnet, etc.). If you are on Windows, ensure that all required libraries and frameworks are installed locally.
