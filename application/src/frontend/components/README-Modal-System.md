# Composable Modal System

This document describes the new composable modal system that replaces the monolithic `InputScreenManager.svelte` component. The system is built with modularity and reusability in mind, allowing you to compose different modal components together to create custom modal experiences.

## Components Overview

### Base Components

#### `Modal.svelte` - Base Modal Container

The foundation component that provides the overlay and container structure.

**Props:**

- `open: boolean` - Controls modal visibility (default: false)
- `class: string` - Additional CSS classes (optional)
- `size: "small" | "medium" | "large" | "full"` - Modal size (default: "medium")
- `closeOnOverlayClick: boolean` - Whether clicking overlay closes modal (default: true)

**Events:**

- `close` - Emitted when modal should be closed

#### `TitleModal.svelte` - Modal Titles

Displays primary titles in modals.

**Props:**

- `title: string` - The title text
- `class: string` - Additional CSS classes (optional)

#### `HeaderModal.svelte` - Modal Headers/Subtitles

Displays secondary headers or subtitles.

**Props:**

- `header: string` - The header text
- `class: string` - Additional CSS classes (optional)

#### `TextModal.svelte` - Text Content

Displays text with various styling variants.

**Props:**

- `text: string` - The text content
- `variant: "body" | "description" | "caption" | "small"` - Text styling (default: "body")
- `class: string` - Additional CSS classes (optional)

#### `SectionModal.svelte` - Content Sections

Organizes content into scrollable sections.

**Props:**

- `class: string` - Additional CSS classes (optional)
- `scrollable: boolean` - Whether content should be scrollable (default: true)

#### `CloseModal.svelte` - Close Button

Provides a close button with customizable positioning.

**Props:**

- `class: string` - Additional CSS classes (optional)
- `position: "top-right" | "top-left" | "bottom-right" | "bottom-left"` - Button position (default: "top-right")

**Events:**

- `close` - Emitted when close button is clicked

### Input Components

#### `InputModal.svelte` - Universal Input Component

Handles various input types including text, number, select, file, and folder inputs.

**Props:**

- `id: string` - Input identifier (required)
- `label: string` - Input label (required)
- `description: string` - Help text (optional)
- `type: "text" | "password" | "number" | "range" | "select" | "file" | "folder"` - Input type (default: "text")
- `value: string | number` - Input value (optional)
- `options: string[]` - Options for select inputs (optional)
- `min: number` - Minimum value for number/range inputs (optional)
- `max: number` - Maximum value for number/range inputs (optional)
- `maxLength: number` - Maximum text length (optional)
- `minLength: number` - Minimum text length (optional)
- `disabled: boolean` - Whether input is disabled (default: false)
- `class: string` - Additional CSS classes (optional)

**Events:**

- `change` - Emitted when input value changes, provides `{ id, value }`

#### `CheckboxModal.svelte` - Checkbox Input

Specialized component for boolean inputs.

**Props:**

- `id: string` - Input identifier (required)
- `label: string` - Checkbox label (required)
- `description: string` - Help text (optional)
- `checked: boolean` - Checkbox state (default: false)
- `disabled: boolean` - Whether checkbox is disabled (default: false)
- `class: string` - Additional CSS classes (optional)

**Events:**

- `change` - Emitted when checkbox state changes, provides `{ id, checked }`

#### `ButtonModal.svelte` - Action Buttons

Provides styled buttons for modal actions.

**Props:**

- `text: string` - Button text (required)
- `variant: "primary" | "secondary" | "danger" | "success"` - Button style (default: "primary")
- `disabled: boolean` - Whether button is disabled (default: false)
- `class: string` - Additional CSS classes (optional)

**Events:**

- `click` - Emitted when button is clicked

## Usage Examples

### Basic Modal

```svelte
<script>
  import Modal from './Modal.svelte';
  import TitleModal from './TitleModal.svelte';
  import ButtonModal from './ButtonModal.svelte';

  let open = false;
</script>

<Modal {open} on:close={() => (open = false)}>
  <TitleModal title="Confirmation" />
  <p>Are you sure you want to proceed?</p>
  <ButtonModal text="Yes" on:click={() => (open = false)} />
</Modal>
```

### Form Modal

```svelte
<script>
  import Modal from './Modal.svelte';
  import TitleModal from './TitleModal.svelte';
  import SectionModal from './SectionModal.svelte';
  import InputModal from './InputModal.svelte';
  import CheckboxModal from './CheckboxModal.svelte';
  import ButtonModal from './ButtonModal.svelte';

  let open = false;
  let formData = { name: '', email: '', subscribe: false };

  function handleInputChange(event) {
    const { id, value, checked } = event.detail;
    formData[id] = checked !== undefined ? checked : value;
  }
</script>

<Modal {open} on:close={() => (open = false)}>
  <TitleModal title="Contact Form" />

  <SectionModal>
    <InputModal
      id="name"
      label="Full Name"
      value={formData.name}
      on:change={handleInputChange}
    />

    <InputModal
      id="email"
      label="Email"
      type="text"
      value={formData.email}
      on:change={handleInputChange}
    />

    <CheckboxModal
      id="subscribe"
      label="Subscribe to newsletter"
      checked={formData.subscribe}
      on:change={handleInputChange}
    />

    <ButtonModal text="Submit" on:click={() => console.log(formData)} />
  </SectionModal>
</Modal>
```

### Configuration Modal (Replacement for InputScreenManager)

The `ConfigurationModal.svelte` component demonstrates how to use the composable system to recreate the functionality of the original `InputScreenManager.svelte` with better modularity and maintainability.

## Migration from InputScreenManager

The old `InputScreenManager.svelte` has been replaced with `ConfigurationModal.svelte`, which uses the composable modal system internally. The functionality remains the same, but the implementation is now more modular and extensible.

Key improvements:

1. **Modularity**: Each component has a single responsibility
2. **Reusability**: Components can be mixed and matched for different use cases
3. **Maintainability**: Easier to modify and extend individual components
4. **Consistency**: Unified styling and behavior across all modal components
5. **Type Safety**: Better TypeScript support with proper prop types

## Best Practices

1. **Always wrap content in Modal**: Use `Modal.svelte` as the base container
2. **Use CloseModal for consistent UX**: Include close buttons for better user experience
3. **Organize with SectionModal**: Use sections to group related content
4. **Handle events properly**: Listen for `change` events from input components
5. **Provide meaningful labels**: Always include descriptive labels and help text
6. **Use appropriate variants**: Choose the right button and text variants for your use case

## Styling

All components use Tailwind CSS classes and can be customized by:

1. Passing additional classes via the `class` prop
2. Modifying the component's internal styles
3. Overriding CSS variables for consistent theming

The modal system inherits the existing design system and maintains visual consistency with the rest of the application.
