<script>
  import GameInstall from "./views/GameInstall.svelte";

</script>

<main class="flex justify-center items-center flex-col gap-4">

	<header class="flex justify-center gap-4 flex-row">
		<button>Settings</button>
		<button>Manage Addons</button>
	</header>
	<GameInstall />
</main>

<style global>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;

	header button {
		@apply rounded border border-gray-800 p-2;
	}
</style>