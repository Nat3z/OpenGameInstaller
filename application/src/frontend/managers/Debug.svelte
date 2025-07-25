<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../components/modal/Modal.svelte';
  import CloseModal from '../components/modal/CloseModal.svelte';
  import TitleModal from '../components/modal/TitleModal.svelte';
  import TextModal from '../components/modal/TextModal.svelte';
  import SectionModal from '../components/modal/SectionModal.svelte';
  import ButtonModal from '../components/modal/ButtonModal.svelte';
  import { createNotification, notificationHistory } from '../store';
  import CheckboxModal from '../components/modal/CheckboxModal.svelte';
  import type { ConfigurationFile } from 'ogi-addon/config';
  import HeaderModal from '../components/modal/HeaderModal.svelte';

  let showDebugModal = $state(false);
  let priorityModals = $state({
    urgent: false,
    addonAsk1: false,
    addonAsk2: false,
  });
  let showEventsPerSec = $state(false);
  let showNotificationSideView = $state(false);
  const optionConfig: {
    config: ConfigurationFile;
    id: string;
    name: string;
    description: string;
  } = {
    config: {
      // @ts-expect-error - options is a valid property for a string option if a choice.
      t: {
        name: 'test-options',
        displayName: 'Test Options',
        description: 'This is a test options modal',
        defaultValue: '',
        type: 'string',
      },
      // @ts-expect-error - options is a valid property for a string option if a choice.
      t: {
        name: 'test-option-2',
        displayName: 'Test Options',
        description: 'This is a test options modal',
        // @ts-expect-error - options is a valid property for a string option if a choice.
        allowedValues: ['test-option-1', 'test-option-2', 'test-option-3'],
        type: 'string',
      },
    },
    id: 'test-options',
    name: 'Test Options',
    description: 'This is a test options modal',
  };

  let eventsPerSec = $state(0);
  onMount(() => {
    document.addEventListener(
      'dbg:debug-modal-trigger',
      () => (showDebugModal = true)
    );
    document.addEventListener(
      'dbg:events-proc-toggle',
      () => (showEventsPerSec = !showEventsPerSec)
    );
    document.addEventListener('dbg:options-modal-trigger', () => {
      document.dispatchEvent(
        new CustomEvent('input-asked', {
          detail: optionConfig,
        })
      );
    });
    document.addEventListener('dbg:priority-test-trigger', () => {
      // Queue up two modals with different priorities
      priorityModals.urgent = true; // High priority modal
      priorityModals.addonAsk1 = true; // Low priority modal
      priorityModals.addonAsk2 = true; // Low priority modal
    });
    document.addEventListener('dbg:events-proc', (e: Event) => {
      if (e instanceof CustomEvent && e.detail) {
        eventsPerSec = e.detail.eventsPerSec;
      }
    });
    document.addEventListener(
      'dbg:notification-side-view-toggle',
      () => (showNotificationSideView = !showNotificationSideView)
    );
  });
</script>

{#if showDebugModal}
  <Modal
    priority="urgent"
    open={showDebugModal}
    onClose={() => (showDebugModal = false)}
  >
    <CloseModal />
    <TitleModal title="Debug" />
    <HeaderModal header="This is a header" />
    <SectionModal>
      <TextModal text="This is a section" variant="caption" />
      <TextModal text="This is a caption" variant="caption" />
      <TextModal text="This is a description" variant="description" />
      <TextModal text="This is a warning" variant="warning" />
    </SectionModal>

    <ButtonModal
      text="Test Button"
      variant="primary"
      onclick={() => {
        createNotification({
          message: 'This is a notification',
          id: 'test-notification',
          type: 'info',
        });
      }}
    />

    <CheckboxModal
      id="test-checkbox"
      label="Test Checkbox"
      description="This is a checkbox"
      checked={true}
      onchange={(id, checked) => {
        console.log('checkbox changed', id, checked);
      }}
    />
  </Modal>
{/if}

{#if priorityModals.urgent}
  <Modal
    priority="urgent"
    open={priorityModals.urgent}
    onClose={() => (priorityModals.urgent = false)}
  >
    <CloseModal />
    <TitleModal title="High Priority Modal" />
    <SectionModal>
      <TextModal
        text="This is a high priority modal (urgent)"
        variant="description"
      />
      <TextModal
        text="It should appear on top of other modals"
        variant="caption"
      />
    </SectionModal>
    <ButtonModal
      text="Close High Priority"
      variant="primary"
      onclick={() => (priorityModals.urgent = false)}
    />
  </Modal>
{/if}

{#if priorityModals.addonAsk1}
  <Modal
    priority="addon-ask"
    open={priorityModals.addonAsk1}
    onClose={() => (priorityModals.addonAsk1 = false)}
  >
    <CloseModal />
    <TitleModal title="Low Priority Modal" />
    <SectionModal>
      <TextModal
        text="This is a low priority modal (addon-ask)"
        variant="description"
      />
      <TextModal
        text="It should appear behind high priority modals"
        variant="caption"
      />
    </SectionModal>
    <ButtonModal
      text="Close Low Priority"
      variant="secondary"
      onclick={() => (priorityModals.addonAsk1 = false)}
    />
  </Modal>
{/if}

{#if priorityModals.addonAsk2}
  <Modal
    priority="addon-ask"
    open={priorityModals.addonAsk2}
    onClose={() => (priorityModals.addonAsk2 = false)}
  >
    <CloseModal />
    <TitleModal title="Low Priority Modal 2" />
    <SectionModal>
      <TextModal
        text="This is a low priority modal (addon-ask), this one should be closed last"
        variant="description"
      />
      <TextModal
        text="It should appear behind high priority modals"
        variant="caption"
      />
    </SectionModal>
    <ButtonModal
      text="Close Low Priority"
      variant="secondary"
      onclick={() => (priorityModals.addonAsk2 = false)}
    />
  </Modal>
{/if}

{#if showEventsPerSec || showNotificationSideView}
  <div
    class="fixed bottom-2 left-2 bg-black/25 text-white p-2 rounded-md pointer-events-none z-50 flex flex-col gap-0"
  >
    {#if showEventsPerSec}
      <p class="text-white">Events/sec: {Math.round(eventsPerSec)}</p>
    {/if}
    {#if showNotificationSideView}
      <p class="text-white">Notifications: {$notificationHistory.length}</p>
    {/if}
  </div>
{/if}
