<script lang="ts">
import { formatError, ValidationError } from '@ogi-sdk/errors';
import { createLogger, LOGGER_PREFIXES } from '@ogi-sdk/logger';
import { Effect, Either, Schema } from 'effect';
import { onDestroy, onMount } from 'svelte';
import { preventDefault } from 'svelte/legacy';
import { fade } from 'svelte/transition';
import { communityAddonArraySchema } from '@/electron/lib/marketplace-schema';
import ThemePicker from '@/frontend/components/ThemePicker.svelte';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';
import {
  type CommunityAddon,
  createNotification,
  DEFAULT_MARKETPLACE_SOURCES,
  oobeLog,
} from '@/frontend/store.svelte';
import { installAddonsAndReconnect } from '@/frontend/utils';
import type {
  SikarugirProvisionState,
  WindowsSupportStatus,
} from '@/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

let stage = $state(0);

let selectedTorrenter:
  | 'qbittorrent'
  | 'real-debrid'
  | 'all-debrid'
  | 'webtorrent'
  | 'torbox'
  | 'premiumize'
  | '' = $state('webtorrent');
let fulfilledRequirements = $state(false);
let addons = '';
let addonSearch = $state('');
let oobeMarketplaceSources = $state<string[]>([...DEFAULT_MARKETPLACE_SOURCES]);
let marketplaceSourceUrl = $state('');
let selectedAddons = $state<string[]>([
  `${DEFAULT_MARKETPLACE_SOURCES[0]}@https://github.com/Nat3z/steam-integration`,
]);
let selectedTheme = $state('light');
let isSettingKey = $state(false);
let logContainer: HTMLDivElement | null = $state(null);
let previousLogLength = $state(0);
let communityAddonsLoading = $state(false);
let communityAddonsError = $state('');

// Auto-scroll when new logs are added
$effect(() => {
  if (logContainer && $oobeLog.logs.length > previousLogLength) {
    logContainer.scrollTo({
      top: logContainer.scrollHeight,
      behavior: 'smooth',
    });
    previousLogLength = $oobeLog.logs.length;
  }
});

$effect(() => {
  if (selectedTorrenter === 'webtorrent') {
    fulfilledRequirements = true;
  } else {
    fulfilledRequirements = false;
  }
});

interface Props {
  finishedSetup: () => void;
}

type ListedCommunityAddon = CommunityAddon & { marketplaceUrl: string };

let communityList: ListedCommunityAddon[] = $state([]);
let { finishedSetup }: Props = $props();

function normalizeMarketplaceSource(source: string) {
  return source.trim().replace(/\/+$/, '');
}

function marketplaceCatalogUrl(source: string) {
  return source.endsWith('/api/marketplace.json')
    ? source
    : `${source}/api/marketplace.json`;
}

function toMarketplaceAddonLink(marketplaceUrl: string, source: string) {
  return `${normalizeMarketplaceSource(marketplaceUrl)}@${source}`;
}

function toGitAddonLink(source: string) {
  const trimmed = source.trim();
  if (!trimmed) return '';
  if (
    trimmed.startsWith('local@') ||
    trimmed.startsWith('git@') ||
    trimmed.includes('@')
  ) {
    return trimmed;
  }
  return `git@${trimmed}`;
}

async function loadCommunityAddonsFromMarketplaces(sources: string[]) {
  communityAddonsLoading = true;
  communityAddonsError = '';
  const normalizedSources = [
    ...new Set(sources.map((source) => normalizeMarketplaceSource(source))),
  ].filter(Boolean);

  try {
    const results = await Promise.allSettled(
      normalizedSources.map(async (marketplaceUrl) => {
        const response = await runFrontendEffect(
          electronRpc.app.axios({
            method: 'GET',
            url: marketplaceCatalogUrl(marketplaceUrl),
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'OpenGameInstaller Client/Rest1.0',
            },
          })
        );
        const parsed = Schema.decodeUnknownEither(communityAddonArraySchema)(
          response.data
        );
        if (Either.isLeft(parsed)) {
          logger.sync.error(
            'Invalid marketplace JSON for',
            marketplaceUrl,
            parsed.left
          );
          return runFrontendEffect(
            Effect.fail(
              new ValidationError({
                message: 'Invalid marketplace JSON',
                field: marketplaceUrl,
              })
            )
          );
        }
        return parsed.right.map((addon) => ({
          ...addon,
          marketplaceUrl,
        }));
      })
    );

    const listed: ListedCommunityAddon[] = [];
    let failedCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        listed.push(...result.value);
      } else {
        failedCount += 1;
        logger.sync.error('Failed to load marketplace source:', result.reason);
      }
    }

    communityList = listed;
    if (listed.length === 0 && failedCount > 0) {
      communityAddonsError =
        'Failed to load marketplace addons. Check your marketplace sources and try again.';
    }
  } finally {
    communityAddonsLoading = false;
  }
}

async function addMarketplaceSource() {
  const source = normalizeMarketplaceSource(marketplaceSourceUrl);
  if (!source) return;

  try {
    new URL(source);
  } catch {
    createNotification({
      message: 'Please enter a valid marketplace URL',
      id: Math.random().toString(36).substring(7),
      type: 'error',
    });
    return;
  }

  if (oobeMarketplaceSources.includes(source)) {
    marketplaceSourceUrl = '';
    return;
  }

  oobeMarketplaceSources = [...oobeMarketplaceSources, source];
  marketplaceSourceUrl = '';
  await loadCommunityAddonsFromMarketplaces(oobeMarketplaceSources);
}

async function removeMarketplaceSource(source: string) {
  const nextSources = oobeMarketplaceSources.filter(
    (marketplaceSource) => marketplaceSource !== source
  );
  oobeMarketplaceSources = nextSources.length
    ? nextSources
    : [...DEFAULT_MARKETPLACE_SOURCES];

  selectedAddons = selectedAddons.filter((addon) => {
    if (!addon.includes('@') || addon.startsWith('git@')) return true;
    const marketplaceUrl = addon.slice(0, addon.indexOf('@'));
    return oobeMarketplaceSources.includes(marketplaceUrl);
  });

  await loadCommunityAddonsFromMarketplaces(oobeMarketplaceSources);
}

async function resetMarketplaceSources() {
  oobeMarketplaceSources = [...DEFAULT_MARKETPLACE_SOURCES];
  selectedAddons = selectedAddons.filter((addon) => {
    if (!addon.includes('@') || addon.startsWith('git@')) return true;
    const marketplaceUrl = addon.slice(0, addon.indexOf('@'));
    return oobeMarketplaceSources.includes(marketplaceUrl);
  });
  await loadCommunityAddonsFromMarketplaces(oobeMarketplaceSources);
}

async function downloadTools() {
  logger.sync.info('Downloading tools');
  oobeLog.update((currentLog) => ({
    ...currentLog,
    status: 'running',
    logs: [],
  }));

  let result: readonly [boolean, boolean];
  try {
    result = await runFrontendEffect(electronRpc.oobe.downloadTools());
  } catch (error: unknown) {
    const message = formatError(error);
    logger.sync.error('Failed to download tools:', error);
    oobeLog.update((currentLog) => ({
      ...currentLog,
      status: 'failed',
      logs: [...currentLog.logs, `Error: ${message}`],
    }));
    return;
  }

  if (!result[0]) {
    oobeLog.update((currentLog) => ({
      ...currentLog,
      status: 'failed',
    }));
    return;
  }

  if (result[1]) {
    stage = 1.5;
    // write the directory first ./config/option
    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/installed.json',
      JSON.stringify({ restartRequired: true, installed: false })
    );
  } else if (currentOS === 'darwin') {
    // Optional Windows-game support step (Homebrew, Rosetta, Sikarugir)
    await refreshWindowsSupport();
    stage = 1.75;
  } else stage = 2;
}

let windowsSupport = $state<WindowsSupportStatus | null>(null);
let homebrewHandoffActive = $state(false);
let homebrewPollTimer: ReturnType<typeof setInterval> | null = null;
let rosettaBusy = $state(false);
let rosettaError = $state('');
let rosettaPollTimer: ReturnType<typeof setInterval> | null = null;
let sikarugirBusy = $state(false);
let sikarugirError = $state('');
let provisionState = $state<SikarugirProvisionState | null>(null);
let provisionBusy = $state(false);
let provisionError = $state('');
// Fully provisioned: wrapper, prefix, Windows Steam, login, and account chosen.
const provisionReady = $derived(
  provisionState?.state === 'ready' &&
    !provisionState.steamAccountSelectionRequired
);

async function refreshWindowsSupport() {
  try {
    windowsSupport = await runFrontendEffect(
      electronRpc.oobe.getWindowsSupportStatus()
    );
  } catch (error: unknown) {
    logger.sync.error('Failed to query Windows support status:', error);
  }
  await refreshProvisionState();
}

async function refreshProvisionState() {
  if (windowsSupport?.sikarugir.status !== 'ready') {
    provisionState = null;
    return;
  }
  try {
    provisionState = await runFrontendEffect(
      electronRpc.oobe.getSikarugirSetupState()
    );
  } catch (error: unknown) {
    logger.sync.error('Failed to query Sikarugir setup state:', error);
  }
}

// Runs one provisioning RPC, surfaces its message on failure, then re-queries state.
async function runProvisionAction(
  action: () => Promise<{ success: boolean; message: string }>
) {
  provisionBusy = true;
  provisionError = '';
  try {
    const result = await action();
    if (!result.success) provisionError = result.message;
  } catch (error: unknown) {
    provisionError = formatError(error);
  }
  await refreshProvisionState();
  provisionBusy = false;
}

function stopHomebrewPoll() {
  if (homebrewPollTimer) {
    clearInterval(homebrewPollTimer);
    homebrewPollTimer = null;
  }
  homebrewHandoffActive = false;
}

async function beginHomebrewInstall() {
  // Marked active up front so a second click cannot start a parallel
  // Terminal hand-off and orphan the first poll timer.
  if (homebrewHandoffActive || homebrewPollTimer) return;
  homebrewHandoffActive = true;
  let launched = false;
  try {
    launched = await runFrontendEffect(electronRpc.oobe.startHomebrewInstall());
  } catch (error: unknown) {
    logger.sync.error('Failed to start Homebrew install:', error);
  }
  if (!launched) {
    stopHomebrewPoll();
    createNotification({
      message: 'Could not open Terminal to install Homebrew',
      id: Math.random().toString(36).substring(7),
      type: 'error',
    });
    return;
  }
  homebrewPollTimer = setInterval(async () => {
    try {
      const result = await runFrontendEffect(electronRpc.oobe.pollHomebrew());
      if (result.status === 'ready') {
        stopHomebrewPoll();
        await refreshWindowsSupport();
      }
    } catch (error: unknown) {
      logger.sync.error('Homebrew poll failed:', error);
    }
  }, 3000);
}

function stopRosettaPoll() {
  if (rosettaPollTimer) {
    clearInterval(rosettaPollTimer);
    rosettaPollTimer = null;
  }
  rosettaBusy = false;
}

async function beginRosettaInstall() {
  if (rosettaBusy || rosettaPollTimer) return;
  rosettaBusy = true;
  rosettaError = '';
  let result: 'ready' | 'installing' | 'launch-failed' | 'unsupported' =
    'launch-failed';
  try {
    result = await runFrontendEffect(electronRpc.oobe.installRosetta());
    await refreshWindowsSupport();
  } catch (error: unknown) {
    logger.sync.error('Failed to install Rosetta:', error);
    rosettaError = formatError(error);
    rosettaBusy = false;
    return;
  }
  if (result === 'launch-failed') {
    rosettaError = 'Could not open Terminal to install Rosetta 2.';
    rosettaBusy = false;
    return;
  }
  if (result !== 'installing') {
    rosettaBusy = false;
    return;
  }
  // The Terminal hand-off outlives the RPC, so keep polling until the
  // softwareupdate install finishes instead of re-showing the button.
  rosettaPollTimer = setInterval(async () => {
    try {
      await refreshWindowsSupport();
      if (windowsSupport?.rosetta.status === 'ready') stopRosettaPoll();
    } catch (error: unknown) {
      logger.sync.error('Rosetta poll failed:', error);
    }
  }, 3000);
}

async function beginSikarugirInstall() {
  sikarugirBusy = true;
  sikarugirError = '';
  oobeLog.update((currentLog) => ({
    ...currentLog,
    status: 'running',
    logs: [],
  }));
  try {
    const result = await runFrontendEffect(electronRpc.oobe.installSikarugir());
    if (!result.success) {
      sikarugirError = result.message;
      oobeLog.update((currentLog) => ({ ...currentLog, status: 'failed' }));
    } else {
      oobeLog.update((currentLog) => ({ ...currentLog, status: 'idle' }));
    }
    await refreshWindowsSupport();
  } catch (error: unknown) {
    sikarugirError = formatError(error);
    oobeLog.update((currentLog) => ({ ...currentLog, status: 'failed' }));
  } finally {
    sikarugirBusy = false;
  }
}

function finishWindowsSupport() {
  stopHomebrewPoll();
  stopRosettaPoll();
  oobeLog.update((currentLog) => ({ ...currentLog, status: 'idle', logs: [] }));
  stage = 2;
}

function submitTorrenter() {
  if (selectedTorrenter === 'real-debrid') {
    logger.sync.info('Submitting RD API Key');
    // save a file with the api key
    const apiKey = document.querySelector(
      'input[data-rd-key]'
    ) as HTMLInputElement;
    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/realdebrid.json',
      JSON.stringify({ debridApiKey: apiKey.value, torboxApiKey: '' })
    );

    fulfilledRequirements = true;
  } else if (selectedTorrenter === 'qbittorrent') {
    logger.sync.info('Submitting qBittorrent');
    const ip = document.querySelector('input[data-qb-ip]') as HTMLInputElement;
    const port = document.querySelector(
      'input[data-qb-port]'
    ) as HTMLInputElement;
    const username = document.querySelector(
      'input[data-qb-username]'
    ) as HTMLInputElement;
    const password = document.querySelector(
      'input[data-qb-pwd]'
    ) as HTMLInputElement;

    if (!ip.value || !port.value || !username.value || !password.value) {
      logger.sync.error('Missing qBittorrent fields');
      return;
    }

    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/qbittorrent.json',
      JSON.stringify({
        qbitHost: ip.value,
        qbitPort: port.value,
        qbitUsername: username.value,
        qbitPassword: password.value,
      })
    );

    fulfilledRequirements = true;
  } else if (selectedTorrenter === 'torbox') {
    logger.sync.info('Submitting TorBox API Key');
    // save a file with the api key
    const apiKey = document.querySelector(
      'input[data-torbox-key]'
    ) as HTMLInputElement;
    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/realdebrid.json',
      JSON.stringify({ torboxApiKey: apiKey.value, debridApiKey: '' })
    );
    fulfilledRequirements = true;
  } else if (selectedTorrenter === 'premiumize') {
    logger.sync.info('Submitting Premiumize API Key');
    // save a file with the api key
    const apiKey = document.querySelector(
      'input[data-premiumize-key]'
    ) as HTMLInputElement;
    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/realdebrid.json',
      JSON.stringify({ premiumizeApiKey: apiKey.value, debridApiKey: '' })
    );
    fulfilledRequirements = true;
  } else if (selectedTorrenter === 'all-debrid') {
    logger.sync.info('Submitting AllDebrid API Key');
    const apiKey = document.querySelector(
      'input[data-alldebrid-key]'
    ) as HTMLInputElement | null;
    if (!apiKey) {
      logger.sync.error('Missing AllDebrid API key input');
      return;
    }
    const key = apiKey.value.trim();
    if (!key) {
      logger.sync.error('Missing AllDebrid API key');
      return;
    }
    window.electronAPI.fs.mkdir('./config/option/');
    let config: Record<string, string> = {};
    if (window.electronAPI.fs.exists('./config/option/realdebrid.json')) {
      try {
        config = JSON.parse(
          window.electronAPI.fs.read('./config/option/realdebrid.json')
        );
      } catch {
        // use empty config
      }
    }
    config.alldebridApiKey = key;
    window.electronAPI.fs.write(
      './config/option/realdebrid.json',
      JSON.stringify(config)
    );
    fulfilledRequirements = true;
  }
}

let downloadLocation = '';

async function updateDownloadLocation() {
  const path = await runFrontendEffect(
    electronRpc.fs.dialog.showOpenDialog({ properties: ['openDirectory'] })
  );
  if (!path) return;
  const htmlElement = document.querySelector(
    'input[data-dwloc]'
  )!! as HTMLInputElement;
  htmlElement.value = path;
  downloadLocation = path;
}

function sendDownloadLocation(event: MouseEvent) {
  const htmlElement = document.querySelector(
    'input[data-dwloc]'
  )!! as HTMLInputElement;
  downloadLocation = htmlElement.value;
  if (
    downloadLocation === '' ||
    !window.electronAPI.fs.exists(downloadLocation)
  ) {
    logger.sync.error('No download location selected');
    const button = event.target as HTMLButtonElement;
    button.textContent = 'Invalid location';
    button.style.backgroundColor = '#f55045';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = 'Continue';
      button.style.backgroundColor = '';
      button.disabled = false;
    }, 2000);
    return;
  }
  stage = 4;
}

let currentOS = $state('');
let isSteamDeck = $state(false);

type OOBETool = {
  shortLabel: string;
  name: string;
  purpose: string;
  icon: 'image' | 'text';
  iconSrc?: string;
};

function getRequiredTools(osName: string): OOBETool[] {
  const platformTools: OOBETool[] =
    osName === 'win32'
      ? [
          {
            shortLabel: '7z',
            name: '7-Zip',
            purpose: 'Extracts archived installers and repacks.',
            icon: 'text',
          },
        ]
      : [];

  return [
    ...platformTools,
    {
      shortLabel: 'Bun',
      name: 'Bun',
      purpose: 'Runs addons and related setup scripts.',
      icon: 'image',
      iconSrc: './bun.svg',
    },
    {
      shortLabel: 'Git',
      name: 'Git',
      purpose: 'Downloads and updates addon repositories.',
      icon: 'image',
      iconSrc: './git.svg',
    },
  ];
}

const requiredTools = $derived(getRequiredTools(currentOS));

function handleThemeChange(detail: { selectedId: string }) {
  selectedTheme = detail.selectedId;
  document.documentElement.setAttribute('data-theme', detail.selectedId);
}

async function finishSetup() {
  const customAddons = addons
    .split('\n')
    .map((addon) => toGitAddonLink(addon))
    .filter((addon) => addon !== '');
  const allAddons = [...new Set([...selectedAddons, ...customAddons])];

  let generalConfig = {
    theme: selectedTheme,
    fileDownloadLocation: downloadLocation,
    addons: [],
    torrentClient: selectedTorrenter,
    marketplaceSources: oobeMarketplaceSources,
  };
  window.electronAPI.fs.mkdir('./config/option/');
  window.electronAPI.fs.write(
    './config/option/general.json',
    JSON.stringify(generalConfig)
  );
  await runFrontendEffect(installAddonsAndReconnect(allAddons));
  window.electronAPI.fs.write(
    './config/option/installed.json',
    JSON.stringify({ installed: true })
  );
  document.getElementById('oobe')?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 500,
    fill: 'forwards',
  });

  Effect.sync(finishedSetup).pipe(Effect.delay('500 millis'), Effect.runSync);
}

function waitForSetup() {
  stage = 7;
}

function toggleAddon(addon: ListedCommunityAddon) {
  const addonLink = toMarketplaceAddonLink(addon.marketplaceUrl, addon.source);
  const index = selectedAddons.indexOf(addonLink);
  if (index > -1) {
    selectedAddons.splice(index, 1);
  } else {
    selectedAddons.push(addonLink);
  }
}

function isAddonSelected(addon: ListedCommunityAddon) {
  return selectedAddons.includes(
    toMarketplaceAddonLink(addon.marketplaceUrl, addon.source)
  );
}

function getFilteredAddons(list: ListedCommunityAddon[]) {
  const query = addonSearch.trim().toLowerCase();
  if (!query) return list;

  return list.filter((addon) => {
    const content =
      `${addon.name} ${addon.author} ${addon.description} ${addon.marketplaceUrl}`.toLowerCase();
    return content.includes(query);
  });
}

// Event listener for OOBE logs
function handleOOBELog(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const logContent = event.detail;

  oobeLog.update((currentLog) => ({
    ...currentLog,
    logs: [...currentLog.logs, logContent],
    status: 'running',
  }));
}

onMount(async () => {
  // Set up OOBE log listener
  document.addEventListener('oobe:log', handleOOBELog);

  // Initialize previous log length
  previousLogLength = $oobeLog.logs.length;
  currentOS = await runFrontendEffect(electronRpc.app.getOS());
  isSteamDeck = await runFrontendEffect(electronRpc.app.isSteamDeck());

  if (window.electronAPI.fs.exists('./config/option/installed.json')) {
    const installed = JSON.parse(
      window.electronAPI.fs.read('./config/option/installed.json')
    );
    if (installed.restartRequired) {
      // Update the file first to clear the restart flag
      window.electronAPI.fs.write(
        './config/option/installed.json',
        JSON.stringify({ restartRequired: false, installed: false })
      );
      // Then set the stage to continue to torrenting
      stage = 2;
    }
  }
  communityList = [];
  await loadCommunityAddonsFromMarketplaces(oobeMarketplaceSources);
});

onDestroy(() => {
  // Clean up event listener
  document.removeEventListener('oobe:log', handleOOBELog);
  stopHomebrewPoll();
  stopRosettaPoll();
});
</script>

<main
  class="flex items-center flex-col justify-center w-full h-full p-8 bg-background-color fixed top-0 left-0 z-5 overflow-y-auto overflow-x-visible"
  id="oobe"
>
  {#if stage >= 1}
    <progress class="animate-fade-in-slow w-full" max="4" value={stage - 1}
    ></progress>
  {/if}

  {#if stage === 0}
    <div
      class="animate-fade-in-pop flex justify-center items-center flex-col gap-6"
    >
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-4xl font-archivo font-semibold text-text-primary">
        Welcome to OpenGameInstaller
      </h1>
      <h2
        class="animate-in-sub-content font-open-sans text-lg text-text-secondary text-center max-w-md"
      >
        An open-source game installer for your video games!
      </h2>

      <div class="animate-in-sub-content-slow">
        <button
          onclick={() => (stage = 0.5)}
          class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Get Started</button
        >
      </div>
    </div>
  {:else if stage === 0.5}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full max-w-xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Choose Your Theme
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-2">
        Pick the look you want to use. You can change this later in settings.
      </h2>
      <div class="w-full max-w-md">
        <ThemePicker
          id="oobe-theme"
          selectedId={selectedTheme}
          onchange={handleThemeChange}
        />
      </div>
      <button
        onclick={() => (stage = 1)}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Continue</button
      >
    </div>
  {:else if stage === 1}
    <div class="animate-fade-in-pop oobe-tools-stage">
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Install Tools
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        These tools are required for launching and running OpenGameInstaller
        services.
      </h2>
      {#if $oobeLog.status === 'idle'}
        <div class="oobe-tools-shell">
          <div
            class="oobe-tools-table"
            role="table"
            aria-label="Required tools"
          >
            {#each requiredTools as tool}
              <div class="oobe-tool-row" role="row">
                <div class="oobe-tool-name">
                  <span class="oobe-tool-mark" aria-hidden="true">
                    {#if tool.icon === 'image' && tool.iconSrc}
                      <img src={tool.iconSrc} alt="" class="oobe-tool-icon" />
                    {:else}
                      <span class="oobe-tool-monogram">{tool.shortLabel}</span>
                    {/if}
                  </span>
                  <span class="oobe-tool-label">{tool.name}</span>
                </div>
                <span class="oobe-tool-purpose">{tool.purpose}</span>
              </div>
            {/each}
          </div>

          <div class="oobe-tools-footer">
            {#if currentOS === 'linux' && !isSteamDeck}
              <p class="oobe-tools-note">
                Install <code>unrar-nonfree</code> and <code>unzip</code> with your
                package manager. These are CLI utilities, and OpenGameInstaller will
                not check whether they are already installed.
              </p>
            {/if}
            <button
              onclick={downloadTools}
              class="bg-accent hover:bg-accent-dark text-white disabled:text-white disabled:bg-yellow-500 font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
              >Install</button
            >
          </div>
        </div>
      {/if}

      <!-- OOBE Terminal Log Display -->
      {#if $oobeLog.status !== 'idle'}
        <div
          class:oobe-terminal-error={$oobeLog.status === 'failed'}
          class="oobe-terminal w-full max-w-3xl mt-6"
        >
          <div class="terminal-header">
            <div class="flex items-center gap-2">
              <span class="terminal-title">
                {$oobeLog.status === 'failed'
                  ? 'Installation failed'
                  : 'Installation console'}
              </span>
            </div>
          </div>

          <div
            bind:this={logContainer}
            class="terminal-content"
            role="log"
            aria-live="polite"
            aria-busy={$oobeLog.status === 'running'}
          >
            {#if $oobeLog.logs.length === 0}
              <div class="terminal-line">
                <span class="terminal-output">
                  {$oobeLog.status === 'failed'
                    ? 'Installation failed before command output was available.'
                    : 'Checking installed tools...'}
                </span>
              </div>
            {/if}
            {#each $oobeLog.logs as log, index}
              <div
                class="terminal-line"
                in:fade={{ duration: 150, delay: index * 20 }}
              >
                <span
                  class:terminal-output-error={log.trimStart().startsWith(
                    'Error:'
                  )}
                  class="terminal-output"
                >
                  {log}
                </span>
              </div>
            {/each}
            {#if $oobeLog.status === 'running'}
              <div class="terminal-cursor" aria-hidden="true">
                <span class="terminal-output animate-pulse">▋</span>
              </div>
            {/if}
          </div>

          {#if $oobeLog.status === 'failed'}
            <div class="terminal-failure" role="alert">
              <p>
                Review the error above, fix the reported issue, then try again.
              </p>
              <button type="button" onclick={downloadTools}>Try again</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else if stage === 1.5}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Restart Required
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        OpenGameInstaller requires a restart of your device to continue the
        setup process.
      </h2>
      <button
        onclick={() => runFrontendEffect(electronRpc.app.close())}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Close</button
      >
    </div>
  {:else if stage === 1.75}
    <div class="animate-fade-in-pop oobe-tools-stage">
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Windows-Game Support
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6 max-w-xl">
        Optional: install the tools OpenGameInstaller uses to run Windows games
        on your Mac. You can skip this and set it up later in settings.
      </h2>

      <div class="oobe-tools-shell">
        <div class="oobe-tools-table" role="table" aria-label="Windows-game support tools">
          <!-- Homebrew -->
          <div class="oobe-tool-row oobe-capability-row" role="row">
            <div class="oobe-tool-name">
              <span class="oobe-tool-mark" aria-hidden="true">
                <span class="oobe-tool-monogram">Brew</span>
              </span>
              <span class="oobe-tool-label">Homebrew</span>
            </div>
            <span class="oobe-tool-purpose">
              Package manager used to install Sikarugir.
            </span>
            <div class="oobe-capability-action">
              {#if windowsSupport?.homebrew.status === 'ready'}
                <span class="oobe-capability-badge is-ready">Installed</span>
              {:else if homebrewHandoffActive}
                <span class="oobe-capability-badge is-waiting">
                  Waiting for Terminal…
                </span>
              {:else}
                <button
                  type="button"
                  class="oobe-capability-button"
                  onclick={beginHomebrewInstall}
                >
                  Install in Terminal
                </button>
              {/if}
            </div>
          </div>

          <!-- Rosetta -->
          <div class="oobe-tool-row oobe-capability-row" role="row">
            <div class="oobe-tool-name">
              <span class="oobe-tool-mark" aria-hidden="true">
                <span class="oobe-tool-monogram">R2</span>
              </span>
              <span class="oobe-tool-label">Rosetta 2</span>
            </div>
            <span class="oobe-tool-purpose">
              Lets Apple Silicon Macs run Intel code that Windows games rely
              on.
            </span>
            <div class="oobe-capability-action">
              {#if windowsSupport?.rosetta.status === 'ready'}
                <span class="oobe-capability-badge is-ready">Installed</span>
              {:else}
                <button
                  type="button"
                  class="oobe-capability-button"
                  disabled={rosettaBusy}
                  onclick={beginRosettaInstall}
                >
                  {rosettaBusy ? 'Installing…' : 'Install in Terminal'}
                </button>
              {/if}
            </div>
          </div>

          <!-- Sikarugir -->
          <div class="oobe-tool-row oobe-capability-row" role="row">
            <div class="oobe-tool-name">
              <span class="oobe-tool-mark" aria-hidden="true">
                <span class="oobe-tool-monogram">Sk</span>
              </span>
              <span class="oobe-tool-label">Sikarugir</span>
            </div>
            <span class="oobe-tool-purpose">
              Wine wrapper that runs Windows Steam and your games.
            </span>
            <div class="oobe-capability-action">
              {#if windowsSupport?.sikarugir.status === 'ready'}
                <span class="oobe-capability-badge is-ready">Installed</span>
              {:else}
                <button
                  type="button"
                  class="oobe-capability-button"
                  disabled={sikarugirBusy ||
                    windowsSupport?.homebrew.status !== 'ready'}
                  onclick={beginSikarugirInstall}
                >
                  {sikarugirBusy
                    ? 'Installing…'
                    : windowsSupport?.homebrew.status !== 'ready'
                      ? 'Requires Homebrew'
                      : 'Install'}
                </button>
              {/if}
            </div>
          </div>
        </div>

        <p class="oobe-tools-note">
          Sikarugir is installed from the third-party Homebrew tap
          <code>Sikarugir-App/sikarugir</code>. macOS may ask you to approve
          the app the first time it opens.
        </p>

        {#if rosettaError}
          <p class="oobe-capability-error" role="alert">{rosettaError}</p>
        {/if}

        {#if sikarugirError}
          <p class="oobe-capability-error" role="alert">{sikarugirError}</p>
        {/if}

        <!-- Sikarugir install console (reuses the oobe:log stream) -->
        {#if sikarugirBusy || $oobeLog.status === 'failed'}
          <div
            class:oobe-terminal-error={$oobeLog.status === 'failed'}
            class="oobe-terminal w-full"
          >
            <div class="terminal-header">
              <span class="terminal-title">
                {$oobeLog.status === 'failed'
                  ? 'Installation failed'
                  : 'Installation console'}
              </span>
            </div>
            <div
              bind:this={logContainer}
              class="terminal-content"
              role="log"
              aria-live="polite"
              aria-busy={sikarugirBusy}
            >
              {#if $oobeLog.logs.length === 0}
                <div class="terminal-line">
                  <span class="terminal-output">Starting installation...</span>
                </div>
              {/if}
              {#each $oobeLog.logs as log, index}
                <div
                  class="terminal-line"
                  in:fade={{ duration: 150, delay: index * 20 }}
                >
                  <span
                    class:terminal-output-error={log.trimStart().startsWith(
                      'Error:'
                    )}
                    class="terminal-output"
                  >
                    {log}
                  </span>
                </div>
              {/each}
              {#if sikarugirBusy}
                <div class="terminal-cursor" aria-hidden="true">
                  <span class="terminal-output animate-pulse">▋</span>
                </div>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Windows Steam provisioning: appears once Sikarugir itself is installed -->
        {#if windowsSupport?.sikarugir.status === 'ready' && provisionState && provisionState.state !== 'unsupported'}
          <div class="oobe-provision-panel">
            <div class="oobe-provision-header">
              <span class="oobe-tool-label">Windows Steam setup</span>
              <span class="oobe-tool-purpose">
                One shared Steam wrapper runs all of your Windows games.
              </span>
            </div>

            {#if provisionState.state === 'wrapper-missing'}
              <p class="oobe-tool-purpose">
                Create a wrapper named <code>Steam.app</code> with Sikarugir
                Creator (in <code>~/Applications/Sikarugir</code>), then check
                again.
                {#if provisionState.message}
                  <br />{provisionState.message}
                {/if}
              </p>
              <button
                type="button"
                class="oobe-capability-button"
                disabled={provisionBusy}
                onclick={() => refreshProvisionState()}
              >
                Check Again
              </button>
            {:else if provisionState.state === 'prefix-missing'}
              <p class="oobe-tool-purpose">
                The wrapper needs a Wine prefix before Steam can be installed.
              </p>
              <button
                type="button"
                class="oobe-capability-button"
                disabled={provisionBusy}
                onclick={() =>
                  runProvisionAction(() =>
                    runFrontendEffect(electronRpc.oobe.createSikarugirPrefix())
                  )}
              >
                {provisionBusy ? 'Creating Prefix…' : 'Create Prefix'}
              </button>
            {:else if provisionState.state === 'steam-not-installed'}
              <p class="oobe-tool-purpose">
                Downloads Valve's official installer and runs it inside the
                wrapper. Follow the installer window when it appears.
              </p>
              <button
                type="button"
                class="oobe-capability-button"
                disabled={provisionBusy}
                onclick={() =>
                  runProvisionAction(() =>
                    runFrontendEffect(electronRpc.oobe.installWindowsSteam())
                  )}
              >
                {provisionBusy ? 'Installing Steam…' : 'Install Windows Steam'}
              </button>
            {:else if provisionState.state === 'steam-login-required'}
              <p class="oobe-tool-purpose">
                Sign in to Steam once so games can be added to your account's
                library. When you're done, check again.
              </p>
              <div class="oobe-provision-actions">
                <button
                  type="button"
                  class="oobe-capability-button"
                  disabled={provisionBusy}
                  onclick={() =>
                    runProvisionAction(() =>
                      runFrontendEffect(electronRpc.oobe.launchWindowsSteam())
                    )}
                >
                  Open Steam to Sign In
                </button>
                <button
                  type="button"
                  class="oobe-capability-button is-outline"
                  disabled={provisionBusy}
                  onclick={() => refreshProvisionState()}
                >
                  Check Again
                </button>
              </div>
            {:else if provisionState.steamAccountSelectionRequired}
              <p class="oobe-tool-purpose">
                Multiple Steam accounts have signed in. Pick the one
                OpenGameInstaller should add games to.
              </p>
              <div class="oobe-provision-actions">
                {#each provisionState.steamAccountIds ?? [] as accountId}
                  <button
                    type="button"
                    class="oobe-capability-button is-outline"
                    disabled={provisionBusy}
                    onclick={() =>
                      runProvisionAction(() =>
                        runFrontendEffect(
                          electronRpc.oobe.selectSikarugirSteamAccount(
                            accountId
                          )
                        )
                      )}
                  >
                    Account {accountId}
                  </button>
                {/each}
              </div>
            {:else}
              <span class="oobe-capability-badge is-ready">
                Ready to run Windows games
              </span>
            {/if}

            {#if provisionError}
              <p class="oobe-capability-error" role="alert">{provisionError}</p>
            {/if}
          </div>
        {/if}

        <div class="oobe-tools-footer justify-end">
          {#if provisionReady}
            <button
              onclick={finishWindowsSupport}
              class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
              >Continue</button
            >
          {:else}
            <button
              onclick={finishWindowsSupport}
              class="border-accent border-2 text-accent hover:border-accent-dark font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
              >Skip for now</button
            >
          {/if}
        </div>
      </div>
    </div>
  {:else if stage === 2}
    <div
      class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-6 p-10 w-full max-w-4xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Torrenting
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        How would you like to torrent your files?
      </h2>
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <div class="flex-row flex gap-6 justify-center items-center">
        <button
          onclick={() => (selectedTorrenter = 'webtorrent')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'webtorrent'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./WebTorrent_logo.png" alt="WebTorrent" />
        </button>
        <button
          onclick={() => (selectedTorrenter = 'real-debrid')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'real-debrid'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./rd-logo.png" alt="Real Debrid" />
        </button>
        <button
          onclick={() => (selectedTorrenter = 'all-debrid')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'all-debrid'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./alldebrid-logo.png" alt="AllDebrid" />
        </button>
        <button
          onclick={() => (selectedTorrenter = 'torbox')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'torbox'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./torbox.svg" alt="Torbox" />
        </button>
        <button
          onclick={() => (selectedTorrenter = 'premiumize')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'premiumize'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./premiumize.svg" alt="Premiumize" />
        </button>
        <button
          onclick={() => (selectedTorrenter = 'qbittorrent')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'qbittorrent'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./qbittorrent.svg" alt="qBittorrent" />
        </button>
      </div>

      <form
        onsubmit={preventDefault(submitTorrenter)}
        class="flex flex-col items-center justify-start w-full max-w-2xl"
      >
        {#if selectedTorrenter === 'real-debrid'}
          <input
            data-rd-key
            type="text"
            onchange={submitTorrenter}
            placeholder="Real Debrid API Key"
            class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-sm text-text-muted mt-2"
            >Insert your <a
              href="https://real-debrid.com/apitoken"
              target="_blank"
              class="underline text-accent hover:text-accent-dark"
              >Real Debrid API Key</a
            ></label
          >
        {:else if selectedTorrenter === 'qbittorrent'}
          <!-- TODO: WORK ON OUR OWN TUTORIAL -->
          <a
            href="https://ogi.nat3z.com/docs/for-users/qb-setup"
            class="font-open-sans mb-4 text-center text-sm underline text-accent hover:text-accent-dark"
            target="_blank"
          >
            <p>
              Enable qBittorrent's WebUI so OpenGameInstaller can interact with
              the client.
            </p>
            <p>Click here for a guide on how to enable it.</p>
          </a>
          <div
            class="justify-center items-center flex flex-row gap-4 mb-4 w-full"
          >
            <span class="items-center justify-center flex flex-col flex-1">
              <input
                data-qb-ip
                type="text"
                onchange={submitTorrenter}
                placeholder="Host"
                value="http://127.0.0.1"
                class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-text-muted mt-1">Hostname</label>
            </span>
            <span class="items-center justify-center flex flex-col w-24">
              <input
                data-qb-port
                type="text"
                onchange={submitTorrenter}
                placeholder="Port"
                value="8080"
                class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-text-muted mt-1">Port</label>
            </span>
          </div>

          <div
            class="justify-center items-center flex flex-row gap-4 mb-4 w-full"
          >
            <span class="items-center justify-center flex flex-col w-32">
              <input
                data-qb-username
                type="text"
                onchange={submitTorrenter}
                placeholder="Username"
                value=""
                class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-text-muted mt-1">Username</label>
            </span>
            <span class="items-center justify-center flex flex-col flex-1">
              <input
                data-qb-pwd
                type="password"
                onchange={submitTorrenter}
                placeholder="Password"
                value=""
                class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-text-muted mt-1">Password</label>
            </span>
          </div>
        {:else if selectedTorrenter === 'webtorrent'}
          <p class="text-text-secondary text-center">
            WebTorrent is built into OpenGameInstaller. No configuration is
            required.
          </p>
          <div
            class="flex justify-center mt-4 items-center flex-col border-red-500 border-2 rounded-lg p-4 bg-red-500/25"
          >
            <p class="text-text-primary text-center">
              Security features like VPN binding are <span class="underline"
                >NOT SUPPORTED</span
              > for WebTorrent.
            </p>
            <p class="text-text-primary text-center">
              Please use qBittorrent/a debrid service if you rely on these
              features.
            </p>
            <p class="text-text-primary text-center font-bold">
              VPNs are still supported.
            </p>
          </div>
        {:else if selectedTorrenter === 'torbox'}
          <input
            data-torbox-key
            type="text"
            onchange={submitTorrenter}
            placeholder="TorBox API Key"
            class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-sm text-text-muted mt-2"
            >Insert your <a
              href="https://torbox.app/settings"
              target="_blank"
              class="underline text-accent hover:text-accent-dark"
              >TorBox API Key</a
            >.
          </label>
        {:else if selectedTorrenter === 'premiumize'}
          <input
            data-premiumize-key
            type="text"
            onchange={submitTorrenter}
            placeholder="Premiumize API Key"
            class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-sm text-text-muted mt-2"
            >Insert your <a
              href="https://www.premiumize.me/account"
              target="_blank"
              class="underline text-accent hover:text-accent-dark"
              >Premiumize API Key</a
            ></label
          >
        {:else if selectedTorrenter === 'all-debrid'}
          <input
            data-alldebrid-key
            type="text"
            onchange={submitTorrenter}
            placeholder="AllDebrid API Key"
            class="w-full p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-sm text-text-muted mt-2"
            >Insert your <a
              href="https://alldebrid.com/apikeys"
              target="_blank"
              class="underline text-accent hover:text-accent-dark"
              >AllDebrid API Key</a
            ></label
          >
        {/if}
      </form>
      {#if fulfilledRequirements || selectedTorrenter === 'webtorrent'}
        <button
          onclick={() => (stage = 3)}
          class="bg-accent animate-fade-in hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Continue</button
        >
      {/if}
    </div>
  {:else if stage === 3}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full max-w-2xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Download Location
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        Where should we save your games?
      </h2>
      <div class="flex justify-center items-center flex-row gap-4 w-full">
        <input
          data-dwloc
          type="text"
          class="flex-1 p-3 bg-surface text-text-primary border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder="Select download location..."
        />
        <button
          onclick={updateDownloadLocation}
          class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-4 rounded-lg transition-colors duration-200"
          >Browse</button
        >
      </div>

      <button
        onclick={sendDownloadLocation}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Continue</button
      >
    </div>
  {:else if stage === 4}
    <div class="animate-fade-in-pop oobe-community-stage">
      <div class="oobe-community-header">
        <h1 class="oobe-community-title">Community Addons</h1>
        <p class="oobe-community-subtitle">
          Pick your core addons from marketplace sources to jump straight into
          discovery.
        </p>
      </div>

      <details class="oobe-marketplace-sources-panel">
        <summary>Marketplace sources</summary>
        <p class="oobe-marketplace-sources-help">
          Base URLs and direct <code>/api/marketplace.json</code> links are both
          supported.
        </p>
        <div class="oobe-marketplace-add-row">
          <input
            type="url"
            bind:value={marketplaceSourceUrl}
            placeholder="https://ogi-marketplace.nat3z.com"
            class="oobe-marketplace-source-input"
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addMarketplaceSource();
              }
            }}
          />
          <button
            type="button"
            onclick={addMarketplaceSource}
            class="oobe-marketplace-add-button"
          >
            Add
          </button>
          <button
            type="button"
            onclick={resetMarketplaceSources}
            class="oobe-marketplace-reset-button"
          >
            Reset
          </button>
        </div>
        <div class="oobe-marketplace-source-list">
          {#each oobeMarketplaceSources as source}
            <div class="oobe-marketplace-source-item">
              <span class="oobe-marketplace-source-url" title={source}
                >{source}</span
              >
              <button
                type="button"
                class="oobe-marketplace-remove-button"
                aria-label={`Remove marketplace source ${source}`}
                onclick={() => removeMarketplaceSource(source)}
              >
                Remove
              </button>
            </div>
          {/each}
        </div>
      </details>

      {#if communityAddonsLoading}
        <div class="oobe-community-loading">
          <p class="text-text-secondary">Loading marketplace addons...</p>
        </div>
      {:else if communityAddonsError}
        <div class="oobe-community-empty">
          <p class="text-text-secondary">{communityAddonsError}</p>
          <button
            type="button"
            class="oobe-marketplace-retry-button"
            onclick={() =>
              loadCommunityAddonsFromMarketplaces(oobeMarketplaceSources)}
          >
            Retry
          </button>
        </div>
      {:else}
        {@const selectedCount = communityList.filter((addon) =>
          isAddonSelected(addon)
        ).length}
        <div class="oobe-community-toolbar">
          <input
            type="search"
            bind:value={addonSearch}
            placeholder="Search addons by name, author, or description"
            class="oobe-community-search"
          />
          <p class="oobe-community-count">
            <span>{selectedCount} selected</span>
            <span class="oobe-community-count-separator">•</span>
            <span>{communityList.length} total</span>
          </p>
        </div>

        {#if getFilteredAddons(communityList).length === 0}
          <div class="oobe-community-empty">
            <p class="text-text-secondary">
              {communityList.length === 0
                ? 'No addons found from the configured marketplace sources.'
                : 'No addons match your search.'}
            </p>
          </div>
        {:else}
          <div class="oobe-community-grid">
            {#each getFilteredAddons(communityList) as addon}
              <article
                class="oobe-addon-card {isAddonSelected(addon)
                  ? 'is-selected'
                  : ''}"
              >
                <div class="oobe-addon-card-header">
                  <img
                    src={addon.img}
                    alt={addon.name}
                    class="oobe-addon-image"
                  />
                  <div class="oobe-addon-meta">
                    <h3 class="oobe-addon-title">{addon.name}</h3>
                    <p class="oobe-addon-author">by {addon.author}</p>
                  </div>
                </div>

                <p class="oobe-addon-description">{addon.description}</p>

                <div class="oobe-addon-footer">
                  <div class="oobe-addon-source-stack">
                    <p class="oobe-addon-marketplace" title={addon.marketplaceUrl}>
                      {addon.marketplaceUrl}
                    </p>
                    <p class="oobe-addon-source" title={addon.source}>
                      {addon.source}
                    </p>
                  </div>
                  <button
                    onclick={() => toggleAddon(addon)}
                    class="oobe-addon-select {isAddonSelected(addon)
                      ? 'selected'
                      : ''}"
                  >
                    {isAddonSelected(addon) ? 'Selected' : 'Select'}
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      {/if}

      <details class="oobe-custom-addon-panel">
        <summary>Add a custom addon repo (optional)</summary>
        <p class="oobe-custom-addon-help">
          Paste one GitHub/Git repository URL per line. Custom repos are
          installed as git-managed addons.
        </p>
        <textarea
          bind:value={addons}
          class="oobe-custom-addon-input"
          placeholder="https://github.com/user/my-custom-addon"
        ></textarea>
      </details>

      <button
        onclick={async () => {
          // check if the user is on windows or linux
          const os = await runFrontendEffect(electronRpc.app.getOS());
          if (os === 'win32') {
            finishSetup();
            stage = 6;
          } else {
            // go to steamgriddb
            stage = 5;
          }
        }}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Continue</button
      >
    </div>
  {:else if stage === 5}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full max-w-2xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        SteamGridDB
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        To automate downloading images for the games you install on Steam, we
        need to use SteamGridDB.
      </h2>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        <a
          href="https://www.steamgriddb.com/profile/preferences/api"
          target="_blank"
          class="underline text-accent hover:text-accent-dark"
          >Insert your SteamGridDB API Key below. If you don't have one, you can
          get one by going here
          (https://www.steamgriddb.com/profile/preferences/api)</a
        >.
      </h2>
      <div class="flex justify-center items-center flex-row gap-4 w-full">
        <input
          data-sgdb-key
          type="text"
          class="flex-1 p-3 bg-surface border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder="SteamGridDB API Key"
        />
      </div>
      <div
        class="flex justify-center items-center flex-row gap-4 w-full max-w-2xl"
      >
        <button
          onclick={async () => {
            isSettingKey = true;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const result = await runFrontendEffect(electronRpc.oobe.setSteamGridDBKey(
              (
                document.querySelector('[data-sgdb-key]') as HTMLInputElement
              ).value.trim()
            ));

            if (!result) {
              createNotification({
                message: 'Failed to set SteamGridDB API Key',
                id: Math.random().toString(36).substring(7),
                type: 'error',
              });
              isSettingKey = false;
              return;
            }

            finishSetup();
            stage = 6;
            isSettingKey = false;
          }}
          class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center"
          disabled={isSettingKey}
        >
          {#if isSettingKey}
            <div
              class="animate-spin mr-2 h-5 w-5 border-2 border-accent border-t-transparent rounded-full"
            ></div>
            Setting Key...
          {:else}
            Set Key and Continue
          {/if}
        </button>
        <button
          onclick={() => {
            finishSetup();
            stage = 6;
          }}
          class="border-accent border-2 text-accent hover:border-accent-dark font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Skip</button
        >
      </div>
    </div>
  {:else if stage === 6}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full"
    >
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        You're all set!
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6 max-w-md">
        OpenGameInstaller is ready to go! Click below to start downloading your
        games!
      </h2>

      <button
        onclick={waitForSetup}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Finish</button
      >
    </div>
  {:else if stage === 7}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full"
    >
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Setting up addons.
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6 max-w-md">
        OpenGameInstaller is setting up your addons. Please hold while we do
        this. Do not close this app, it is regular for this to take a while.
      </h2>
    </div>
  {:else}
    <p>Unknown stage</p>
  {/if}
</main>

<style scoped>
  @reference "../app.css";
  progress {
    @apply fixed top-4 left-0 h-2 w-full [&::-webkit-progress-bar]:rounded-lg [&::-webkit-progress-bar]:bg-accent-light px-4;
  }
  ::-webkit-progress-value {
    transition: width 1s;
    @apply rounded-lg bg-accent;
  }

  .oobe-terminal {
    @apply rounded-lg overflow-hidden border flex flex-col;
    background-color: var(--color-bg-secondary);
    border-color: var(--color-border);
  }

  .oobe-terminal-error {
    border-color: var(--color-error);
  }

  .terminal-header {
    @apply px-4 py-2 border-b;
    background-color: var(--color-surface);
    border-color: var(--color-border);
  }

  .oobe-terminal-error .terminal-header {
    border-color: var(--color-error);
  }

  .terminal-title {
    @apply text-xs text-text-muted font-mono;
  }

  .oobe-terminal-error .terminal-title {
    color: color-mix(
      in srgb,
      var(--color-error) 72%,
      var(--color-text-primary)
    );
  }

  .terminal-content {
    @apply p-4 overflow-y-auto;
    min-height: 12rem;
    max-height: 16rem;
    scrollbar-width: thin;
    scrollbar-color: var(--color-scrollbar) var(--color-bg-secondary);
  }

  .terminal-content::-webkit-scrollbar {
    width: 6px;
  }

  .terminal-content::-webkit-scrollbar-track {
    background: var(--color-bg-secondary);
  }

  .terminal-content::-webkit-scrollbar-thumb {
    background: var(--color-scrollbar);
    border-radius: 3px;
  }

  .terminal-content::-webkit-scrollbar-thumb:hover {
    background: var(--color-scrollbar-hover);
  }

  .terminal-line {
    @apply mb-1;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  .terminal-output {
    @apply font-mono text-sm leading-relaxed;
    color: color-mix(
      in srgb,
      var(--color-success) 72%,
      var(--color-text-primary)
    );
  }

  .terminal-output-error {
    color: color-mix(
      in srgb,
      var(--color-error) 72%,
      var(--color-text-primary)
    );
  }

  .terminal-cursor {
    @apply mt-2;
  }

  .terminal-failure {
    @apply flex items-center justify-between gap-4 border-t px-4 py-3 font-open-sans text-sm text-text-secondary flex-wrap;
    border-color: var(--color-error);
    background-color: color-mix(in srgb, var(--color-error) 8%, transparent);
  }

  .terminal-failure button {
    @apply shrink-0 rounded-lg px-4 py-2 font-semibold text-white cursor-pointer;
    background-color: var(--color-error-hover);
    transition: filter 200ms ease;
  }

  .terminal-failure button:hover {
    filter: brightness(0.88);
  }

  .terminal-failure button:focus-visible {
    outline: 2px solid var(--color-text-primary);
    outline-offset: 2px;
  }

  .oobe-community-stage {
    @apply flex justify-start items-center h-full flex-col gap-4 p-6 w-full max-w-6xl;
  }

  .oobe-tools-stage {
    @apply flex justify-start items-center min-h-full flex-col gap-5 px-4 py-10 w-full max-w-5xl overflow-visible;
  }

  .oobe-tools-shell {
    @apply w-full max-w-3xl flex flex-col gap-5;
  }

  .oobe-tools-table {
    @apply w-full rounded-2xl border border-accent-light bg-surface overflow-x-auto;
  }

  .oobe-tool-row {
    display: grid;
    grid-template-columns: minmax(180px, 1.1fr) minmax(220px, 1.8fr);
    gap: 1rem;
    align-items: center;
    padding: 0.95rem 1rem;
    border-bottom: 1px solid var(--color-accent-light);
  }

  .oobe-tools-table .oobe-tool-row:last-child {
    border-bottom: none;
  }

  .oobe-tool-name {
    @apply flex items-center gap-3 min-w-0;
    min-width: 180px;
  }

  .oobe-tool-mark {
    @apply flex items-center justify-center w-11 h-11 rounded-xl border border-accent-light bg-accent-lighter shrink-0;
  }

  .oobe-tool-icon {
    @apply w-6 h-6;
  }

  .oobe-tool-monogram {
    @apply font-archivo font-extrabold text-accent-dark text-sm uppercase;
    letter-spacing: 0.08em;
  }

  .oobe-tool-label {
    @apply font-open-sans font-semibold text-text-primary truncate;
  }

  .oobe-tool-purpose {
    @apply font-open-sans text-sm text-text-secondary leading-snug;
    min-width: 220px;
  }

  .oobe-tools-footer {
    @apply flex items-center justify-between gap-4 flex-wrap;
  }

  .oobe-tools-note {
    @apply font-open-sans text-sm text-text-muted;
    max-width: 34rem;
  }

  .oobe-tools-note code {
    @apply font-mono text-xs;
  }

  .oobe-capability-row {
    grid-template-columns: minmax(160px, 1fr) minmax(200px, 1.6fr) auto;
  }

  .oobe-capability-action {
    @apply flex items-center justify-end;
    min-width: 130px;
  }

  .oobe-capability-badge {
    @apply font-open-sans text-sm font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap;
  }

  .oobe-capability-badge.is-ready {
    color: color-mix(
      in srgb,
      var(--color-success) 80%,
      var(--color-text-primary)
    );
    background-color: color-mix(in srgb, var(--color-success) 12%, transparent);
  }

  .oobe-capability-badge.is-waiting {
    @apply text-text-secondary animate-pulse;
    background-color: var(--color-accent-lighter);
  }

  .oobe-capability-button {
    @apply bg-accent hover:bg-accent-dark text-white font-open-sans text-sm font-semibold px-4 py-2 rounded-lg transition-colors duration-200 cursor-pointer whitespace-nowrap;
  }

  .oobe-capability-button:disabled {
    @apply bg-accent-light text-accent-dark cursor-not-allowed;
  }

  .oobe-provision-panel {
    @apply w-full rounded-2xl border border-accent-light bg-surface flex flex-col items-start gap-3 px-4 py-4;
  }

  .oobe-provision-header {
    @apply flex flex-col gap-0.5;
  }

  .oobe-provision-panel code {
    @apply font-mono text-xs;
  }

  .oobe-provision-actions {
    @apply flex items-center gap-3 flex-wrap;
  }

  .oobe-capability-button.is-outline {
    @apply bg-transparent border-2 border-accent text-accent hover:border-accent-dark hover:bg-transparent;
  }

  .oobe-capability-error {
    @apply font-open-sans text-sm rounded-lg px-4 py-3;
    color: color-mix(
      in srgb,
      var(--color-error) 72%,
      var(--color-text-primary)
    );
    background-color: color-mix(in srgb, var(--color-error) 8%, transparent);
    border: 1px solid var(--color-error);
  }

  .oobe-community-header {
    @apply flex flex-col items-center text-center gap-2;
  }

  .oobe-community-title {
    @apply text-4xl font-archivo font-bold text-text-primary;
  }

  .oobe-community-subtitle {
    @apply font-open-sans text-text-secondary max-w-3xl;
  }

  .oobe-marketplace-sources-panel {
    @apply w-full rounded-xl border border-border bg-surface px-4 py-3;
  }

  .oobe-marketplace-sources-panel summary {
    @apply font-open-sans text-sm text-text-secondary cursor-pointer select-none;
  }

  .oobe-marketplace-sources-help {
    @apply mt-3 mb-2 text-sm font-open-sans text-text-muted;
  }

  .oobe-marketplace-sources-help code {
    @apply font-mono text-xs;
  }

  .oobe-marketplace-add-row {
    @apply flex items-center gap-2 w-full mb-3;
  }

  .oobe-marketplace-source-input {
    @apply flex-1 px-3 py-2 rounded-lg border border-accent-light bg-surface text-text-primary font-open-sans text-sm;
  }

  .oobe-marketplace-source-input:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--color-focus-ring);
    border-color: var(--color-accent);
  }

  .oobe-marketplace-add-button,
  .oobe-marketplace-reset-button,
  .oobe-marketplace-remove-button,
  .oobe-marketplace-retry-button {
    @apply px-3 py-2 rounded-lg font-open-sans text-sm font-semibold transition-colors duration-200 cursor-pointer;
  }

  .oobe-marketplace-add-button {
    @apply bg-accent text-white hover:bg-accent-dark border border-accent;
  }

  .oobe-marketplace-reset-button,
  .oobe-marketplace-remove-button {
    @apply bg-accent-lighter text-accent-dark border border-accent-light hover:bg-accent-light;
  }

  .oobe-marketplace-retry-button {
    @apply mt-3 bg-accent text-white hover:bg-accent-dark border border-accent;
  }

  .oobe-marketplace-source-list {
    @apply flex flex-col gap-2;
  }

  .oobe-marketplace-source-item {
    @apply flex items-center justify-between gap-3 rounded-lg border border-accent-light bg-accent-lighter/40 px-3 py-2;
  }

  .oobe-marketplace-source-url {
    @apply text-sm font-open-sans text-text-primary truncate;
  }

  .oobe-community-loading,
  .oobe-community-empty {
    @apply flex flex-col items-center justify-center w-full rounded-xl border border-accent-light bg-surface p-8;
  }

  .oobe-community-toolbar {
    @apply w-full flex items-center gap-3;
  }

  .oobe-community-count {
    @apply text-xs font-open-sans bg-surface border border-accent-light text-text-secondary px-3 py-2 rounded-xl flex items-center justify-center whitespace-nowrap h-full;
  }

  .oobe-community-count-separator {
    @apply mx-2 text-text-muted;
  }

  .oobe-community-search {
    @apply flex-1 px-4 py-2.5 rounded-xl border border-accent-light bg-surface text-text-primary font-open-sans;
  }

  .oobe-community-search:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--color-focus-ring);
    border-color: var(--color-accent);
  }

  .oobe-community-grid {
    @apply w-full grid gap-4 rounded-2xl border border-accent-light bg-surface p-4 overflow-y-auto;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-height: min(50vh, 470px);
  }

  .oobe-addon-card {
    @apply flex flex-col gap-2.5 rounded-xl border border-accent-light bg-accent-lighter/50 p-3 transition-all duration-200;
  }

  .oobe-addon-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.08);
    border-color: var(--color-accent);
  }

  .oobe-addon-card.is-selected {
    background: var(--color-accent-lighter);
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent);
  }

  .oobe-addon-card-header {
    @apply flex items-center gap-3;
  }

  .oobe-addon-image {
    @apply w-11 h-11 rounded-lg object-cover;
  }

  .oobe-addon-meta {
    @apply min-w-0;
  }

  .oobe-addon-title {
    @apply font-archivo text-lg text-text-primary leading-tight;
  }

  .oobe-addon-author {
    @apply font-open-sans text-xs text-text-secondary truncate;
  }

  .oobe-addon-description {
    @apply font-open-sans text-xs text-text-secondary leading-relaxed;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .oobe-addon-footer {
    @apply flex items-end justify-between gap-2 mt-auto;
  }

  .oobe-addon-source-stack {
    @apply min-w-0 flex flex-col gap-0.5;
    max-width: calc(100% - 86px);
  }

  .oobe-addon-marketplace {
    @apply text-[11px] font-open-sans text-accent-dark truncate;
  }

  .oobe-addon-source {
    @apply text-xs font-open-sans text-text-muted truncate;
  }

  .oobe-addon-select {
    @apply px-2.5 py-1.5 rounded-lg border border-accent-light bg-accent-light text-accent-dark font-open-sans text-xs font-semibold transition-colors duration-200 cursor-pointer;
  }

  .oobe-addon-select:hover {
    @apply bg-accent text-white border-accent;
  }

  .oobe-addon-select.selected {
    @apply bg-accent border-accent text-white;
  }

  .oobe-custom-addon-panel {
    @apply w-full rounded-xl border border-border bg-surface px-4 py-3;
  }

  .oobe-custom-addon-panel summary {
    @apply font-open-sans text-sm text-text-secondary cursor-pointer select-none;
  }

  .oobe-community-multi-note {
    @apply w-full -mt-2 text-xs font-open-sans text-text-muted;
  }

  .oobe-custom-addon-help {
    @apply mt-3 mb-2 text-sm font-open-sans text-text-muted;
  }

  .oobe-custom-addon-input {
    @apply w-full h-24 p-3 rounded-lg border border-accent-light bg-surface resize-none font-open-sans text-text-primary;
  }

  .oobe-custom-addon-input:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--color-focus-ring);
    border-color: var(--color-accent);
  }

  @media (max-width: 720px) {
    .oobe-tools-stage {
      @apply px-2 py-8;
    }

    .oobe-tool-row {
      grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.35fr);
      min-width: 0;
    }

    .oobe-capability-row {
      grid-template-columns: 1fr;
    }

    .oobe-capability-action {
      @apply justify-start;
    }

    .oobe-community-toolbar {
      @apply flex-col items-start;
    }

    .oobe-community-count {
      @apply self-end;
    }
  }
</style>
