<script lang="ts">
  import { createNotification } from "../store";

  const fs = window.electronAPI.fs;
  interface OptionsCategory {
    name: string;
    id: string;
    description: string;
    options: {
      [key: string]: {
        displayName: string;
        description: string;
        defaultValue: string | number | boolean;
        choice?: string[];
        value: string | number | boolean;
        type: "string" | "number" | "boolean" | "file-folder" | 'textarea';
        maxTextLength?: number;
        minTextLength?: number;
        max?: number;
        min?: number;
      };
    };
  }
  let options: OptionsCategory[] = [
    {
      name: "General",
      id: "general",
      description: "General Settings",
      options: {
        fileDownloadLocation: {
          displayName: "Download Location",
          description: "The location where files will be downloaded to",
          defaultValue: "./downloads",
          value: "",
          type: "file-folder",
        },
        torrentClient: {
          displayName: "Torrent Client",
          description: "What will do the torrenting for you",
          defaultValue: "webtorrent",
          value: "",
          choice: [ "webtorrent", "qbittorrent", "real-debrid" ],
          type: "string",
        },
        addons: {
          displayName: "Addons",
          description: "The addons you want to use",
          defaultValue: "",
          value: "",
          type: "textarea",
        }
      }
    },
    {
      name: "Real Debrid",
      id: "realdebrid",
      description: "Configure Real Debrid",
      options: {
        debridApiKey: {

          displayName: "Real Debrid API Key",
          description: "Your Real Debrid API Key",
          defaultValue: "",
          value: "",
          type: "string",
        },
      }
    },
    {
      name: "qBittorrent",
      description: "Configure qBittorrent",
      id: "qbittorrent",
      options: {
        qbitHost: {
          displayName: "Host",
          description: "The host of the qBittorrent server",
          defaultValue: "http://127.0.0.1",
          value: "",
          type: "string",
        },
        qbitPort: {
          displayName: "Port",
          description: "The port of the qBittorrent server",
          defaultValue: 8080,
          value: 8080,
          type: "number",
          max: 65535,
          min: 1,
        },
        qbitUsername: {
          displayName: "Username",
          description: "The username of the qBittorrent server",
          defaultValue: "admin",
          value: "",
          type: "string",
        },
        qbitPassword: {
          displayName: "Password",
          description: "The password of the qBittorrent server",
          defaultValue: "admin",
          value: "",
          type: "string",
        },
      }
    },
    {
      "name": "Developer",
      "id": "developer",
      "description": "Developer Settings",
      options: {
        disableSecretCheck: {
          displayName: "Disable Server Secret Check",
          description: "Disables the secret check (WARNING - This is a security risk as anyone can connect to your server)",
          defaultValue: false,
          value: false,
          type: "boolean",
        }
      }
    },
    {
      "name": "About",
      id: "about",
      description: "About the application",
      options: {}
    }
  ];

  let selectedOption: OptionsCategory | null = null;
  
  function selectOption(addon: OptionsCategory) {
    const selected = document.querySelector(".selected");
    if (selected) {
      selected.classList.remove("selected");
    }
    const element = document.getElementById("cfg-" + addon.name);
    if (element) {
      element.classList.add("selected");
      selectedOption = addon;
    }
  }

  function updateConfig() {
    const config: any = {};
    Object.keys(selectedOption!!.options).forEach((key) => {
      if (!selectedOption) return;
      const element = document.getElementById(key) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (element && selectedOption!!.options[key]) {
        if (selectedOption.options[key].type === "string" || selectedOption.options[key].type === "file-folder") {
          config[key] = element.value;
        }
        if (selectedOption.options[key].type === "textarea") {
          if (key === "addons") {
            config[key] = element.value.split("\n");
            if (config[key].length === 1 && config[key][0] === "") {
              config[key] = [];
            }
            else {
              // verify that each line is a link
              try {
                config[key].forEach((line: string) => {
                  if (!line || line.length === 0) return;
                  if (line.startsWith('local:')) {
                    if (!window.electronAPI.fs.exists(line.split('local:')[1])) {
                      createNotification({
                        id: Math.random().toString(36).substring(7),
                        message: "Invalid Local File in Addons",
                        type: "error",
                      });
                      return;
                    }
                  }
                  else {
                    new URL(line);
                  }
                });
              } catch (error) {
                createNotification({
                  id: Math.random().toString(36).substring(7),
                  message: "Invalid URL in Addons",
                  type: "error",
                });
                return;
              }
            }
          }

          else {
            config[key] = element.value;
          }
        }
        if (selectedOption.options[key].type === "number") {
          config[key] = parseInt(element.value);
        }
        if (selectedOption.options[key].type === "boolean" && element instanceof HTMLInputElement) {
          config[key] = element.checked;
        }
      }
    });
    // save this config to local storage
    if (!selectedOption) return; 
    fs.write("./config/option/" + selectedOption.id + ".json", JSON.stringify(config));
  }

  function getStoredOrDefaultValue(key: string) {
    if (!selectedOption) return;
    if (!fs.exists("./config/option/" + selectedOption.id + ".json")) {
      return selectedOption.options[key].defaultValue;
    }
    else {
      const storedConfig = JSON.parse(fs.read("./config/option/" + selectedOption.id + ".json"));
      return storedConfig[key];
    }
  }

  function browseForFolder(event: MouseEvent) {
    const dialog = window.electronAPI.fs.dialog;
    const element = (event.target as HTMLElement).parentElement!!.querySelector("input") as HTMLInputElement;
    dialog.showOpenDialog({ properties: ["openDirectory"] }).then((path) => {
      if (!path) return;
      if (element) {
        element.value = path;
      }
      updateConfig();
    });
  }

  async function installAddons() {
    const buttonsToDisable = document.querySelectorAll("[data-disable]");
    buttonsToDisable.forEach((button) => {
      button.setAttribute("disabled", "true");
    });
    const addons = getStoredOrDefaultValue("addons") as string[];
    if (!addons || addons.length === 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: "No addons to install",
        type: "error",
      });
      return;
    }
    await window.electronAPI.installAddons(addons);
    buttonsToDisable.forEach((button) => {
      button.removeAttribute("disabled");
    });
  }

  async function cleanAddons() {
    const buttonsToDisable = document.querySelectorAll("[data-disable]");
    buttonsToDisable.forEach((button) => {
      button.setAttribute("disabled", "true");
    });
    await window.electronAPI.cleanAddons();
    buttonsToDisable.forEach((button) => {
      button.removeAttribute("disabled");
    });
  }

  async function updateAddons() {
    const buttonsToDisable = document.querySelectorAll("[data-disable]");
    buttonsToDisable.forEach((button) => {
      button.setAttribute("disabled", "true");
    });
    await window.electronAPI.updateAddons();
    buttonsToDisable.forEach((button) => {
      button.removeAttribute("disabled");
    });
  }

  
</script>

<div class="config">
  <div class="w-72 rounded h-full">
    <section class="selected hidden">
    </section>
    {#if options.length !== 0}
      {#each options as addon}
        <section class="hover:bg-slate-100 hover:cursor-pointer" on:keypress={() => {}} on:click={() => selectOption(addon)} id={"cfg-" + addon.name}>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article class="w-full h-full bg-slate-100 p-4 py-2 border-l-2 border-gray-200">
    {#if selectedOption}
      {#if selectedOption.id !== "about"}
        <h2>{selectedOption.name}</h2>
        <p>{selectedOption.description}</p>
      {/if}
      <div class={`options overflow-y-auto h-5/6 ${selectedOption.id === "about" && "!border-t-0"}`}>
        <div class="hidden outline-red-500 outline-4">
        </div>
        {#each Object.keys(selectedOption.options) as key}
          <div class={`flex ${selectedOption.options[key].type === "textarea" ? 'flex-col' : 'flex-row'} gap-2 items-center`}>
            <label for={key}>{selectedOption.options[key].displayName}</label>
            {#if selectedOption.options[key].type === "string"}
              {#if selectedOption.options[key].choice}
                <select id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key)}>
                  {#each selectedOption.options[key].choice as choice}
                    <option value={choice}>{choice}</option>
                  {/each}
                </select>
              {:else}
                <input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedOption.options[key].maxTextLength} minlength={selectedOption.options[key].minTextLength} />
              {/if}
            {/if}
            {#if selectedOption.options[key].type === "file-folder"}
              <div class="flex-col items-center w-full gap-2">
                <input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedOption.options[key].maxTextLength} minlength={selectedOption.options[key].minTextLength} />
                <button class="bg-blue-500 text-white px-2 rounded" on:click={(ev) => browseForFolder(ev)}>Browse</button>
              </div>

            {/if}
            {#if selectedOption.options[key].type === "textarea"}
              <textarea class="w-full h-32 resize-none" id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key).join('\n')}></textarea>
            {/if}
            {#if selectedOption.options[key].type === "number"}
              <input type="number" id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key)} max={selectedOption.options[key].max} min={selectedOption.options[key].min} />
            {/if}
            {#if selectedOption.options[key].type === "boolean"}
              {#if getStoredOrDefaultValue(key)}
                <input type="checkbox" id={key} on:change={updateConfig} checked />
              {:else}
                <input type="checkbox" id={key} on:change={updateConfig} />
              {/if}
            {/if}
            <p data-error-message class="text-red-500"></p>
          </div>
        {/each}

        {#if selectedOption.id === "general"}
          <div class="flex justify-center items-center flex-col gap-2">
            <div class="flex justify-center items-center flex-row gap-2">
              <button class="bg-green-500 disabled:bg-slate-400 text-white p-2 rounded" on:click={() => installAddons()} data-disable>Install All</button>
              <button class="bg-yellow-500 disabled:bg-slate-400 text-white p-2 rounded" on:click={() => updateAddons()} data-disable>Update</button>
              <button class="bg-red-500 disabled:bg-slate-400 text-white p-2 rounded" on:click={() => cleanAddons()} data-disable>Clean All</button>
            </div>

            <div class="flex justify-center items-center flex-row gap-2">
              <button class="bg-red-500 disabled:bg-slate-400 text-white p-2 rounded" on:click={() => window.electronAPI.restartAddonServer()} data-disable>Restart Addon Server</button>
            </div>
          </div>
        {/if}

        {#if selectedOption.id === 'about'}
          <div class="flex-col flex justify-start items-center h-full">
            <img src="./favicon.png" alt="Favicon" class="w-32 h-32" />
            <h1 class="font-archivo font-semibold text-xl">OpenGameInstaller</h1>
            <p class="font-normal">By Nat3z & the OGI Team</p>
            <ul class="flex-row justify-center items-center list-disc">
              <li class="inline">
                <a href="https://github.com/Nat3z/OpenGameInstaller" target="_blank" class="text-blue-500">GitHub</a>
              </li>
              <li class="inline">
                •
                <a href="https://github.com/Nat3z/OpenGameInstaller/blob/main/application/LICENSE" target="_blank" class="text-blue-500">License</a>
              </li>
          </ul>
            <p class="mt-auto absolute bottom-2">v{window.electronAPI.getVersion()}</p>
          </div>
        {/if}
      </div>
    {/if}    
 
  </article>
</div>

<style>
  .selected {
    @apply bg-slate-200;
  }
	.config {
		@apply flex flex-row w-full h-full rounded justify-center items-start;
	}
  section {
    @apply p-2;
  }
  section h2 {
    @apply text-xl;
  }
  section p {
    @apply text-sm text-gray-500; 
  }  
	.options {
    @apply gap-2 flex flex-col w-full py-2 border-t-2 border-gray-200 mt-2 h-5/6 overflow-y-auto;
  }

	article h2 {
		@apply text-xl;
	}

  input[type="text"], input[type="number"], textarea {
    @apply px-1 pl-2 bg-white rounded-lg appearance-none;
  }

  textarea {
    @apply resize-none text-xs py-2;
  }

  input[type=number]::-webkit-inner-spin-button, 
  input[type=number]::-webkit-outer-spin-button { 
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    margin: 0; 
  }

</style>
