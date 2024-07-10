<script lang="ts" type="module">
  import { onMount } from "svelte";
  import { safeFetch } from "../utils";
  import type { BooleanOption, ConfigurationFile, ConfigurationOption, NumberOption, StringOption } from "ogi-addon/build/config/ConfigurationBuilder";
  import type { OGIAddonConfiguration } from "ogi-addon";

  function isStringOption(option: ConfigurationOption): option is StringOption {
      return option.type === 'string';
    }

  function isNumberOption(option: ConfigurationOption): option is NumberOption {
    return option.type === 'number';
  }

  function isBooleanOption(option: ConfigurationOption): option is BooleanOption {
    return option.type === 'boolean';
  }
  let addons: ConfigTemplateAndInfo[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });
  interface ConfigTemplateAndInfo extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile
  }
  let selectedAddon: ConfigTemplateAndInfo | null = null;
  
  function selectAddon(addon: ConfigTemplateAndInfo) {
    const selected = document.querySelector(".selected");
    if (selected) {
      selected.classList.remove("selected");
    }
    const element = document.getElementById("cfg-" + addon.id);
    if (element) {
      element.classList.add("selected");
      selectedAddon = addon;
    }
  }

  function updateConfig() {
    if (!selectedAddon) return;
    let config: Record<string, string | number | boolean> = {};
    Object.keys(selectedAddon.configTemplate).forEach((key) => {
    if (!selectedAddon) return;
      const element = document.getElementById(key) as HTMLInputElement;
      if (element) {
        if (selectedAddon.configTemplate[key].type === "string") {
          config[key] = element.value;
        }
        if (selectedAddon.configTemplate[key].type === "number") {
          config[key] = parseInt(element.value);
        }
        if (selectedAddon.configTemplate[key].type === "boolean") {
          config[key] = element.checked;
        }
      }
    });
    document.querySelectorAll("[data-error-message]").forEach((element) => {
      element.textContent = "";
      element.parentElement!!.querySelector("input")!!.classList.remove("outline-red-500");
      element.parentElement!!.querySelector("input")!!.classList.remove("outline-4");
      element.parentElement!!.querySelector("input")!!.classList.remove("outline");
    }); 
    safeFetch("http://localhost:7654/addons/" + selectedAddon.id + "/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }).then((data) => {
      if (!data.success) {
        console.error(data);
        const element = document.getElementById(data.error.keyErrored)
        if (!element) return console.error("element not found");
        element.classList.add("outline-red-500");
        element.classList.add("outline-4");
        element.classList.add("outline");
        element.parentElement!!.querySelector("p")!!.textContent = data.error.error;
      }
    });
    // save this config to local storage
    localStorage.setItem("addon-" + selectedAddon.id, JSON.stringify(config));
  }

  function getStoredOrDefaultValue(key: string) {
    if (!selectedAddon) return;
    const storedConfig = localStorage.getItem("addon-" + selectedAddon.id);
    if (storedConfig) {
      return JSON.parse(storedConfig)[key];
    }
    return selectedAddon.configTemplate[key].defaultValue;
  }
  
</script>

<div class="config">
  <div class="w-2/6 border-r-2 border-gray-800 h-full">
    <section class="selected hidden">
    </section>
    {#if addons.length !== 0}
      {#each addons as addon}
        <section class="" on:keypress={() => {}} on:click={() => selectAddon(addon)} id={"cfg-" + addon.id}>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article>
    {#if selectedAddon}
      <h2>{selectedAddon.name}</h2>
      <p>{selectedAddon.description}</p>
      <div class="options">
        <div class="hidden outline-red-500 outline-4">
        </div>
        {#each Object.keys(selectedAddon.configTemplate) as key}
          <div class="flex flex-row gap-2 items-center">
            <label for={key}>{selectedAddon.configTemplate[key].displayName}</label>
            {#if isStringOption(selectedAddon.configTemplate[key])}
              <input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedAddon.configTemplate[key].maxTextLength} minlength={selectedAddon.configTemplate[key].minTextLength} />
            {/if}
            {#if isNumberOption(selectedAddon.configTemplate[key])}
              <input type="number" id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key)} max={isNumberOption(selectedAddon.configTemplate[key]) ? selectedAddon.configTemplate[key].max : 0} min={isNumberOption(selectedAddon.configTemplate[key]) ? selectedAddon.configTemplate[key].min : 0} />
            {/if}
            {#if isBooleanOption(selectedAddon.configTemplate[key])}
              {#if getStoredOrDefaultValue(key)}
                <input type="checkbox" id={key} on:change={updateConfig} checked />
              {:else}
                <input type="checkbox" id={key} on:change={updateConfig} />
              {/if}
            {/if}
            <p data-error-message class="text-red-500"></p>
          </div>
        {/each}
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