---
layout: ../../../layouts/BlogLayout.astro
title: Your First Addon
description: A guide on how to make your first addon for OpenGameInstaller.
part: 0
priority: 1
section: Your First Addon
---

# CLI Tool

The quickest way to create an addon is to use `create-ogi-addon`!

```shell
$ bun create ogi-addon
```

This will setup a simple project skeleton which gets you ready for developing OGI addons!

# Manual

Making an OpenGameInstaller addon is simple, as our Type-Safe library lets you connect to the client gracefully without any restraints.

Firstly, install the OpenGameInstaller client by going to our [download](/) link.

Then, in a new npm project, run:

```shell
$ bun add ogi-addon@latest
```

## Create a .gitignore file

It is additionally recommended that you create a .gitignore file to protect your development environment from leaking important info. Here is a basic template you can use:

```md
# dependencies

node_modules/

# required because crashes make a \*-crash.log file and client uses an installation.log file to verify addon installs.

\*.log
```

Follow the next guide to learn how to create an `addon.json` file, which is essential for OpenGameInstaller to get metadata about your addon.
