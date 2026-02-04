# Real-Debrid-JS

A simple Real-Debrid interface for NodeJS.

## Development

The package uses `skipLibCheck: true` in `tsconfig.json` to avoid upstream type conflicts. For a stricter check (including dependency types), run `tsc --noEmit` with a temporary config that sets `skipLibCheck: false`, or run this periodically (e.g. before releases).

## Features

- Add Torrent
- Add Magnet Link
- Unrestrict Links
- Select Torrents to Download

# Installation

```bash
$ npm install real-debrid-js
```
