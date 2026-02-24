---
layout: ../../../layouts/BlogLayout.astro
title: Adding Game Update Support
description: Implement update checks, update source search, and update setup.
part: 9
section: Your First Addon
---

OpenGameInstaller supports addon-driven game updates through three events:

1. `check-for-updates`
2. `search` with `for: 'update'`
3. `setup` with `for: 'update'`

## How update flow works in the app

1. OGI checks installed library entries and calls `check-for-updates` with:
   - `appID`
   - `storefront`
   - `currentVersion`
2. If your addon resolves with `{ available: true, version }`, the Play page shows an update button.
3. When the user opens update sources, OGI calls `search` with `for: 'update'` and includes `libraryInfo`.
4. User picks a source and downloads.
5. OGI calls `setup` with `for: 'update'` and includes `currentLibraryInfo`.
6. Your `setup` resolves new runtime data (`version`, `cwd`, `launchExecutable`, `launchArguments`).
7. OGI updates the existing library entry version and launch metadata.

## 1) Implement `check-for-updates`

```typescript
addon.on('check-for-updates', ({ appID, storefront, currentVersion }, event) => {
  event.defer();

  // Replace with your own update lookup.
  const latestVersion = '1.2.0';

  if (currentVersion !== latestVersion) {
    event.resolve({
      available: true,
      version: latestVersion,
    });
  } else {
    event.resolve({
      available: false,
    });
  }
});
```

## 2) Handle update source queries in `search`

Branch on `for === 'update'` and use `libraryInfo` when needed:

```typescript
addon.on('search', async (query, event) => {
  const { appID, storefront, for: searchFor } = query;
  event.defer();

  if (searchFor === 'update') {
    const currentInfo = query.libraryInfo;

    event.resolve([
      {
        name: `Update ${currentInfo.name} to 1.2.0`,
        downloadType: 'direct',
        files: [
          {
            name: `${currentInfo.name}-patch.zip`,
            downloadURL: 'https://example.com/patch.zip',
          },
        ],
        manifest: {
          targetVersion: '1.2.0',
          patchType: 'incremental',
        },
        // Keep existing files in place for incremental patchers.
        clearOldFilesBeforeUpdate: false,
      },
    ]);
    return;
  }

  // Normal non-update search logic:
  event.resolve([]);
});
```

## 3) Handle update setup in `setup`

When `for === 'update'`, use `currentLibraryInfo` and apply your patch/update logic.

```typescript
addon.on('setup', async (data, event) => {
  event.defer();

  if (data.for === 'update') {
    const { path, currentLibraryInfo, manifest, clearOldFilesBeforeUpdate } = data;

    // Apply patch/update files in `path`...
    // You can use currentLibraryInfo + manifest to decide strategy.
    // clearOldFilesBeforeUpdate reflects the selected source option.

    event.resolve({
      version: String(manifest?.targetVersion ?? '1.2.0'),
      cwd: currentLibraryInfo.cwd,
      launchExecutable: currentLibraryInfo.launchExecutable,
      launchArguments: currentLibraryInfo.launchArguments ?? '',
    });
    return;
  }

  // Normal game setup logic...
  event.resolve({
    version: '1.0.0',
    cwd: data.path,
    launchExecutable: 'game.exe',
    launchArguments: '',
  });
});
```

## Important behavior to know

- Control whether OGI stages files into `old_files` before update setup:
  - Set `clearOldFilesBeforeUpdate: false` in your update `search` result when you need in-place patching.
  - OGI defaults to staging existing files when the property is omitted.

- Return the exact target version in update setup:
  - OGI validates the version returned by `setup` against the selected update target.
  - If they do not match, OGI marks the update as failed.
- Update setup updates existing library metadata:
  - This flow updates version/launch metadata for an existing entry.
  - It is not the same as first-time install setup.
- **Linux / UMU:** If the game uses UMU, preserve the existing config by including `umu: currentLibraryInfo.umu` in the object you pass to `event.resolve(...)`. Otherwise the game may lose its UMU association. See [UMU and LibraryInfo (Linux)](/docs/first-addon/umu-libraryinfo).
- Keep version strings consistent:
  - Use a stable format in both `check-for-updates` and `setup`.

## Storefront ownership note

Update checks are storefront-scoped. Make sure your addon declares and serves the storefront of apps you want to update.

- `check-for-updates` is expected to have a single storefront owner.
- If multiple addons try to serve update checks for the same storefront, OGI will not choose one automatically.

## Related pages

- [Creating a Source Searcher](/docs/first-addon/adding-source-searcher)
- [Adding a Setup Handler](/docs/first-addon/setup-app)
