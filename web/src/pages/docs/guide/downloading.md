---
layout: ../../../layouts/BlogLayout.astro
title: Downloading Content
description: Downloading Content on OpenGameInstaller
part: 3
section: User's Guide
---

Downloading content on OpenGameInstaller relies on a catalog addon to provide metadata about the game you are downloading and a source search addon to provide the actual download links.

## Important Notes

OpenGameInstaller does not host any game files. We solely provide tooling to help addons integrate their source's download links or content into our client. We are not responsible for the content provided by addons, and we do not endorse any specific source or content.

## Downloading Content

Once you have a proper catalog and source search addon installed, you can search for games in the search bar or Discovery tab. On the side of the game's store page, you will see a list of sources that provide download links for the game. You can click on any of the links to start the download process.

### Note on Downloading

When you click on the "Download" button, OGI will immediately start trying to download the game to your download location. If you have concerns about torrenting, refer to the download type at the top right of the source before you download.

## Torrenting

### TorBox

To use TorBox as a torrenting client, you need to set your TorBox API key in the settings. Make sure it's selected as the client in `Settings > General`. Afterward, go to `Settings > Torrent Clients` and [set the API key to your TorBox key found on this link.](https://torbox.app/settings)

> [!INFO]
> Requires a TorBox account and active subscription. [Get a subscription with my link here](https://torbox.app/subscription?referral=e5b6cae9-f8b7-4f6a-823f-9db2b89cd37a).

### Premiumize

To use Premiumize as a torrenting client, you need to set your Premiumize API key in the settings. Make sure it's selected as the client in `Settings > General`. Afterward, go to `Settings > Torrent Clients` and [set the API key to your Premiumize key found on this link.](https://premiumize.me/account)

> [!INFO]
> Requires a Premiumize account and active subscription. [Get a subscription with my link here](https://premiumize.me/account).

### Real-Debrid

To use Real-Debrid as a torrenting client, you need to set your Real-Debrid API key in the settings. Make sure it's selected as the client in `Settings > General`. Afterward, go to `Settings > Torrent Clients` and [set the API key to your Real-Debrid key found on this link.](https://real-debrid.com/apitoken)

> [!INFO]
> Requires a Real-Debrid account and active subscription. [Get a subscription with my link here](http://real-debrid.com/?id=11485717).

### AllDebrid

To use AllDebrid as a torrenting client, you need to set your AllDebrid API key in the settings. Make sure it's selected as the client in `Settings > General`. Afterward, go to `Settings > Torrent Clients` and [set the API key to your AllDebrid key found on this link.](https://alldebrid.com/apikeys)

> [!INFO]
> Requires an AllDebrid account and active subscription.

### qBittorrent

To use qBittorrent as a torrenting client, please refer to our [qBittorrent WebUI guide](/docs/for-users/qb-setup) to learn how to set up a WebUI. After that, go to `Settings > General` and select `qBittorrent` as the torrent client, then go to `Settings > qBittorrent` and adjust the settings to match what you set in qBittorrent.

> [!INFO]
> qBittorrent must be installed and open when you have OpenGameInstaller open in order for this to work as a torrenting client.

### WebTorrent

WebTorrent is built into OGI. To use it, go to `Settings > General` and select `WebTorrent` as the torrent client.

> [!WARNING]
> This client misses some features that other clients have (such as VPN binding), so we recommend to use this client when you want a seamless experience without needing extra setup.

## Choosing a Torrent Client

When choosing a torrent client, you should consider some factors:

1. What are the DMCA laws in your country?
1. Do you want privacy when torrenting?
1. Are you willing to pay for a premium service?

Simply put, if you are in a country with strict DMCA laws or you want privacy when torrenting, we recommend
to use a premium cloud downloading service. Great options include Real-Debrid, AllDebrid, Premiumize, and TorBox.
If you aren't interested in cloud downloading but still want privacy, we recommend to pay for an external VPN
and use qBittorrent (with proper VPN binding). Otherwise, if you just want a seamless experience with OpenGameInstaller,
we recommend to use WebTorrent as it is built into the app and requires no setup.
