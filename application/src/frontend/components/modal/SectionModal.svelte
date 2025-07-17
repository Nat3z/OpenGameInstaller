<script lang="ts">
  let { 
    class: className = "",
    scrollable = true
  }: { 
    class?: string;
    scrollable?: boolean;
  } = $props();

  const baseClasses = "gap-2 flex flex-col w-full p-6 bg-accent-lighter rounded-lg border border-accent-lighter mt-2 max-h-[60vh] space-y-4";
  const scrollClasses = scrollable ? "overflow-y-auto" : "";
</script>

<div class="{baseClasses} {scrollClasses} {className}">
  <slot />
</div> 