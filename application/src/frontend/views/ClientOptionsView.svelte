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
      const element = document.getElementById(key) as HTMLInputElement;
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
        if (selectedOption.options[key].type === "boolean") {
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

  function installAddons() {
    const addons = getStoredOrDefaultValue("addons") as string[];
    if (!addons || addons.length === 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: "No addons to install",
        type: "error",
      });
      return;
    }
    window.electronAPI.installAddons(addons);
  }

  
</script>

<div class="config">
  <div class="w-2/6 border-r-2 border-gray-800 h-full">
    <section class="selected hidden">
    </section>
    {#if options.length !== 0}
      {#each options as addon}
        <section class="" on:keypress={() => {}} on:click={() => selectOption(addon)} id={"cfg-" + addon.name}>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article>
    {#if selectedOption}
      <h2>{selectedOption.name}</h2>
      <p>{selectedOption.description}</p>
      <div class="options">
        <div class="hidden outline-red-500 outline-4">
        </div>
        {#each Object.keys(selectedOption.options) as key}
          <div class={`flex ${selectedOption.options[key].type === "textarea" ? 'flex-col' : 'flex-row'} gap-2 items-center`}>
            <label for={key}>{selectedOption.options[key].displayName}</label>
            {#if selectedOption.options[key].type === "string"}
              <input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedOption.options[key].maxTextLength} minlength={selectedOption.options[key].minTextLength} />
            {/if}
            {#if  selectedOption.options[key].type === "file-folder"}
              <input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedOption.options[key].maxTextLength} minlength={selectedOption.options[key].minTextLength} />
              <button class="bg-blue-500 text-white p-2 rounded" on:click={(ev) => browseForFolder(ev)}>Browse</button>
            {/if}
            {#if selectedOption.options[key].type === "textarea"}
              <textarea class="w-full h-32" id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key)}></textarea>
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
          <div class="flex justify-center items-center flex-row gap-2">
            <button class="bg-green-500 text-white p-2 rounded" on:click={() => installAddons()}>Install Addons</button>
            <button class="bg-red-500 text-white p-2 rounded">Clean Addons</button>
          </div>
        {/if}
      </div>
    {/if}    
 
  </article>
</div>

<style>
  .selected {
    @apply bg-gray-400;
  }
	.config {
		@apply flex flex-row gap-2 bg-gray-300 w-5/6 h-5/6 border-gray-800 rounded;
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
	section .download {
		@apply bg-blue-500 text-white p-2 rounded;
	}
	.options {
    @apply gap-2 flex flex-col border-t-2 border-gray-800 p-2;
  }

	article h2 {
		@apply text-xl;
	}

</style>