# OpenGameInstaller - Codebase Summary

## 1. Overview

**OpenGameInstaller** is a game installation and management platform built with developers in mind. It provides a desktop application (built with Electron) that allows users to discover, download, and manage games through a plugin-based addon system. The platform emphasizes extensibility, allowing third-party developers to create addons that expand functionality.

### Key Features
- **Addon System**: Extensible plugin architecture for game sources and management
- **Multi-Platform Support**: Windows, Linux (including Steam Deck), and macOS
- **Download Management**: Supports torrents, direct downloads, and premium debrid services (Real-Debrid, Premiumize, Torbox, AllDebrid)
- **Game Library Management**: Track and launch installed games
- **Auto-Updater**: Built-in updater application to keep the main app current
- **WebSocket Communication**: Real-time communication between addons and the main application

**Important Note**: Using third-party addons is the user's responsibility. OpenGameInstaller is not responsible for content downloaded through addons.

## 2. Architecture

### High-Level Structure

This is an **npm workspace monorepo** containing multiple packages and applications:

```plaintext
OpenGameInstaller/
├── application/          # Main Electron GUI application
├── packages/
│   ├── ogi-addon/        # Addon SDK/library for developers
│   ├── real-debrid/      # Real-Debrid API client library
│   ├── all-debrid/       # AllDebrid API client library
│   └── create-ogi-addon/ # CLI tool to scaffold new addons
├── web/                  # Documentation website (Astro)
├── updater/              # Auto-updater Electron app
└── test-addon/           # Example/test addon implementation
```

### Design Patterns

1. **IPC Communication**: Electron's IPC (Inter-Process Communication) for main ↔ renderer communication
2. **WebSocket Server**: Express + WebSocket server for addon ↔ application communication
3. **Handler Pattern**: Modular handlers for different functionalities (addons, filesystem, torrents, etc.)
4. **Service Pattern**: Download services extend a `BaseService` abstract class
5. **Manager Pattern**: Managers handle lifecycle and state (addon manager, download manager, game manager)
6. **Store Pattern**: Svelte stores for reactive state management

### Communication Flow

```plaintext
┌─────────────────┐
│  Electron Main  │
│   (Node.js)     │
└────────┬────────┘
         │ IPC
         │
┌────────▼────────┐         ┌──────────────┐
│  Svelte Frontend│◄────────┤  Addon Server │
│   (Renderer)    │ WebSocket│  (Port 7654) │
└─────────────────┘         └───────┬──────┘
                                    │
                            ┌───────▼──────┐
                            │   Addons     │
                            │  (External)  │
                            └──────────────┘
```

## 3. Core Components

### 3.1 Application (`application/`)

The main Electron desktop application.

**Key Directories:**
- `src/electron/` - Main process code
  - `main.ts` - Application entry point, window creation, lifecycle
  - `handlers/` - IPC handlers for different features:
    - `handler.addon.ts` - Addon management
    - `handler.app.ts` - Application-level operations
    - `handler.ddl.ts` - Direct download handling
    - `handler.fs.ts` - Filesystem operations
    - `handler.realdebrid.ts` - Real-Debrid integration
    - `handler.alldebrid.ts` - AllDebrid integration
    - `handler.torrent.ts` - Torrent management
    - `handler.rest.ts` - REST API handlers
    - `handler.oobe.ts` - Out-of-box experience
  - `manager/` - State and lifecycle managers:
    - `manager.addon.ts` - Addon process management
    - `manager.config.ts` - Configuration management
    - `manager.paths.ts` - Path resolution utilities
    - `manager.queue.ts` - Download queue management
    - `manager.webtorrent.ts` - WebTorrent client management
  - `server/` - Addon server implementation:
    - `addon-server.ts` - Express + WebSocket server setup
    - `AddonConnection.ts` - WebSocket connection handler
    - `api/addons.ts` - Addon API procedures
    - `api/defer.ts` - Deferred task procedures
  - `startup.ts` - Startup tasks and initialization
  - `startup-runner.ts` - Startup task orchestration
  - `updater.ts` - Application update logic
  - `preload.mts` - Preload script for secure IPC

- `src/frontend/` - Renderer process (Svelte UI)
  - `main.ts` - Frontend entry point
  - `App.svelte` - Root component
  - `views/` - Main application views:
    - `LibraryView.svelte` - Installed games library
    - `StorePage.svelte` - Addon storefront view
    - `DiscoverView.svelte` - Game discovery
    - `DownloadView.svelte` - Download management
    - `ConfigView.svelte` - Settings/configuration
    - `OutOfBoxExperience.svelte` - First-run setup
  - `components/` - Reusable UI components
  - `managers/` - Frontend state managers:
    - `DownloadManager.svelte` - Download state management
    - `GameManager.svelte` - Game library management
    - `NotificationManager.svelte` - Notification system
    - `AppUpdateManager.svelte` - Update notifications
  - `lib/` - Frontend libraries:
    - `downloads/` - Download service implementations
    - `setup/` - Game installation/setup logic
    - `tasks/` - Task management (deferred tasks, runners)
    - `core/` - Core utilities (IPC, filesystem, library)
  - `store.ts` - Svelte stores for global state
  - `states.svelte.ts` - Reactive state definitions

**Entry Points:**
- Main Process: `src/electron/main.ts`
- Renderer Process: `src/frontend/main.ts`
- Addon Server: `src/electron/server/addon-server.ts` (runs on port 7654)

### 3.2 OGI Addon Package (`packages/ogi-addon/`)

The SDK/library for developing OpenGameInstaller addons.

**Key Files:**
- `src/main.ts` - Main addon client class, WebSocket communication, event handling
- `src/SearchEngine.ts` - Search functionality with Fuse.js integration
- `src/config/Configuration.ts` - Configuration management
- `src/config/ConfigurationBuilder.ts` - Configuration builder pattern
- `src/EventResponse.ts` - Event response types

**Exports:**
- Main module: `ogi-addon` - Core addon functionality
- Config module: `ogi-addon/config` - Configuration types and builders

**Addon Events:**
- `connect`, `disconnect` - Connection lifecycle
- `authenticate` - Addon authentication
- `configure` - Configuration management
- `search` - Game search
- `setup` - Game installation
- `library-search` - Library queries
- `game-details` - Game information
- `request-dl` - Download requests
- `catalog` - Catalog browsing

### 3.3 Real-Debrid Package (`packages/real-debrid/`)

A TypeScript client library for the Real-Debrid API.

**Features:**
- Add torrents
- Add magnet links
- Unrestrict links
- Select torrents to download

**Usage:** Published as `real-debrid-js` on npm (used internally as workspace dependency).

### 3.4 AllDebrid Package (`packages/all-debrid/`)

A TypeScript client library for the AllDebrid API.

**Features:**
- Add torrents
- Add magnet links
- Unrestrict links
- Manage downloads

**Usage:** Published as `all-debrid-js` on npm (used internally as workspace dependency).

### 3.5 Create OGI Addon (`packages/create-ogi-addon/`)

CLI tool to scaffold new addon projects.

**Usage:**
```bash
npx create-ogi-addon
```

Creates addon templates in TypeScript or JavaScript.

### 3.6 Web (`web/`)

Documentation website built with Astro.

**Purpose:**
- Hosts project documentation
- Addon development guides
- Community addons list

**Tech:** Astro + Tailwind CSS + Markdown

### 3.7 Updater (`updater/`)

Separate Electron application that handles auto-updates.

**Purpose:**
- Downloads and installs application updates
- Provides installation wizard
- Bundled as `OpenGameInstaller-Setup.exe` (Windows) or `.AppImage` (Linux)

### 3.8 Test Addon (`test-addon/`)

Example addon implementation for testing and reference.

**Structure:**
- `addon.json` - Addon manifest
- `main.ts` - Addon entry point
- Standard addon project structure

## 4. Tech Stack

### Core Technologies
- **Runtime**: Node.js (via Electron)
- **Language**: TypeScript (throughout)
- **Package Manager**: Bun (primary), npm (publishing)
- **Desktop Framework**: Electron ^40.1.0
- **Frontend Framework**: Svelte 5 (with Svelte 5 runes)
- **Build Tool**: Vite (via electron-vite)
- **Styling**: Tailwind CSS 4.x

### Key Dependencies

**Application:**
- `electron` - Desktop app framework
- `svelte` - UI framework
- `express` - HTTP server for addon API
- `ws` - WebSocket server
- `webtorrent` - Torrent client
- `steamworks.js` - Steam integration
- `zod` - Schema validation
- `axios` - HTTP client
- `fuse.js` - Fuzzy search

**Addon SDK:**
- `ws` - WebSocket client
- `zod` - Configuration validation
- `fuse.js` - Search functionality

**Real-Debrid:**
- `axios` - HTTP client
- `zod` - Response validation

**Web:**
- `astro` - Static site generator
- `tailwindcss` - CSS framework

### Development Tools
- `electron-vite` - Electron + Vite integration
- `electron-builder` - Application packaging
- `tsdown` - TypeScript bundler (for packages)
- `prettier` - Code formatting
- `svelte-check` - Svelte type checking

## 5. Entry Points

### Main Application Entry Point
**File:** `application/src/electron/main.ts`

**Responsibilities:**
- Initialize Electron app
- Create main BrowserWindow
- Set up IPC handlers
- Start addon server (port 7654)
- Handle application lifecycle
- Register global shortcuts
- Manage addon processes

**Key Flow:**
1. App ready → Run startup tasks
2. Create window → Load renderer
3. Window ready → Register handlers
4. Start addon server → Begin addon connections

### Frontend Entry Point
**File:** `application/src/frontend/main.ts`

**Responsibilities:**
- Mount Svelte root component (`App.svelte`)
- Initialize frontend application

### Addon Server Entry Point
**File:** `application/src/electron/server/addon-server.ts`

**Responsibilities:**
- Create Express HTTP server
- Set up WebSocket server
- Handle addon connections
- Register API procedures
- CORS configuration

**Port:** 7654 (default)

### Addon Development Entry Point
**File:** Addon's `main.ts` (or entry specified in `addon.json`)

**Responsibilities:**
- Connect to addon server via WebSocket
- Authenticate with addon secret
- Register event handlers
- Respond to application requests

## 6. Development

### Prerequisites
- **Bun** 1.3.8+ (package manager)
- **Node.js** (for Electron)
- **Git** (for addon repositories)

### Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Nat3z/OpenGameInstaller.git
   cd OpenGameInstaller
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Build addon packages:**
   ```bash
   bun run build:ogiaddon
   # Or from application directory:
   cd application && bun run build:ogiaddon
   ```

### Running in Development

**Start the application:**
```bash
bun run dev
# Or:
cd application && bun run electron-dev
```

This will:
- Build the addon packages
- Start the Electron app in development mode
- Enable hot-reload for frontend
- Open DevTools (if `OGI_DEBUG=true`)

**Environment Variables:**
- `OGI_DEBUG=true` - Enable DevTools in production builds

### Building

**Build application:**
```bash
cd application
bun run build
```

**Build for release:**
```bash
cd application
bun run preelectron-pack  # Builds addon packages
bun run electron-pack     # Packages Electron app
```

**Build packages:**
```bash
# From root:
bun run release

# Individual packages:
cd packages/ogi-addon && bun run build
cd packages/real-debrid && bun run build
```

### Testing

**Type checking:**
```bash
cd application
bun run check  # Svelte type checking
```

**Test addon:**
- Use `test-addon/` as reference
- Add local addon path in Settings > General: `local:/path/to/addon`

### Project Structure Conventions

**Addon Structure:**
```plaintext
addon-name/
├── addon.json          # Addon manifest (required)
├── main.ts             # Entry point (or specified in addon.json)
├── package.json        # Dependencies
└── ...                 # Other files
```

**Addon.json Schema:**
```typescript
{
  author: string;
  scripts: {
    setup?: string;      // Installation script
    run: string;        // Required: Entry script
    preSetup?: string;  // Pre-installation hook
    postSetup?: string; // Post-installation hook
  };
  icon?: string;        // Icon path
}
```

### CI/CD

**GitHub Actions Workflows:**
- `.github/workflows/build-release.yml` - Builds and releases on tags
- `.github/workflows/typecheck.yml` - Type checking
- `.github/workflows/npm-publish.yml` - Publishes packages to npm

**Release Process:**
1. Create version tag: `v2.x.x`
2. GitHub Actions builds for Windows and Linux
3. Creates GitHub release with artifacts
4. Publishes packages to npm (if changed)

### Development Tips

1. **Local Addon Development:**
   - Use `local:` prefix in Settings > General
   - Example: `local:C:\Users\You\Documents\MyAddon`
   - Disables signature requirement for local addons

2. **Debugging:**
   - Set `OGI_DEBUG=true` to enable DevTools
   - Check console logs in main process (terminal)
   - Check renderer logs (DevTools console)

3. **Addon Server:**
   - Runs on `http://localhost:7654`
   - WebSocket endpoint for addon connections
   - REST API for addon procedures

4. **Security:**
   - Addons must authenticate with secret
   - Can disable signature check in Developer settings (unsafe)
   - Only enable for debugging

## 7. Key Concepts

### Addon Lifecycle
1. **Discovery**: Addon URLs configured in Settings
2. **Setup**: `preSetup` → `setup` → `postSetup` scripts run
3. **Launch**: `run` script starts addon process
4. **Connection**: Addon connects via WebSocket
5. **Authentication**: Addon provides secret and metadata
6. **Operation**: Addon responds to events (search, setup, etc.)

### Download Services
Abstract `BaseService` class with implementations:
- `DirectService` - Direct HTTP downloads
- `TorrentService` - WebTorrent-based downloads
- `RealDebridService` - Real-Debrid premium downloads
- `AllDebridService` - AllDebrid premium downloads
- `PremiumizeService` - Premiumize.me integration
- `TorboxService` - Torbox integration

### Configuration System
- Addons define configuration schemas using `ConfigurationBuilder`
- Users configure addons through UI modals
- Configuration persisted and sent to addons on connect

### State Management
- **Svelte Stores**: Global reactive state (`store.ts`)
- **Svelte 5 Runes**: Component-level reactive state
- **IPC**: Main ↔ Renderer communication
- **WebSocket**: Application ↔ Addon communication

## 8. File Structure Summary

```plaintext
OpenGameInstaller/
├── .github/workflows/     # CI/CD workflows
├── application/           # Main Electron app
│   ├── src/
│   │   ├── electron/      # Main process
│   │   └── frontend/       # Renderer process (Svelte)
│   └── package.json
├── packages/
│   ├── ogi-addon/         # Addon SDK
│   ├── real-debrid/       # Real-Debrid client
│   ├── all-debrid/        # AllDebrid client
│   └── create-ogi-addon/  # Addon scaffolder
├── web/                   # Documentation site
├── updater/               # Auto-updater app
├── test-addon/            # Example addon
├── package.json           # Workspace root
└── bun.lockb              # Bun lockfile
```

## 9. Additional Resources

- **Website**: https://ogi.nat3z.com
- **Documentation**: https://ogi.nat3z.com/docs/
- **Community Addons**: https://ogi.nat3z.com/community/
- **GitHub**: https://github.com/Nat3z/OpenGameInstaller
- **First Addon Guide**: https://ogi.nat3z.com/docs/first-addon

---

**Last Updated**: February 2026
**Version**: 2.7.4 (application), 2.2.0 (ogi-addon)
