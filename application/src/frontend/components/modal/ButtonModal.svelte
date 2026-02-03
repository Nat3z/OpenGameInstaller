<script lang="ts">
  let {
    text,
    variant = 'primary',
    disabled = false,
    class: className = '',
    onclick,
  }: {
    text: string;
    variant?: 'primary' | 'secondary' | 'danger' | 'success';
    disabled?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();

  const variantClasses = {
    primary:
      'btn btn-primary bg-accent text-accent-text-color hover:bg-accent-dark focus:ring-accent border-none',
    secondary:
      'btn btn-secondary bg-accent-lighter text-accent-dark hover:bg-accent-light focus:ring-accent border border-accent-light',
    danger:
      'btn btn-danger bg-red-500 text-white hover:bg-red-600 focus:ring-red-400 border-none',
    success:
      'btn btn-success bg-green-500 text-white hover:bg-green-600 focus:ring-green-400 border-none',
  };

  function handleClick(event: MouseEvent) {
    if (!disabled) {
      onclick?.(event);
    }
  }
</script>

<button
  class="font-archivo rounded-lg px-6 py-2.5 text-base font-semibold shadow transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed {variantClasses[
    variant
  ]} {className}"
  onclick={handleClick}
  {disabled}
>
  {text}
</button>
