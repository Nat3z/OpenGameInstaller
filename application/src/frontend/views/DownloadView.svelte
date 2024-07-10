<script lang="ts">
  import { currentDownloads } from "../store";

  currentDownloads.subscribe((downloads) => {
    console.log(downloads);
  });

</script>

<div class="downloads">
  {#each $currentDownloads as download}
    <div>
      <img src={download.coverURL} alt="Game"/>
      <h2>{download.name}</h2>
      <p>{download.progress}</p>
      <p>Size: {download.downloadSize}</p>
    </div>
  {/each}
</div>