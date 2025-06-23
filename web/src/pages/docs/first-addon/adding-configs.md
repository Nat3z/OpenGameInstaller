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
addon.on('configure', (config) => config);
```

To add options to your config, use the `config` builder. For example:

```typescript
addon.on('configure', (config) =>
  config.addStringOption((option) =>
    option
      .setName('testOption')
      .setDisplayName('Test Option')
      .setDescription('A test option')
      .setDefaultValue('Test Value')
  )
);
```

There are multiple properties which you can define on each option, but the **3 required** options are:

```typescript
option.setName(string);
option.setDisplayName(string);
option.setDescription(string);
```

`option.setName(string)` sets the key for your option in the generated JSON file. This is also used when referencing config values when getting them.

`option.setDisplayName(string)` sets the display name for your option which the user sees. This should be human-readable and **concise**.

`option.setDescription(string)` sets the description for your option when the user hovers over it for information. This should be human-readable and short.

You can see how the config looks by restarting OpenGameInstaller.

## How do I get configuration values?

To get the values of your config, you can use the functions:

`addon.config.getStringValue`

`addon.config.getNumberValue`

`addon.config.getBooleanValue`

The `key` should be the same string you provided to `option.setName(string)` when making the option.
