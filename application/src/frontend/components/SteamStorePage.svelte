<script lang="ts">
  // fetch the Steam store page
  import { onMount } from 'svelte';
  export let appID: number;
  type GameRequirements = {
    minimum: string;
    recommended: string;
  };

  type PackageGroup = {
    name: string;
    title: string;
    description: string;
    selection_text: string;
    save_text: string;
    display_type: number;
    is_recurring_subscription: string;
    subs: {
      packageid: number;
      percent_savings_text: string;
      percent_savings: number;
      option_text: string;
      option_description: string;
      can_get_free_license: string;
      is_free_license: boolean;
      price_in_cents_with_discount: number;
    }[];
  };

  type Category = {
    id: number;
    description: string;
  };

  type Genre = {
    id: string;
    description: string;
  };

  type Screenshot = {
    id: number;
    path_thumbnail: string;
    path_full: string;
  };

  type PlatformSupport = {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };

  type PriceOverview = {
    currency: string;
    initial: number;
    final: number;
    discount_percent: number;
    initial_formatted: string;
    final_formatted: string;
  };

  type Metacritic = {
    score: number;
    url: string;
  };

  type GameData = {
    type: string;
    name: string;
    steam_appid: number;
    required_age: number;
    is_free: boolean;
    controller_support: string;
    dlc: number[];
    detailed_description: string;
    about_the_game: string;
    short_description: string;
    supported_languages: string;
    reviews: string;
    header_image: string;
    capsule_image: string;
    capsule_imagev5: string;
    website: string;
    pc_requirements: GameRequirements;
    mac_requirements: GameRequirements;
    linux_requirements: GameRequirements[];
    legal_notice: string;
    developers: string[];
    publishers: string[];
    price_overview: PriceOverview;
    packages: number[];
    package_groups: PackageGroup[];
    platforms: PlatformSupport;
    metacritic: Metacritic;
    categories: Category[];
    recommendations: {
      total: number;
    };
    genres: Genre[];
    screenshots: Screenshot[];
    release_date: {
      coming_soon: boolean;
      date: string;
    };
  };

  let gameData: GameData;
  let loading = true;
  onMount(async () => {
    const response = await window.electronAPI.app.axios({
      method: 'get',
      url: 'https://store.steampowered.com/api/appdetails?appids=' + appID,
    });
    if (!response.data[appID].success) {
      console.error('Failed to fetch Steam store page');
      return;
    }
    gameData = response.data[appID].data;
    loading = false;

  });
</script>

<main class="fixed flex w-full h-full z-10 top-0 left-0 bg-white">
  {#if loading}
    <p>Loading...</p>
  {:else}
    <div class="flex justify-start flex-col p-4 gap-2 w-full overflow-y-auto h-full">
      <div class="flex flex-col object-cover relative gap-2">
        <div class="flex flex-col p-4 bg-slate-100 gap-2">
        <img src={gameData.header_image} alt={gameData.name} class="relative w-full rounded object-cover z-0" />
          <h1 class="text-3xl font-archivo font-medium">{gameData.name}</h1>
          <h2 class="text-sm">
            <p class="text-gray-500 inline">Developer:</p> {gameData.developers.join(', ')}
            <span class="mx-2"></span>
            <p class="text-gray-500 inline">Publisher:</p> {gameData.publishers.join(', ')}
            <span class="block"></span>
            <p class="text-gray-500 inline">Release Date:</p> {gameData.release_date.date}
          </h2>
          <p class="text-sm text-black">{gameData.short_description}</p>
        </div>
      </div>
      <article id="g-descript">{@html gameData.detailed_description}</article>

    </div>
    <div class="flex justify-start p-4 bg-slate-100 h-full w-3/6">
      
    </div>
  {/if}
</main>

<style global>
  #g-descript {
    @apply p-4 bg-slate-100 rounded flex flex-col gap-2; 
  }

  #g-descript img {
    @apply w-full rounded;
  }
  #g-descript p {
    @apply text-sm text-black;
  }
  #g-descript h1 {
    @apply text-2xl font-archivo font-medium;
  }
  #g-descript h2 {
    @apply text-sm;
  }
  #g-descript strong {
    @apply font-bold text-gray-900;
  }
</style>
