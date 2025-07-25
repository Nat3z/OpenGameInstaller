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
    { path, type, name, usedRealDebrid, appID, storefront, multiPartFiles },
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
event
  .askForInput(
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
  )
  .then((input) => {
    /* do what you want with the input! */
  });
```

# Important about async functions

If you want your event handler to be async, you must use `new Promise` to make it async.

**Example:**

```typescript
addon.on('setup', ({ text, type }, event) => {
  event.defer(); // IMPORTANT!!!!! This MUST be before your Promise.
  new Promise<void>(async (resolve, reject) => {
    // your async code here...
    event.resolve(/* your resolution here */);
    resolve();
  });
});
```
