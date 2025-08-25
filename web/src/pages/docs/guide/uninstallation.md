---
layout: ../../../layouts/BlogLayout.astro
title: Uninstallation
description: How to uninstall OpenGameInstaller
part: 5
section: User's Guide
---

## Windows

To uninstall OpenGameInstaller, you can run the uninstallation script attached to the application when you downloaded it through the -Setup.exe file. If you are running portably, all files are stored in the same directory as that portable executable, so you can just delete the directory.

## Linux

To uninstall OpenGameInstaller, go to `~/.local/share/OpenGameInstaller` and delete the directory. Then, next to where your `OpenGameInstaller-Setup.AppImage` is, delete the `update` directory.

## Uninstalling Bun (Where most of your storage is taken)

Many addons rely on Bun, and Bun uses "caching" to store important dependencies (such as entire web browsers) to speed up the update and installation process. Delete the `.bun` directory in your home directory (/home/[username]/.bun), or if on Windows, delete the `%USERPROFILE%\.bun` directory to remove Bun and all its dependencies.
