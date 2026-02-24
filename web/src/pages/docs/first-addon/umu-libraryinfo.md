---
layout: ../../../layouts/BlogLayout.astro
title: UMU and LibraryInfo (Linux)
description: How to return UMU config from setup so games launch from the library on Linux.
part: 11
section: Your First Addon
---

On **Linux**, OpenGameInstaller uses **UMU** (Unified Launcher for Windows Games on Linux) to run Windows games from the **in-app library**. For a game to use UMU, your addon’s **setup** handler must include an `umu` object in the resolved `LibraryInfo`. If you omit `umu`, OGI will use the legacy Steam + Proton flow instead (game launches from Steam, not the library).

## When to return `umu`

- You are building a **source search** addon that sets up Windows games.
- You want those games to be **launchable from the OpenGameInstaller library** on Linux (no Steam required for launch).

Return `umu` only when the game is a Windows title that will run under Wine/Proton. You do not need to return `umu` on Windows or for native Linux games.

## LibraryInfo.umu shape

The `umu` field in `LibraryInfo` (from `ogi-addon`) has this shape:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `umuId` | `string` | Yes | Unique ID for the game’s Wine prefix. Format: `steam:${number}` or `umu:${string \| number}`. |
| `protonVersion` | `string` | No | Proton build to use (e.g. `UMU-Latest`). OGI default is `UMU-Latest` if omitted. |
| `store` | `string` | No | Store identifier for UMU. |
| `dllOverrides` | `string[]` | No | WINEDLLOVERRIDES-style overrides (e.g. `d3d11=n,b`). |
| `winePrefixPath` | `string` | No | Set by OGI; do not set in addon. |

OGI will set `winePrefixPath` automatically from `umuId`. Prefixes are stored under `~/.ogi-wine-prefixes/`.

## umuId format

- **Steam-sourced games:** Use `steam:${appID}` so the prefix maps to a stable Steam-style ID (e.g. `steam:12345` → prefix `umu-12345`).
- **Non-Steam games:** Use `umu:${id}` where `id` is a number or string unique to the game (e.g. `umu:12345` or `umu:my-store-xyz`). Using your internal `appID` is fine: `umu:${appID}`.

The regex enforced by `ogi-addon` is: `^(steam|umu):\S+$`.

## Example: setup with UMU (Linux)

```typescript
addon.on('setup', async (data, event) => {
  event.defer();

  const isLinux = process.platform === 'linux';
  const cwd = data.path;
  const version = '1.0.0';

  event.resolve({
    cwd,
    launchExecutable: 'game.exe',
    launchArguments: '',
    version,
    // Optional: only include umu on Linux so the game uses UMU and launches from the library
    ...(isLinux && {
      umu: {
        umuId: `umu:${data.appID}` as const,
        protonVersion: 'UMU-Latest', // optional
        store: data.storefront ?? 'unknown',
      },
    }),
  });
});
```

If your catalog is Steam-based and you have a Steam app ID, you can use `umuId: \`steam:${steamAppId}\`` so the prefix aligns with Steam’s compat data naming.

## Legacy mode

If you do **not** return `umu` on Linux, OGI sets the game to **legacy mode**: it is added to Steam and launched via Steam/Proton (and SteamTinkerLaunch if configured). The in-app library will not launch that game; the user launches it from Steam.

To force legacy mode even when you could pass `umu`, you can set `legacyMode: true` in the resolved `LibraryInfo`. Use this only if you need the old Steam-centric flow.

## Update setup and UMU

When handling **update** setup (`for: 'update'`), you usually resolve updated `version`, `cwd`, `launchExecutable`, and `launchArguments`. To keep the game on UMU after an update, **include the existing `umu` config** in the resolved object so OGI does not drop it:

```typescript
if (data.for === 'update') {
  const { currentLibraryInfo } = data;
  event.resolve({
    version: String(manifest?.targetVersion ?? '1.2.0'),
    cwd: currentLibraryInfo.cwd,
    launchExecutable: currentLibraryInfo.launchExecutable,
    launchArguments: currentLibraryInfo.launchArguments ?? '',
    umu: currentLibraryInfo.umu, // preserve UMU config
  });
  return;
}
```

If you omit `umu`, the app may treat the entry as legacy or lose the UMU association depending on merge behavior.

## Redistributables

If your game needs Visual C++ runtimes, .NET, or other redistributables, you can still use the `redistributables` array on `LibraryInfo`. On Linux with UMU, OGI can install them via UMU’s winetricks integration. See the main app logic for the expected shape (e.g. `name`, `path`).

## Summary

- **Linux + want library launch:** Return `umu: { umuId: 'steam:...' | 'umu:...' }` (and optionally `protonVersion`, `store`, `dllOverrides`) from `setup`.
- **Linux + Steam launch (legacy):** Omit `umu` (or set `legacyMode: true`).
- **Windows / native:** Omit `umu`; it is ignored on non-Linux.
- **Update setup:** Preserve `currentLibraryInfo.umu` when resolving so the game stays on UMU.

For user-facing UMU behavior and troubleshooting, see [UMU Launcher (Linux)](/docs/guide/umu) in the User’s Guide.
