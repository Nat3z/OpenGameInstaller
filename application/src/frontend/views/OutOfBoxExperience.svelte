<script lang="ts">
  import { preventDefault } from 'svelte/legacy';

  import { onMount } from 'svelte';
  // @ts-ignore
  import WineIcon from '../Icons/WineIcon.svelte';
  import { createNotification } from '../store';

  let stage = $state(0);

  let selectedTorrenter: 'qbittorrent' | 'real-debrid' | 'webtorrent' | '' =
    $state('');
  let fulfilledRequirements = $state(false);
  let addons = '';
  let selectedAddons = $state<string[]>([
    'https://github.com/Nat3z/steam-integration',
  ]);

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

  async function downloadTools(event: MouseEvent) {
    console.log('Downloading tools');
    const button = event.target as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Downloading...';
    const result = await window.electronAPI.oobe.downloadTools();
    if (!result[0]) {
      button.disabled = false;
      button.textContent = 'Install';
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
        JSON.stringify({ debridApiKey: apiKey.value })
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

  function updateAddons(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    addons = textarea.value;
  }
  let completedSetup = false;
  async function finishSetup() {
    const customAddons = addons
      .split('\n')
      .filter((addon) => addon.trim() !== '');
    const allAddons = [...new Set([...selectedAddons, ...customAddons])];

    let generalConfig = {
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

  onMount(async () => {
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
</script>

<main
  class="flex items-center flex-col justify-center w-full h-full p-8 bg-background-color fixed top-0 left-0 z-[5]"
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
      <h1 class="text-4xl font-archivo font-semibold text-gray-900">
        Welcome to OpenGameInstaller
      </h1>
      <h2
        class="animate-in-sub-content font-open-sans text-lg text-gray-600 text-center max-w-md"
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
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Install Tools
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
        These tools are required for launching and running OpenGameInstaller
        services.
      </h2>
      <div class="w-full justify center items-center flex flex-col gap-4 mb-6">
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
                <span class="font-open-sans font-semibold text-gray-900"
                  >7zip</span
                >
                <span class="font-open-sans text-sm text-gray-600"
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
                <span class="font-open-sans font-semibold text-gray-900"
                  >Steamtinkerlaunch</span
                >
                <span class="font-open-sans text-sm text-gray-600"
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
                <span class="font-open-sans font-semibold text-gray-900"
                  >Wine</span
                >
                <span class="font-open-sans text-sm text-gray-600"
                  >Required for launching games/installer. <strong
                    class="text-red-600">MUST BE INSTALLED BY YOURSELF</strong
                  ></span
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
            <span class="font-open-sans font-semibold text-gray-900">Bun</span>
            <span class="font-open-sans text-sm text-gray-600"
              >Required for executing addons</span
            >
          </span>
        </div>
        <div
          class="flex justify-start p-4 gap-4 items-center flex-row w-full max-w-2xl h-20 bg-accent-lighter rounded-lg"
        >
          <img class="w-12 h-12" src="./git.svg" alt="Git" />
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans font-semibold text-gray-900">Git</span>
            <span class="font-open-sans text-sm text-gray-600"
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
    </div>
  {:else if stage === 1.5}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full"
    >
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Restart Required
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
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
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Torrenting
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
        How would you like to torrent your files?
      </h2>
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <div class="flex-row flex gap-6 justify-center items-center">
        <button
          onclick={() => (selectedTorrenter = 'qbittorrent')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'qbittorrent'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./qbittorrent.svg" alt="qBittorrent" />
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
          onclick={() => (selectedTorrenter = 'webtorrent')}
          class="flex justify-center p-4 items-center w-24 h-24 bg-accent-lighter hover:bg-accent-light rounded-lg border-2 transition-colors duration-200 {selectedTorrenter ===
          'webtorrent'
            ? 'border-accent'
            : 'border-accent-light'}"
        >
          <img class="w-16 h-16" src="./WebTorrent_logo.png" alt="WebTorrent" />
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
            class="w-full p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="text-sm text-gray-500 mt-2"
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
            class="font-open-sans mb-4 text-sm underline text-accent hover:text-accent-dark"
            target="_blank"
            >Enable qBittorrent's WebUI so OpenGameInstaller can interact with
            the client. Click here for a guide on how to enable it.</a
          >
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
                class="w-full p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-gray-500 mt-1">Hostname</label>
            </span>
            <span class="items-center justify-center flex flex-col w-24">
              <input
                data-qb-port
                type="text"
                onchange={submitTorrenter}
                placeholder="Port"
                value="8080"
                class="w-full p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-gray-500 mt-1">Port</label>
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
                class="w-full p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-gray-500 mt-1">Username</label>
            </span>
            <span class="items-center justify-center flex flex-col flex-1">
              <input
                data-qb-pwd
                type="password"
                onchange={submitTorrenter}
                placeholder="Password"
                value=""
                class="w-full p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <label class="text-sm text-gray-500 mt-1">Password</label>
            </span>
          </div>
        {:else if selectedTorrenter === 'webtorrent'}
          <p class="text-gray-600 text-center">
            WebTorrent is built into OpenGameInstaller. No configuration is
            required.
          </p>
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
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Download Location
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
        Where should we save your games?
      </h2>
      <div class="flex justify-center items-center flex-row gap-4 w-full">
        <input
          data-dwloc
          type="text"
          class="flex-1 p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
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
    <div
      class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-6 p-10 w-full max-w-4xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Addons
      </h1>
      <h2 class="font-open-sans text-gray-900">
        Kickstart OpenGameInstaller and download some addons!
      </h2>
      <h2 class="font-open-sans text-gray-600 text-center -mt-2">
        Select from our community addons, or add your own below.
      </h2>
      <div
        class="w-full max-w-3xl h-64 overflow-y-auto border border-accent-light rounded-lg p-4 bg-white"
      >
        {#if communityList}
          {#await communityList}
            <div class="flex items-center justify-center h-full">
              <p class="text-gray-600">Loading community addons...</p>
            </div>
          {:then list}
            <div class="flex flex-col gap-3">
              {#each list as addon}
                <div
                  class="flex flex-row gap-4 items-center p-3 rounded-lg hover:bg-accent-lighter transition-colors duration-200 border border-transparent hover:border-accent-light"
                >
                  <img
                    src={addon.img}
                    alt={addon.name}
                    class="w-12 h-12 rounded-lg object-cover"
                  />
                  <div class="flex flex-col flex-1">
                    <h3 class="font-open-sans font-semibold text-gray-900">
                      {addon.name}
                    </h3>
                    <p class="text-sm text-gray-600">{addon.description}</p>
                  </div>
                  <button
                    onclick={() => toggleAddon(addon)}
                    class="px-4 py-2 rounded-lg font-open-sans font-medium transition-colors duration-200 border-none {selectedAddons.includes(
                      addon.source
                    )
                      ? 'bg-accent hover:bg-accent-dark text-white'
                      : 'bg-accent-light hover:bg-accent text-accent-dark hover:text-white'}"
                  >
                    {selectedAddons.includes(addon.source)
                      ? 'Selected'
                      : 'Select'}
                  </button>
                </div>
              {/each}
            </div>
          {/await}
        {/if}
      </div>
      <h2 class="font-open-sans text-gray-600 text-center max-w-2xl">
        Insert the Github/Git Repo link of your addons to download them. Split
        each addon by new line.
      </h2>
      <textarea
        onchange={updateAddons}
        class="w-full max-w-3xl h-24 p-3 bg-white border border-accent-light rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-accent"
        placeholder="https://github.com/user/my-custom-addon"
        value=""
      ></textarea>
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
  {:else if stage === 5 && window}
    <div
      class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-6 p-10 w-full max-w-2xl"
    >
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        SteamGridDB
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
        To automate downloading images for the games you install on Steam, we
        need to use SteamGridDB.
      </h2>
      <h2 class="font-open-sans text-gray-600 text-center mb-6">
        <a
          href="https://www.steamgriddb.com/profile/preferences/api"
          target="_blank"
          class="underline text-accent hover:text-accent-dark"
          >Insert your SteamGridDB API Key below. If you don't have one, you can
          get one by going here</a
        >.
      </h2>
      <div class="flex justify-center items-center flex-row gap-4 w-full">
        <input
          data-sgdb-key
          type="text"
          class="flex-1 p-3 bg-white border border-accent-light rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder="SteamGridDB API Key"
        />
      </div>
      <div
        class="flex justify-center items-center flex-row gap-4 w-full max-w-2xl"
      >
        <button
          onclick={async () => {
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
              return;
            }

            finishSetup();
            stage = 6;
          }}
          class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
          >Set Key and Continue</button
        >
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
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        You're all set!
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6 max-w-md">
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
      <h1 class="text-3xl font-archivo font-semibold text-gray-900 mt-2">
        Setting up addons.
      </h1>
      <h2 class="font-open-sans text-gray-600 text-center mb-6 max-w-md">
        OpenGameInstaller is setting up your addons. Please hold while we do
        this, it shouldn't take too long!
      </h2>
    </div>
  {:else}
    <p>Unknown stage</p>
  {/if}
</main>

<style scoped>
  progress {
    @apply fixed top-4 left-0 h-2 w-full [&::-webkit-progress-bar]:rounded-lg [&::-webkit-progress-bar]:bg-accent-light px-4;
  }
  ::-webkit-progress-value {
    transition: width 1s;
    @apply rounded-lg bg-accent;
  }
</style>
