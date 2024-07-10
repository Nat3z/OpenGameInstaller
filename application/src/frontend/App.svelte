<script lang="ts" type="module">
  import { onMount } from "svelte";
  import ConfigView from "./views/ConfigView.svelte";
  import GameInstallView from "./views/GameInstallView.svelte";
  import ClientOptionsView from "./views/ClientOptionsView.svelte";
	import DownloadView from "./views/DownloadView.svelte";
	import DownloadManager from "./components/DownloadManager.svelte";

  import { fetchAddonsWithConfigure } from "./utils";
	type Views = "gameInstall" | "config" | "clientoptions" | "downloader";
	let selectedView: Views = "gameInstall";
	// post config to server for each addon
	onMount(() => {
		fetchAddonsWithConfigure();
	});
</script>

<main class="flex items-center flex-col gap-4 w-full h-full">

	<header class="flex justify-center gap-4 flex-row">
		<button on:click={() => selectedView = "clientoptions"}>Settings</button>
		<button on:click={() => selectedView = "gameInstall"}>Game Install</button>
		<button on:click={() => selectedView = "downloader"}>Downloads</button>
		<button on:click={() => selectedView = "config"}>Manage Addons</button>
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

</main>

<style global>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;

	header button {
		@apply rounded border border-gray-800 p-2;
	}
</style>