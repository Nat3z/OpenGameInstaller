<script lang="ts">
  import { fly } from 'svelte/transition';
  import { createNotification } from '../store';

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
        torrentClient: {
          displayName: 'Torrent Client',
          description: 'What will do the torrenting for you',
          defaultValue: 'webtorrent',
          value: '',
          choice: ['webtorrent', 'qbittorrent', 'real-debrid'],
          type: 'string',
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
      name: 'Real Debrid',
      id: 'realdebrid',
      description: 'Configure Real Debrid',
      options: {
        debridApiKey: {
          displayName: 'Real Debrid API Key',
          description: 'Your Real Debrid API Key',
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
          defaultValue: 8080,
          value: 8080,
          type: 'number',
          max: 65535,
          min: 1,
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
          config[key] = element.value;
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

  function getStoredOrDefaultValue(key: string) {
    if (!selectedOption) return;
    if (!fs.exists('./config/option/' + selectedOption.id + '.json')) {
      return selectedOption.options[key].defaultValue;
    } else {
      const storedConfig = JSON.parse(
        fs.read('./config/option/' + selectedOption.id + '.json')
      );
      return storedConfig[key];
    }
  }

  function browseForFolder(event: MouseEvent) {
    const dialog = window.electronAPI.fs.dialog;
    const element = (event.target as HTMLElement).parentElement!!.querySelector(
      'input'
    ) as HTMLInputElement;
    dialog.showOpenDialog({ properties: ['openDirectory'] }).then((path) => {
      if (!path) return;
      if (element) {
        element.value = path;
      }
      updateConfig();
    });
  }

  async function installAddons() {
    const buttonsToDisable = document.querySelectorAll('[data-disable]');
    buttonsToDisable.forEach((button) => {
      button.setAttribute('disabled', 'true');
    });
    const addons = getStoredOrDefaultValue('addons') as string[];
    if (!addons || addons.length === 0) {
      createNotification({
        id: Math.random().toString(36).substring(7),
        message: 'No addons to install',
        type: 'error',
      });
      return;
    }
    await window.electronAPI.installAddons(addons);
    buttonsToDisable.forEach((button) => {
      button.removeAttribute('disabled');
    });
  }

  async function cleanAddons() {
    const buttonsToDisable = document.querySelectorAll('[data-disable]');
    buttonsToDisable.forEach((button) => {
      button.setAttribute('disabled', 'true');
    });
    await window.electronAPI.cleanAddons();
    buttonsToDisable.forEach((button) => {
      button.removeAttribute('disabled');
    });
  }

  async function updateAddons() {
    const buttonsToDisable = document.querySelectorAll('[data-disable]');
    buttonsToDisable.forEach((button) => {
      button.setAttribute('disabled', 'true');
    });
    await window.electronAPI.updateAddons();
    buttonsToDisable.forEach((button) => {
      button.removeAttribute('disabled');
    });
  }

  let showPassword: { [key: string]: boolean } = $state({});

  $effect(() => {
    if (mainContent && selectedOption) {
      mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
</script>

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
                </div>
                <p class="about-version">v{window.electronAPI.getVersion()}</p>
              </div>
            </div>
          {:else}
            <div class="content-body">
              <div class="options-grid">
                {#each Object.keys(selectedOption.options) as key}
                  {#if selectedOption.options[key].type === 'section-describer'}
                    <div class="option-item">
                      <label class="option-label !mb-0 !text-2xl" for={key}>
                        {selectedOption.options[key].displayName}
                      </label>
                      <p class="option-description !mb-0">
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
                            class="input-text !pr-14 relative z-1"
                            onchange={updateConfig}
                            value={getStoredOrDefaultValue(key)}
                            maxlength={selectedOption.options[key]
                              .maxTextLength}
                            minlength={selectedOption.options[key]
                              .minTextLength}
                          />
                          <div
                            class="pointer-events-none absolute right-12 top-1 h-8 w-8 z-2 rounded-lg bg-gradient-to-r from-transparent to-white/80"
                          ></div>
                          <button
                            type="button"
                            class="ml-2 px-2 py-1 text-sm absolute right-2 border-none rounded-lg bg-transparent outline-none text-accent-dark z-[3]"
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
                                ><path d="M0 0h24v24H0V0z" fill="none" /><path
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
                          type="number"
                          id={key}
                          class="input-number"
                          onchange={updateConfig}
                          value={getStoredOrDefaultValue(key)}
                          max={selectedOption.options[key].max}
                          min={selectedOption.options[key].min}
                        />
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
                        <select
                          id={key}
                          class="input-select"
                          onchange={updateConfig}
                          value={getStoredOrDefaultValue(key)}
                        >
                          {#each selectedOption.options[key].choice as choiceValue}
                            <option value={choiceValue}>{choiceValue}</option>
                          {/each}
                        </select>
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
                          maxlength={selectedOption.options[key].maxTextLength}
                          minlength={selectedOption.options[key].minTextLength}
                        />
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>

              {#if selectedOption.id === 'general'}
                <div class="action-section">
                  <h3 class="action-title">Addon Management</h3>
                  <div class="action-buttons">
                    <button
                      class="action-button primary"
                      onclick={() => installAddons()}
                      data-disable
                    >
                      Install All Addons
                    </button>
                    <button
                      class="action-button secondary"
                      onclick={() => updateAddons()}
                      data-disable
                    >
                      Update Addons
                    </button>
                    <button
                      class="action-button danger"
                      onclick={() => cleanAddons()}
                      data-disable
                    >
                      Clean All Addons
                    </button>
                  </div>
                  <div class="action-buttons">
                    <button
                      class="action-button warning"
                      onclick={() => window.electronAPI.restartAddonServer()}
                      data-disable
                    >
                      Restart Addon Server
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
  .config-container {
    @apply flex h-full w-full;
  }

  /* Sidebar Styles */
  .sidebar {
    @apply w-80 flex flex-col;
  }

  .sidebar-title {
    @apply text-2xl font-archivo font-bold text-gray-900;
  }

  .sidebar-nav {
    @apply flex-1 space-y-2;
  }

  .sidebar-item {
    @apply w-full p-4 rounded-lg border-none bg-transparent hover:bg-accent-lighter transition-colors duration-200 text-left text-white;
  }

  .sidebar-item.selected {
    @apply bg-accent-lighter;
  }

  .sidebar-item-content {
    @apply space-y-1;
  }

  .sidebar-item-title {
    @apply text-lg font-archivo font-semibold text-gray-900;
  }

  .sidebar-item-description {
    @apply text-sm text-gray-600;
  }

  /* Main Content Styles */
  .main-content {
    @apply flex-1 flex flex-col;
  }

  .content-header {
    @apply p-6 border-b;
  }

  .content-title {
    @apply text-3xl font-archivo font-bold text-gray-900 mb-2;
  }

  .content-description {
    @apply text-gray-600;
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
    @apply text-3xl font-archivo font-bold text-gray-900;
  }

  .about-subtitle {
    @apply text-lg text-gray-600;
  }

  .about-links {
    @apply flex items-center space-x-2;
  }

  .about-link {
    @apply text-accent hover:text-accent-dark transition-colors;
  }

  .about-separator {
    @apply text-gray-400;
  }

  .about-version {
    @apply text-sm text-gray-500 mt-8;
  }

  /* Options Grid */
  .options-grid {
    @apply space-y-6;
  }

  .option-item {
    @apply bg-white p-6 rounded-lg border border-gray-200 shadow-sm;
  }

  .option-label {
    @apply block text-lg font-archivo font-semibold text-gray-900 mb-1;
  }

  .option-description {
    @apply text-sm text-gray-600 mb-4;
  }

  .option-input {
    @apply space-y-2;
  }

  /* Input Styles */
  .input-text,
  .input-number,
  .input-select {
    @apply w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors;
  }

  .input-textarea {
    @apply w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-accent-light focus:border-accent transition-colors resize-none h-32;
  }

  .file-input-group {
    @apply flex gap-2;
  }

  .file-input-group .input-text {
    @apply flex-1;
  }

  .browse-button {
    @apply px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-dark transition-colors border-none font-archivo font-semibold;
  }

  /* Checkbox Styles */
  .checkbox-container {
    @apply relative flex items-center cursor-pointer;
  }

  .input-checkbox {
    @apply sr-only;
  }

  .checkbox-checkmark {
    @apply w-5 h-5 bg-white border-2 border-gray-300 rounded flex items-center justify-center transition-colors;
  }

  .input-checkbox:checked + .checkbox-checkmark {
    @apply bg-accent border-accent;
  }

  .input-checkbox:not(:checked) + .checkbox-checkmark::after {
    content: '–';
    @apply text-gray-400 text-sm font-archivo;
  }

  .input-checkbox:checked + .checkbox-checkmark::after {
    content: '•';
    @apply text-white text-sm font-archivo;
  }

  /* Action Section */
  .action-section {
    @apply mt-8 p-6 bg-white rounded-lg border border-gray-200;
  }

  .action-title {
    @apply text-xl font-archivo font-semibold text-gray-900 mb-4;
  }

  .action-buttons {
    @apply flex flex-wrap gap-3 mb-4;
  }

  .action-button {
    @apply px-4 py-2 rounded-lg font-medium transition-colors border-none;
  }

  .action-button.primary {
    @apply bg-green-500 text-white hover:bg-green-600 disabled:bg-gray-400;
  }

  .action-button.secondary {
    @apply bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-400;
  }

  .action-button.danger {
    @apply bg-red-500 text-white hover:bg-red-600 disabled:bg-gray-400;
  }

  .action-button.warning {
    @apply bg-yellow-500 text-white hover:bg-yellow-600 disabled:bg-gray-400;
  }

  /* No Selection State */
  .no-selection {
    @apply flex-1 flex items-center justify-center;
  }

  .no-selection-content {
    @apply text-center space-y-4;
  }

  .no-selection-icon {
    @apply w-16 h-16 text-gray-400 mx-auto;
  }

  .no-selection-title {
    @apply text-2xl font-archivo font-semibold text-gray-900;
  }

  .no-selection-description {
    @apply text-gray-600;
  }

  /* Remove webkit number input spinners */
  .input-number::-webkit-inner-spin-button,
  .input-number::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
</style>
