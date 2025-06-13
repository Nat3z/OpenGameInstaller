<script lang="ts">
  import { type BooleanOption, type ConfigurationFile, type ConfigurationOption, type NumberOption, type StringOption } from "ogi-addon/config";
  import { writable, type Writable } from "svelte/store";
  function isStringOption(option: ConfigurationOption): option is StringOption {
    return option.type === 'string';
  }

  function isNumberOption(option: ConfigurationOption): option is NumberOption {
    return option.type === 'number';
  }

  function isBooleanOption(option: ConfigurationOption): option is BooleanOption {
    return option.type === 'boolean';
  }
  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  let screenRendering: ConfigurationFile | undefined = $state(undefined) 

  let screenID: string | undefined;
  let screenName: string | undefined = $state(undefined);
  let screenDescription: string | undefined = $state(undefined);
  let listOfScreensQueued: Writable<{ config: ConfigurationFile, id: string, name: string, description: string }[]> = writable([]);
  document.addEventListener('input-asked', (e) => {
    if (!isCustomEvent(e)) return;
    const { detail } = e;
    const { config, id, name, description }: { config: ConfigurationFile, id: string, name: string, description: string } = detail;
    listOfScreensQueued.update((screens) => screens.concat({ config, id, name, description }));
  });
  
  function updateInputNum(event: Event) {
    const element = event.target as HTMLInputElement;
    if (element.type === "range") {
      element.parentElement!!.querySelector("p")!!.textContent = element.value;
    }
  }

  listOfScreensQueued.subscribe((screens) => {
    if (screens.length === 0) return;
    if (screenRendering) return;
    const screen = screens[0];
    screenRendering = screen.config;
    screenID = screen.id;
    screenName = screen.name;
    screenDescription = screen.description;
    listOfScreensQueued.update((screens) => screens.slice(1));
  });

  function pushChanges() {
    const inputs = document.querySelectorAll("[data-input]");
    const data: { [key: string]: any } = {};
    inputs.forEach((input) => {
      const element = input as HTMLInputElement | HTMLSelectElement;
      data[element.id] = element.type === "checkbox" ? element.checked : element.value;
    });
    window.electronAPI.app.inputSend(screenID!!, data);
    console.log(data);
    // delete the screen
    screenRendering = undefined;
    screenID = undefined;

    if ($listOfScreensQueued.length !== 0) {
      listOfScreensQueued.update((screens) => {
        if (screens.length === 0) return [];
        const screen = screens[0];
        screenRendering = screen.config;
        screenID = screen.id;
        screenName = screen.name;
        screenDescription = screen.description;
        return screens.slice(1);
      });
    }
  }

  function browseForFolder(event: MouseEvent, type: 'file' | 'folder') {
    const dialog = window.electronAPI.fs.dialog;
    const element = (event.target as HTMLElement).parentElement!!.querySelector("input") as HTMLInputElement;
    dialog.showOpenDialog({ properties: type === 'folder' ? [ 'openDirectory' ] : [ 'openFile' ]}).then((path) => {
      if (!path) return;
      if (element) {
        element.value = path;
      }
    });
  }
</script>

{#if screenRendering}
<div class="w-full h-full fixed bg-slate-900/50 flex justify-center items-center z-20">
  <article class="w-3/6 h-5/6 bg-slate-100 p-4 py-2 border-gray-200 animate-fade-in-pop rounded-lg">
    <h1>{screenName}</h1>
    <h2>{screenDescription}</h2>
    <div class="options">
      <div class="hidden outline-red-500 outline-4">
      </div>
      {#each Object.keys(screenRendering) as key}
        <div class="flex flex-col items-start justify-center relative">
          <div class="flex flex-row gap-2 items-center relative">
            <label for={key}>{screenRendering[key].displayName}</label>
            {#if isStringOption(screenRendering[key])}
              {#if screenRendering[key].allowedValues.length !== 0}
                <select data-input id={key} value={screenRendering[key].defaultValue || screenRendering[key].allowedValues[0]}>
                  {#each screenRendering[key].allowedValues as value}
                    <option value={value}>{value}</option>
                  {/each}
                </select>
              {:else if screenRendering[key].inputType === "text" || screenRendering[key].inputType === "password"}
                <input data-input type={screenRendering[key].inputType} value={screenRendering[key].defaultValue ?? ''} id={key} maxlength={screenRendering[key].maxTextLength} minlength={screenRendering[key].minTextLength} />
              {:else if screenRendering[key].inputType === "file" || screenRendering[key].inputType === "folder"}
                <input type="text" data-input value={screenRendering[key].defaultValue ?? ''} id={key} />
                {#if screenRendering[key].inputType === "folder"}
                  <button class="bg-blue-500 text-white px-2 rounded" onclick={(ev) => browseForFolder(ev, 'folder')}>Browse</button>
                {:else}
                  <button class="bg-blue-500 text-white px-2 rounded" onclick={(ev) => browseForFolder(ev, 'file')}>Browse</button>
                {/if}
              {/if}
            {/if}
            {#if isNumberOption(screenRendering[key])}
              <input data-input type={screenRendering[key].inputType} id={key} oninput={(event) => updateInputNum(event)} value={screenRendering[key].defaultValue ?? screenRendering[key].min} max={isNumberOption(screenRendering[key]) ? screenRendering[key].max : 0} min={isNumberOption(screenRendering[key]) ? screenRendering[key].min : 0} />
              {#if screenRendering[key].inputType === "range"}
                <p>{screenRendering[key].defaultValue ?? screenRendering[key].min}</p>
              {/if}
            {/if}
            {#if isBooleanOption(screenRendering[key])}
              {#if screenRendering[key].defaultValue}
                <input data-input type="checkbox" id={key} class="top-[2px] relative" checked />
              {:else}
                <input data-input type="checkbox" id={key} class="top-[2px] relative" />
              {/if}
            {/if}
  
          </div>
          <h2 class="block text-xs text-gray-300">{screenRendering[key].description}</h2>
        </div>
      {/each}
      <button onclick={pushChanges} class="px-4 py-1 rounded w-fit bg-blue-300 mt-4">Submit</button>
    </div>

  </article>
</div>
{/if}


<style>
  article h1 {
    @apply text-2xl font-bold;
  }
  artcile h2 {
    @apply text-lg font-semibold;
  }
	.options {
    @apply gap-2 flex flex-col w-full py-2 border-t-2 border-gray-200 mt-2 h-5/6 overflow-y-auto;
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