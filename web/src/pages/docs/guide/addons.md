---
layout: ../../../layouts/BlogLayout.astro
title: Addons
description: What are addons and why do you need them
part: 2
section: User's Guide
---

Addons are the key for running code, providing sources, and creating setup scripts for games in OpenGameInstaller. OGI addons are written in JavaScript/TypeScript and are stored in the `addons` folder of the OGI installation directory. They are automatically loaded by the OGI Addon Server on startup.

When installing addons, you will usually need to have a '**catalog**' addon and a '**source search**' addon. The catalog addon provides the list of games and their metadata, while the source search addon is responsible for finding, serving, and setting up the game files. Once the source search addon has setup the game, OpenGameInstaller then becomes responsible for additional setup, such as installing dependencies, configuring the game to work on Steam, and launching.

## Troubleshooting

### Getting errors about addons not running

Make sure that your addon is installed completely. You can do this by going to `Settings > General` and pressing the "Install All Addons" button. Afterwards, click "Restart Addon Server" to ensure that the addon is loaded correctly. If you're still having issues, make sure that "Bun" is installed on your system.

### Can't find any games

Make sure you have a catalog addon installed. When you downloaded OpenGameInstaller, we automatically installed the `steam-catalog` addon, which serves games found on Steam. If you want to install games from other sources, you will need to install a different catalog addon.

### My search isn't giving any results

Make sure that you are searching through the search bar that's persistent between view changes, it's the one at the very top next to the OGI logo, the downloads, and notifications buttons. Additionally, make sure your search query is precise, with no missing letters, typos, or acronyms. If you are still having issues, make sure that a source search addon is installed.

### My game isn't launching

If you are playing on Linux, games are automatically setup and configured to work on Steam with Proton. The built-in library feature is currently not supported for Linux. If you don't see the game on Steam, make sure that you either entered into Game Mode or fully restarted the Steam client.