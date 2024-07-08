<script lang="ts">
  // send a request to localhost:7654/addons?secret={secret} and get the list of addons
  
</script>

<div class="config">
  <div class="w-2/6 border-r-2 border-gray-800 h-full">
    <section>
      <h2>Game Name</h2>
      <p>Lorem ipsum dolor sit amet consectetur adipisicing elit.</p>
    </section>
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