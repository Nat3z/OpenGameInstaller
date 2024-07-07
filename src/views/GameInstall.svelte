<input placeholder="Search for Game" class="border border-gray-800 px-2 py-1 w-2/3 outline-none"/>
<div class="games">
  <div>
    <img src="https://via.placeholder.com/150" alt="Game Image" />
    <article>
      <h2>Game Name</h2>
      <p>Lorem ipsum dolor sit amet consectetur adipisicing elit. Omnis, amet facilis. Sint esse soluta vitae harum non, natus aperiam adipisci voluptas rerum? Eveniet dolor deleniti tenetur quia a, accusamus ducimus!</p>
      <section>
        <button class="download">Download</button>
      </section>
    </article>
  </div>
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