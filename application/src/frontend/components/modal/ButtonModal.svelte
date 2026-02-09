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
      'btn btn-primary bg-accent focus:ring-accent border-none',
    secondary:
      'btn btn-secondary bg-accent-lighter text-accent-dark hover:bg-accent-light focus:ring-accent border border-accent-light',
    danger:
      'btn btn-danger border-none',
    success:
      'btn btn-success border-none',
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
  style={variant === 'danger' 
    ? `background-color: var(--theme-error); color: var(--theme-overlay-text);` 
    : variant === 'success'
    ? `background-color: var(--theme-success); color: var(--theme-overlay-text);`
    : variant === 'primary'
    ? `color: var(--theme-overlay-text);`
    : ''}
  onmouseenter={(e) => {
    if (!disabled && (variant === 'danger' || variant === 'success')) {
      e.currentTarget.style.backgroundColor = variant === 'danger' 
        ? 'var(--theme-error-hover)' 
        : 'var(--theme-success-hover)';
    }
  }}
  onmouseleave={(e) => {
    if (variant === 'danger' || variant === 'success') {
      e.currentTarget.style.backgroundColor = variant === 'danger' 
        ? 'var(--theme-error)' 
        : 'var(--theme-success)';
    }
  }}
  onclick={handleClick}
  {disabled}
>
  {text}
</button>

<style>
  .btn-primary {
    color: var(--color-overlay-text);
  }

  .btn-danger {
    background-color: var(--color-error);
    color: var(--color-overlay-text);
  }

  .btn-danger:hover:not(:disabled),
  .btn-danger:focus-visible {
    background-color: var(--color-error-hover);
  }

  .btn-success {
    background-color: var(--color-success);
    color: var(--color-overlay-text);
  }

  .btn-success:hover:not(:disabled),
  .btn-success:focus-visible {
    background-color: var(--color-success-hover);
  }
</style>
