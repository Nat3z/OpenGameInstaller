<script lang="ts">
  import { fly } from 'svelte/transition';
  import { createNotification } from '../store';
  import Modal from '../components/modal/Modal.svelte';
  import TitleModal from '../components/modal/TitleModal.svelte';
  import InputModal from '../components/modal/InputModal.svelte';
  import ButtonModal from '../components/modal/ButtonModal.svelte';
  import { onMount } from 'svelte';
  import TextModal from '../components/modal/TextModal.svelte';
  import SectionModal from '../components/modal/SectionModal.svelte';
  import CustomDropdown from '../components/CustomDropdown.svelte';
  import { fetchAddonsWithConfigure } from '../utils';
  import { THEMES } from '../lib/themes/themes';
  import { applyTheme } from '../lib/themes/applyTheme';

  const fs = window.electronAPI.fs;
  interface OptionsCategory {
    name: string;
    id: string;
    description: string;
    options: {
      [key: string]: {
        displayName: string;
        description: string;
        defaultValue: string | number | boolean;
        choice?: string[];
        value: string | number | boolean;
        type:
          | 'string'
          | 'number'
          | 'boolean'
          | 'file-folder'
          | 'textarea'
          | 'password'
          | 'section-describer'
          | 'action';
        maxTextLength?: number;
        minTextLength?: number;
        action?: () => void;
        max?: number;
        min?: number;
        condition?: () => Promise<boolean>;
      };
    };
  }
  let options: OptionsCategory[] = [
    {
      name: 'General',
      id: 'general',
      description: 'General Settings',
      options: {
        fileDownloadLocation: {
          displayName: 'Download Location',
          description: 'The location where files will be downloaded to',
          defaultValue: './downloads',
          value: '',
          type: 'file-folder',
        },
        theme: {
          displayName: 'Theme',
          description: 'Appearance theme (e.g. light, dark, synthwave)',
          defaultValue: 'light',
          value: '',
          choice: ['light', 'dark', 'synthwave'],
          type: 'string',
        },
        torrentClient: {
          displayName: 'Torrent Client',
          description: 'What will do the torrenting for you',
          defaultValue: 'webtorrent',
          value: '',
          choice: [
            'webtorrent',
            'qbittorrent',
            'real-debrid',
            'torbox',
            'premiumize',
            'disable',
          ],
          type: 'string',
        },
        parallelChunkCount: {
          displayName: 'Parallelize Downloads',
          description:
            "The number of parallel downloads to use per download. More doesn't always mean faster.",
          defaultValue: 8,
          value: 8,
          type: 'number',
          max: 32,
          min: 1,
        },
        reconfigurSteamGridDb: {
          displayName: 'Change SteamGridDB API Key',
          description: 'Reconfigure your SteamGridDB API Key',
          defaultValue: '',
          value: '',
          type: 'action',
          condition: async () =>
            (await window.electronAPI.app.getOS()) === 'linux',
          action: () => {
            document.dispatchEvent(
              new CustomEvent('steamgriddb-launch', {
                detail: '',
              })
            );
          },
        },
        addToDesktop: {
          displayName: 'Add to Desktop',
          description: 'Create a desktop shortcut for OpenGameInstaller',
          defaultValue: '',
          value: '',
          type: 'action',
          condition: async () =>
            (await window.electronAPI.app.getOS()) !== 'win32',
          action: async () => {
            const result = await window.electronAPI.app.addToDesktop();
            if (result.success) {
              createNotification({
                id: Math.random().toString(36).substring(7),
                message: 'Desktop shortcut created successfully',
                type: 'success',
              });
            } else {
              createNotification({
                id: Math.random().toString(36).substring(7),
                message: result.error || 'Failed to create desktop shortcut',
                type: 'error',
              });
            }
          },
        },
        addons: {
          displayName: 'Addons',
          description: 'The addons you want to use',
          defaultValue: '',
          value: '',
          type: 'textarea',
        },
      },
    },
    {
      name: 'Torrent Clients',
      id: 'realdebrid',
      description: 'Configure Torrent Clients',
      options: {
        debridApiKey: {
          displayName: 'Real Debrid API Key',
          description: 'Your Real Debrid API Key',
          defaultValue: '',
          value: '',
          type: 'password',
        },
        torboxApiKey: {
          displayName: 'TorBox API Key',
          description: 'Your TorBox API Key',
          defaultValue: '',
          value: '',
          type: 'password',
        },
        premiumizeApiKey: {
          displayName: 'Premiumize API Key',
          description: 'Your Premiumize API Key',
          defaultValue: '',
          value: '',
          type: 'password',
        },
      },
    },
    {
      name: 'qBittorrent',
      description: 'Configure qBittorrent',
      id: 'qbittorrent',
      options: {
        qbitHost: {
          displayName: 'Host',
          description: 'The host of the qBittorrent server',
          defaultValue: 'http://127.0.0.1',
          value: '',
          type: 'string',
        },
        qbitPort: {
          displayName: 'Port',
          description: 'The port of the qBittorrent server',
          defaultValue: '8080',
          value: '',
          type: 'string',
        },
        qbitUsername: {
          displayName: 'Username',
          description: 'The username of the qBittorrent server',
          defaultValue: 'admin',
          value: '',
          type: 'string',
        },
        qbitPassword: {
          displayName: 'Password',
          description: 'The password of the qBittorrent server',
          defaultValue: 'admin',
          value: '',
          type: 'password',
        },
      },
    },
    {
      name: 'Developer',
      id: 'developer',
      description: 'Developer Settings',
      options: {
        describer: {
          displayName: 'WARNING BEFORE YOU CHANGE',
          description:
            'These settings are for developer use only. Modification of these may lead to undefined, unexpected, and dangerous behavior not intended to be used by the average user. Use at your own risk.',
          defaultValue: '',
          value: '',
          type: 'section-describer',
        },
        disableSecretCheck: {
          displayName: 'Disable Server Secret Check',
          description:
            'Disables the check preventing addons without authorization from connecting to the server. Dangerous as malicious addons could chain load another addon which could make unsandboxed changes to the system.',
          defaultValue: false,
          value: false,
          type: 'boolean',
        },
        showEventsPerSec: {
          displayName: 'Show Events Per Sec',
          description: 'Show the number of events processed per second',
          defaultValue: '',
          value: '',
          type: 'action',
          action: () => {
            document.dispatchEvent(new Event('dbg:events-proc-toggle'));
          },
        },
        showNotificationSideView: {
          displayName: 'Show Notification Side View',
          description: 'Show the notification side view',
          defaultValue: '',
          value: '',
          type: 'action',
          action: () => {
            document.dispatchEvent(
              new Event('dbg:notification-side-view-toggle')
            );
          },
        },
        testModal: {
          displayName: 'Test Modal',
          description: 'Test Modal',
          defaultValue: '',
          value: '',
          type: 'action',
          action: () => {
            document.dispatchEvent(new Event('dbg:debug-modal-trigger'));
          },
        },
        testOptionsModal: {
          displayName: 'Test Priority Modal',
          description: 'Test Priority Modal',
          defaultValue: '',
          value: '',
          type: 'action',
          action: () => {
            document.dispatchEvent(new Event('dbg:priority-test-trigger'));
          },
        },
        triggerOOBE: {
          displayName: 'Trigger OOBE',
          description: 'Trigger the Out of Box Experience',
          defaultValue: '',
          value: '',
          type: 'action',
          action: () => {
            window.electronAPI.fs.delete('./config/option/installed.json');
            window.location.reload();
          },
        },
        describerEnd: {
          displayName: 'Restart to Apply Changes',
          description: '',
          defaultValue: '',
          value: '',
          type: 'section-describer',
        },
      },
    },
    {
      name: 'About',
      id: 'about',
      description: 'About the application',
      options: {},
    },
  ];

  let selectedOption: OptionsCategory | null = $state(null);
  let mainContent: HTMLElement;
  let rangeValues: { [key: string]: number } = $state({});

  /** Selects an options category and updates the UI. */
  function selectOption(addon: OptionsCategory) {
    const selected = document.querySelector('.selected');
    if (selected) {
      selected.classList.remove('selected');
    }
    const element = document.getElementById('cfg-' + addon.name);
    if (element) {
      element.classList.add('selected');
      selectedOption = addon;
    }
  }

  /** Reads form state and writes current option config to disk. */
  function updateConfig() {
    const config: any = {};
    Object.keys(selectedOption!!.options).forEach((key) => {
      if (!selectedOption) return;
      const element = document.getElementById(key) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement;
      if (element && selectedOption!!.options[key]) {
        if (
          selectedOption.options[key].type === 'string' ||
          selectedOption.options[key].type === 'file-folder' ||
          selectedOption.options[key].type === 'password'
        ) {
          if (key === 'torrentClient') {
            config[key] = selectedTorrentClientId;
          } else {
            config[key] = element.value;
          }
        }
        if (selectedOption.options[key].type === 'textarea') {
          if (key === 'addons') {
            config[key] = element.value.split('\n');
            if (config[key].length === 1 && config[key][0] === '') {
              config[key] = [];
            } else {
              // verify that each line is a link
              try {
                config[key].forEach((line: string) => {
                  if (!line || line.length === 0) return;
                  if (line.startsWith('local:')) {
                    if (
                      !window.electronAPI.fs.exists(line.split('local:')[1])
                    ) {
                      createNotification({
                        id: Math.random().toString(36).substring(7),
                        message: 'Invalid Local File in Addons',
                        type: 'error',
                      });
                      return;
                    }
                  } else {
                    new URL(line);
                  }
                });
              } catch (error) {
                createNotification({
                  id: Math.random().toString(36).substring(7),
                  message: 'Invalid URL in Addons',
                  type: 'error',
                });
                return;
              }
            }
          } else {
            config[key] = element.value;
          }
        }
        if (selectedOption.options[key].type === 'number') {
          config[key] = parseInt(element.value);
        }
        if (
          selectedOption.options[key].type === 'boolean' &&
          element instanceof HTMLInputElement
        ) {
          config[key] = element.checked;
        }
      }
    });
    // save this config to local storage
    if (!selectedOption) return;
    fs.write(
      './config/option/' + selectedOption.id + '.json',
      JSON.stringify(config)
    );
  }

  /** Returns stored value for key or option default. */
  function getStoredOrDefaultValue(key: string) {
    if (!selectedOption) return;
    if (!fs.exists('./config/option/' + selectedOption.id + '.json')) {
      return selectedOption.options[key].defaultValue;
    } else {
      const storedConfig = JSON.parse(
        fs.read('./config/option/' + selectedOption.id + '.json')
      );
      return storedConfig[key] ?? selectedOption.options[key].defaultValue;
    }
  }

  /** Opens folder picker and updates the associated input. */
  function browseForFolder(event: MouseEvent) {
    const dialog = window.electronAPI.fs.dialog;
    const element = (event.target as HTMLElement).parentElement!!.querySelector(
      'input'
    ) as HTMLInputElement;
    dialog.showOpenDialog({ properties: ['openDirectory'] }).then((path) => {
      if (path && path.length > 0) {
        if (element) {
          element.value = path[0];
        }
        updateConfig();
      }
    });
  }

  /** Installs addons from the configured list. */
  async function installAddons() {
    isInstallingAddons = true;
    const addons = getStoredOrDefaultValue('addons') as string[];
    if (!addons || addons.length === 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'No addons to install',
        type: 'error',
      });
      isInstallingAddons = false;
      return;
    }
    await window.electronAPI.installAddons(addons);
    isInstallingAddons = false;
  }

  /** Cleans addon installations. */
  async function cleanAddons() {
    isCleaningAddons = true;
    await window.electronAPI.cleanAddons();
    isCleaningAddons = false;
  }

  /** Updates addons. */
  async function updateAddons() {
    isUpdatingAddons = true;
    await window.electronAPI.updateAddons();
    isUpdatingAddons = false;
  }

  /** Restarts the addon server and refreshes addon list. */
  async function restartAddonServer() {
    isRestartingServer = true;
    await window.electronAPI.restartAddonServer();
    isRestartingServer = false;
    fetchAddonsWithConfigure();
    createNotification({
      id: Math.random().toString(36).substring(7),
      message: 'Addon server restarted',
      type: 'success',
    });
  }

  let showPassword: { [key: string]: boolean } = $state({});
  let doSteamGridDBReconfigure: boolean = $state(false);
  let selectedTorrentClientId: string = $state('webtorrent'); // Track selection reactively

  // Loading states for addon management buttons
  let isInstallingAddons = $state(false);
  let isUpdatingAddons = $state(false);
  let isCleaningAddons = $state(false);
  let isRestartingServer = $state(false);

  const torrentClients = [
    {
      id: 'webtorrent',
      name: 'WebTorrent',
      icon: './WebTorrent_logo.png',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Built-in torrent client with no external dependencies. Works out of the box, but lacks security features like VPNs and proxies.',
    },
    {
      id: 'qbittorrent',
      name: 'qBittorrent',
      icon: './qbittorrent.svg',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Connect to your existing qBittorrent instance. Tried and tested with security features, but requires setup and configuration.',
    },
    {
      id: 'torbox',
      name: 'TorBox',
      icon: './torbox.svg',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Community-driven and high-speed seedbox with cached torrents. Requires subscription.',
    },
    {
      id: 'real-debrid',
      name: 'Real-Debrid',
      icon: './rd-logo.png',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Premium service for faster downloads and cached torrents. Requires subscription.',
    },
    {
      id: 'premiumize',
      name: 'Premiumize',
      icon: './premiumize.svg',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Premium seedbox with cached torrents. Requires subscription.',
    },
    {
      id: 'disable',
      name: 'Disable',
      icon: './disabled_torrent.svg',
      iconWidth: 24,
      iconHeight: 24,
      description:
        'Disable torrenting altogether, preventing any downloads from happening.',
    },
  ];

  /** Handles torrent client dropdown change and persists config. */
  function handleTorrentClientChange(detail: { selectedId: string }) {
    selectedTorrentClientId = detail.selectedId;
    updateConfig();
  }

  $effect(() => {
    if (mainContent && selectedOption) {
      mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Initialize selectedTorrentClientId with stored value
  $effect(() => {
    if (selectedOption && selectedOption.id === 'general') {
      const storedValue = getStoredOrDefaultValue('torrentClient');
      if (storedValue && storedValue !== selectedTorrentClientId) {
        selectedTorrentClientId = storedValue as string;
      }
    }
  });

  // Initialize range values when selectedOption changes
  $effect(() => {
    if (selectedOption) {
      const currentOption = selectedOption;
      const newRangeValues: { [key: string]: number } = {};
      Object.keys(currentOption.options).forEach((key) => {
        if (currentOption.options[key].type === 'number') {
          newRangeValues[key] = getStoredOrDefaultValue(key) as number;
        }
      });
      rangeValues = newRangeValues;
    }
  });

  let reasonForSteamGridLaunch: string = $state('');
  onMount(() => {
    function steamgriddbLaunch(event: Event) {
      doSteamGridDBReconfigure = true;
      reasonForSteamGridLaunch = (event as CustomEvent).detail || '';
    }
    document.addEventListener('steamgriddb-launch', steamgriddbLaunch);

    return () => {
      document.removeEventListener('steamgriddb-launch', steamgriddbLaunch);
    };
  });
</script>

{#if doSteamGridDBReconfigure}
  <Modal
    open={doSteamGridDBReconfigure}
    boundsClose={true}
    onClose={() => (doSteamGridDBReconfigure = false)}
  >
    <TitleModal title="SteamGridDB API Key" />

    {#if reasonForSteamGridLaunch}
      <SectionModal>
        <TextModal
          text="Why are we asking for your API Key?"
          variant="caption"
        />
        <TextModal
          text={reasonForSteamGridLaunch}
          class="-mt-2!"
          variant="body"
        />
      </SectionModal>
    {/if}
    <a
      href="https://steamgriddb.com/profile/preferences/api"
      target="_blank"
      class="text-accent-dark hover:text-accent-light underline mt-4"
    >
      Get your API Key here (https://steamgriddb.com/profile/preferences/api)
    </a>
    <InputModal
      id="steamgriddb-api-key"
      label="SteamGridDB API Key"
      description="Enter your SteamGridDB API Key below."
      value=""
    />
    <div class="flex flex-row gap-2 mt-4">
      <ButtonModal
        variant="primary"
        text="Save"
        onclick={() => {
          window.electronAPI.oobe.setSteamGridDBKey(
            (document.getElementById('steamgriddb-api-key') as HTMLInputElement)
              .value
          );
          doSteamGridDBReconfigure = false;
        }}
      />
      <ButtonModal
        variant="secondary"
        text="Cancel"
        onclick={() => (doSteamGridDBReconfigure = false)}
      />
    </div>
  </Modal>
{/if}
<div class="config-container">
  <!-- Sidebar -->
  <div class="sidebar">
    <nav class="sidebar-nav">
      {#if options.length !== 0}
        {#each options as option}
          <button
            class="sidebar-item"
            class:selected={selectedOption?.id === option.id}
            onclick={() => selectOption(option)}
            id={'cfg-' + option.name}
          >
            <div class="sidebar-item-content">
              <h3 class="sidebar-item-title">{option.name}</h3>
              <p class="sidebar-item-description">{option.description}</p>
            </div>
          </button>
        {/each}
      {/if}
    </nav>
  </div>

  <!-- Main Content -->
  <main
    class="main-content overflow-x-hidden overflow-y-auto relative"
    bind:this={mainContent}
  >
    {#key selectedOption?.id}
      <div
        class="absolute inset-0 w-full h-full"
        in:fly={{ x: 300, duration: 300 }}
        out:fly={{ x: -300, duration: 300 }}
      >
        {#if selectedOption}
          {#if selectedOption.id === 'about'}
            <div class="content-body about-content">
              <!-- About Section -->
              <div class="about-section">
                <div class="about-icon">
                  <img
                    src="./favicon.png"
                    alt="OpenGameInstaller"
                    class="app-icon"
                  />
                </div>
                <h1 class="about-title">OpenGameInstaller</h1>
                <p class="about-subtitle">By Nat3z & the OGI Team</p>
                <div class="about-links">
                  <a
                    href="https://github.com/Nat3z/OpenGameInstaller"
                    target="_blank"
                    class="about-link"
                  >
                    GitHub
                  </a>
                  <span class="about-separator">•</span>
                  <a
                    href="https://github.com/Nat3z/OpenGameInstaller/blob/main/application/LICENSE"
                    target="_blank"
                    class="about-link"
                  >
                    License
                  </a>
                  <span class="about-separator">•</span>
                  <a
                    href="https://ogi.nat3z.com/docs/"
                    target="_blank"
                    class="about-link"
                  >
                    Documentation
                  </a>
                </div>
                <p class="about-version">v{window.electronAPI.getVersion()}</p>
              </div>
            </div>
          {:else}
            <div class="content-body">
              <div class="options-grid">
                {#each Object.keys(selectedOption.options) as key}
                  {#await selectedOption.options[key].condition ? selectedOption.options[key].condition() : new Promise( (resolve) => resolve(true) ) then condition}
                    {#if condition}
                      {#if selectedOption.options[key].type === 'section-describer'}
                        <div class="option-item">
                          <label class="option-label mb-0! text-2xl!" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          <p class="option-description mb-0!">
                            {selectedOption.options[key].description}
                          </p>
                        </div>
                      {:else if selectedOption.options[key].type === 'boolean'}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <label class="checkbox-container">
                              <input
                                type="checkbox"
                                id={key}
                                class="input-checkbox"
                                onchange={updateConfig}
                                checked={getStoredOrDefaultValue(key)}
                              />
                              <span class="checkbox-checkmark"></span>
                            </label>
                          </div>
                        </div>
                      {:else if selectedOption.options[key].type === 'password'}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <div class="flex items-center relative">
                              <input
                                type={showPassword?.[key] ? 'text' : 'password'}
                                id={key}
                                class="input-text pr-14! relative z-1"
                                onchange={updateConfig}
                                value={getStoredOrDefaultValue(key)}
                                maxlength={selectedOption.options[key]
                                  .maxTextLength}
                                minlength={selectedOption.options[key]
                                  .minTextLength}
                              />
                              <div
                                class="pointer-events-none absolute right-12 top-1 h-8 w-8 z-2 rounded-lg bg-linear-to-r from-transparent to-surface/80"
                              ></div>
                              <button
                                type="button"
                                class="ml-2 px-2 py-1 text-sm absolute right-2 border-none rounded-lg bg-transparent outline-none text-accent-dark z-3"
                                onclick={() => {
                                  if (!showPassword) showPassword = {};
                                  showPassword[key] = !showPassword[key];
                                  showPassword = { ...showPassword };
                                }}
                                tabindex="-1"
                              >
                                {#if showPassword?.[key]}
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="currentColor"
                                    height="24"
                                    viewBox="0 0 24 24"
                                    width="24"
                                    ><path
                                      d="M0 0h24v24H0V0zm0 0h24v24H0V0zm0 0h24v24H0V0zm0 0h24v24H0V0z"
                                      fill="none"
                                    /><path
                                      d="M12 6.5c2.76 0 5 2.24 5 5 0 .51-.1 1-.24 1.46l3.06 3.06c1.39-1.23 2.49-2.77 3.18-4.53C21.27 7.11 17 4 12 4c-1.27 0-2.49.2-3.64.57l2.17 2.17c.47-.14.96-.24 1.47-.24zM2.71 3.16c-.39.39-.39 1.02 0 1.41l1.97 1.97C3.06 7.83 1.77 9.53 1 11.5 2.73 15.89 7 19 12 19c1.52 0 2.97-.3 4.31-.82l2.72 2.72c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L4.13 3.16c-.39-.39-1.03-.39-1.42 0zM12 16.5c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57 0 1.66 1.34 3 3 3 .2 0 .38-.03.57-.07L14.14 16c-.65.32-1.37.5-2.14.5zm2.97-5.33c-.15-1.4-1.25-2.49-2.64-2.64l2.64 2.64z"
                                    /></svg
                                  >
                                {:else}
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="currentColor"
                                    height="24"
                                    viewBox="0 0 24 24"
                                    width="24"
                                    ><path
                                      d="M0 0h24v24H0V0z"
                                      fill="none"
                                    /><path
                                      d="M12 4C7 4 2.73 7.11 1 11.5 2.73 15.89 7 19 12 19s9.27-3.11 11-7.5C21.27 7.11 17 4 12 4zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
                                    /></svg
                                  >
                                {/if}
                              </button>
                            </div>
                          </div>
                        </div>
                      {:else if selectedOption.options[key].type === 'file-folder'}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <div class="file-input-group">
                              <input
                                type="text"
                                id={key}
                                class="input-text"
                                onchange={updateConfig}
                                value={getStoredOrDefaultValue(key)}
                                maxlength={selectedOption.options[key]
                                  .maxTextLength}
                                minlength={selectedOption.options[key]
                                  .minTextLength}
                              />
                              <button
                                class="browse-button"
                                onclick={(ev) => browseForFolder(ev)}
                              >
                                Browse
                              </button>
                            </div>
                          </div>
                        </div>
                      {:else if selectedOption.options[key].type === 'textarea'}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <textarea
                              id={key}
                              class="input-textarea"
                              onchange={updateConfig}
                              value={getStoredOrDefaultValue(key).join('\n')}
                              placeholder={key === 'addons'
                                ? 'Enter addon URLs, one per line...'
                                : ''}
                            ></textarea>
                          </div>
                        </div>
                      {:else if selectedOption.options[key].type === 'number'}
                        {@const min = selectedOption.options[key].min ?? 0}
                        {@const max = selectedOption.options[key].max ?? 100}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <div class="range-container">
                              <input
                                type="range"
                                id={key}
                                class="input-number"
                                oninput={(e) => {
                                  const value = parseInt(
                                    (e.target as HTMLInputElement).value
                                  );
                                  rangeValues[key] = value;
                                  updateConfig();
                                }}
                                value={rangeValues[key] ?? getStoredOrDefaultValue(key)}
                                max={max}
                                min={min}
                              />
                              <input
                                type="text"
                                inputmode="numeric"
                                pattern="[0-9]*"
                                class="range-value-input"
                                value={rangeValues[key] ?? getStoredOrDefaultValue(key)}
                                onchange={(e) => {
                                  const input = e.target as HTMLInputElement;
                                  let value = parseInt(input.value);
                                  
                                  if (isNaN(value)) {
                                    value = rangeValues[key] ?? (getStoredOrDefaultValue(key) as number);
                                  } else if (value < min) {
                                    value = min;
                                  } else if (value > max) {
                                    value = max;
                                  }
                                  
                                  input.value = value.toString();
                                  rangeValues[key] = value;
                                  updateConfig();
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      {:else if selectedOption.options[key].type === 'action'}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          <div class="option-input">
                            {#if selectedOption && selectedOption.options[key].action !== undefined}
                              <button
                                class="action-button bg-accent-light text-accent-dark hover:bg-accent-dark hover:text-accent-light"
                                onclick={() =>
                                  selectedOption!.options[key].action?.()}
                              >
                                {selectedOption.options[key].displayName}
                              </button>
                            {/if}
                          </div>
                        </div>
                      {:else if selectedOption.options[key].choice}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            {#if key === 'torrentClient'}
                              <CustomDropdown
                                id={key}
                                options={torrentClients}
                                selectedId={selectedTorrentClientId}
                                onchange={handleTorrentClientChange}
                              />
                            {:else if key === 'theme'}
                              <select
                                id={key}
                                class="input-select"
                                onchange={(e) => {
                                  updateConfig();
                                  applyTheme((e.target as HTMLSelectElement).value);
                                }}
                                value={getStoredOrDefaultValue(key)}
                              >
                                {#each THEMES as t}
                                  <option value={t.id}>{t.label}</option>
                                {/each}
                              </select>
                            {:else}
                              <!-- Regular select for other options -->
                              <select
                                id={key}
                                class="input-select"
                                onchange={updateConfig}
                                value={getStoredOrDefaultValue(key)}
                              >
                                {#each selectedOption.options[key].choice as choiceValue}
                                  <option value={choiceValue}
                                    >{choiceValue}</option
                                  >
                                {/each}
                              </select>
                            {/if}
                          </div>
                        </div>
                      {:else}
                        <div class="option-item">
                          <label class="option-label" for={key}>
                            {selectedOption.options[key].displayName}
                          </label>
                          {#if selectedOption.options[key].description}
                            <p class="option-description">
                              {selectedOption.options[key].description}
                            </p>
                          {/if}
                          <div class="option-input">
                            <input
                              type="text"
                              id={key}
                              class="input-text"
                              onchange={updateConfig}
                              value={getStoredOrDefaultValue(key)}
                              maxlength={selectedOption.options[key]
                                .maxTextLength}
                              minlength={selectedOption.options[key]
                                .minTextLength}
                            />
                          </div>
                        </div>
                      {/if}
                    {/if}
                  {/await}
                {/each}
              </div>

              {#if selectedOption.id === 'general'}
                <div class="action-section">
                  <h3 class="action-title">Addon Management</h3>
                  <div class="action-buttons">
                    <button
                      class="action-button primary flex items-center justify-center"
                      onclick={() => installAddons()}
                      disabled={isInstallingAddons}
                    >
                      {#if isInstallingAddons}
                        <div
                          class="animate-spin mr-2 h-5 w-5 border-2 border-accent-text-color border-t-transparent rounded-full"
                        ></div>
                        Installing...
                      {:else}
                        Install All Addons
                      {/if}
                    </button>
                    <button
                      class="action-button secondary flex items-center justify-center"
                      onclick={() => updateAddons()}
                      disabled={isUpdatingAddons}
                    >
                      {#if isUpdatingAddons}
                        <div
                          class="animate-spin mr-2 h-5 w-5 border-2 border-accent-text-color border-t-transparent rounded-full"
                        ></div>
                        Updating...
                      {:else}
                        Update Addons
                      {/if}
                    </button>
                    <button
                      class="action-button danger flex items-center justify-center"
                      onclick={() => cleanAddons()}
                      disabled={isCleaningAddons}
                    >
                      {#if isCleaningAddons}
                        <div
                          class="animate-spin mr-2 h-5 w-5 border-2 border-accent-text-color border-t-transparent rounded-full"
                        ></div>
                        Cleaning...
                      {:else}
                        Clean All Addons
                      {/if}
                    </button>
                  </div>
                  <div class="action-buttons">
                    <button
                      class="action-button warning flex items-center justify-center"
                      onclick={() => restartAddonServer()}
                      disabled={isRestartingServer}
                    >
                      {#if isRestartingServer}
                        <div
                          class="animate-spin mr-2 h-5 w-5 border-2 border-accent-text-color border-t-transparent rounded-full"
                        ></div>
                        Restarting...
                      {:else}
                        Restart Addon Server
                      {/if}
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="no-selection">
            <div class="no-selection-content">
              <svg
                class="no-selection-icon"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                />
              </svg>
              <h2 class="no-selection-title">Select a Setting Category</h2>
              <p class="no-selection-description">
                Choose a category from the sidebar to configure your settings
              </p>
            </div>
          </div>
        {/if}
      </div>
    {/key}
  </main>
</div>

<style>
  @reference "../app.css";
  .config-container {
    @apply flex h-full w-full;
  }

  /* Sidebar Styles */
  .sidebar {
    @apply w-80 flex flex-col;
  }

  .sidebar-nav {
    @apply flex-1 space-y-2;
  }

  .sidebar-item {
    @apply w-full p-4 rounded-lg border-none bg-transparent hover:bg-accent-lighter transition-colors duration-200 text-left text-text;
  }

  .sidebar-item.selected {
    @apply bg-accent-lighter;
  }

  .sidebar-item-content {
    @apply space-y-1;
  }

  .sidebar-item-title {
    @apply text-lg font-archivo font-semibold text-text;
  }

  .sidebar-item-description {
    @apply text-sm text-text-muted;
  }

  /* Main Content Styles */
  .main-content {
    @apply flex-1 flex flex-col;
  }

  .content-body {
    @apply flex-1 p-6 pt-0 overflow-y-auto;
  }

  .content-body.about-content {
    @apply flex items-center justify-center;
  }

  /* About Section Styles */
  .about-section {
    @apply flex flex-col items-center text-center space-y-4 max-w-md;
  }

  .about-icon {
    @apply mb-4;
  }

  .app-icon {
    @apply w-48 h-48 rounded-lg;
  }

  .about-title {
    @apply text-3xl font-archivo font-bold text-text;
  }

  .about-subtitle {
    @apply text-lg text-text-muted;
  }

  .about-links {
    @apply flex items-center space-x-2;
  }

  .about-link {
    @apply text-accent hover:text-accent-dark transition-colors;
  }

  .about-separator {
    @apply text-text-muted;
  }

  .about-version {
    @apply text-sm text-text-muted mt-8;
  }

  /* Options Grid */
  .options-grid {
    @apply space-y-6;
  }

  .option-item {
    @apply bg-surface p-6 rounded-lg border border-border shadow-sm;
  }

  .option-label {
    @apply block text-lg font-archivo font-semibold text-text mb-1;
  }

  .option-description {
    @apply text-sm text-text-muted mb-4;
  }

  .option-input {
    @apply space-y-2;
  }

  /* Input Styles */
  .input-text,
  .input-number,
  .input-select {
    @apply w-full px-4 py-2 border border-border-muted rounded-lg bg-surface focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors text-text;
  }

  .input-textarea {
    @apply w-full px-4 py-2 border border-border-muted rounded-lg bg-surface focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors resize-none h-32;
  }

  .file-input-group {
    @apply flex gap-2;
  }

  .file-input-group .input-text {
    @apply flex-1;
  }

  .browse-button {
    @apply px-4 py-2 bg-accent text-accent-text-color rounded-lg hover:bg-accent-dark transition-colors border-none font-archivo font-semibold;
  }

  /* Checkbox Styles */
  .checkbox-container {
    @apply relative flex items-center cursor-pointer;
  }

  .input-checkbox {
    @apply sr-only;
  }

  .checkbox-checkmark {
    @apply w-5 h-5 bg-surface border-2 border-border-muted rounded flex items-center justify-center transition-colors;
  }

  .input-checkbox:checked + .checkbox-checkmark {
    @apply bg-accent border-accent;
  }

  .input-checkbox:not(:checked) + .checkbox-checkmark::after {
    content: '–';
    @apply text-text-muted text-sm font-archivo;
  }

  .input-checkbox:checked + .checkbox-checkmark::after {
    content: '•';
    @apply text-accent-text-color text-sm font-archivo;
  }

  /* Action Section */
  .action-section {
    @apply mt-8 p-6 bg-surface rounded-lg border border-border;
  }

  .action-title {
    @apply text-xl font-archivo font-semibold text-text mb-4;
  }

  .action-buttons {
    @apply flex flex-wrap gap-3 mb-4;
  }

  .action-button {
    @apply px-4 py-2 rounded-lg font-medium transition-colors border-none;
  }

  .action-button.primary {
    @apply bg-success-bg text-success-text hover:opacity-90 disabled:bg-border-muted;
  }

  .action-button.secondary {
    @apply bg-accent text-accent-text-color hover:bg-accent-dark disabled:bg-border-muted;
  }

  .action-button.danger {
    @apply bg-error-bg text-error-text hover:opacity-90 disabled:bg-border-muted;
  }

  .action-button.warning {
    @apply bg-accent-lighter text-accent-dark hover:bg-accent-light disabled:bg-border-muted;
  }

  /* No Selection State */
  .no-selection {
    @apply flex-1 flex items-center justify-center;
  }

  .no-selection-content {
    @apply text-center space-y-4;
  }

  .no-selection-icon {
    @apply w-16 h-16 text-text-muted mx-auto;
  }

  .no-selection-title {
    @apply text-2xl font-archivo font-semibold text-text;
  }

  .no-selection-description {
    @apply text-text-muted;
  }

  /* Remove webkit number input spinners */
  .input-number::-webkit-inner-spin-button,
  .input-number::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  /* Range Container Styles */
  .range-container {
    @apply flex items-center gap-4;
  }

  .range-container .input-number {
    @apply flex-1;
  }

  .range-value-input {
    @apply w-16 text-center px-3 py-1 bg-accent-lighter text-accent-dark rounded-lg font-archivo font-semibold text-lg border-none focus:ring-2 focus:ring-accent-light outline-none;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
    cursor: text;
  }
</style>
