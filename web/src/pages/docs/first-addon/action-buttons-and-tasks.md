---
layout: ../../../layouts/BlogLayout.astro
title: Action Buttons & Tasks
description: Add configurable action buttons and run addon tasks.
part: 8
section: Your First Addon
---

Action buttons let users trigger addon-specific jobs from configuration screens, without downloading anything.

## Add an action button in `configure`

Use `addActionOption(...)` with a task name and optional manifest payload:

```typescript
addon.on('configure', (config) =>
  config
    .addActionOption((option) =>
      option
        .setName('clearCache')
        .setDisplayName('Clear Cache')
        .setDescription('Clear temporary addon cache files')
        .setButtonText('Run Cleanup')
        .setTaskName('maintenance:clear-cache')
        .setManifest({
          scope: 'all',
          includeIndexes: true,
        })
    )
);
```

## Handle the action with `onTask`

Register a handler matching the same task name:

```typescript
addon.onTask('maintenance:clear-cache', async (task, data) => {
  task.log('Starting cleanup...');
  task.setProgress(20);

  const { manifest, downloadPath, name, libraryInfo } = data;
  task.log(`scope=${String(manifest.scope)}`);
  task.log(`name=${name}`);
  task.log(`downloadPath=${downloadPath}`);
  task.log(`libraryInfo=${libraryInfo?.name ?? 'none'}`);

  // your cleanup logic...

  task.setProgress(100);
  task.complete();
});
```

## Run tasks from `search` results

`search` can return `downloadType: 'task'` entries:

```typescript
addon.on('search', ({ appID }, event) => {
  event.resolve([
    {
      name: `Verify install for ${appID}`,
      downloadType: 'task',
      taskName: 'verify-install',
      manifest: {
        deepCheck: true,
      },
    },
  ]);
});
```

Then register the matching task:

```typescript
addon.onTask('verify-install', async (task, { manifest, libraryInfo }) => {
  task.log(`deepCheck=${String(manifest.deepCheck)}`);
  task.log(`library=${libraryInfo?.name ?? 'unknown'}`);
  task.complete();
});
```

## Ask users for input inside tasks

Inside `onTask` handlers, use `task.askForInput(...)`:

```typescript
import { ConfigurationBuilder } from 'ogi-addon';

addon.onTask('verify-install', async (task) => {
  const input = await task.askForInput(
    'Verification Options',
    'Choose how to run verification',
    new ConfigurationBuilder().addBooleanOption((option) =>
      option
        .setName('deepCheck')
        .setDisplayName('Deep Check')
        .setDescription('Run additional checks')
        .setDefaultValue(true)
    )
  );

  task.log(`deepCheck=${input.deepCheck}`);
  task.complete();
});
```

## Important notes

- Always pair `.setTaskName('...')` with `addon.onTask('...', ...)`.
- Keep custom runtime payload in `.setManifest(...)`.
- Do not manually inject internal task routing fields into the manifest.
