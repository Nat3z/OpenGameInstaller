<script lang="ts">
  import { onMount } from 'svelte';
  import { currentDownloads, failedSetups } from '../store';
  import {
    loadFailedSetups,
    removeFailedSetup,
    retryFailedSetup,
  } from '../utils';
  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }
  function correctParsingSize(size: number) {
    if (size < 1024) {
      return size + 'B';
    } else if (size < 1024 * 1024) {
      return (size / 1024).toFixed(2) + 'KB';
    } else if (size < 1024 * 1024 * 1024) {
      return (size / (1024 * 1024)).toFixed(2) + 'MB';
    } else {
      return (size / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
    }
  }

  document.addEventListener('setup:log', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const log: string[] = event.detail.log;
    const download = document.querySelector(`[data-id="${downloadID}"]`);
    if (download === null) return;
    const code = download.querySelector('code')!!;
    code.innerHTML = '';
    // make each line a new line without using innerHTML
    log.forEach((line) => {
      const textNode = document.createTextNode(line);
      code.appendChild(textNode);
      code.appendChild(document.createElement('br'));
    });
    code.scrollTop = code.scrollHeight;
  });

  document.addEventListener('setup:progress', (event: Event) => {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    const download = document.querySelector(`[data-id="${downloadID}"]`);
    if (download === null) return;
    const progressBar = download.querySelector('progress')!!;
    progressBar.value = progress;
  });

  // taken from: https://stackoverflow.com/questions/14783869/convert-a-decimal-number-to-a-fraction-rational-number
  var toFraction = function (dec: number) {
    var is_neg = dec < 0;
    dec = Math.abs(dec);
    var done = false;
    //you can adjust the epsilon to a larger number if you don't need very high precision
    var n1 = 0,
      d1 = 1,
      n2 = 1,
      d2 = 0,
      n = 0,
      q = dec,
      num = 0,
      den = 0,
      epsilon = 1e-13;
    while (!done) {
      n++;
      if (n > 10000) {
        done = true;
      }
      var a = q;
      num = n1 + a * n2;
      den = d1 + a * d2;
      var e = q - a;
      if (e < epsilon) {
        done = true;
      }
      q = 1 / e;
      n1 = n2;
      d1 = d2;
      n2 = num;
      d2 = den;
      if (Math.abs(num / den - dec) < epsilon || n > 30) {
        done = true;
      }
    }
    return [is_neg ? -num : num, den];
  };
  function toRatio(x: number) {
    const fraction = toFraction(x);
    return (
      (fraction[0] < 1 ? fraction[0].toFixed(2) : fraction[0]) +
      ':' +
      (fraction[1] < 1 ? fraction[1].toFixed(2) : fraction[1])
    );
  }

  // Load failed setups when component mounts
  onMount(() => {
    loadFailedSetups();
  });

  async function handleRetry(failedSetup: any) {
    await retryFailedSetup(failedSetup);
  }

  function handleRemove(setupId: string) {
    removeFailedSetup(setupId);
  }

  function clearCompletedDownloads() {
    currentDownloads.update((downloads) => {
      return downloads.filter(
        (download) =>
          download.status !== 'setup-complete' &&
          download.status !== 'error' &&
          download.status !== 'errored' &&
          download.status !== 'seeding'
      );
    });
  }

  function clearAllDownloads() {
    currentDownloads.update(() => []);
  }
</script>

<div class="container mx-auto px-6 py-8 max-w-6xl">
  {#if $currentDownloads.length > 0}
    <div class="downloads-header">
      <div class="flex items-center gap-3 mb-6">
        <div
          class="w-1 h-8 bg-gradient-to-b from-accent to-accent-light rounded-full"
        ></div>
        <h2 class="text-3xl font-bold text-gray-900">Active Downloads</h2>
        <span
          class="bg-blue-100 text-blue-800 text-sm font-medium px-3 py-1 rounded-full"
        >
          {$currentDownloads.length}
        </span>
      </div>
      <div class="downloads-actions">
        <button class="btn btn-secondary" onclick={clearCompletedDownloads}>
          <svg
            class="w-4 h-4 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            ></path>
          </svg>
          Clear Completed
        </button>
        <button class="btn btn-danger" onclick={clearAllDownloads}>
          <svg
            class="w-4 h-4 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            ></path>
          </svg>
          Clear All
        </button>
      </div>
    </div>
  {:else}
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg
          class="w-16 h-16 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
          ></path>
        </svg>
      </div>
      <h3 class="text-2xl font-semibold text-gray-900 mb-2">
        No Active Downloads
      </h3>
      <p class="text-gray-600">
        Your downloads will appear here when you start downloading games.
      </p>
    </div>
  {/if}

  <div class="downloads-grid">
    {#each $currentDownloads as download}
      <div data-id={download.id} class="download-card">
        <div class="download-image">
          <img
            src={download.coverURL || './favicon.png'}
            alt="Game cover"
            class="game-cover"
          />
          <div class="status-indicator status-{download.status}"></div>
        </div>

        <div class="download-content">
          {#if download.status === 'seeding' && download.ratio !== undefined}
            <div class="status-badge seeding">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
                ></path>
              </svg>
              Seeding
            </div>
            <div class="metrics-grid">
              <div class="metric-card">
                <div class="metric-value text-blue-600">
                  {toRatio(download.ratio)}
                </div>
                <div class="metric-label">Ratio</div>
              </div>
              <div class="metric-card">
                <div class="metric-value text-emerald-600">
                  {correctParsingSize(Math.floor(download.downloadSpeed))}/s
                </div>
                <div class="metric-label">Upload Speed</div>
              </div>
              <div class="metric-card">
                <div class="metric-value text-gray-700">
                  {correctParsingSize(download.downloadSize)}
                </div>
                <div class="metric-label">Total Size</div>
              </div>
            </div>
          {/if}

          {#if download.status === 'completed'}
            <div class="status-badge setup">
              <div class="spinner"></div>
              Setting up with {download.addonSource}
            </div>
            <div class="setup-section">
              <progress class="setup-progress" value="0" max="100"></progress>
              <div class="setup-log">
                <code class="log-content"></code>
              </div>
            </div>
          {:else if download.status === 'error'}
            <div class="status-badge error">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Download Failed
              <p class="text-sm text-gray-500">{download.error}</p>
            </div>
          {:else if download.status === 'errored'}
            <div class="status-badge errored">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Setup Failed
              <p class="text-sm text-gray-500">{download.error}</p>
            </div>
          {:else if download.status === 'setup-complete' || download.status === 'seeding'}
            {#if download.status === 'setup-complete'}
              <div class="status-badge complete">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fill-rule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clip-rule="evenodd"
                  ></path>
                </svg>
                Setup Complete
              </div>
            {/if}
            <button
              class="btn btn-primary w-full"
              onclick={() =>
                window.electronAPI.fs.showFileLoc(download.downloadPath)}
            >
              <svg
                class="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2v0"
                ></path>
              </svg>
              Open Game Folder
            </button>
          {:else if download.status === 'rd-downloading'}
            <div class="status-badge downloading">
              <div class="spinner"></div>
              Real-Debrid Processing
            </div>
          {:else if download.status === 'requesting'}
            <div class="status-badge requesting">
              <div class="spinner"></div>
              Requesting Download
            </div>
          {:else}
            <div class="metrics-grid">
              <div class="metric-card">
                <div class="metric-value text-blue-600">
                  {Math.floor(download.progress * 100)}%
                </div>
                <div class="metric-label">Downloaded</div>
              </div>
              <div class="metric-card">
                <div class="metric-value text-emerald-600">
                  {correctParsingSize(download.downloadSpeed)}/s
                </div>
                <div class="metric-label">Speed</div>
              </div>
              <div class="metric-card">
                <div class="metric-value text-gray-700">
                  {correctParsingSize(download.downloadSize)}
                </div>
                <div class="metric-label">Size</div>
              </div>
            </div>

            {#if download.part !== undefined}
              <div class="parts-section">
                <div class="part-indicator">
                  <span class="part-current">Part {download.part}</span>
                  <span class="part-separator">of</span>
                  <span class="part-total">{download.totalParts}</span>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<!-- Failed Setups Section -->
{#if $failedSetups.length > 0}
  <div class="container mx-auto px-6 max-w-6xl">
    <div class="flex items-center gap-3 mb-6">
      <div
        class="w-1 h-8 bg-gradient-to-b from-red-500 to-orange-600 rounded-full"
      ></div>
      <h2 class="text-3xl font-bold text-gray-900">Failed Setups</h2>
      <span
        class="bg-red-100 text-red-800 text-sm font-medium px-3 py-1 rounded-full"
      >
        {$failedSetups.length}
      </span>
    </div>

    <div class="failed-setups-grid">
      {#each $failedSetups as failedSetup}
        <div class="failed-setup-card">
          <div class="failed-setup-image">
            <img
              src={failedSetup.downloadInfo.coverURL || './favicon.png'}
              alt="Game cover"
            />
            <div class="error-indicator">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                ></path>
              </svg>
            </div>
          </div>

          <div class="failed-setup-content">
            <h3 class="failed-setup-title">{failedSetup.downloadInfo.name}</h3>
            <div class="error-details">
              <p class="error-message">
                <span class="error-label">Error:</span>
                {failedSetup.error}
              </p>
              <div class="error-meta">
                <span class="error-time">
                  Failed: {new Date(failedSetup.timestamp).toLocaleString()}
                </span>
                <span class="retry-count">
                  {failedSetup.retryCount} retr{failedSetup.retryCount !== 1
                    ? 'ies'
                    : 'y'}
                </span>
              </div>
            </div>
            <div class="failed-setup-actions">
              <button
                class="btn btn-primary btn-sm"
                onclick={() => handleRetry(failedSetup)}
              >
                <svg
                  class="w-4 h-4 mr-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  ></path>
                </svg>
                Retry Setup
              </button>
              <button
                class="btn btn-danger btn-sm"
                onclick={() => handleRemove(failedSetup.id)}
              >
                <svg
                  class="w-4 h-4 mr-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  ></path>
                </svg>
                Remove
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Button System */
  .btn {
    @apply inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed;
  }

  .btn-primary {
    @apply bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500 shadow-md hover:shadow-lg;
  }

  .btn-secondary {
    @apply bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-500 border border-gray-300;
  }

  .btn-danger {
    @apply bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 shadow-md hover:shadow-lg;
  }

  .btn-sm {
    @apply px-3 py-1.5 text-xs;
  }

  /* Layout */
  .downloads-header {
    @apply flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8;
  }

  .downloads-actions {
    @apply flex flex-wrap gap-3;
  }

  .empty-state {
    @apply flex flex-col items-center justify-center text-center py-16 px-8 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-300;
  }

  .empty-state-icon {
    @apply mb-4 p-4 bg-gray-100 rounded-full;
  }

  /* Downloads Grid */
  .downloads-grid {
    @apply grid gap-6 mb-12;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  }

  .download-card {
    @apply bg-white rounded-xl shadow-md hover:shadow-lg transition-all duration-300 overflow-hidden border border-gray-200;
  }

  .download-image {
    @apply relative h-48 bg-gradient-to-br from-gray-100 to-gray-200 overflow-hidden;
  }

  .game-cover {
    @apply w-full h-full object-cover;
  }

  .status-indicator {
    @apply absolute top-3 right-3 w-3 h-3 rounded-full;
  }

  .status-downloading {
    @apply bg-blue-500;
  }
  .status-completed {
    @apply bg-yellow-500;
  }
  .status-setup-complete {
    @apply bg-green-500;
  }
  .status-seeding {
    @apply bg-purple-500;
  }
  .status-error {
    @apply bg-red-500;
  }
  .status-rd-downloading {
    @apply bg-orange-500;
  }
  .status-requesting {
    @apply bg-indigo-500;
  }
  .status-errored {
    @apply bg-red-600;
  }

  .download-content {
    @apply p-6 space-y-4;
  }

  /* Status Badges */
  .status-badge {
    @apply inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg;
  }

  .status-badge.seeding {
    @apply bg-purple-100 text-purple-800;
  }

  .status-badge.setup {
    @apply bg-yellow-100 text-yellow-800;
  }

  .status-badge.error {
    @apply bg-red-100 text-red-800;
  }

  .status-badge.complete {
    @apply bg-green-100 text-green-800;
  }

  .status-badge.downloading {
    @apply bg-blue-100 text-blue-800;
  }

  .status-badge.requesting {
    @apply bg-indigo-100 text-indigo-800;
  }

  .status-badge.errored {
    @apply bg-red-100 text-red-800;
  }

  /* Metrics */
  .metrics-grid {
    @apply grid grid-cols-3 gap-4;
  }

  .metric-card {
    @apply text-center p-3 bg-gray-50 rounded-lg;
  }

  .metric-value {
    @apply text-lg font-bold;
  }

  .metric-label {
    @apply text-xs font-medium text-gray-500 uppercase tracking-wide mt-1;
  }

  /* Setup Section */
  .setup-section {
    @apply space-y-3;
  }

  .setup-progress {
    @apply w-full h-2 rounded-full overflow-hidden;
    background-color: #e5e7eb;
  }

  .setup-progress::-webkit-progress-bar {
    @apply bg-gray-200 rounded-full;
  }

  .setup-progress::-webkit-progress-value {
    @apply bg-gradient-to-r from-blue-500 to-purple-600 rounded-full;
  }

  .setup-log {
    @apply bg-gray-900 rounded-lg p-4 max-h-32 overflow-y-auto;
  }

  .log-content {
    @apply block text-green-400 text-sm font-mono leading-relaxed whitespace-pre-wrap;
  }

  /* Parts Section */
  .parts-section {
    @apply border-t border-gray-200 pt-4;
  }

  .part-indicator {
    @apply flex items-center justify-center gap-2 text-sm;
  }

  .part-current {
    @apply font-semibold text-blue-600;
  }

  .part-separator {
    @apply text-gray-500;
  }

  .part-total {
    @apply font-semibold text-gray-700;
  }

  /* Spinner Animation */
  .spinner {
    @apply w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin;
  }

  /* Failed Setups */
  .failed-setups-grid {
    @apply grid gap-4;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  }

  .failed-setup-card {
    @apply bg-white rounded-xl shadow-md border border-red-200 overflow-hidden hover:shadow-lg transition-all duration-300;
  }

  .failed-setup-image {
    @apply relative h-32 bg-gradient-to-br from-red-50 to-red-100 overflow-hidden;
  }

  .failed-setup-image img {
    @apply w-full h-full object-cover;
  }

  .error-indicator {
    @apply absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center;
  }

  .failed-setup-content {
    @apply p-5 space-y-4;
  }

  .failed-setup-title {
    @apply text-lg font-semibold text-gray-900 truncate;
  }

  .error-details {
    @apply space-y-2;
  }

  .error-message {
    @apply text-sm;
  }

  .error-label {
    @apply font-medium text-red-700;
  }

  .error-meta {
    @apply flex flex-col sm:flex-row sm:justify-between gap-1 text-xs text-gray-500;
  }

  .error-time {
    @apply font-medium;
  }

  .retry-count {
    @apply bg-gray-100 px-2 py-1 rounded-md;
  }

  .failed-setup-actions {
    @apply flex gap-3 pt-2;
  }

  /* Responsive Design */
  @media (max-width: 640px) {
    .downloads-grid {
      grid-template-columns: 1fr;
    }

    .metrics-grid {
      @apply grid-cols-1 gap-2;
    }

    .metric-card {
      @apply flex justify-between items-center p-2;
    }

    .metric-value {
      @apply text-base;
    }

    .failed-setups-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
