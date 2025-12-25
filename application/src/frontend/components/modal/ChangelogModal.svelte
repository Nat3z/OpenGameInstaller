<script lang="ts">
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Modal from './Modal.svelte';
  import type { Changelog } from '../../lib/changelog/types';

  let {
    changelog,
    open = $bindable(false),
    onClose,
  }: {
    changelog: Changelog;
    open?: boolean;
    onClose?: () => void;
  } = $props();

  let currentSlideIndex = $state(0);
  let direction = $state<'left' | 'right'>('right');

  const slides = $derived(changelog?.slides ?? []);
  const totalSlides = $derived(slides.length);
  const currentSlide = $derived(slides[currentSlideIndex]);

  function nextSlide() {
    if (currentSlideIndex < totalSlides - 1) {
      direction = 'right';
      currentSlideIndex++;
    }
  }

  function prevSlide() {
    if (currentSlideIndex > 0) {
      direction = 'left';
      currentSlideIndex--;
    }
  }

  function goToSlide(index: number) {
    direction = index > currentSlideIndex ? 'right' : 'left';
    currentSlideIndex = index;
  }

  function handleClose() {
    currentSlideIndex = 0;
    open = false;
    onClose?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') {
      nextSlide();
    } else if (event.key === 'ArrowLeft') {
      prevSlide();
    }
  }

  function openExternalLink(url: string) {
    window.open(url, '_blank');
  }
</script>

<Modal {open} size="large" onClose={handleClose} boundsClose={true}>
  <div
    class="changelog-modal"
    role="dialog"
    tabindex="-1"
    aria-label="Changelog"
    onkeydown={handleKeydown}
  >
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div class="flex flex-col gap-1">
        <h1 class="font-archivo text-2xl font-bold text-accent-dark">
          Version {changelog.version}
        </h1>
        {#if changelog.date}
          <span class="text-sm text-gray-500">{changelog.date}</span>
        {/if}
      </div>
      <button
        class="close-button"
        onclick={handleClose}
        aria-label="Close modal"
      >
        <svg
          fill="currentColor"
          class="w-6 h-6"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
        >
          <path d="M0 0h24v24H0V0z" fill="none" />
          <path
            d="M18.3 5.71c-.39-.39-1.02-.39-1.41 0L12 10.59 7.11 5.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L10.59 12 5.7 16.89c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L12 13.41l4.89 4.89c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"
          />
        </svg>
      </button>
    </div>

    <!-- Slide Content -->
    <div class="slide-container relative min-h-[300px] overflow-hidden">
      {#key currentSlideIndex}
        <div
          class="slide-content absolute inset-0"
          in:fly={{
            x: direction === 'right' ? 100 : -100,
            duration: 300,
            easing: cubicOut,
          }}
          out:fly={{
            x: direction === 'right' ? -100 : 100,
            duration: 300,
            easing: cubicOut,
          }}
        >
          {#if currentSlide}
            <div class="flex flex-col gap-4">
              {#each currentSlide.content as block}
                {#if block.type === 'title'}
                  <h2
                    class="font-archivo text-xl font-semibold text-accent-dark"
                  >
                    {block.text}
                  </h2>
                {:else if block.type === 'description'}
                  <p class="text-gray-700 font-open-sans leading-relaxed">
                    {block.text}
                  </p>
                {:else if block.type === 'image'}
                  <figure class="flex flex-col items-center gap-2">
                    <img
                      src={block.src}
                      alt={block.alt ?? 'Changelog image'}
                      class="rounded-lg shadow-md max-h-48 object-contain"
                    />
                    {#if block.caption}
                      <figcaption class="text-sm text-gray-500 italic">
                        {block.caption}
                      </figcaption>
                    {/if}
                  </figure>
                {:else if block.type === 'bullets'}
                  <ul class="list-disc list-inside space-y-2 text-gray-700">
                    {#each block.items as item}
                      <li class="font-open-sans">{item}</li>
                    {/each}
                  </ul>
                {:else if block.type === 'link'}
                  <button
                    class="inline-flex items-center gap-2 text-accent hover:text-accent-dark transition-colors font-medium underline underline-offset-2"
                    onclick={() => openExternalLink(block.url)}
                  >
                    {block.text}
                    <svg
                      class="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/key}
    </div>

    <!-- Navigation -->
    <div class="flex items-center justify-between mt-8">
      <!-- Previous Button -->
      <button
        class="nav-arrow"
        onclick={prevSlide}
        disabled={currentSlideIndex === 0}
        aria-label="Previous slide"
      >
        <svg
          class="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      <!-- Dot Indicators -->
      <div class="flex items-center gap-2">
        {#each slides as _, index}
          <button
            class="dot-indicator"
            class:active={index === currentSlideIndex}
            onclick={() => goToSlide(index)}
            aria-label="Go to slide {index + 1}"
            aria-current={index === currentSlideIndex ? 'step' : undefined}
          ></button>
        {/each}
      </div>

      <!-- Next Button -->
      <button
        class="nav-arrow"
        onclick={nextSlide}
        disabled={currentSlideIndex === totalSlides - 1}
        aria-label="Next slide"
      >
        <svg
          class="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>
    </div>

    <!-- Slide Counter -->
    <div class="text-center mt-4 text-sm text-gray-500">
      {currentSlideIndex + 1} / {totalSlides}
    </div>
  </div>
</Modal>

<style>
  .changelog-modal {
    @apply w-full;
  }

  .slide-container {
    @apply rounded-xl p-6;
  }

  .slide-content {
    @apply w-full;
  }

  .close-button {
    @apply p-2 border-none rounded-full hover:bg-accent-lighter 
           text-accent hover:text-accent-dark transition-colors
           flex justify-center items-center;
  }

  .nav-arrow {
    @apply p-2 rounded-full bg-accent-lighter text-accent-dark 
           hover:bg-accent-light transition-all duration-200
           disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-accent-lighter;
  }

  .nav-arrow:not(:disabled):hover {
    @apply scale-110;
  }

  .dot-indicator {
    @apply w-3 h-3 rounded-full bg-gray-300 transition-all duration-200
           hover:bg-accent-light;
  }

  .dot-indicator.active {
    @apply bg-accent w-4 scale-110;
  }
</style>
