<script lang="ts" type="module">
  import { onMount } from "svelte";
  import { safeFetch } from "../utils";
  import type { BooleanOption, ConfigurationFile, ConfigurationOption, NumberOption, StringOption } from "ogi-addon/config";
  import type { OGIAddonConfiguration } from "ogi-addon";
  import { notifications } from "../store";
  const fs = window.electronAPI.fs;

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
    setTimeout(() => {
      updateConfig();
    }, 100);
  }

  function updateConfig() {
    if (!selectedAddon) return;
    let config: Record<string, string | number | boolean> = {};
    Object.keys(selectedAddon.configTemplate).forEach((key) => {
    if (!selectedAddon) return;
      const element = document.getElementById(key) as HTMLInputElement | HTMLSelectElement;
      if (element) {
        if (selectedAddon.configTemplate[key].type === "string") {
          config[key] = element.value;
        }
        if (selectedAddon.configTemplate[key].type === "number") {
          config[key] = parseInt(element.value);
        }
        if (selectedAddon.configTemplate[key].type === "boolean" && element.type === "checkbox") {
          config[key] = element.checked;
        }
      }
    });
    document.querySelectorAll("[data-error-message]").forEach((element) => {
      element.textContent = "";
      element.parentElement!!.querySelector("[data-input]")!!.classList.remove("outline-red-500");
      element.parentElement!!.querySelector("[data-input]")!!.classList.remove("outline-2");
      element.parentElement!!.querySelector("[data-input]")!!.classList.remove("outline");
    }); 
    safeFetch("http://localhost:7654/addons/" + selectedAddon.id + "/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }).then((data) => {
      if (!data.success) {
        for (const key in data.errors) {
          const element = document.getElementById(key);
          if (!element) return console.error("element not found");
          element.classList.add("outline-red-500");
          element.classList.add("outline-2");
          element.classList.add("outline");
          element.parentElement!!.querySelector("p")!!.innerHTML = `
            <img src="./error.svg" alt="error" class="w-6 h-6" />
          `;
          
          element.parentElement!!.querySelector("p")!!.setAttribute("data-context", data.errors[key]);
        }
        notifications.update((update) => [
            ...update,
            {
              id: Math.random().toString(36).substring(7),
              type: "error",
              message: "Failed to validate configuration. Configuration will not be usable.",
            },
          ]);
      }
    });
    // save this config to local storage
    fs.write("./config/" + selectedAddon!!.id + ".json", JSON.stringify(config));
  }

  function getStoredOrDefaultValue(key: string) {
    if (!selectedAddon) return;
    if (!fs.exists("./config/" + selectedAddon.id + ".json")) {
      return selectedAddon.configTemplate[key].defaultValue;
    }
    else {
      const storedConfig = JSON.parse(fs.read("./config/" + selectedAddon.id + ".json"));
      return storedConfig[key];
    }
  }

  function showDescription(event: MouseEvent | FocusEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector("[data-description]")!! as HTMLDivElement;
    contextual.style.display = "flex";
    contextual.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
  }

  function hideDescription(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector("[data-description]")!! as HTMLDivElement;
    contextual.style.display = "flex";
    contextual.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
    setTimeout(() => {
      contextual.style.display = "none";
    }, 200);
  }
  function showContextHint(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const context = element.getAttribute("data-context");
    if (!context) return;
    const contextual = element.parentElement!!.querySelector("[data-contextual]")!! as HTMLDivElement;
    contextual.style.display = "flex";
    
    const hint = contextual.querySelector("p")!!;
    hint.textContent = context;
    contextual.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
  }

  function hideContextHint(event: MouseEvent) {
    const element = event.target as HTMLElement;
    const contextual = element.parentElement!!.querySelector("[data-contextual]")!! as HTMLDivElement;
    contextual.style.display = "flex";
    contextual.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
    setTimeout(() => {
      contextual.style.display = "none";
    }, 200);
  }
  
  function updateInputNum(event: Event) {
    const element = event.target as HTMLInputElement;
    if (element.type === "range") {
      element.parentElement!!.querySelector("p")!!.textContent = element.value;
    }
  }
</script>


<div class="config">
  <div class="w-72 h-full gap-2 flex flex-col">
    <section class="selected hidden">
    </section>
    {#if addons.length !== 0}
      {#each addons as addon}
        <section class="hover:bg-slate-100 hover:cursor-pointer" on:keypress={() => {}} on:click={() => selectAddon(addon)} id={"cfg-" + addon.id}>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article class="w-full h-full bg-slate-100 p-4 py-2 border-l-2 border-gray-200">
    {#if selectedAddon}
      <h2>{selectedAddon.name}</h2>
      <p>{selectedAddon.description}</p>
      <div class="options">
        <div class="hidden outline-red-500 outline-4">
        </div>
        {#each Object.keys(selectedAddon.configTemplate) as key}
          <div class="flex flex-row gap-2 items-center relative">
            <label for={key} on:mouseover={showDescription} on:focus={showDescription} on:mouseleave={hideDescription}>{selectedAddon.configTemplate[key].displayName}</label>
            {#if isStringOption(selectedAddon.configTemplate[key])}
              {#if selectedAddon.configTemplate[key].allowedValues.length !== 0}
                <select data-input id={key} on:change={updateConfig} value={getStoredOrDefaultValue(key)}>
                  {#each selectedAddon.configTemplate[key].allowedValues as value}
                    <option value={value}>{value}</option>
                  {/each}
                </select>
              {:else}
                <input data-input type="text" on:change={updateConfig} value={getStoredOrDefaultValue(key)} id={key} maxlength={selectedAddon.configTemplate[key].maxTextLength} minlength={selectedAddon.configTemplate[key].minTextLength} />
              {/if}
            {/if}
            {#if isNumberOption(selectedAddon.configTemplate[key])}
              <input data-input type={selectedAddon.configTemplate[key].inputType} id={key} on:input={(event) => updateInputNum(event)} on:change={updateConfig} value={getStoredOrDefaultValue(key)} max={isNumberOption(selectedAddon.configTemplate[key]) ? selectedAddon.configTemplate[key].max : 0} min={isNumberOption(selectedAddon.configTemplate[key]) ? selectedAddon.configTemplate[key].min : 0} />
              {#if selectedAddon.configTemplate[key].inputType === "range"}
                <p>{getStoredOrDefaultValue(key)}</p>
              {/if}
            {/if}
            {#if isBooleanOption(selectedAddon.configTemplate[key])}
              {#if getStoredOrDefaultValue(key)}
                <input data-input type="checkbox" id={key} on:change={updateConfig} class="top-[2px] relative" checked />
              {:else}
                <input data-input type="checkbox" id={key} on:change={updateConfig} class="top-[2px] relative" />
              {/if}
            {/if}
            <p data-error-message class="text-red-500" data-context="" on:mouseenter={showContextHint} on:mouseleave={hideContextHint}>
            </p>

            <div data-contextual style="display: none" class="absolute flex flex-row gap-2 justify-start items-center z-20 top-8 border border-gray-200 left-0 bg-slate-100 text-sm p-2 rounded-md shadow-lg w-full">
              <img src="./error.svg" alt="error" class="w-4 h-4" />
              <p class=""></p>
            </div>
            <div data-description style="display: none" class="absolute flex flex-row gap-2 justify-start items-center z-20 top-8 border border-gray-200 left-0 bg-slate-100 text-sm p-2 rounded-md shadow-lg w-full">
              <img src="./info.svg" alt="error" class="w-4 h-4" />
              <p class="">{selectedAddon.configTemplate[key].description}</p>
            </div>
          </div>
        {/each}
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

  input[type="text"], input[type="number"] {
    @apply px-1 pl-2 bg-white rounded-lg appearance-none;
  }

  input[type=number]::-webkit-inner-spin-button, 
  input[type=number]::-webkit-outer-spin-button { 
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    margin: 0; 
  }

</style>