---
layout: ../../../layouts/BlogLayout.astro
title: Creating a Store Page
description: A guide on how to create a store page for your addon.
part: 5
section: Your First Addon
---

Store pages are listings which contain information about a game. OpenGameInstaller uses the information provided by the `game-details` event to create the store page.

# Storefronts

Storefronts are used to identify the source of a game. For example, if you want to create a store page for a game, you need to assign that game to a specific "storefront" like `steam`, `epic`, `origin`, etc. Keep in mind that the storefront can be any name you want, as OpenGameInstaller does not have any built-in storefronts or concept of a real/fake storefront where you can buy from.

When creating a store front, you must add it to the `storefronts` property in your addon's `OGIAddon` class.

```typescript
const addon = new OGIAddon({
  ...
  "storefronts": ["test-front"]
  ...
});
```

This will allow the addon server to know that the `test-front` storefront is available for your addon.

# Adding a Search Query Function

You must create a search function which provides results for games when requested by the client. You can do this by creating an event handler for the `library-search` event.

```typescript
addon.on('library-search', (text, event) => {
  event.defer();
  event.resolve([
    {
      appID: 1, // the appID used when sent to your addon for information about the listing.
      capsuleImage: 'https://dummyimage.com/375x500/968d96/ffffff',
      storefront: 'test-front',
      name: 'Test App',
    },
  ]);
});
```

To handle searches, we recommend using the built-in search tool to query!

```typescript

const tool = new SearchTool<T>([], [ ... ], { threshold: 0.3, includeScore: true });
// ^ T is the type of the items you want to search through
// ^ The first array is the items you want to search through
// ^ The second array are the keys you want to use as a search index
// ^ The third object is the options for the search tool (powered by fuse.js)

tool.addItems([ ... ]);
const results = tool.search(text);
// ^ text is the text you want to search for
// ^ results is an array of the results
```

# Adding a Store Page

To provide the store page for the appID provided, create an event handler for the `game-details` event. This event provides the appID, which you can use to get the application information.

```typescript
addon.on('game-details', ({ appID, storefront }, event) => {
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
