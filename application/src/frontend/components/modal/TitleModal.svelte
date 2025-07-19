<script lang="ts">
  let {
    title,
    class: className = '',
  }: {
    title: string;
    class?: string;
  } = $props();
</script>

<h1
  class="font-archivo text-2xl font-bold text-accent-dark tracking-tight {className}"
>
  {title}
</h1>
