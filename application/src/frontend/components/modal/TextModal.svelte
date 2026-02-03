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
    body: 'font-archivo text-base text-text',
    description: 'font-archivo text-xs text-text-muted',
    caption: 'font-archivo text-sm text-text-muted',
    small: 'font-archivo text-xs text-text-muted',
    warning:
      'font-archivo text-sm text-error-text bg-error-bg border border-error-border rounded px-3 py-2 font-semibold mt-2 mb-2',
  };
</script>

<p class="{variantClasses[variant]} {className}">{text}</p>
