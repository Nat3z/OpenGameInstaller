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
  import {
    ConfigurationBuilder,
    type ConfigurationFile,
  } from 'ogi-addon/config';
  import HeaderModal from '../components/modal/HeaderModal.svelte';

  let showDebugModal = $state(false);
  let priorityModals = $state({
    urgent: false,
    addonAsk1: false,
    addonAsk2: false,
  });
  let showEventsPerSec = $state(false);
  let showNotificationSideView = $state(false);
  let showInsertAppModal = $state(false);
  // Build test config with real StringOption instances (matches production shape)
  const optionConfig: {
    config: ConfigurationFile;
    id: string;
    name: string;
    description: string;
  } = {
    config: new ConfigurationBuilder()
      .addStringOption((option) =>
        option
          .setName('test-options')
          .setDisplayName('Test Options')
          .setDescription('This is a test options modal')
          .setDefaultValue('')
      )
      .addStringOption((option) =>
        option
          .setName('test-option-2')
          .setDisplayName('Test Options')
          .setDescription('This is a test options modal')
          .setAllowedValues([
            'test-option-1',
            'test-option-2',
            'test-option-3',
          ])
      )
      .build(false),
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
    document.addEventListener('dbg:insert-app-modal-trigger', () => {
      showInsertAppModal = true;
    });
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

    <ButtonModal
      text="Test Insert App with Dependencies"
      variant="secondary"
      onclick={() => {
        showInsertAppModal = true;
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

{#if showInsertAppModal}
  <Modal
    priority="urgent"
    open={showInsertAppModal}
    onClose={() => (showInsertAppModal = false)}
  >
    <CloseModal />
    <TitleModal title="Debug: Insert App with Dependencies" />
    <SectionModal>
      <TextModal
        text="This will simulate inserting an app with redistributables (dependencies)"
        variant="description"
      />
      <TextModal
        text="The app will be added to your library with mock data"
        variant="caption"
      />
    </SectionModal>

    <ButtonModal
      text="Insert Test App with Dependencies"
      variant="primary"
      onclick={async () => {
        try {
          const mockAppData = {
            name: 'Test Game with Dependencies',
            version: '1.0.0',
            cwd: '/path/to/game',
            appID: 12345,
            launchExecutable: 'game.exe',
            launchArguments: '--debug',
            capsuleImage:
              'https://via.placeholder.com/600x900/428a91/ffffff?text=Test+Game',
            coverImage:
              'https://via.placeholder.com/920x430/428a91/ffffff?text=Cover+Image',
            titleImage:
              'https://via.placeholder.com/920x430/2d626a/ffffff?text=Title+Image',
            storefront: 'steam',
            addonsource: 'test-addon',
            redistributables: [
              {
                name: 'dotnet48',
                path: 'winetricks',
              },
            ],
          };

          const result = await window.electronAPI.app.insertApp(mockAppData);

          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: result.includes('success') ? 'success' : 'error',
            message: `App insertion result: ${result}`,
          });

          showInsertAppModal = false;
        } catch (error) {
          console.error('Error inserting test app:', error);
          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: 'error',
            message: `Failed to insert test app: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }}
    />

    <ButtonModal
      text="Insert Test App without Dependencies"
      variant="secondary"
      onclick={async () => {
        try {
          const mockAppData = {
            name: 'Test Game (No Dependencies)',
            version: '1.0.0',
            cwd: '/path/to/game',
            appID: 67890,
            launchExecutable: 'game.exe',
            launchArguments: '',
            capsuleImage:
              'https://via.placeholder.com/600x900/B0DFD5/ffffff?text=Simple+Game',
            coverImage:
              'https://via.placeholder.com/920x430/B0DFD5/ffffff?text=Simple+Cover',
            storefront: 'steam',
            addonsource: 'test-addon',
          };

          const result = await window.electronAPI.app.insertApp(mockAppData);

          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: result.includes('success') ? 'success' : 'error',
            message: `App insertion result: ${result}`,
          });

          showInsertAppModal = false;
        } catch (error) {
          console.error('Error inserting test app:', error);
          createNotification({
            id: Math.random().toString(36).substring(2, 9),
            type: 'error',
            message: `Failed to insert test app: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }}
    />

    <ButtonModal
      text="Cancel"
      variant="secondary"
      onclick={() => (showInsertAppModal = false)}
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
