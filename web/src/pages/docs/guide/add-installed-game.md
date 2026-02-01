---
layout: ../../../layouts/BlogLayout.astro
title: Add an installed game
description: How to add games that are already installed on your system to your library.
part: 5
section: User's Guide
---

You can add games that are already installed on your system to your OpenGameInstaller library. This lets you launch and manage them from the same interface as games installed via addons.

## How to add an installed game

1. Open the **Library** view.
2. Click **Add game** (in the "All Games" header) or **Add installed game** (when the library is empty).
3. In the modal:
   - **Game name**: Enter a display name for your library.
   - **Executable path**: Choose the game's executable (e.g. `.exe`, `.sh`, or a binary). Use **Browse** to pick the file.
   - **Working directory**: Optional. Leave empty to use the executable's folder, or choose another folder (e.g. where the game stores configs or assets).
   - Optionally set **Version**, **Launch arguments**, and **Capsule** / **Cover** image URLs.
4. Click **Add game**.

The game is saved with a local entry in your library. On Linux, it is also added to Steam with Proton so you can launch it from OGI or Steam.

## After adding

- **Play**: Use the **Play** button on the game's page as with any other library game.
- **Settings**: Use **Settings** to change the executable path, working directory, or launch arguments if the game was moved or you need to fix the path.
- **Executable not found**: If you move or delete the game file after adding it, the game page will show an "Executable not found" warning. Open **Settings** and update the executable path (and working directory if needed).

## Notes

- **Linux**: If the executable is a Windows (`.exe`) game, it will run through Steam using Proton. Native Linux binaries and scripts (e.g. `.sh`) can be launched directly.
- **Steam**: If adding to Steam fails (e.g. "Could not add game to Steam"), ensure Steam is running and try again. You can also add the game manually in Steam and still launch it from OGI if the paths in Settings are correct.
