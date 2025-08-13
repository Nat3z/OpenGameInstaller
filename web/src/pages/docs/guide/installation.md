---
layout: ../../../layouts/BlogLayout.astro
title: Installation
description: How to install OpenGameInstaller and setup its tooling.
part: 1
section: User's Guide
---

Download OpenGameInstaller at [ogi.nat3z.com](https://ogi.nat3z.com/). This file
includes an automatic update tool and logger which helps with debugging issues and
updating the software itself.

If you don't want any of these features, or prefer OGI's
executable being somewhere else, download the latest release on [GitHub](https://github.com/Nat3z/OpenGameInstaller/releases/latest)
with the file ending in -pt.AppImage or -Portable.AppImage.

> If you decide to use just the Portable version of OpenGameInstaller without the Setup.AppImage/.exe, we
> sadly will not be able to provide support, as logs are created by -Setup.AppImage/.exe.

# Out of Box Experience (OOBE)

The Out of Box Experience after installing through the -Setup file is a structured step-by-step setup guide
to get tools downloaded, torrent clients ready, and install folders created. If you encounter any issues with
the OOBE, follow these troubleshooting steps.

## Downloading tools

Tools are required by OpenGameInstaller to run and activate setup scripts properly.

Before downloading any of these programs, make sure you have a **root password** created. If you don't think
you have one or are confused, open your terminal (Konsole on Steam Deck), and run the following command to create one.

```sh
passwd
```

> [!INFO]
> OGI automatically downloads all of these tools necessary on first launch. If you are having issues with downloading the tools through the
> app, we recommend to follow the manual guides below.

### Installing Git

If your device does not have Git pre-installed (ex. Windows) and OGI failed to automatically download
it, you must download it through [git-scm.com](https://git-scm.com/). Afterwards, a restsrt of your computer
is required.

### Installing Bun

If you are having an issue installing Bun on your device, make sure the program has proper permissions
to access your home folder and you have a stable internet connection. Downloading Bun manually
also is a solution to this problem.

To download Bun manually, open a powershell window (if on Windows) or a terminal (Konsole if on Steam Deck) and run the command found
found at the top on [bun.sh](https://bun.sh).

If there are any issues with installing Bun through this script, please don't go to us for support. Resort to GitHub discussions
or issues on the [Bun GitHub repository](https://github.com/oven-sh/bun) instead.

### Installing Wine (LINUX ONLY)

Wine must be installed through the Flatpak package to work. If issues arise from downloading the Flatpak through OGI, run

```sh
flatpak install --system flathub org.winehq.Wine
```

### Installing SteamTinkerLaunch (LINUX ONLY)

To install steamtinkerlaunch, go to the folder `~/.local/share/OpenGameInstaller/bin/` (create the folder if it does not exist).
Then, in the `bin` folder, run

```sh
git clone https://github.com/sonic2kk/steamtinkerlaunch
cd steamtinkerlaunch
chmod +x ./steamtinkerlaunch
./steamtinkerlaunch
```

If you get notifications, steamtinkerlaunch installed successfully.
