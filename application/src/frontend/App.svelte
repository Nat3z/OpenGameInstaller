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
</script>

{#if !finishedOOBE}
	<OOBE finishedSetup={() => finishedOOBE = true}/>
{/if}

{#if !loading}
<main class="flex items-center flex-col gap-4 w-full h-full py-2">
	<header class="flex justify-center gap-4 flex-row items-center">
		<button on:click={() => selectedView = "clientoptions"} data-selected-header={selectedView === "clientoptions"} class="mr-auto">Settings</button>
		<button on:click={() => selectedView = "gameInstall"} data-selected-header={selectedView === "gameInstall"}>Game Install</button>
		<button on:click={() => selectedView = "downloader"} data-selected-header={selectedView === "downloader"}>Downloads</button>
		<button on:click={() => selectedView = "config"} data-selected-header={selectedView === "config"} class="ml-auto">Manage Addons</button>
	</header>
	<DownloadManager />
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

	<Notifications />

</main>
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
</style>