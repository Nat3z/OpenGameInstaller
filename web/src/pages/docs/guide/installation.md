---
layout: ../../../layouts/BlogLayout.astro
title: Installation
description: How to install OpenGameInstaller and setup its tooling.
part: 1
---

Download OpenGameInstaller at [ogi.nat3z.com](https://ogi.nat3z.com/). This file
includes an automatic update tool and logger which helps with debugging issues and
updating the software itself.

If you don't want any of these features, or prefer OGI's
executable being somewhere else, download the latest release on [GitHub](https://github.com/Nat3z/OpenGameInstaller/releases/latest)
with the file ending in -pt.AppImage or -Portable.AppImage.

> [!WARNING]
> If you decide to use just the Portable version of OpenGameInstaller without the Setup.AppImage/.exe, we
> sadly will not be able to provide support, as logs are created by -Setup.AppImage/.exe.

## Out of Box Experience (OOBE)

The Out of Box Experience after installing through the -Setup file is a structured step-by-step setup guide
to get tools downloaded, torrent clients ready, and install folders created. If you encounter any issues with
the OOBE, follow these troubleshooting steps.

### Installing Bun

If you are having an issue installing Bun on your device, make sure the program has proper permissions
to access your home folder and you have a stable internet connection. Downloading Bun manually
also is a solution to this problem.

To download Bun manually, open a powershell window (if on Windows) or a terminal (Konsole if on Steam Deck) and run the command found
found at the top on [bun.sh](https://bun.sh).

If there are any issues with installing Bun through this script, please don't go to us for support. Resort to GitHub discussions
or issues on the [Bun GitHub repository](https://github.com/oven-sh/bun) instead.

