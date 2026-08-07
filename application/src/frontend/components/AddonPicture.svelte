<script lang="ts">
import { createLogger, LOGGER_PREFIXES } from '@ogi/logger';
import { runFrontendEffect } from '@/frontend/lib/core/runtime';
import { electronRpc } from '@/frontend/lib/electron-rpc';

const logger = createLogger(LOGGER_PREFIXES.frontend);

let { addonId, class: className }: { addonId: string; class?: string } =
  $props();
let image = $state<string | undefined>(undefined);

$effect(() => {
  // Reset image when addonId changes
  image = undefined;

  logger.sync.info('Getting addon icon for: ' + addonId);
  runFrontendEffect(electronRpc.app.getAddonIcon(addonId)).then(
    async (iconPath) => {
      if (iconPath) {
        image =
          (await runFrontendEffect(electronRpc.app.getLocalImage(iconPath))) ??
          undefined;
      }
    }
  );
});
</script>

<div class={className}>
  {#if image}
    <img
      src={image}
      alt="Addon Icon"
      class="w-full h-full object-cover {className}"
    />
  {:else}
    <div
      class="{className} bg-accent-light flex items-center rounded-lg justify-center text-accent-dark uppercase"
      style="font-size: max(1.4vw, 1.4vh, 1.4em, 1.4rem); font-weight: 400;"
    >
      {addonId.slice(0, 2)}
    </div>
  {/if}
</div>
