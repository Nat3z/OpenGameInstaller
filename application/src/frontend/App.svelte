<script lang="ts">
  import { onMount } from "svelte";
  import ConfigView from "./views/ConfigView.svelte";
  import { safeFetch } from "./utils";
  import GameInstallView from "./views/GameInstallView.svelte";
	type Views = "gameInstall" | "config";
	let selectedView: Views = "gameInstall";

	// post config to server for each addon
	onMount(() => {
		safeFetch("http://localhost:7654/addons").then((data) => {
			data.forEach((addon: any) => {
				const storedConfig = localStorage.getItem(addon.id);
				if (storedConfig) {
					console.log("Posting stored config for addon", addon.id);
					safeFetch("http://localhost:7654/addons/" + addon.id + "/config", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: storedConfig,
						consume: 'text'
					});
				}
			});

		});
	})
</script>

<main class="flex items-center flex-col gap-4 w-full h-full">

	<header class="flex justify-center gap-4 flex-row">
		<button>Settings</button>
		<button on:click={() => selectedView = "gameInstall"}>Game Install</button>
		<button on:click={() => selectedView = "config"}>Manage Addons</button>
	</header>
	{#if selectedView === "config"}
		<ConfigView />
	{:else if selectedView === "gameInstall"}
		<GameInstallView />
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