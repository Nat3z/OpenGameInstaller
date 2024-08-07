<script lang="ts">
  import { onMount } from "svelte";
    import WineIcon from "../Icons/WineIcon.svelte";

  let stage = 0;

  let selectedTorrenter: "qbittorrent" | "real-debrid" | "webtorrent" | "" = "";
  let fulfilledRequirements = false;
  let addons = "";

  export let finishedSetup: () => void;
  
  async function downloadTools(event: MouseEvent) {
    console.log("Downloading tools");
    const button = event.target as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Downloading...";
    const result = await window.electronAPI.oobe.downloadTools()
    if (!result[0]) {
      button.disabled = false;
      button.textContent = "Install";
      return;
    }

    // WARNING: CHANGE IN PROD
    if (!result[1]) {
      stage = 1.5;
      window.electronAPI.fs.write('./config/option/installed.json', JSON.stringify({ restartRequired: true, installed: false }));
    }
    else
      stage = 2;
  }

  function submitTorrenter() {
    if (selectedTorrenter === "real-debrid") {
      console.log("Submitting RD API Key");
      // save a file with the api key
      const apiKey = document.querySelector("input[data-rd-key]") as HTMLInputElement;
      window.electronAPI.fs.mkdir('./config/option/')
      window.electronAPI.fs.write('./config/option/realdebrid.json', JSON.stringify({ debridApiKey: apiKey.value }));

      fulfilledRequirements = true;
    }
    else if (selectedTorrenter === "qbittorrent") {
      console.log("Submitting qBittorrent");
      const ip = document.querySelector("input[data-qb-ip]") as HTMLInputElement;
      const port = document.querySelector("input[data-qb-port]") as HTMLInputElement;
      const username = document.querySelector("input[data-qb-username]") as HTMLInputElement;
      const password = document.querySelector("input[data-qb-pwd]") as HTMLInputElement;

      if (!ip.value || !port.value || !username.value || !password.value) {
        console.error("Missing qBittorrent fields");
        return;
      }

      window.electronAPI.fs.mkdir('./config/option/')
      window.electronAPI.fs.write('./config/option/qbittorrent.json', JSON.stringify({ qbitHost: ip.value, qbitPort: port.value, qbitUsername: username.value, qbitPassword: password.value }));

      fulfilledRequirements = true;
    }
  }

  let downloadLocation = "";

  async function updateDownloadLocation() {
    window.electronAPI.fs.dialog.showOpenDialog({ properties: ["openDirectory"] }).then((result) => {
      if (result) {
        const htmlElement = document.querySelector("input[data-dwloc]")!! as HTMLInputElement;
        htmlElement.value = result; 
        downloadLocation = result;
      }
    });

  }

  function sendDownloadLocation(event: MouseEvent) {

    const htmlElement = document.querySelector("input[data-dwloc]")!! as HTMLInputElement;
    downloadLocation = htmlElement.value;
    if (downloadLocation === "" || !window.electronAPI.fs.exists(downloadLocation)) {
      console.error("No download location selected");
      const button = event.target as HTMLButtonElement;
      button.textContent = "Invalid location";
      button.style.backgroundColor = "#f55045";
      button.disabled = true;
      setTimeout(() => {
        button.textContent = "Continue";
        button.style.backgroundColor = "";
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
    const addonsSplitted = addons.split("\n").filter((addon) => addon !== "");
    let generalConfig = {
      fileDownloadLocation: downloadLocation,
      addons: addonsSplitted,
      torrentClient: selectedTorrenter,
    }
    window.electronAPI.fs.mkdir('./config/option/')
    window.electronAPI.fs.write('./config/option/general.json', JSON.stringify(generalConfig));
    window.electronAPI.fs.write('./config/option/installed.json', JSON.stringify({ installed: true }));
    await window.electronAPI.installAddons(addonsSplitted);
    await window.electronAPI.restartAddonServer();
    completedSetup = true;
  }

  function waitForSetup() {
    stage = 6;
    const waitFor = setInterval(() => {
      if (completedSetup) {
        document.getElementById("oobe")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: "forwards" });
        setTimeout(() => {
          finishedSetup();
        }, 500);
        clearInterval(waitFor);
      }
    }, 200);
  }

  onMount(() => {
    if (window.electronAPI.fs.exists('./config/option/installed.json')) {
      const installed = JSON.parse(window.electronAPI.fs.read('./config/option/installed.json'));
      if (installed.restartRequired) {
        stage = 2;
        new Promise<void>(async (resolve) => {
          window.electronAPI.fs.write('./config/option/installed.json', JSON.stringify({ restartRequired: false, installed: false }));
          resolve();
        });
      }
    }
  });
</script>

<main class="flex items-center flex-col justify-center w-full h-full p-8 bg-white fixed top-0 left-0 z-[5]" id="oobe">
  {#if stage > 0}
    <progress class="animate-fade-in-slow" max="4" value={stage - 1}></progress>
  {/if}

  {#if stage === 0}
    <div class="animate-fade-in-pop flex justify-center items-center flex-col gap-4">
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-4xl font-archivo">Welcome to OpenGameInstaller</h1> 
      <h2 class="animate-in-sub-content font-open-sans">An open-source game installer for your video games!</h2>

      <div class="animate-in-sub-content-slow">
        <button on:click={() => stage = 1} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-bold py-2 px-4 rounded">Get Started</button>
      </div>
    </div>
  {:else if stage === 1}
    <div class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-2">Install Tools</h1>
      <h2 class="font-open-sans mb-6 text-sm">These tools are required for launching and running OpenGameInstaller services.</h2>
      <div class="w-full justify center items-center flex flex-col gap-4 mb-6">
        {#await window.electronAPI.app.getOS()}
          
        {:then result} 
          {#if result === 'win32'} 
            <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
              <div class="flex justify-center items-center w-16">
                <h4 class="font-archivo font-extrabold">7z</h4>
              </div>
              <span class="flex flex-col justify-start items-start">
                <span class="font-open-sans text-sm font-bold">7zip</span>
                <span class="font-open-sans text-xs">Required for unzipping .rar file extensions</span>
              </span>
            </div>    
          {:else if result === 'linux'}
            <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
              <div class="flex justify-center items-center w-16">
                <h4 class="font-archivo font-extrabold">stl</h4>
              </div>
              <span class="flex flex-col justify-start items-start">
                <span class="font-open-sans text-sm font-bold">Steamtinkerlaunch</span>
                <span class="font-open-sans text-xs">Required for adding games to Steam</span>
              </span>
            </div>
            <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
              <div class="p-4 w-16 h-16 flex justify-center items-center">
                <WineIcon />
              </div>
              <span class="flex flex-col justify-start items-start">
                <span class="font-open-sans text-sm font-bold">Wine</span>
                <span class="font-open-sans text-xs">Required for launching games/installer. <strong>MUST BE INSTALLED BY YOURSELF</strong></span>
              </span>
            </div>
          {/if}
        {/await}
        <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-16 h-16" src="./bun.svg" />
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans text-sm font-bold">Bun</span>
            <span class="font-open-sans text-xs">Required for executing addons</span>
          </span>
        </div>    
        <div class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-16 h-16" src="./git.svg" />
          <span class="flex flex-col justify-start items-start">
            <span class="font-open-sans text-sm font-bold">Git</span>
            <span class="font-open-sans text-xs">Required for downloading addons</span>
          </span>
        </div>    
      </div>

      <button on:click={downloadTools} class="bg-accent hover:bg-accent-dark text-white disabled:text-white disabled:bg-yellow-300 font-open-sans font-semibold py-2 px-4 rounded">Install</button>
    </div>
  {:else if stage === 1.5}
    <div class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-2">Restart Required</h1>
      <h2 class="font-open-sans text-sm mb-6">OpenGameInstaller requires a restart to continue the setup process.</h2>
      <button on:click={() => window.electronAPI.app.close()} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Close</button>
    </div>
  {:else if stage === 2}
    <div class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-2">Torrenting</h1>
      <h2 class="font-open-sans text-sm mb-6">How would you like to torrent your files?</h2>
      <div class="flex-row flex gap-4 justify-center items-center">
        <button on:click={() => selectedTorrenter = "qbittorrent"} class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-20 h-20" src="./qbittorrent.svg" />
        </button>
        <button on:click={() => selectedTorrenter = "real-debrid"} class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-20 h-20" src="./rd-logo.png" />
        </button>
        <button on:click={() => selectedTorrenter = "webtorrent"} class="flex justify-start p-2 pl-2 gap-4 items-center flex-row w-8/12 h-14 bg-slate-100 rounded-lg">
          <img class="p-4 w-20 h-20" src="./WebTorrent_logo.png" />
        </button>
      </div>

      <form on:submit|preventDefault={submitTorrenter} class="flex flex-col items-center justify-start w-full">
        {#if selectedTorrenter === "real-debrid"}
          <input data-rd-key type="text" on:change={submitTorrenter} placeholder="Real Debrid API Key" class="w-8/12 p-2 pl-2 bg-slate-100 rounded-lg" />
          <label class="text-left text-sm text-gray-300">Insert your <a href="https://real-debrid.com/apitoken" target="_blank" class="underline">Real Debrid API Key</a></label>
        {:else if selectedTorrenter === "qbittorrent"}
          <!-- TODO: WORK ON OUR OWN TUTORIAL -->
          <a href="https://lgallardo.com/2014/09/29/como-activar-la-interfaz-web-de-qbittorrent/" class="font-open-sans mb-4 text-sm underline" target="_blank">Enable qBittorrent's WebUI so OpenGameInstaller can interact with the client.</a>
          <div class="justify-center items-center flex flex-row gap-2 mb-4">
            <span class="items-center justify-center flex flex-col">
              <input data-qb-ip type="text" on:change={submitTorrenter} placeholder="Host" value="http://127.0.0.1" class="w-72 p-2 pl-2 bg-slate-100 rounded-lg" />
              <label class="text-left text-sm text-gray-300">Hostname</label>
            </span>
            <span class="items-center justify-center flex flex-col">
              <input data-qb-port type="text" on:change={submitTorrenter} placeholder="Port" value="8080" class="w-24 p-2 pl-2 bg-slate-100 rounded-lg" />
              <label class="text-left text-sm text-gray-300">Port</label>
            </span>
          </div>

          <div class="justify-center items-center flex flex-row gap-2 mb-4">
            <span class="items-center justify-center flex flex-col">
              <input data-qb-username type="text" on:change={submitTorrenter} placeholder="Username" value="" class="w-24 p-2 pl-2 bg-slate-100 rounded-lg" />
              <label class="text-left text-sm text-gray-300">Username</label>
            </span>
            <span class="items-center justify-center flex flex-col">
              <input data-qb-pwd type="password" on:change={submitTorrenter} placeholder="Password" value="" class="w-72 p-2 pl-2 bg-slate-100 rounded-lg" />
              <label class="text-left text-sm text-gray-300">Password</label>
            </span>
          </div>
        {:else if selectedTorrenter === "webtorrent"}
          <p>WebTorrent is built into OpenGameInstaller. No configuration is required.</p>
        {/if}
      </form>
      {#if fulfilledRequirements || selectedTorrenter === "webtorrent"}
        <button on:click={() => stage = 3} class="bg-accent animate-fade-in hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Continue</button>
      {/if}
    </div>
  {:else if stage === 3}
    <div class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-2">Download Location</h1>
      <h2 class="font-open-sans text-sm mb-6">Where should we save your games?</h2>
      <div class="flex justify-center items-center flex-row gap-2 w-full">
        <input data-dwloc type="text" class="py-2 w-8/12 pl-2" />
        <button on:click={updateDownloadLocation} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Browse</button>
      </div>

      <button on:click={sendDownloadLocation} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Continue</button>
    </div>
  {:else if stage === 4}
    <div class="animate-fade-in-pop flex justify-start items-center h-full flex-col gap-4 p-10 w-full">
      <h1 class="text-3xl font-archivo font-semibold mt-2">Addons</h1>
      <h2 class="font-open-sans">Kickstart OpenGameInstaller and download some addons!</h2>
      <h2 class="font-open-sans text-sm mb-4 -mt-2 w-8/12 text-center">Insert the Github/Git Repo link of your addons to download them. Split each addon by new line.</h2>
      <textarea on:change={updateAddons} class="w-8/12 h-48 text-xs p-2 pl-2 bg-slate-100 rounded-lg resize-none" placeholder="Addons to download" value="" />
      <button on:click={() => {finishSetup(); stage = 5}} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Continue</button>
    </div>
  {:else if stage === 5}
    <div class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-4 p-10 w-full">
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-3xl font-archivo font-semibold mt-2">You're all set!</h1>
      <h2 class="font-open-sans text-center mb-6">OpenGameInstaller is ready to go! Click below to start downloading your games!</h2>

      <button on:click={waitForSetup} class="bg-accent hover:bg-accent-dark text-white font-open-sans font-semibold py-2 px-4 rounded">Finish</button>
    </div>
  {:else if stage === 6}
    <div class="animate-fade-in-pop flex justify-center items-center h-full flex-col gap-4 p-10 w-full">
      <img src="./favicon.png" alt="OpenGameInstaller Logo" class="w-32 h-32" />
      <h1 class="text-3xl font-archivo font-semibold mt-2">Setting up addons.</h1>
      <h2 class="font-open-sans text-center mb-6">OpenGameInstaller is setting up your addons. Please hold while we do this, it shouldn't take too long!</h2>
    </div>
  {:else}
    <p>Unknown stage</p>
  {/if}
</main>

<style scoped>
  progress {
    @apply fixed top-2 pr-2 pl-2 w-full h-2 [&::-webkit-progress-bar]:rounded-lg [&::-webkit-progress-bar]:bg-accent-light;
  }
  ::-webkit-progress-value {
    transition: width 1s;
    @apply rounded-lg bg-accent
  }
</style>