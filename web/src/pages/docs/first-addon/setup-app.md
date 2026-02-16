---
layout: ../../../layouts/BlogLayout.astro
title: Adding a Setup Handler
description: A guide on how to make your first addon for OpenGameInstaller.
part: 6
section: Your First Addon
---

**Setup handlers are required by OpenGameInstaller in order for games to be properly added to the library.** Setup handlers are called once a download is finished, and the addon must provide the **library info** for the app. **Keep In Mind** that only the addon whom the user chose to download from will be able to setup the app.

To create a setup handler, create an event handler for the `setup` event.

```typescript
addon.on(
  'setup',
  (
    {
      path,
      type,
      name,
      usedRealDebrid,
      clearOldFilesBeforeUpdate,
      appID,
      storefront,
      multiPartFiles,
      manifest,
      for: setupFor,
      currentLibraryInfo,
    },
    event
  ) => {
    // resolve a LibraryInfo object
    event.resolve({
      cwd: path,
      launchExecutable: join(path, 'text.exe'),
      version: '1.0.0',
    });
  }
);
```

As you can see, the setup event provides a variety of information about the download, allowing the setup handler to determine if files need to be unzipped, where to place files, etc.

## Creating Screens to Ask for Input

If your setup script requires many inputs before it can complete the setup, you can use `event.askForInput`, which can be used to ask the user for info. It uses `ConfigurationBuilder` to make the screen, which is the same class used for making addon configs.

```typescript
await event.askForInput(name, description, config);
```

**Example:**

```typescript
const input = await event.askForInput(
  'Please enter the code',
  'code',
  new ConfigurationBuilder().addNumberOption((option) =>
    option
      .setDisplayName('Code')
      .setName('code')
      .setDescription('Enter the code')
      .setMin(1)
      .setMax(100)
  )
);

// do what you want with input.code
```

# Important about async functions

You can make setup handlers `async` directly. You do not need to wrap them in `new Promise`.

**Example:**

```typescript
addon.on(
  'setup',
  async ({ path, appID, storefront, for: setupFor, currentLibraryInfo }, event) => {
    event.defer();

    const latestVersion =
      (await addon.getAppDetails(appID, storefront))?.latestVersion ?? '1.0.0';

    event.resolve({
      cwd: path,
      launchExecutable: 'game.exe',
      launchArguments: '',
      version: latestVersion,
    });
  }
);
```

Use `event.defer()` whenever your setup performs async work like extraction, network requests, or scanning files.

## Related: Action tasks and task input

For user-triggered tasks outside setup (including `task.askForInput(...)`), see [Action Buttons & Tasks](/docs/first-addon/action-buttons-and-tasks).

For update-specific setup (`for: 'update'` with `currentLibraryInfo`), see [Adding Game Update Support](/docs/first-addon/adding-game-updates).
