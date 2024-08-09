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
  import { addonUpdates, currentStorePageOpened, currentStorePageOpenedSource, currentStorePageOpenedStorefront, gameFocused, launchGameTrigger, selectedView, viewOpenedWhenChanged, type Views } from "./store";
  import SteamStorePage from "./components/SteamStorePage.svelte";
  import InputScreenManager from "./components/InputScreenManager.svelte";
	import PlayIcon from './Icons/PlayIcon.svelte';
  import LibraryView from "./views/LibraryView.svelte";
  import GameManager from "./components/GameManager.svelte";
  import CustomStorePage from "./components/CustomStorePage.svelte";
	
	// post config to server for each addon

	let finishedOOBE = true;
	let loading = true;

	let recentlyLaunchedApps: LibraryInfo[] = [];
	onMount(() => {
		loading = true;
		setTimeout(() => {
			fetchAddonsWithConfigure();
			const installedOption = getConfigClientOption('installed') as { installed: boolean };
			if (!installedOption || !installedOption.installed) {
				finishedOOBE = false;
			}
			loading = false;

			// get recently launched apps
			updateRecents();
		}, 100);
	});

	function updateRecents() {
		let exists = window.electronAPI.fs.exists('./internals/apps.json');
		let itemsAdded = 0;
		if (exists) {
			let apps: number[] = JSON.parse(window.electronAPI.fs.read('./internals/apps.json'));
			// then get the app info via the ./library/{appID}.json
			recentlyLaunchedApps = [];
			apps.forEach((appID) => {
				let exists = window.electronAPI.fs.exists(`./library/${appID}.json`);
				if (itemsAdded >= 3) return;
				if (exists) {
					let appInfo: LibraryInfo = JSON.parse(window.electronAPI.fs.read(`./library/${appID}.json`));
					recentlyLaunchedApps.push(appInfo);
					itemsAdded++;
				}
			});
		}
	}

	let heldPageOpened: number | undefined;
	let isStoreOpen = false;
	let iTriggeredIt = false;

	document.addEventListener("addon:update-available", (event) => {
		if (event instanceof CustomEvent) {
			const { detail } = event;
			addonUpdates.update((value) => {
				value.push(detail);
				return value;
			});
		}
	});
	document.addEventListener("addon:updated", (event) => {
		if (event instanceof CustomEvent) {
			const { detail } = event;
			addonUpdates.update((value) => {
				value = value.filter((addon) => addon !== detail);
				return value;
			});
		}
	});
	currentStorePageOpened.subscribe((value) => {
		if (value) {
			heldPageOpened = value;
			isStoreOpen = true;
			if (!$viewOpenedWhenChanged && !iTriggeredIt)
				viewOpenedWhenChanged.set($selectedView);
		}
	});
	let exitPlayPage: () => void;
	function setView(view: Views) {
		iTriggeredIt = true;
		
    if (isStoreOpen && $selectedView === view) {
      // If the store is open and the same tab is clicked again, close the store
      isStoreOpen = false;
      currentStorePageOpened.set(undefined);
			currentStorePageOpenedSource.set(undefined);
      heldPageOpened = undefined;
			viewOpenedWhenChanged.set(undefined);
			console.log("Removing store from view");
    } else if (view === $viewOpenedWhenChanged && heldPageOpened !== undefined) {
      // If switching back to the tab that had the store, reopen the store
      currentStorePageOpened.set(heldPageOpened);
			selectedView.set(view);
      isStoreOpen = true;
			console.log("Switching back to tab that had the store")
    } else {
      // Otherwise, just switch to the new tab
			if ($selectedView === view && view === "library") {
				exitPlayPage();
			} else {
				selectedView.set(view);
				currentStorePageOpened.set(undefined);
				isStoreOpen = false;
				console.log("Otherwise, just switch to the new tab");
			}
    }
		iTriggeredIt = false;
  }
	launchGameTrigger.subscribe(() => {
		setTimeout(() => {
			updateRecents();	
		}, 200);
	});
	function playGame(gameID: number) {
		console.log("Playing game with ID: " + gameID);
    selectedView.set('library');
    viewOpenedWhenChanged.set('library');
    currentStorePageOpened.set(undefined);
		currentStorePageOpenedStorefront.set(undefined);
		gameFocused.set(gameID);
		setTimeout(() => {
			launchGameTrigger.set(gameID);
		}, 5);	
  }
</script>

<Notifications />
{#if !finishedOOBE}
	<OOBE finishedSetup={() => finishedOOBE = true}/>
{/if}

{#if !loading}
<div class="flex items-center justify-center flex-row h-screen w-screen fixed left-0 top-0">
	<nav class="flex justify-start flex-col items-center h-full w-3/12 border-r-2">
		<div class="flex justify-start items-center flex-col p-2">
			<img src="./favicon.png" alt="logo" class="w-5/12 h-5/12">
		</div>

		<button on:click={() => setView('gameInstall')} data-selected-header={$selectedView === "gameInstall"}>
			<img src="./search.svg" alt="Search" />
			<label>Search</label>
		</button>
		<button on:click={() => setView('library')} data-selected-header={$selectedView === "library"}>
			<img src="./library.svg" alt="Library" />
			<label>Library</label>
		</button>
		<button on:click={() => setView('downloader')} data-selected-header={$selectedView === "downloader"}>
			<img src="./download.svg" alt="Downloads" />
			<label>Downloads</label>
		</button>
		<button on:click={() => setView('config')} data-selected-header={$selectedView === "config"}>
			<img src="./apps.svg" alt="addon">
			Addons
		</button>
		<button on:click={() => setView('clientoptions')} data-selected-header={$selectedView === "clientoptions"}>
			<img src="./settings.svg" alt="Settings" />
			<label>Settings</label>
		</button>

		<span class="flex flex-col justify-start items-center w-full p-4">
			{#await window.electronAPI.app.getOS()}
			{:then os}
			{#if os === "win32"}
				{#if recentlyLaunchedApps.length > 0}
					<h1 class="text-left !font-archivo w-full">Recently Played</h1>
						{#each recentlyLaunchedApps as app}
							<div data-recently-item class="flex flex-row justify-start items-center w-full gap-4 p-2 h-22 rounded hover:bg-gray-100 hover:cursor-pointer transition-colors" on:click={() => playGame(app.appID)}>
								<img src={app.capsuleImage} alt="capsule" class="w-12 h-22 rounded" />
								<div class="flex flex-col">
									<h1 class="font-open-sans text-sm">{app.name}</h1>
									<div class="flex flex-row gap-2">
										<PlayIcon width="12px" fill="#d1d5db" /> 

										<p class="font-archivo text-gray-300">Start</p>
									</div>
								</div>
							</div>
						{/each}
					{/if}
				{/if}
			{/await}
		</span>
	</nav>
	<main class="flex items-center flex-col gap-4 w-full h-full overflow-y-auto">
		{#if $currentStorePageOpened}
			{#if $currentStorePageOpenedStorefront === 'steam'}
			<SteamStorePage appID={$currentStorePageOpened} />
			{:else if $currentStorePageOpenedSource && $currentStorePageOpenedStorefront === 'internal'}
				<CustomStorePage appID={$currentStorePageOpened} addonSource={$currentStorePageOpenedSource} />
			{/if}
		{:else}
			{#if $selectedView === "config"}
				<ConfigView />
			{:else if $selectedView === "gameInstall"}
				<GameInstallView />
			{:else if $selectedView === "clientoptions"}
				<ClientOptionsView />
			{:else if $selectedView === "downloader"}
				<DownloadView />
			{:else if $selectedView === "library"}
				<LibraryView bind:exitPlayPage={exitPlayPage} />
			{:else}
				<p>Unknown view</p>
			{/if}
		{/if}
		
		<DownloadManager />

	</main>
	<InputScreenManager />
	<GameManager />
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
		@apply w-6 h-6 pointer-events-none;
	}
	nav button label {
		@apply pointer-events-none;
	}

	[data-recently-item]:hover p {
		@apply text-green-300 transition-colors duration-300;
	}
	[data-recently-item]:hover svg {
		@apply fill-green-300 transition-colors duration-300;
	}
</style>