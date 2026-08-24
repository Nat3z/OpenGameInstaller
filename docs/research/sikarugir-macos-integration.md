# Sikarugir macOS integration research

Research date: 2026-08-23. No application code was changed.

## Recommendation

Sikarugir can support an OpenGameInstaller (OGI) macOS backend, but it should be treated as an external, versioned runtime rather than as a library API. The useful automation surface is the launcher embedded in each generated wrapper. OGI should own a shared Windows-Steam wrapper, store the exact wrapper/template/engine versions it created, and serialize every prefix mutation.

The safe first implementation is:

1. Make Homebrew and Rosetta explicit OOBE prerequisites on Apple Silicon.
2. Install Sikarugir Creator from its official cask, then let the user create/select a Steam wrapper once, or reproduce the Creator assembly flow only after licensing review.
3. Initialize the wrapper prefix, install the official Windows Steam installer, and require one interactive Steam login before trying to add shortcuts.
4. Run per-game Winetricks verbs through that wrapper's launcher and edit the Windows Steam client's `shortcuts.vdf` only while Steam is stopped.
5. Initially make Play launch the Windows Steam wrapper. Gate direct launch of an OGI-created non-Steam shortcut behind a macOS validation spike because Steam's current non-Steam `rungameid` is not a stable precomputable identifier.

## Supported systems and installation

- The project declares macOS 14 (Sonoma) or later. Apple Silicon also requires Rosetta 2, for which upstream publishes `/usr/sbin/softwareupdate --install-rosetta --agree-to-license`. The cask independently declares `depends_on macos: :sonoma` and `requires_rosetta`. ([Sikarugir README at `39710f1`, lines 1-3 and 22-33](https://github.com/Sikarugir-App/Sikarugir/blob/39710f11e0b9a1b4a1a7110ef8c8ad6fbf1fe786/README.md#L1-L33), [cask at `640e200`, lines 10-23](https://github.com/Sikarugir-App/homebrew-sikarugir/blob/640e2001e7622ac5098d472713ab7297e50dbec9/Casks/sikarugir.rb#L10-L23))
- Upstream's current Homebrew sequence is `brew upgrade`, `brew trust Sikarugir-App/sikarugir`, then `brew install --cask Sikarugir-App/sikarugir/sikarugir`. OGI should **not** run the global `brew upgrade`: it is unrelated to installing Sikarugir and can mutate every package the user owns. A fully qualified cask install is sufficient to select the intended item. Homebrew 6 also documents that installing a fully qualified third-party item trusts only that item, which is narrower than trusting the entire tap. ([Sikarugir install instructions](https://github.com/Sikarugir-App/Sikarugir/blob/39710f11e0b9a1b4a1a7110ef8c8ad6fbf1fe786/README.md#L22-L33), [Homebrew tap-trust documentation](https://docs.brew.sh/Tap-Trust#installing-from-a-tap))
- The current cask is Creator 1.0.1. It verifies the Creator archive with SHA-256, installs `Sikarugir Creator.app`, removes the quarantine attribute, ad-hoc signs the app, creates `~/Applications/Sikarugir`, and zaps `~/Library/Application Support/Sikarugir` on removal. The cask does **not** create a game wrapper or install an engine; Creator downloads/caches those later. ([current cask](https://github.com/Sikarugir-App/homebrew-sikarugir/blob/640e2001e7622ac5098d472713ab7297e50dbec9/Casks/sikarugir.rb#L1-L28))
- Creator's current runtime convention is `~/Library/Application Support/Sikarugir/{Template,Engines}` and `~/Applications/Sikarugir` for generated apps. The published Configure source uses the same application-support cache convention. ([Configure constants at `4be1b04`, lines 77-91](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/OtherSources/Configure_Prefix.pch#L77-L91))
- At research time, the current template pointer is `Template-1.0.11`, and the engine list includes `WS12WineSikarugir10.0_6`, CrossOver-derived, Whisky, and GPTK variants. Do not infer that the first engine in this mutable list is the right Steam engine; pin and validate one. ([wrapper pointer at `9f0e08d`](https://github.com/Sikarugir-App/Wrapper/blob/9f0e08d76e36f60bcd74a4b2ca729a5349655dc5/NewestVersion.txt), [engine list at `9581b3a`](https://github.com/Sikarugir-App/Engines/blob/9581b3a7d1e473b832c0dda2ecdf6eac1791c0dc/EngineList.txt))

### Homebrew in OOBE

Homebrew's supported prefixes are `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel. An app-spawned process may not inherit the user's interactive shell setup, so OGI should probe those absolute locations first, then execute the discovered `brew` path directly rather than assuming `brew` is on `PATH`. ([Homebrew installation documentation](https://docs.brew.sh/Installation))

A truly silent first-time Homebrew install is not available on a normal Mac:

- `NONINTERACTIVE=1` suppresses all prompts.
- The official installer switches sudo to `sudo -n` in that mode and aborts when passwordless/cached sudo is unavailable.
- Homebrew maintainers explicitly recommend `SUDO_ASKPASS` if an automation host needs to provide its own authorization UI.

Therefore OGI OOBE should either open the official installer in Terminal/Installer and poll until `brew` becomes available, or implement a carefully reviewed macOS authorization/`SUDO_ASKPASS` flow. It should not run the curl-to-shell installer as a hidden background command. ([official installer source](https://github.com/Homebrew/install/blob/main/install.sh), [maintainer clarification](https://github.com/Homebrew/install/issues/714#issuecomment-1324587607))

Once Homebrew already exists, the Sikarugir step can run through a visible progress process using an absolute `brew` path:

```sh
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 \
  /opt/homebrew/bin/brew install --cask Sikarugir-App/sikarugir/sikarugir
```

Use `/usr/local/bin/brew` on Intel. Suppressing automatic update makes the OOBE bounded, but OGI should later offer an explicit update action. Do not disable Homebrew's tap-trust protections. If an explicit trust step is desired, prefer `brew trust --cask Sikarugir-App/sikarugir/sikarugir`, not whole-tap trust. Homebrew explains that third-party tap files execute Ruby with the user's privileges. ([tap-trust security model](https://docs.brew.sh/Tap-Trust#why-tap-trust-exists), [trust command reference](https://docs.brew.sh/Manpage#trust-options-target-))

On Apple Silicon, run the upstream Rosetta command in a user-visible authorization flow. Before and afterward, a capability probe such as `/usr/bin/arch -x86_64 /usr/bin/true` is more useful than merely checking for a file: success proves an Intel process can execute.

## Wrapper layout and callable interface

The current blank wrapper release was inspected directly from the official [`Template-1.0.11.tar.xz`](https://github.com/Sikarugir-App/Wrapper/releases/download/v1.0/Template-1.0.11.tar.xz). Its SHA-256 was `9fa15479e7ff6abd99c1d07be285fb95f41fc6991586502427152b1f7d6ccb8a`, matching GitHub's release-asset digest on the research date.

The assembled wrapper layout that OGI needs is:

```text
Steam.app/
  Contents/
    Info.plist
    MacOS/                         launcher executable(s)
    Configure.app/
    Frameworks/
    SharedSupport/
      wine/                        selected engine; version file inside
      prefix/
        drive_c/
        dosdevices/
        system.reg
        user.reg
      Logs/
      winetricks                   downloaded on demand
```

The prefix location is specifically `Contents/SharedSupport/prefix`, not `Contents/drive_c`. The published Configure source rebuilds and deletes prefix data there, resolves Wine drives through its `dosdevices`, and stores the engine under `Contents/SharedSupport/wine`. ([prefix rebuild paths](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L960-L1001), [path conversion and engine paths](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Utilities/NSPathUtilities.m#L21-L80), [engine version lookup](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Utilities/NSPortDataLoader.m#L22-L36))

Template 1.0.11's universal arm64/x86_64 launcher embeds this modern help surface:

```text
boot
create-prefix [--no-regs]
run [<absolute Windows-or-macOS path> [flags]]
run --start-exe <absolute path> [flags]
debug [<absolute path> [flags]]
winetricks <verb>
config
quit
```

It also retains the legacy aliases `WSS-installer`, `WSS-winecfg`, `WSS-cmd`, `WSS-control`, `WSS-explorer`, `WSS-regedit`, `WSS-taskmgr`, `WSS-uninstaller`, `WSS-wineprefixcreate`, `WSS-wineprefixcreatenoregs`, `WSS-wineboot`, `WSS-winetricks`, and `WSS-wineserverkill`. This is artifact inspection, not a documented stability guarantee: the Sikarugir Launcher is closed-source. OGI should wrap these invocations in one adapter, pin the template version, and smoke-test command availability before use. The published Configure source corroborates `WSS-installer`, `WSS-wineprefixcreate`, and multi-verb `WSS-winetricks` calls. ([installer call](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L345-L358), [prefix call](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L993-L1001), [Winetricks call](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L1565-L1583))

Do not hard-code only `Contents/MacOS/Sikarugir`: Creator and template versions have used launcher names such as `launcher`, `wineskinlauncher`, and `WineskinLauncher`. Resolve `CFBundleExecutable` and validate the resulting binary's help/capabilities when adopting an existing wrapper.

Important `Contents/Info.plist` keys include:

- `Program Name and Path` and `Program Flags`
- `CFBundleName`, `CFBundleIdentifier`, `CFBundleExecutable`, and icon/version keys
- `WINEDEBUG`, `WINEESYNC`, and `WINEMSYNC`
- `D3DMETAL`, `DXMT`, `DXVK`, `METAL_HUD`, `FASTMATH`, and `MOLTENVKCX`
- `Winetricks silent`, `Winetricks force`, and `Winetricks disable logging`
- user-folder symlink mappings and `CLI Custom Commands`

The key names are defined by the published Configure source. Renderer availability depends on OS, architecture/translation state, and engine contents, so OGI should not blindly enable a renderer just because a plist key exists. ([plist constants](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/OtherSources/Configure_Prefix.pch#L37-L71), [renderer checks](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L686-L720))

## Steam setup, dependencies, and shortcuts

Suggested automation sequence, with each mutation serialized and resumable:

```sh
# Current interface (preferred after capability check)
"$launcher" create-prefix
"$launcher" run --start-exe "/absolute/path/to/SteamSetup.exe"
"$launcher" winetricks vcrun2022

# Corroborated legacy equivalents
"$launcher" WSS-wineprefixcreate
"$launcher" WSS-installer "/absolute/path/to/SteamSetup.exe"
"$launcher" WSS-winetricks vcrun2022
```

Download the Windows installer only from Valve's [official Steam download](https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe). Installation remains interactive. Keep its default Windows location so the expected executable is `C:\Program Files (x86)\Steam\steam.exe`, then launch Steam and require the user to log in once.

Winetricks must run against the same wrapper that contains Windows Steam and the game. The launcher accepts multiple verbs after the legacy `WSS-winetricks` token, while the modern help describes one verb; invoking one verb per OGI dependency is easier to resume and attribute. The Configure app downloads Sikarugir's forked Winetricks script into `Contents/SharedSupport/winetricks` on demand. ([Winetricks download location/source](https://github.com/Sikarugir-App/Sikarugir-foss-sources/blob/4be1b048f8df14b073a6e39e8245bbb52c6a71c0/Configure/Classes/Controller/WineskinAppDelegate.m#L1194-L1258))

After first login, the Windows Steam shortcut file is expected at:

```text
Steam.app/Contents/SharedSupport/prefix/drive_c/
  Program Files (x86)/Steam/userdata/<account-id>/config/shortcuts.vdf
```

There is no `<account-id>` directory before the first successful login, so shortcut installation cannot be part of initial prefix creation. OGI should model “Steam login required” as a resumable setup state, discover numeric account directories afterward, and ask the user if there is more than one viable account.

Stop Windows Steam before reading or writing binary VDF; otherwise the client may overwrite OGI's changes. Use the wrapper's `quit`/`WSS-wineserverkill`, confirm the process has exited, merge rather than replace the file, write atomically with a backup, then restart Steam so it ingests the shortcut.

### Play-page launch behavior

For a real Steam catalog game, pass its stable Steam AppID to Windows Steam, for example:

```sh
"$launcher" run 'C:\Program Files (x86)\Steam\steam.exe' -applaunch 123456
```

For an OGI-created **non-Steam shortcut**, do not assume the traditional `crc32(exe + appName)`/`steam://rungameid/<value>` calculation is stable. Valve's still-open Steam client issue reports that the browser-protocol BPID became ad-hoc/randomized and can no longer be calculated ahead of time, even though `shortcuts.vdf` can be parsed for the shortcut's separate AppID. ([ValveSoftware issue #9463](https://github.com/ValveSoftware/steam-for-linux/issues/9463#issue-1696763239))

This leaves three staged choices:

1. Reliable baseline: Play launches the configured Steam wrapper and lets the user click the shortcut.
2. Validation spike: on a current Windows Steam client inside Sikarugir, create a shortcut, restart Steam, test `-applaunch <shortcut-appid>`, `steam://launch/<shortcut-appid>`, and `steam://rungameid/<candidate>` while capturing Steam logs and the post-normalization VDF.
3. Only after that test, persist the identifier Steam actually accepts alongside the OGI library record. Never recompute it from the game path at Play time.

The current Sikarugir launcher advertises flag forwarding, but a recent Sikarugir discussion reports an older/direct launcher invocation dropping a Steam URL argument. That is another reason to test the exact pinned template on macOS and prefer the modern `run <file> [flags]` form. ([Sikarugir discussion #249](https://github.com/orgs/Sikarugir-App/discussions/249))

## Mapping this into OpenGameInstaller

### OOBE and Bun

OGI's current OOBE already has the right ownership boundary: `handler.oobe.ts` checks and installs host tools, streams `oobe:log` events, and returns a coarse `[clean, restart]` result. The current Bun decision function only installs on Windows and non-NixOS Linux; Darwin falls through to `unsupported`. It also upgrades every detected installation with `bun upgrade`. ([local OOBE handler](../../application/src/electron/handlers/handler.oobe.ts), [local Bun setup policy](../../application/src/electron/lib/bun-setup.ts))

The macOS implementation should make two changes independently:

1. Add Darwin Bun installation. Bun officially supports macOS through either its install script or Homebrew, and warns Homebrew users to upgrade with `brew upgrade bun`, not `bun upgrade`. OGI therefore needs to resolve both the Bun executable and its installation provenance. ([Bun installation and upgrade documentation](https://bun.com/docs/installation), [Homebrew's Bun formula](https://formulae.brew.sh/formula/bun))
2. Make Homebrew/Sikarugir an optional **Windows-game support** capability, not a prerequisite for every macOS OGI user. If the user enables it, OOBE performs the interactive Homebrew handoff described above, installs Sikarugir, and then starts the separate wrapper/login setup. Bun can use Homebrew when it is already available, but OGI should not force a Homebrew installation solely to obtain Bun.

Do not rely on the GUI application's inherited `PATH`. Resolve tools in this order:

```text
Homebrew: /opt/homebrew/bin/brew, /usr/local/bin/brew, then PATH
Bun:      <brew --prefix>/bin/bun, ~/.bun/bin/bun, then PATH
Git:      /usr/bin/git, <brew --prefix>/bin/git, then PATH
```

After installing Bun, either add its directory to the child-process environment immediately or keep using the absolute executable path. A full device restart is unnecessary for a PATH-only change. OGI's executor already falls back to `~/.bun/bin/bun`, so this fits the existing runtime behavior. ([local Bun resolution](../../packages/executor/lib/addon.ts))

The OOBE RPC should eventually replace the tuple with explicit per-tool state so an interactive handoff is not reported as a generic failure or reboot:

```ts
type ToolSetupStatus = 'ready' | 'installed' | 'action-required' | 'failed';

interface ToolSetupResult {
  readonly tools: readonly {
    readonly id: 'homebrew' | 'bun' | 'git' | 'rosetta' | 'sikarugir';
    readonly status: ToolSetupStatus;
    readonly message?: string;
  }[];
  readonly appRelaunchRequired: boolean;
}
```

The Homebrew installation button should open a visible Terminal session running the official installer and then poll the two supported `brew` paths. Once detected, OGI can continue without restarting the machine. The Sikarugir cask trust/install step must have its own disclosure because it executes a third-party tap and the cask removes quarantine/ad-hoc signs Creator.

### Runtime and library state

Use one shared Steam wrapper rather than installing Steam once per game. Keep wrapper-wide state out of individual library records:

```ts
interface SikarugirRuntimeConfiguration {
  readonly wrapperPath: string;
  readonly templateVersion: string;
  readonly engineVersion: string;
  readonly steamRootPath: string;
  readonly steamAccountId?: string;
}

interface SikarugirGameConfiguration {
  readonly steamShortcutAppId?: number;
  readonly steamLaunchId?: string;
  readonly windowsExecutable: string;
  readonly windowsWorkingDirectory: string;
}
```

The runtime configuration belongs in an application-level runtime config file; `LibraryInfo` only needs the per-game configuration. Every create-prefix, installer, Winetricks, Steam-stop, VDF-write, and wrapper-update operation must take the same runtime mutex because they mutate one prefix.

OGI's existing Steam code is largely reusable. `SteamRepositoryLive(candidates)` already accepts an explicit Steam root, discovers numeric accounts from `userdata`, parses `loginusers.vdf`, merges binary `shortcuts.vdf`, and writes atomically. A Sikarugir-specific service can provide the Windows Steam root under the wrapper instead of native macOS Steam's root. ([local Steam repository](../../application/src/electron/lib/steam-installation.ts), [local shortcut merge/ID code](../../application/src/electron/lib/steam-shortcuts.ts))

The shortcut should use a Wine-visible Windows path. For files outside the prefix, resolve the wrapper's `dosdevices/z:` mapping and store a `Z:\\...` executable/working directory. Do not construct this with string replacement alone: resolve the symlink and verify the macOS game path is reachable through that mapping.

### Dependency step

The setup insertion flow currently creates UMU state and returns `setup-prefix-required` only on Linux; the redistributable handler explicitly fails on every non-Linux platform. macOS should dispatch through a runtime backend instead of weakening those Linux guards. ([local setup dispatch](../../application/src/electron/handlers/handler.library.ts), [local redistributable dispatch](../../application/src/electron/handlers/handler.redists.ts))

For a Sikarugir-backed game, process each `{ path: 'winetricks', name: verb }` entry sequentially as:

```text
launcher winetricks <verb>
```

Report through the existing redistributable-progress event shape. One verb per process preserves item-level progress and makes retry behavior clear. A non-Winetricks `.exe` redistributable can use `launcher run --start-exe <absolute path> <silent flags>` only after the pinned launcher's exit-code and flag behavior have been verified on macOS.

Shortcut insertion belongs after dependencies and after Steam login. If the account directory does not exist yet, persist the installed game and return a distinct `setup-steam-login-required` state rather than treating the install as failed.

### PlayPage and lifecycle

`PlayPage.svelte` already runs addon pre-launch hooks and then calls one `app.launchGame` RPC. `launchGameFromLibrary` already owns backend selection and emits `game:launch`/`game:exit`, while `GameManager.svelte` uses `game:exit` to run post-launch hooks. The frontend should remain unchanged apart from macOS-specific readiness/action-required messaging; backend selection belongs beside the existing UMU branch. ([local PlayPage launch flow](../../application/src/frontend/components/PlayPage.svelte), [local launch dispatcher](../../application/src/electron/handlers/handler.library.ts), [local lifecycle manager](../../application/src/frontend/managers/GameManager.svelte))

The macOS branch should be:

```text
Play
  -> addon pre-launch hooks
  -> ensure wrapper + Steam login + stored shortcut launch ID are ready
  -> launcher run "C:\\Program Files (x86)\\Steam\\steam.exe" <validated launch args>
  -> emit game:launch only after Steam accepts the request
  -> observe the launched game, not the long-lived Steam client
  -> emit game:exit
  -> existing addon post-launch hooks
```

The final observation step is important. The Sikarugir launcher process may represent the long-lived Steam client rather than the selected game, so its exit is not automatically the game's exit. The validation spike should test whether Steam's child process can be identified reliably. If it cannot, use a generated per-game Windows command wrapper that creates a sentinel, starts the actual executable with `start /wait`, and removes the sentinel on exit; then have Electron watch that sentinel. This must be tested for Steam Overlay/controller compatibility before adoption.

Until the non-Steam launch identifier and lifecycle signal are validated, Play should open the Windows Steam wrapper and show “Choose the game in Steam” rather than claiming a successful one-click launch.

## Licensing, security, and updates

- Upstream says only the modified `Configure.app` is LGPL-2.1. Creator 1.0.1+ and the Sikarugir Launcher do not fall under that license, and the Creator/Wrapper repositories publish no repository-level license. OGI should not redistribute or modify those binaries without explicit permission; user-installed Creator plus user-generated wrappers is the safer boundary. ([upstream component licensing statement](https://github.com/Sikarugir-App/Sikarugir/blob/39710f11e0b9a1b4a1a7110ef8c8ad6fbf1fe786/README.md#L70-L80), [LGPL source repository](https://github.com/Sikarugir-App/Sikarugir-foss-sources))
- D3DMetal/GPTK is closed-source and upstream explicitly says its license forbids commercial ports. OGI should default to WineD3D/another suitable renderer or require a deliberate user choice after showing the relevant license; do not silently bundle D3DMetal into a commercial distribution. ([DirectX and D3DMetal notice](https://github.com/Sikarugir-App/Sikarugir/blob/39710f11e0b9a1b4a1a7110ef8c8ad6fbf1fe786/README.md#L42-L55))
- Upstream warns that `sikarugir.com` is unaffiliated and may distribute malware. OGI should use only the `Sikarugir-App` GitHub organization and its Homebrew tap. ([security warning](https://github.com/Sikarugir-App/Sikarugir/blob/39710f11e0b9a1b4a1a7110ef8c8ad6fbf1fe786/README.md#L7-L8))
- The cask deliberately strips quarantine and ad-hoc signs Creator. This is visible behavior that OGI should disclose rather than replicate silently. Pin/verify release SHA-256 values for any direct download. ([cask postflight](https://github.com/Sikarugir-App/homebrew-sikarugir/blob/640e2001e7622ac5098d472713ab7297e50dbec9/Casks/sikarugir.rb#L14-L18))
- Creator, template, engine, Winetricks, and Windows Steam update independently. Record all versions per wrapper. Never update an in-use wrapper as an OOBE side effect; offer an explicit update/repair operation with a backup of `Info.plist`, `SharedSupport/prefix`, and Steam shortcut data.

## Validation required before shipping

- Build one wrapper through Creator on a real Sonoma-or-newer Apple Silicon Mac and record its final launcher filename/layout. The released artifacts were inspected on Linux, so the macOS-only assembly executable itself could not be run here.
- Verify the chosen engine can bootstrap and log into the current Windows Steam client; Steam web-helper compatibility is engine-sensitive.
- Confirm modern launcher exit codes and progress/log behavior for `create-prefix`, `run --start-exe`, `winetricks`, and `quit`.
- Verify dependency idempotency and whether a failed Winetricks verb leaves the prefix usable.
- Resolve the current non-Steam shortcut launch identifier empirically before promising one-click direct launch from Play.
