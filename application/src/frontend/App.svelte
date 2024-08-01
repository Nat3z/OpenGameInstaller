<script lang="ts" type="module">
  import { onMount } from "svelte";
  import ConfigView from "./views/ConfigView.svelte";
  import GameInstallView from "./views/GameInstallView.svelte";
  import ClientOptionsView from "./views/ClientOptionsView.svelte";
	import DownloadView from "./views/DownloadView.svelte";
	import DownloadManager from "./components/DownloadManager.svelte";
	import OOBE from './views/OutOfBoxExperience.svelte';

  import { fetchAddonsWithConfigure, getConfigClientOption } from "./utils";
  import Notifications from "./components/Notifications.svelte";
  import { currentStorePageOpened } from "./store";
  import SteamStorePage from "./components/SteamStorePage.svelte";
  import InputScreenManager from "./components/InputScreenManager.svelte";
	type Views = "gameInstall" | "config" | "clientoptions" | "downloader";
	let selectedView: Views = "gameInstall";
	// post config to server for each addon

	let finishedOOBE = true;
	let loading = true;
	onMount(() => {
		loading = true;
		setTimeout(() => {
			fetchAddonsWithConfigure();
			const installedOption = getConfigClientOption('installed') as { installed: boolean };
			if (!installedOption || !installedOption.installed) {
				finishedOOBE = false;
			}
			loading = false;
		}, 100);
	});
	function setView(view: Views) {
		currentStorePageOpened.set(undefined)
		selectedView = view;
	}
</script>

{#if !finishedOOBE}
	<OOBE finishedSetup={() => finishedOOBE = true}/>
{/if}

{#if !loading}
<div class="flex items-center justify-center flex-row h-screen w-screen fixed left-0 top-0">
	<nav class="flex justify-start flex-col items-center h-full w-3/12 border-r-2">
		<div class="flex justify-start items-center flex-col p-2">
			<img src="./favicon.png" alt="logo" class="w-5/12 h-5/12">
		</div>

		<button on:click={() => setView('gameInstall')} data-selected-header={selectedView === "gameInstall"}>
			<img src="./search.svg" alt="Search" />
			<label>Search</label>
		</button>
		<button on:click={() => setView('downloader')} data-selected-header={selectedView === "downloader"}>
			<img src="./download.svg" alt="Downloads" />
			<label>Downloads</label>
		</button>
		<button on:click={() => setView('config')} data-selected-header={selectedView === "config"}>
			<img src="./apps.svg" alt="addon">
			Addons
		</button>
		<button on:click={() => setView('clientoptions')} data-selected-header={selectedView === "clientoptions"}>
			<img src="./settings.svg" alt="Settings" />
			<label>Settings</label>
		</button>
	</nav>
	<main class="flex items-center flex-col gap-4 w-full h-full overflow-y-auto">
		{#if $currentStorePageOpened}
			<SteamStorePage appID={$currentStorePageOpened} />
		{:else}
			{#if selectedView === "config"}
				<ConfigView />
			{:else if selectedView === "gameInstall"}
				<GameInstallView />
			{:else if selectedView === "clientoptions"}
				<ClientOptionsView />
			{:else if selectedView === "downloader"}
				<DownloadView />
			{:else}
				<p>Unknown view</p>
			{/if}
		{/if}
		
		<DownloadManager />
		<Notifications />

	</main>
	<InputScreenManager />
</div>

{/if}
<style global>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;

	header button {
		@apply rounded border border-gray-200 bg-slate-100 px-4 py-2 focus:border focus:bg-slate-200 focus:text-slate-900;
	}
	header button[data-selected-header="true"] {
		@apply border bg-slate-200 text-slate-900 border-gray-300;
	}
	* {
		-webkit-touch-callout: none; /* iOS Safari */
			-webkit-user-select: none; /* Safari */
			-khtml-user-select: none; /* Konqueror HTML */
				-moz-user-select: none; /* Old versions of Firefox */
					-ms-user-select: none; /* Internet Explorer/Edge */
							user-select: none; /* Non-prefixed version, currently
																		supported by Chrome, Edge, Opera and Firefox */
	}

	::-webkit-scrollbar{
		width: 5px;
	}

	::-webkit-scrollbar-thumb{
		background-color: #cbcbcb51;
		@apply rounded-lg bg-opacity-10;
	}

	::-webkit-scrollbar-thumb:hover{
		background-color: #909090;
		@apply rounded-lg bg-opacity-100;
	}

	textarea:focus, input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus {
		@apply outline outline-accent-light;
	}

	button {
		@apply font-open-sans
	}


	nav button {
		/* show the label once the button is hovered */
		@apply w-full h-12 border-none bg-transparent flex flex-row items-center justify-start px-4 gap-1 hover:bg-slate-100;
	}
	nav button[data-selected-header="true"] {
		@apply bg-slate-200;
	}
	nav button img {
		@apply w-6 h-6;
	}
	nav button label {

	}
</style>