<script lang="ts">
  import { currentDownloads } from "../store";

  currentDownloads.subscribe((downloads) => {
    console.log(downloads);
  });

</script>

<div class="downloads">
  {#each $currentDownloads as download}
    <div>
      <h2>{download.name}</h2>
      <p>{download.progress}</p>
    </div>
  {/each}
</div>