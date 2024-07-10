<script lang="ts" type="module">
  import { onMount } from "svelte";
  import ConfigView from "./views/ConfigView.svelte";
  import GameInstallView from "./views/GameInstallView.svelte";
  import ClientOptionsView from "./views/ClientOptionsView.svelte";
  import { fetchAddonsWithConfigure } from "./utils";
	type Views = "gameInstall" | "config" | "clientoptions";
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
		<button on:click={() => selectedView = "config"}>Manage Addons</button>
	</header>
	{#if selectedView === "config"}
		<ConfigView />
	{:else if selectedView === "gameInstall"}
		<GameInstallView />
	{:else if selectedView === "clientoptions"}
		<ClientOptionsView />
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