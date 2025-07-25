---
layout: ../../../layouts/BlogLayout.astro
title: Basic Addon Setup
description: A guide on how to make your first addon for OpenGameInstaller.
part: 2
section: Your First Addon
---

In the file where you defined how the addon starts (your `scripts.run` property), initialize the OGIAddon class.

```typescript
const addon = new OGIAddon({
  name: 'Your Addon Name',
  id: 'addon-id',
  description: 'Your Addon Description',
  version: '1.0.0',
  author: 'Your Name',
  repository: 'Your git repo url',
  storefronts: [ ... ], // an array of storefronts your addon supports
});
```

The `id` of your addon should **always** be unique, following this basic pattern: `your-addon-name` with hyphens in between each word of your addon.

We recommend your addon's name to be short, around only **two words**.

## How to add your addon to OpenGameInstaller

Adding your addon to our client is simple. Go to `Settings > General` and in the **_Addons_** field, input this:

```md
local:[THE PATH TO YOUR ADDON'S WORKING DIRECTORY]
```

Then, press `Install All` and `Restart Addon Server` to initialize your addon!
