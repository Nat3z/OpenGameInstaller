<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./modal/Modal.svelte";
  import CloseModal from "./modal/CloseModal.svelte";
  import TitleModal from "./modal/TitleModal.svelte";
  import TextModal from "./modal/TextModal.svelte";
  import SectionModal from "./modal/SectionModal.svelte";
  import ButtonModal from "./modal/ButtonModal.svelte";
  import { createNotification } from "../store";
  import CheckboxModal from "./modal/CheckboxModal.svelte";
  import type { ConfigurationFile } from "ogi-addon/config";
  import HeaderModal from "./modal/HeaderModal.svelte";

  let showDebugModal = $state(false);
  let showOptionsModal = $state(false);
  const optionConfig: { config: ConfigurationFile, id: string, name: string, description: string } = {
    config: {
      // @ts-expect-error - options is a valid property for a string option if a choice.
      t: {
        name: "test-options",
        displayName: "Test Options",
        description: "This is a test options modal",
        defaultValue: "fwofp",
        type: "string",
      },
      // @ts-expect-error - options is a valid property for a string option if a choice.
      t: {
        name: "test-optionx",
        displayName: "Test Options",
        description: "This is a test options modal",
        // @ts-expect-error - options is a valid property for a string option if a choice.
        allowedValues: [ "test-option-1", "test-option-2", "test-option-3" ],
        type: "string",
        
      }
    },
    id: "test-options",
    name: "Test Options",
    description: "This is a test options modal"
  };
  onMount(() => {
    document.addEventListener("dbg:debug-modal-trigger", () => showDebugModal = true);
    document.addEventListener("dbg:options-modal-trigger", () => {
      document.dispatchEvent(new CustomEvent("input-asked", {
        detail: optionConfig
      }));
    });
  });
</script>

{#if showDebugModal}
  <Modal open={showDebugModal} onClose={() => showDebugModal = false}>
    <CloseModal onClose={() => showDebugModal = false} />
    <TitleModal title="Debug" />
    <HeaderModal header="This is a header" />
    <SectionModal>
      <TextModal text="This is a section" variant="caption" />
      <TextModal text="This is a caption" variant="caption" />
      <TextModal text="This is a description" variant="description" />
      <TextModal text="This is a warning" variant="warning" />
    </SectionModal>
    
    <ButtonModal text="Test Button" variant="primary" on:click={() => {
      createNotification({
        message: "This is a notification",
        id: "test-notification",
        type: "info"
      });
    }} />

    <CheckboxModal id="test-checkbox" label="Test Checkbox" description="This is a checkbox" checked={true} on:change={() => {
      console.log("checkbox changed");
    }} />
  </Modal>
{/if}
{#if showOptionsModal}

{/if}