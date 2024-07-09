<script lang="ts">
  import { onMount } from "svelte";
  import { safeFetch } from "../utils";

	let addons: any[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });
	const results: any[] = [];
	async function search() {
		const search = document.getElementById("search")!! as HTMLInputElement;
		const query = search.value = search.value.toLowerCase();
		for (const addon of addons) {
			const searchResults = await safeFetch("http://localhost:7654/addons/" + addon.id + "/search?query=" + query)
			results.push(...searchResults);
		}
	}
</script>
<input id="search" on:change={search} placeholder="Search for Game" class="border border-gray-800 px-2 py-1 w-2/3 outline-none"/>
<div class="games">
	{#each results as result}
		<div>
			<img src={result.coverURL} alt="Game" />
			<article>
					<h2>{result.name}</h2>
					<p>{result.description}</p>
					<section>
						<button class="download">Download</button>
					</section>
			</article>
		</div>
	{/each}
</div>

<style>
	.games {
		@apply flex flex-col gap-2 bg-gray-200 w-5/6;
	}
	.games div {
		@apply border border-gray-800 p-2 flex flex-row gap-2;
	}
	.games section {
		@apply flex flex-row gap-2;
	}

	section .download {
		@apply bg-blue-500 text-white p-2 rounded;
	}
	.games div article {
		@apply flex flex-col gap-2;
	}
	article h2 {
		@apply text-xl;
	}
	article p {
		@apply text-sm text-gray-500;
	}

</style>