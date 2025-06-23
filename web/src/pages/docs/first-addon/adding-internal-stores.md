---
layout: ../../../layouts/BlogLayout.astro
title: Creating an Internal Store Page
description: A guide on how to make your first addon for OpenGameInstaller.
part: 5
section: Your First Addon
---

Internal Store Pages are listings which contain information about a non-steam game. OpenGameInstaller automatically creates listings for games that are from Steam, but games which aren't in Steam must have an internal game store.

# Adding a Search Function

Firstly, you must create a search function which provides results for games when requested by the client. You can do this by creating an event handler for the `library-search` event.

```typescript
addon.on('library-search', (text, event) => {
  event.defer();
  event.resolve([
    {
      appID: 1, // the appID used when sent to your addon for information about the listing.
      capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      name: 'Test App',
    },
  ]);
});
```

To handle searches, we recommend using `js-search` to query! You can get this library from [npm](https://www.npmjs.com/package/js-search), like so:

```bash
$ bun add js-search
$ bun add -D @types/js-search
```

# Adding a Store Page

To provide the store page for the appID provided, create an event handler for the `game-details` event. This event provides the appID, which you can use to get the application information.

```typescript
addon.on('game-details', (appID, event) => {
  event.resolve({
    appID: appID,
    basicDescription: 'The Coolest Test App',
    capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
    description: '<h1>hello world</h1>' // can be rendered as html!,
    coverImage: 'https://dummyimage.com/375x500/968d96/ffffff',
    name: 'Test App',
    developers: ['OGI Developers'],
    headerImage: 'https://dummyimage.com/500x350/968d96/ffffff',
    publishers: ['OGI Developers'],
    releaseDate: new Date().toISOString(),
  })
});
```

The `description` property can be used to provide rich content about the game in html.
