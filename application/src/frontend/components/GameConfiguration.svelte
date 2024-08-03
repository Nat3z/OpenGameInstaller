<script lang="ts">
  import type { LibraryInfo } from "ogi-addon";
  import { ConfigurationBuilder, type BooleanOption, type ConfigurationFile, type ConfigurationOption, type NumberOption, type StringOption } from "ogi-addon/config";
  import { createNotification } from "../store";

  export let exitPlayPage: () => void;
  function isStringOption(option: ConfigurationOption): option is StringOption {
    return option.type === 'string';
  }

  function isNumberOption(option: ConfigurationOption): option is NumberOption {
    return option.type === 'number';
  }

  function isBooleanOption(option: ConfigurationOption): option is BooleanOption {
    return option.type === 'boolean';
  }
  export let gameInfo: LibraryInfo;

  let screenRendering: ConfigurationFile = new ConfigurationBuilder()
    .addStringOption(option => option
      .setDisplayName("Game Path")
      .setName("cwd")
      .setDescription("The path to the game executable")
      .setInputType("folder")
      .setDefaultValue(gameInfo.cwd ?? "C:\\Program Files\\Game")
    )
    .addStringOption(option => option
      .setDisplayName("Game Executable")
      .setName("launchExecutable")
      .setDescription("The game executable path")
      .setInputType("file")
      .setDefaultValue(gameInfo.launchExecutable ?? "game.exe")
    )
    .addStringOption(option => option
      .setDisplayName("Game Arguments")
      .setName("launchArguments")
      .setDescription("The arguments to pass to the game executable")
      .setInputType("text")
      .setDefaultValue(gameInfo.launchArguments ?? "")
    )
    .build(false);

  let screenName = gameInfo.name;
  let screenDescription = "Define the game configuration";
  export let onFinish: (data: { [key: string]: any } | undefined) => void;
  
  function updateInputNum(event: Event) {
    const element = event.target as HTMLInputElement;
    if (element.type === "range") {
      element.parentElement!!.querySelector("p")!!.textContent = element.value;
    }
  }

  function pushChanges() {
    const inputs = document.querySelectorAll("[data-input]");
    const data: { [key: string]: any } = {};
    inputs.forEach((input) => {
      const element = input as HTMLInputElement | HTMLSelectElement;
      data[element.id] = element.type === "checkbox" ? element.checked : element.value;
    });

    onFinish(data);
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

  async function removeFromList() {
    await window.electronAPI.app.removeApp(gameInfo.steamAppID);
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Game removed from library. (Not deleted from disk)',
      type: 'success'
    });
    exitPlayPage();
  }
</script>

<div class="w-full h-full fixed bg-slate-900/50 flex justify-center items-center top-0 left-0 z-10">
  <!-- close button at top right-->
  <article class="w-3/6 h-5/6 bg-slate-100 p-4 py-2 border-gray-200 animate-fade-in-pop rounded-lg relative">
    <button class="absolute top-4 right-4 text-white hover:bg-slate-200 px-2 py-2 border-none rounded-lg" on:click={() => onFinish(undefined)}>
      <img src="./close.svg" alt="close" class="pointer-events-none" />
    </button>
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
                  <button class="bg-blue-500 text-white px-2 rounded" on:click={(ev) => browseForFolder(ev, 'folder')}>Browse</button>
                {:else}
                  <button class="bg-blue-500 text-white px-2 rounded" on:click={(ev) => browseForFolder(ev, 'file')}>Browse</button>
                {/if}
              {/if}
            {/if}
            {#if isNumberOption(screenRendering[key])}
              <input data-input type={screenRendering[key].inputType} id={key} on:input={(event) => updateInputNum(event)} value={screenRendering[key].defaultValue ?? screenRendering[key].min} max={isNumberOption(screenRendering[key]) ? screenRendering[key].max : 0} min={isNumberOption(screenRendering[key]) ? screenRendering[key].min : 0} />
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
      <div class="flex flex-row justify-start items-center gap-2">
        <button on:click={pushChanges} class="px-4 py-1 rounded w-fit border-none bg-blue-300 mt-4">Save</button>
        <button on:click={removeFromList} class="px-4 py-1 rounded w-fit border-none bg-red-300 mt-4">Remove</button>
      </div>
    </div>

  </article>
</div>


<style>
  article h1 {
    @apply text-2xl font-bold;
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