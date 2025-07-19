<script lang="ts">
  let {
    text,
    variant = 'body',
    class: className = '',
  }: {
    text: string;
    variant?: 'body' | 'description' | 'caption' | 'small' | 'warning';
    class?: string;
  } = $props();

  const variantClasses = {
    body: 'font-archivo text-base text-gray-700',
    description: 'font-archivo text-xs text-gray-500',
    caption: 'font-archivo text-sm text-gray-600',
    small: 'font-archivo text-xs text-gray-400',
    warning:
      'font-archivo text-sm text-red-600 bg-red-50 rounded px-3 py-2 font-semibold mt-2 mb-2',
  };
</script>

<p class="{variantClasses[variant]} {className}">{text}</p>
