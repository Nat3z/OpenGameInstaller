---
layout: ../../../layouts/BlogLayout.astro
title: Configuration Setup
description: A guide on how to make your first addon for OpenGameInstaller.
part: 3
section: Your First Addon
---

Adding a config to your addon lets your users to adjust and configure it via the built-in configuration manager.

To add a config, add an event handler for the `configure` event.

```typescript
addon.on('configure', (config) => 
  config
)
```

To add options to your config, use the `config` builder. For example:

```typescript
addon.on('configure', (config) => 
  .addStringOption(option => option
    .setName('testOption')
    .setDisplayName('Test Option')
    .setDescription('A test option')
    .setDefaultValue('Test Value')
  )
)
```

There are multiple properties which you can define on each option, but the **3 required** options are:
```typescript
option.setName(string)
option.setDisplayName(string)
option.setDescription(string)
```

`.setName(string)` sets the key for your option in the generated JSON file. This is also used when referencing config values when getting them.

`.setDisplayName(string)` sets the display name for your option which the user sees. This should be human-readable and **concise**.

`.setDescription(string)` sets the description for your option when the user hovers over it for information. This should be human-readable and short.
