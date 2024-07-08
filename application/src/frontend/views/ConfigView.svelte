<script lang="ts">
  import type { OGIAddonConfiguration } from "ogi-addon";
  import type { ConfigurationFile } from "ogi-addon/lib/ConfigurationBuilder";
  import { onMount } from "svelte";
  import { safeFetch } from "../utils";
  interface AddonsData extends OGIAddonConfiguration {
    configTemplate: ConfigurationFile;
  }
  let addons: AddonsData[] = [];
  onMount(() => {
    safeFetch("http://localhost:7654/addons").then((data) => {
      addons = data;
    });
  });
  
</script>

<div class="config">
  <div class="w-2/6 border-r-2 border-gray-800 h-full">
    {#if addons.length !== 0}
      {#each addons as addon}
        <section>
          <h2>{addon.name}</h2>
          <p>{addon.description}</p>
        </section>
      {/each}
    {/if}
  </div>

  <article>
    
 
  </article>
</div>

<style>
	.config {
		@apply flex flex-row gap-2 bg-gray-300 w-5/6 h-5/6 border-gray-800 rounded;
	}
  section {
    @apply p-2;
  }
  section h2 {
    @apply text-xl;
  }
  section p {
    @apply text-sm text-gray-500; 
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