---
layout: ../../../layouts/BlogLayout.astro
title: Creating a Source Searcher
description: A guide on how to make your first addon for OpenGameInstaller.
part: 4
section: Your First Addon
---

Source searchers are called by OpenGameInstaller when a user wants the download link for a game. To create a source searcher, add an event handler to the `search` event.

```typescript
addon.on('search', ({ text, type }, event) => {
  event.defer(); // IMPORTANT!!!!!
});
```

## Why do we need `event.defer`?

We need `event.defer` so we can tell the addon server that what we're doing will **take time.** You can use this in any function that contains an event resolver.

## How do I use source searcher?

The `search` event provides two properties, `appID` and `storefront`.

`appID` is the id of the app which OpenGameInstaller wants the download link to.

`storefront` defines where the appID points to in accordance to a storefront. (_You will learn this in the Internal Stores lesson_)

Your function should complete the query, then resolve the **SearchResult** with `event.resolve`

**Example:**

```typescript
addon.on('search', ({ text, type }, event) => {
  event.defer(); // IMPORTANT!!!!!
  // your code here...
  event.resolve([
    {
      name: 'Direct Download Test',
      downloadType: 'magnet', // could be either direct, torrent, or magnet.
      filename: 'Big Buck Bunny.mp4',
      downloadURL:
        'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent',
    },
  ]);
});
```

## How do I do multi-part direct downloads?

For direct downloads with multiple parts, you can omit the `filename` and `downloadURL` properties and instead use `files`. The order in which the files are downloaded are determined by the order of the `files` array.

```typescript
addon.on('search', ({ text, type }, event) => {
  event.defer(); // IMPORTANT!!!!!
  // your code here...
  event.resolve([
    {
      name: 'Direct Download Test',
      description: 'No description',
      coverURL: 'https://dummyimage.com/375x500/968d96/ffffff', // an image to show in the downloads section
      appID: parseInt(text),
      storefront: type, // where the appID points to (could be an addon name or steam)
      downloadSize: 100,
      downloadType: 'direct', // could be either direct, torrent, or magnet.
      files: [
        {
          name: 'test',
          downloadURL: '<download_url_here>',
        },
        {
          name: 'test2',
          downloadURL: '<download_url_here>',
        },
      ],
    },
  ]);
});
```

# Important about async functions

If you want your event handler to be async, you must use `new Promise` to make it async.

**Example:**

```typescript
addon.on('search', ({ text, type }, event) => {
  event.defer(); // IMPORTANT!!!!! This MUST be before your Promise.
  new Promise<void>(async (resolve, reject) => {
    // your async code here...
    event.resolve(/* your resolution here */);
    resolve();
  });
});
```
