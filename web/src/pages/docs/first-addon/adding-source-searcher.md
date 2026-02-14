---
layout: ../../../layouts/BlogLayout.astro
title: Creating a Source Searcher
description: A guide on how to make your first addon for OpenGameInstaller.
part: 4
section: Your First Addon
---

Source searchers are called by OpenGameInstaller when a user wants the download link for a game. To create a source searcher, add an event handler to the `search` event.

```typescript
addon.on('search', ({ appID, storefront, for: searchFor }, event) => {
  event.defer(); // IMPORTANT!!!!!
});
```

## Why do we need `event.defer`?

We need `event.defer` so we can tell the addon server that what we're doing will **take time.** You can use this in any function that contains an event resolver.

## How do I use source searcher?

The `search` event provides two properties, `appID` and `storefront`.

`appID` is the id of the app which OpenGameInstaller wants the download link to.

`storefront` defines where the appID points to in accordance to a storefront. (_You will learn this in the Store Pages lesson_)

Your function should complete the query, then resolve the **SearchResult** with `event.resolve`

Keep in mind that the storefront must be one of the storefronts defined in your addon's config (`storefronts` in your Configuration), or else the server will not know that your addon supports that storefront.

**Example:**

```typescript
addon.on('search', ({ appID, storefront, for: searchFor }, event) => {
  event.defer(); // IMPORTANT!!!!!
  // your code here...
  event.resolve([
    {
      name: 'Direct Download Test',
      downloadType: 'magnet',
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
addon.on('search', ({ appID, storefront, for: searchFor }, event) => {
  event.defer(); // IMPORTANT!!!!!
  // your code here...
  event.resolve([
    {
      name: 'Direct Download Test (Multi-Part)',
      downloadType: 'direct',
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

## Control parallel chunking with `OGI-Parallel-Limit`

For `downloadType: 'direct'` files, you can add headers per file using `files[].headers`.

Use the `OGI-Parallel-Limit` header to control OGI's chunk-parallel behavior for that link.

```typescript
addon.on('search', ({ appID, storefront, for: searchFor }, event) => {
  event.defer();

  event.resolve([
    {
      name: 'Rate Limited Direct Download',
      downloadType: 'direct',
      files: [
        {
          name: 'archive.part1.rar',
          downloadURL: 'https://example.com/archive.part1.rar',
          headers: {
            // Exact key recommended (case-sensitive in addon-side object checks)
            'OGI-Parallel-Limit': '1',
          },
        },
      ],
    },
  ]);
});
```

### Behavior notes

- `'OGI-Parallel-Limit': '1'` disables chunk parallelization for that link.
- OGI also reads `OGI-Parallel-Limit` from the file host's HTTP response headers.
- For response limits greater than `1`, OGI applies the lowest value between:
  - the app's global parallel chunk setting
  - the response `OGI-Parallel-Limit` for the link
- This is useful for hosts that rate limit range/chunk requests or frequently return `429`.

## What does `for` mean?

`search.for` tells you what context triggered the search:

- `'game'`: normal game download flow.
- `'update'`: game update flow (includes `libraryInfo` on the event input).
- `'task'` or `'all'`: task-related or broad query contexts.

# Important about async functions

You can make event handlers `async` directly. You do not need to wrap them in `new Promise`.

**Example:**

```typescript
addon.on('search', async ({ appID, storefront, for: searchFor }, event) => {
  event.defer();

  // your async code here...
  const links = await getLinksForApp(appID, storefront);

  event.resolve(
    links.map((link) => ({
      name: link.name,
      downloadType: 'direct',
      files: [{ name: link.fileName, downloadURL: link.url }],
    }))
  );
});
```

Use `event.defer()` whenever your resolver may take more than a moment (network calls, scraping, heavy parsing, etc).

## Related: Action tasks from search

If you want `search` to return `downloadType: 'task'`, see [Action Buttons & Tasks](/docs/first-addon/action-buttons-and-tasks).

For the dedicated update search flow (`for: 'update'`), see [Adding Game Update Support](/docs/first-addon/adding-game-updates).
