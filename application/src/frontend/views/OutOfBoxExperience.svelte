<script lang="ts">
  import { preventDefault } from 'svelte/legacy';
  import { fade } from 'svelte/transition';

  import { onMount, onDestroy } from 'svelte';
  // @ts-ignore
  import WineIcon from '../Icons/WineIcon.svelte';
  import { createNotification, oobeLog } from '../store';

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
  let selectedAddons = $state<string[]>([
    'https://github.com/Nat3z/steam-integration',
  ]);
  let isSettingKey = $state(false);
  let logContainer: HTMLDivElement | null = $state(null);
  let previousLogLength = $state(0);

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

  type CommunityAddon = {
    name: string;
    author: string;
    source: string;
    img: string;
    description: string;
  };

  let communityList: Promise<CommunityAddon[]> | null = $state(null);
  let { finishedSetup }: Props = $props();

  async function downloadTools() {
    console.log('Downloading tools');
    // Activate OOBE logging
    oobeLog.update((currentLog) => ({
      ...currentLog,
      isActive: true,
      logs: [],
    }));

    const result = await window.electronAPI.oobe.downloadTools();
    if (!result[0]) {
      oobeLog.update((currentLog) => ({
        ...currentLog,
        isActive: false,
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
    } else stage = 2;
  }

  function submitTorrenter() {
    if (selectedTorrenter === 'real-debrid') {
      console.log('Submitting RD API Key');
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
      console.log('Submitting qBittorrent');
      const ip = document.querySelector(
        'input[data-qb-ip]'
      ) as HTMLInputElement;
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
        console.error('Missing qBittorrent fields');
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
      console.log('Submitting TorBox API Key');
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
      console.log('Submitting Premiumize API Key');
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
      console.log('Submitting AllDebrid API Key');
      const apiKey = document.querySelector(
        'input[data-alldebrid-key]'
      ) as HTMLInputElement | null;
      if (!apiKey) {
        console.error('Missing AllDebrid API key input');
        return;
      }
      const key = apiKey.value.trim();
      if (!key) {
        console.error('Missing AllDebrid API key');
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
    window.electronAPI.fs.dialog
      .showOpenDialog({ properties: ['openDirectory'] })
      .then((result) => {
        if (result) {
          const htmlElement = document.querySelector(
            'input[data-dwloc]'
          )!! as HTMLInputElement;
          htmlElement.value = result;
          downloadLocation = result;
        }
      });
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
      console.error('No download location selected');
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

  let completedSetup = false;
  async function finishSetup() {
    const customAddons = addons
      .split('\n')
      .map((addon) => addon.trim())
      .filter((addon) => addon !== '');
    const allAddons = [...new Set([...selectedAddons, ...customAddons])];

    let generalConfig = {
      theme: 'light',
      fileDownloadLocation: downloadLocation,
      addons: allAddons,
      torrentClient: selectedTorrenter,
    };
    window.electronAPI.fs.mkdir('./config/option/');
    window.electronAPI.fs.write(
      './config/option/general.json',
      JSON.stringify(generalConfig)
    );
    window.electronAPI.fs.write(
      './config/option/installed.json',
      JSON.stringify({ installed: true })
    );
    await window.electronAPI.installAddons(allAddons);
    completedSetup = true;
  }

  function waitForSetup() {
    stage = 7;
    const waitFor = setInterval(() => {
      if (completedSetup) {
        document
          .getElementById('oobe')
          ?.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 500,
            fill: 'forwards',
          });
        setTimeout(() => {
          finishedSetup();
        }, 500);
        clearInterval(waitFor);
      }
    }, 200);
  }

  function toggleAddon(addon: CommunityAddon) {
    const index = selectedAddons.indexOf(addon.source);
    if (index > -1) {
      selectedAddons.splice(index, 1);
    } else {
      selectedAddons.push(addon.source);
    }
  }

  function getFilteredAddons(list: CommunityAddon[]) {
    const query = addonSearch.trim().toLowerCase();
    if (!query) return list;

    return list.filter((addon) => {
      const content =
        `${addon.name} ${addon.author} ${addon.description}`.toLowerCase();
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
      isActive: true,
    }));
  }

  onMount(async () => {
    // Set up OOBE log listener
    document.addEventListener('oobe:log', handleOOBELog);

    // Initialize previous log length
    previousLogLength = $oobeLog.logs.length;

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
    communityList = fetch('https://ogi.nat3z.com/api/community.json').then(
      (response) => response.json()
    );
  });

  onDestroy(() => {
    // Clean up event listener
    document.removeEventListener('oobe:log', handleOOBELog);
  });
</script>

<main
  class="flex items-center flex-col justify-center w-full h-full p-8 bg-background-color fixed top-0 left-0 z-5"
  id="oobe"
>
  {#if stage > 0}
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
          onclick={() => (stage = 1)}
          class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Get Started</button
        >
      </div>
    </div>
  {:else if stage === 1}
    <div
      class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-6 p-10 w-full max-w-4xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-text-primary mt-2">
        Install Tools
      </h1>
      <h2 class="font-open-sans text-text-secondary text-center mb-6">
        These tools are required for launching and running OpenGameInstaller
        services.
      </h2>
      {#if !$oobeLog.isActive}
        <div
          class="w-full justify center items-center flex flex-col gap-4 mb-6"
        >
          {#await window.electronAPI.app.getOS() then result}
            {#if result === 'win32'}
              <div
                class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
              >
                <div class="flex justify-center items-center w-16">
                  <h4
                    class="font-archivo font-extrabold text-accent-dark text-xl"
                  >
                    7z
                  </h4>
                </div>
                <span class="flex flex-col justify-start items-start">
                  <span class="font-open-sans font-semibold text-text-primary"
                    >7zip</span
                  >
                  <span class="font-open-sans text-sm text-text-secondary"
                    >Required for unzipping .rar file extensions</span
                  >
                </span>
              </div>
            {:else if result === 'linux'}
              <div
                class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
              >
                <div class="flex justify-center items-center w-16">
                  <h4
                    class="font-archivo font-extrabold text-accent-dark text-lg"
                  >
                    stl
                  </h4>
                </div>
                <span class="flex flex-col justify-start items-start">
                  <span class="font-open-sans font-semibold text-text-primary"
                    >Steamtinkerlaunch</span
                  >
                  <span class="font-open-sans text-sm text-text-secondary"
                    >Required for adding games to Steam</span
                  >
                </span>
              </div>
              <div
                class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
              >
                <div class="p-2 w-16 h-16 flex justify-center items-center">
                  <WineIcon />
                </div>
                <span class="flex flex-col justify-start items-start">
                  <span class="font-open-sans font-semibold text-text-primary"
                    >Wine</span
                  >
                  <span class="font-open-sans text-sm text-text-secondary"
                    >Required for launching games/installer.</span
                  >
                </span>
              </div>
            {/if}
          {/await}
          <div
            class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
          >
            <img class="w-12 h-12" src="./bun.svg" alt="Bun" />
            <span class="flex flex-col justify-start items-start">
              <span class="font-open-sans font-semibold text-text-primary"
                >Bun</span
              >
              <span class="font-open-sans text-sm text-text-secondary"
                >Required for executing addons</span
              >
            </span>
          </div>
          <div
            class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
          >
            <img class="w-12 h-12" src="./git.svg" alt="Git" />
            <span class="flex flex-col justify-start items-start">
              <span class="font-open-sans font-semibold text-text-primary"
                >Git</span
              >
              <span class="font-open-sans text-sm text-text-secondary"
                >Required for downloading addons</span
              >
            </span>
          </div>
        </div>
        <button
          onclick={downloadTools}
          class="bg-accent hover:bg-accent-dark text-white disabled:text-white disabled:bg-yellow-500 font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Install</button
        >
      {/if}

      <!-- OOBE Terminal Log Display -->
      {#if $oobeLog.isActive && $oobeLog.logs.length > 0}
        <div class="oobe-terminal w-full max-w-3xl mt-6 h-64">
          <div class="terminal-header">
            <div class="flex items-center gap-2">
              <span class="text-xs text-text-muted font-mono"
                >Installation Console</span
              >
            </div>
          </div>

          <div bind:this={logContainer} class="terminal-content">
            {#each $oobeLog.logs as log, index}
              <div
                class="terminal-line"
                in:fade={{ duration: 150, delay: index * 20 }}
              >
                <span class="text-green-400 font-mono text-sm leading-relaxed">
                  {log}
                </span>
              </div>
            {/each}
            <div class="terminal-cursor">
              <span class="text-green-400 font-mono text-sm animate-pulse"
                >▋</span
              >
            </div>
          </div>
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
        onclick={() => window.electronAPI.app.close()}
        class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
        >Close</button
      >
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
          Pick your core addons from the community list to jump straight into
          discovery.
        </p>
      </div>

      {#if communityList}
        {#await communityList}
          <div class="oobe-community-loading">
            <p class="text-text-secondary">Loading community addons...</p>
          </div>
        {:then list}
          {@const selectedCount = list.filter((addon) =>
            selectedAddons.includes(addon.source)
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
              <span>{list.length} total</span>
            </p>
          </div>

          {#if getFilteredAddons(list).length === 0}
            <div class="oobe-community-empty">
              <p class="text-text-secondary">No addons match your search.</p>
            </div>
          {:else}
            <div class="oobe-community-grid">
              {#each getFilteredAddons(list) as addon}
                <article
                  class="oobe-addon-card {selectedAddons.includes(addon.source)
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
                    <p class="oobe-addon-source" title={addon.source}>
                      {addon.source}
                    </p>
                    <button
                      onclick={() => toggleAddon(addon)}
                      class="oobe-addon-select {selectedAddons.includes(
                        addon.source
                      )
                        ? 'selected'
                        : ''}"
                    >
                      {selectedAddons.includes(addon.source)
                        ? 'Selected'
                        : 'Select'}
                    </button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        {/await}
      {/if}

      <details class="oobe-custom-addon-panel">
        <summary>Add a custom addon repo (optional)</summary>
        <p class="oobe-custom-addon-help">
          Paste one GitHub/Git repository URL per line.
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
          const os = await window.electronAPI.app.getOS();
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
            const result = await window.electronAPI.oobe.setSteamGridDBKey(
              (
                document.querySelector('[data-sgdb-key]') as HTMLInputElement
              ).value.trim()
            );

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
    @apply rounded-lg overflow-hidden border;
    background-color: var(--color-bg-secondary);
    border-color: var(--color-border);
  }

  .terminal-header {
    @apply px-4 py-2 border-b;
    background-color: var(--color-surface);
    border-color: var(--color-border);
  }

  .terminal-content {
    @apply p-4 max-h-48 overflow-y-auto;
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

  .terminal-cursor {
    @apply mt-2;
  }

  .oobe-community-stage {
    @apply flex justify-start items-center h-full flex-col gap-4 p-6 w-full max-w-6xl;
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

  .oobe-community-loading,
  .oobe-community-empty {
    @apply flex items-center justify-center w-full rounded-xl border border-accent-light bg-surface p-8;
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

  .oobe-addon-source {
    @apply text-xs font-open-sans text-text-muted truncate;
    max-width: calc(100% - 86px);
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
    .oobe-community-toolbar {
      @apply flex-col items-start;
    }

    .oobe-community-count {
      @apply self-end;
    }
  }
</style>
