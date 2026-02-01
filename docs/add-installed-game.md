# Add an installed game (user-facing)

This document describes the **Add own Games** feature for end users. See the [implementation plan](./implementation-plan-issue-18-add-own-games.md) for technical details.

## What it does

Users can add games that are already installed on their system to the OpenGameInstaller library. The flow is:

1. **Library** → **Add game** (or **Add installed game** when the library is empty).
2. Fill in the form: **Game name**, **Executable path** (required), **Working directory** (optional; defaults to the executable’s folder), and optional version, launch arguments, and image URLs.
3. Submit. The game is saved with `storefront: 'local'` and a negative app ID. On Linux, it is also added to Steam with Proton.

## In-app behavior

- **PlayPage** for these games shows “Added locally” instead of a store link, and does not show update/addon tasks.
- **Settings** allow changing the executable path, working directory, and launch arguments.
- If the executable is moved or deleted, the game page shows an “Executable not found” warning with a link to Settings.

## User docs

A short guide for users is in the web docs under **User’s Guide → Add an installed game** (`web/src/pages/docs/guide/add-installed-game.md`).
