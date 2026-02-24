---
layout: ../../../layouts/BlogLayout.astro
title: Welcome to OpenGameInstaller!
description: A guide on how to make your first addon for OpenGameInstaller.
part: 0
priority: 1
section: User's Guide
---

In this section, you will learn how to use OpenGameInstaller, how the
addons system works, and what you can do to troubleshoot common issues.

This guide is recommended for all users of OpenGameInstaller, as knowing
the underlying architecture of this software benefits you in understanding
errors and troubleshoot them effectively. **Linux users**: we use [UMU](/docs/guide/umu) to run Windows games from the library—no Steam required for new installations.

## What is OpenGameInstaller?

OpenGameInstaller (OGI for short) is a platform for downloading, installing, and managing
video games. We provide a user interface for you (the user) to browse, install, and
manage your games. Developers then use the tools we give them through our platform to create
storefronts, game downloads, and setup scripts for those games, creating an all-in-one
extensible gaming platform.

### What are we NOT?

We are NOT a video game distribution platform. We don't host any content on our servers nor
do we provide tools to help with breaking copyright laws. We at OpenGameInstaller are not
responsible for content downloaded on our platform and we do not take any logs of games downloaded
or addons downloaded on our platform.

## Important Directories/Files to Know

| Directory/File Linux                                                 | Directory/File Windows                                | Description                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ~/.local/share/OpenGameInstaller/                                    | %localappdata%\Programs\ogi-updater\update            | The main directory for stored content, including addons, configs, game data, etc.                           |
| ~/.local/share/OpenGameInstaller/addons/                             | %localappdata%\Programs\ogi-updater\update\addons     | The directory where addons are stored.                                                                      |
| Next to where you have the -Setup.AppImage file `/update`            | %localappdata%\Programs\ogi-updater\update            | The directory where the updater stores log files, the program itself, and misc. files for version tracking. |
| Next to where you have the -Setup.AppImage file `/update/latest.log` | %localappdata%\Programs\ogi-updater\update\latest.log | The latest log file for OGI. We usually ask for this file when requesting support.                          |
