<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    currentDownloads,
    failedSetups,
    setupLogs,
    redistributableInstalls,
    type FailedSetup,
  } from '../store';
  import {
    loadFailedSetups,
    removeFailedSetup,
    retryFailedSetup,
    pauseDownload,
    resumeDownload,
    cancelPausedDownload,
  } from '../utils';
  import * as d3 from 'd3';
  import SetupPrompt from '../components/SetupPrompt.svelte';
  import RedistributablesProgress from '../components/RedistributablesProgress.svelte';

  let chartContainer: HTMLDivElement | null = $state(null);
  let speedData: { time: Date; speed: number; downloadId: string }[] = $state(
    []
  );

  // Sort downloads by queue position lowest to highest
  let sortedDownloads = $state(
    $currentDownloads
      .slice()
      .sort((a, b) => (a.queuePosition || 999) - (b.queuePosition || 999))
  );

  let targetDownload = $derived(
    sortedDownloads.find(
      (download) =>
        download.status === 'downloading' && download.queuePosition === 1
    ) || undefined
  );

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

  function formatETA(etaMs: number): string {
    if (!etaMs || !isFinite(etaMs) || etaMs <= 0) {
      return '--';
    }

    const etaSec = Math.floor(etaMs / 1000);
    const hours = Math.floor(etaSec / 3600);
    const minutes = Math.floor((etaSec % 3600) / 60);
    const seconds = Math.floor(etaSec % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  function setupLog(event: Event) {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    let logs: string[] = event.detail.log;
    // Update the $setupLogs state for the given downloadID
    // if the logs are above 100, remove the first 50
    if (logs.length > 100) {
      logs = logs.slice(50);
    }
    setupLogs.update((otherLogs) => ({
      ...otherLogs,
      [downloadID]: {
        ...(otherLogs[downloadID] || {
          logs: [],
          progress: 0,
          isActive: true,
          downloadId: downloadID,
        }),
        logs: [...logs],
      },
    }));
  }

  function setupProgress(event: Event) {
    if (!isCustomEvent(event)) return;
    const downloadID = event.detail.id;
    const progress = event.detail.progress;
    setupLogs.update((otherLogs) => ({
      ...otherLogs,
      [downloadID]: {
        ...(otherLogs[downloadID] || {
          logs: [],
          progress: 0,
          isActive: true,
          downloadId: downloadID,
        }),
        progress,
      },
    }));
  }

  // Load failed setups and paused downloads when component mounts
  onMount(() => {
    loadFailedSetups();
    document.addEventListener('setup:log', setupLog);
    document.addEventListener('setup:progress', setupProgress);

    return () => {
      document.removeEventListener('setup:log', setupLog);
      document.removeEventListener('setup:progress', setupProgress);
    };
  });

  async function handleRetry(failedSetup: FailedSetup) {
    await retryFailedSetup(failedSetup);
  }

  function handleRemove(setupId: string) {
    removeFailedSetup(setupId);
  }
  function updateSpeedData() {
    const now = new Date();

    // Add current speeds to data
    sortedDownloads.forEach((download) => {
      if (download.status === 'downloading' && download.downloadSpeed > 0) {
        speedData.push({
          time: now,
          speed: download.downloadSpeed,
          downloadId: download.id,
        });
      }
    });

    // Keep only last 50 data points (last ~5 minutes if updated every 6 seconds)
    if (speedData.length > 50) {
      speedData = speedData.slice(-50);
    }

    // Update chart if we have data
    if (speedData.length > 0 && chartContainer) {
      createChart();
    }
  }

  function getDownloadStatistics() {
    if (!targetDownload) return null;

    const download = targetDownload;
    const totalSize = download.downloadSize;
    const currentSpeed = download.downloadSpeed;
    const downloadedSize = download.downloadSize * download.progress;
    const remainingSize = totalSize - downloadedSize;

    // Calculate ETA based on current speed
    let eta = 0;
    if (currentSpeed > 0 && remainingSize > 0) {
      eta = (remainingSize / currentSpeed) * 1000; // Convert to milliseconds
    }

    const progress = downloadedSize / totalSize;
    return {
      totalSize,
      currentSpeed,
      downloadedSize,
      remainingSize,
      eta,
      progress,
    };
  }

  function createChart() {
    if (!chartContainer || speedData.length === 0) return;

    // Clear existing chart
    d3.select(chartContainer).selectAll('*').remove();

    const margin = { top: 20, right: 30, bottom: 40, left: 60 };
    const width = chartContainer.clientWidth - margin.left - margin.right;
    const height = 200 - margin.top - margin.bottom;

    const svg = d3
      .select(chartContainer)
      .append('svg')
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales
    const xScale = d3
      .scaleTime()
      .domain(d3.extent(speedData, (d) => d.time) as [Date, Date])
      .range([0, width]);

    const yScale = d3
      .scaleLinear()
      .domain([0, d3.max(speedData, (d) => d.speed) || 0])
      .nice()
      .range([height, 0]);

    // Line generator
    const line = d3
      .line<{ time: Date; speed: number; downloadId: string }>()
      .x((d) => xScale(d.time))
      .y((d) => yScale(d.speed))
      .curve(d3.curveCardinal);

    // Group data by download ID
    const groupedData = Array.from(d3.group(speedData, (d) => d.downloadId));

    // Order IDs with the active/target download first for consistent dark coloring
    const idsOrdered = groupedData.map((d) => d[0]);
    if (targetDownload) {
      const idx = idsOrdered.indexOf(targetDownload.id);
      if (idx > 0) {
        idsOrdered.splice(idx, 1);
        idsOrdered.unshift(targetDownload.id);
      }
    }

    // Color scale from theme (accent and accent-dark)
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--theme-accent').trim() || '#428a91';
    const accentDark =
      style.getPropertyValue('--theme-accent-dark').trim() || '#2d626a';
    const borderColor =
      style.getPropertyValue('--theme-border').trim() || '#e5e7eb';
    const accentPalette = [accentDark, accent, accentDark, accent];
    const colorScale = d3
      .scaleOrdinal()
      .domain(idsOrdered)
      .range(accentPalette.slice(0, idsOrdered.length));

    // Add grid lines (theme border)
    g.selectAll('.grid-line-y')
      .data(yScale.ticks())
      .enter()
      .append('line')
      .attr('class', 'grid-line-y')
      .attr('x1', 0)
      .attr('x2', width)
      .attr('y1', (d) => yScale(d))
      .attr('y2', (d) => yScale(d))
      .attr('stroke', borderColor)
      .attr('stroke-width', 0.5)
      .attr('opacity', 0.7);

    // Add lines for each download
    groupedData.forEach(([downloadId, data]) => {
      if (data.length > 1) {
        g.append('path')
          .datum(data)
          .attr('fill', 'none')
          .attr('stroke', colorScale(downloadId) as string)
          .attr('stroke-width', 2)
          .attr('d', line);
      }
    });
  }

  let sub_currentDownloads = currentDownloads.subscribe((downloads) => {
    if (downloads.length > 0) {
      updateSpeedData();
    }
  });

  let sub_sortedDownloads = currentDownloads.subscribe((downloads) => {
    sortedDownloads = downloads
      .slice()
      .sort((a, b) => (a.queuePosition || 999) - (b.queuePosition || 999));
  });

  // Update chart every 5 seconds
  onMount(() => {
    const interval = setInterval(() => {
      updateSpeedData();
    }, 1000);

    return () => clearInterval(interval);
  });

  onDestroy(() => {
    sub_currentDownloads();
    sub_sortedDownloads();
  });
</script>

<!-- Speed Chart Section -->
{#if sortedDownloads.length > 0}
  {#if targetDownload}
    <div class="w-full flex flex-row gap-4 pl-1 mb-8">
      <div class="h-auto w-5/12 relative">
        <img
          src={targetDownload.coverImage}
          alt="Game cover"
          class="rounded-lg object-cover bg-no-repeat w-full h-full min-w-0 shadow-lg"
        />
        {#if targetDownload.queuePosition && targetDownload.queuePosition > 1}
          <div
            class="absolute top-2 left-2 bg-accent text-overlay-text text-xs font-bold px-2 py-1 rounded-full shadow-lg"
          >
            Queued #{targetDownload.queuePosition}
          </div>
        {/if}
      </div>

      <div class="w-7/12 h-full flex flex-col">
        <div class="chart-container" bind:this={chartContainer}></div>

        {#if getDownloadStatistics()}
          {@const stats = getDownloadStatistics()}
          {#if stats}
            <div
              class="mt-4 p-4 bg-accent-lighter rounded-lg border border-border"
            >
              <div class="grid grid-cols-2 gap-4">
                <div
                  class="flex items-center gap-3 p-3 bg-surface rounded-lg border border-border shadow-sm hover:shadow-md transition-all duration-200"
                >
                  <div class="p-2 bg-accent text-overlay-text rounded-lg">
                    <svg
                      fill="currentColor"
                      xmlns="http://www.w3.org/2000/svg"
                      height="24"
                      viewBox="0 0 24 24"
                      width="24"
                      ><path d="M0 0h24v24H0V0z" fill="none" /><path
                        d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"
                      /><path
                        d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"
                      /></svg
                    >
                  </div>
                  <div class="flex-1">
                    <div class="text-lg font-bold text-accent-dark">
                      {formatETA(stats?.eta)}
                    </div>
                    <div
                      class="text-xs font-medium text-accent-dark/70 uppercase tracking-wide"
                    >
                      ETA
                    </div>
                  </div>
                </div>
                <div
                  class="flex items-center gap-3 p-3 bg-surface rounded-lg border border-border shadow-sm hover:shadow-md transition-all duration-200"
                >
                  <div class="p-2 bg-accent text-overlay-text rounded-lg">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      width="24"
                      ><path d="M0 0h24v24H0z" fill="none" /><path
                        d="M19.46 10a1 1 0 0 0-.07 1 7.55 7.55 0 0 1 .52 1.81 8 8 0 0 1-.69 4.73 1 1 0 0 1-.89.53H5.68a1 1 0 0 1-.89-.54A8 8 0 0 1 13 6.06a7.69 7.69 0 0 1 2.11.56 1 1 0 0 0 1-.07 1 1 0 0 0-.17-1.76A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0 .55-8.89 1 1 0 0 0-1.75-.11z"
                      /><path
                        d="M10.59 12.59a2 2 0 0 0 2.83 2.83l5.66-8.49z"
                      /></svg
                    >
                  </div>
                  <div class="flex-1">
                    <div class="text-lg font-bold text-accent-dark">
                      {correctParsingSize(stats.currentSpeed)}/s
                    </div>
                    <div
                      class="text-xs font-medium text-accent-dark/70 uppercase tracking-wide"
                    >
                      Total Speed
                    </div>
                  </div>
                </div>

                <div
                  class="flex items-center gap-3 p-3 bg-surface rounded-lg border border-border shadow-sm hover:shadow-md transition-all duration-200"
                >
                  <div class="p-2 bg-accent text-overlay-text rounded-lg">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      enable-background="new 0 0 20 20"
                      height="20"
                      viewBox="0 0 20 20"
                      width="20"
                      fill="currentColor"
                      ><g><rect fill="none" height="20" width="20" /></g><g
                        ><g
                          ><path
                            d="M13,11.5v3c0,0.83,0.67,1.5,1.5,1.5h0c0.83,0,1.5-0.67,1.5-1.5v-3c0-0.83-0.67-1.5-1.5-1.5h0C13.67,10,13,10.67,13,11.5z"
                          /><path
                            d="M5.5,16L5.5,16C6.33,16,7,15.33,7,14.5v-5C7,8.67,6.33,8,5.5,8h0C4.67,8,4,8.67,4,9.5v5C4,15.33,4.67,16,5.5,16z"
                          /><path
                            d="M10,16L10,16c0.83,0,1.5-0.67,1.5-1.5v-9C11.5,4.67,10.83,4,10,4h0C9.17,4,8.5,4.67,8.5,5.5v9C8.5,15.33,9.17,16,10,16z"
                          /></g
                        ></g
                      ></svg
                    >
                  </div>
                  <div class="flex-1">
                    <div class="text-lg font-bold text-accent-dark">
                      {Math.floor(
                        (stats.downloadedSize / stats.totalSize) * 100
                      ) || '--'}%
                    </div>
                    <div
                      class="text-xs font-medium text-accent-dark/70 uppercase tracking-wide"
                    >
                      Progress
                    </div>
                  </div>
                </div>

                <div
                  class="flex items-center gap-3 p-3 bg-surface rounded-lg border border-border shadow-sm hover:shadow-md transition-all duration-200"
                >
                  <div class="p-2 bg-accent text-overlay-text rounded-lg">
                    <svg
                      fill="currentColor"
                      xmlns="http://www.w3.org/2000/svg"
                      height="24"
                      viewBox="0 0 24 24"
                      width="24"
                      ><path d="M0 0h24v24H0V0z" fill="none" /><path
                        d="M4 20h16c1.1 0 2-.9 2-2s-.9-2-2-2H4c-1.1 0-2 .9-2 2s.9 2 2 2zm0-3h2v2H4v-2zM2 6c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2s-.9-2-2-2H4c-1.1 0-2 .9-2 2zm4 1H4V5h2v2zm-2 7h16c1.1 0 2-.9 2-2s-.9-2-2-2H4c-1.1 0-2 .9-2 2s.9 2 2 2zm0-3h2v2H4v-2z"
                      /></svg
                    >
                  </div>
                  <div class="flex-1">
                    <div class="text-lg font-bold text-accent-dark">
                      {correctParsingSize(targetDownload?.downloadSize ?? 0)}
                    </div>
                    <div
                      class="text-xs font-medium text-accent-dark/70 uppercase tracking-wide"
                    >
                      Size
                    </div>
                  </div>
                </div>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
{:else}
  <div class="w-full h-48">
    <div class="flex items-center justify-center h-full">
      <div class="text-center">
        <div
          class="flex flex-col items-center justify-center h-full text-center p-8"
        >
          <div
            class="w-16 h-16 bg-accent-lighter rounded-full flex items-center justify-center mb-4"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24"
              viewBox="0 0 24 24"
              width="24"
              class="w-8 h-8 fill-accent-dark"
              fill="currentColor"
              ><path d="M0 0h24v24H0V0z" fill="none" /><path
                d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71zM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1z"
              /></svg
            >
          </div>
          <h3
            class="text-lg font-archivo font-semibold text-text-secondary mb-2"
          >
            No Downloads
          </h3>
          <p class="text-text-muted text-sm">
            You don't have any downloads yet.
          </p>
        </div>
      </div>
    </div>
  </div>
{/if}

<div class="container mx-auto max-w-6xl">
  <div class="downloads-grid">
    {#each sortedDownloads as download}
      <div
        data-id={download.id}
        class="download-card"
        class:queue-item={download.status === 'downloading' &&
          download.queuePosition &&
          download.queuePosition > 1}
      >
        <div class="flex flex-row gap-4 w-full">
          <div class="download-image">
            <img
              src={download.coverImage || './favicon.png'}
              alt="Game cover"
              class="game-cover"
            />
            <div class="status-indicator status-{download.status}"></div>
          </div>

          <div class="download-content">
            <div class="download-info">
              <h3 class="download-title">{download.name}</h3>
              {#if download.status === 'downloading' && download.queuePosition && download.queuePosition > 1}
                <div class="status-badge queued">
                  <div class="spinner"></div>
                  Queued {download.queuePosition === 999
                    ? '-'
                    : download.queuePosition}
                </div>
              {:else if download.status === 'downloading'}
                {@const stats =
                  download === targetDownload ? getDownloadStatistics() : null}
                <div class="progress-section">
                  <div class="progress-bar">
                    {#if isNaN(download.progress) || isNaN(download.progress * 100)}
                      <div class="progress-fill animate-pulse bg-accent"></div>
                    {:else}
                      <div
                        class="progress-fill"
                        style:width="{download.progress * 100}%"
                      ></div>
                    {/if}
                  </div>
                  <div class="progress-stats">
                    <span class="progress-percentage">
                      {#if isNaN(download.progress) || isNaN(download.progress * 100)}
                        Processing
                      {:else}
                        {Math.floor(download.progress * 100)}%
                      {/if}
                      {#if download.part && download.totalParts && download.totalParts > 1}
                        <span class="text-accent-dark/70 ml-1">
                          (Part {download.part}/{download.totalParts})
                        </span>
                      {/if}
                    </span>
                    {#if stats}
                      <span class="progress-eta">
                        ETA: {formatETA(stats.eta)}
                      </span>
                    {:else if download.queuePosition && download.queuePosition > 1}
                      <span class="progress-eta queue-text"> Queued </span>
                    {/if}
                  </div>
                </div>
              {:else if download.status === 'merging'}
                <div class="progress-section">
                  <div class="progress-bar">
                    <div
                      class="progress-fill"
                      style="width: {Math.min(download.progress * 100, 100)}%"
                    ></div>
                  </div>
                  <div class="progress-stats">
                    <span class="progress-percentage">
                      Merging files...
                      {#if download.part && download.totalParts && download.totalParts > 1}
                        <span class="text-accent-dark/70 ml-1">
                          (Part {download.part}/{download.totalParts})
                        </span>
                      {/if}
                    </span>
                  </div>
                </div>
              {:else if download.status === 'completed'}
                <div class="status-badge setup">
                  <div class="spinner"></div>
                  Setting up with {download.addonSource}
                </div>
              {:else if download.status === 'redistr-downloading'}
                <div class="status-badge redistr-downloading">
                  <div class="spinner"></div>
                  Downloading Redistributables
                </div>
              {:else if download.status === 'installing-redistributables'}
                <div class="status-badge installing-redistributables">
                  <div class="spinner"></div>
                  Installing Dependencies
                </div>
              {:else if download.status === 'setup-complete'}
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
              {:else if download.status === 'error'}
                <div class="status-badge error">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fill-rule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                      clip-rule="evenodd"
                    ></path>
                  </svg>
                  {download.status === 'error'
                    ? 'Download Failed'
                    : 'Setup Failed'}
                </div>
              {:else if download.status === 'rd-downloading'}
                <div class="status-badge downloading">
                  <div class="spinner"></div>
                  {download.usedDebridService === 'realdebrid'
                    ? 'Real-Debrid Processing'
                    : download.usedDebridService === 'alldebrid'
                      ? 'AllDebrid Processing'
                      : download.usedDebridService === 'torbox'
                        ? 'TorBox Processing'
                        : download.usedDebridService === 'premiumize'
                          ? 'Premiumize Processing'
                          : 'Processing with ' + download.usedDebridService}
                </div>
              {:else if download.status === 'requesting'}
                <div class="status-badge requesting">
                  <div class="spinner"></div>
                  Requesting Download
                </div>
              {:else if download.status === 'seeding'}
                <div class="status-badge seeding">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
                    ></path>
                  </svg>
                  <div class="flex flex-row gap-2 items-center">
                    <span>Seeding</span>
                    {#if download.ratio !== undefined && !isNaN(download.ratio)}
                      <span class="text-xs opacity-90"> • </span>
                      <span class="text-xs opacity-90"
                        >Ratio: {download.ratio.toFixed(2)}</span
                      >
                    {/if}
                  </div>
                </div>
              {:else if download.status === 'paused'}
                <div class="status-badge paused">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      d="M6 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1zM14 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1z"
                    ></path>
                  </svg>
                  Paused
                </div>
              {/if}
            </div>

            <div class="download-actions">
              {#if download.status === 'setup-complete'}
                <button
                  class="btn btn-primary btn-sm"
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
                  Open
                </button>
              {:else if download.status === 'downloading' && download.queuePosition && download.queuePosition > 1}
                <button
                  class="text-overlay-text border-none p-4 rounded-lg bg-accent hover:bg-accent-dark transition-colors"
                  onclick={() => window.electronAPI.queue.cancel(download.id)}
                  aria-label="Cancel Download"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    width="24"
                  >
                    <path
                      d="M8 6h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2z"
                    />
                  </svg>
                </button>
              {:else if download.status === 'downloading'}
                <!-- PAUSE BUTTON -->
                <button
                  class="text-overlay-text border-none p-4 rounded-lg bg-accent hover:bg-accent-dark transition-colors"
                  aria-label="Pause Download"
                  onclick={async () => {
                    if (download.queuePosition && download.queuePosition > 1) {
                      window.electronAPI.queue.cancel(download.id);
                    } else {
                      await pauseDownload(download.id);
                    }
                  }}
                >
                  <svg
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                    height="24"
                    viewBox="0 0 24 24"
                    width="24"
                    ><path d="M0 0h24v24H0V0z" fill="none" /><path
                      d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"
                    /></svg
                  >
                </button>
              {:else if download.status === 'paused'}
                <!-- RESUME BUTTON -->
                <button
                  class="text-overlay-text border-none p-3 rounded-lg bg-success hover:bg-success-hover transition-colors mr-2"
                  aria-label="Resume Download"
                  onclick={async () => {
                    await resumeDownload(download.id);
                  }}
                >
                  <svg
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                    height="20"
                    viewBox="0 0 24 24"
                    width="20"
                    ><path d="M0 0h24v24H0V0z" fill="none" /><path
                      d="M8 5v14l11-7z"
                    /></svg
                  >
                </button>
                <!-- ABORT BUTTON -->
                <button
                  class="text-overlay-text border-none p-3 rounded-lg bg-error hover:bg-error-hover transition-colors"
                  aria-label="Cancel Download"
                  onclick={() => cancelPausedDownload(download.id)}
                >
                  <svg
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                    height="20"
                    viewBox="0 0 24 24"
                    width="20"
                    ><path d="M0 0h24v24H0V0z" fill="none" /><path
                      d="M18.3 5.71c-.39-.39-1.02-.39-1.41 0L12 10.59 7.11 5.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L10.59 12 5.7 16.89c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L12 13.41l4.89 4.89c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"
                    /></svg
                  >
                </button>
              {/if}
            </div>
          </div>
        </div>
        {#if download.status === 'completed' && $setupLogs[download.id]?.isActive}
          <div class="mt-3 w-full">
            <SetupPrompt
              setupLog={$setupLogs[download.id]}
              downloadName={download.name}
              addonSource={download.addonSource}
            />
          </div>
        {/if}
        {#if download.status === 'installing-redistributables' && $redistributableInstalls[download.id]}
          <div class="mt-4">
            <RedistributablesProgress
              setup={$redistributableInstalls[download.id]}
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<!-- Failed Setups Section -->
{#if $failedSetups.length > 0}
  <div class="container mx-auto py-6 max-w-6xl">
    <div class="flex items-center gap-3 mb-4">
      <div
        class="w-1 h-6 bg-linear-to-b from-error to-warning rounded-full"
      ></div>
      <h2 class="text-2xl font-bold text-text-primary">Failed Setups</h2>
      <span
        class="bg-error/20 text-error text-xs font-medium px-2 py-1 rounded-full"
      >
        {$failedSetups.length}
      </span>
    </div>

    <div class="failed-setups-compact">
      {#each $failedSetups as failedSetup}
        <div class="failed-setup-compact">
          <div class="failed-setup-header">
            <div class="failed-setup-image">
              <img
                src={failedSetup.downloadInfo.coverImage || './favicon.png'}
                alt="Game cover"
                class="game-cover"
              />
              <div class="status-indicator status-error"></div>
            </div>

            <div class="failed-setup-info">
              <h3 class="failed-setup-title">
                {failedSetup.downloadInfo.name}
              </h3>
              <div class="failed-setup-meta">
                <span class="error-time">
                  {new Date(failedSetup.timestamp).toLocaleDateString()}
                </span>
                <!-- <span class="retry-count">
                  {failedSetup.retryCount} retr{failedSetup.retryCount !== 1
                    ? 'ies'
                    : 'y'}
                </span> -->
              </div>
            </div>
          </div>

          <div class="failed-setup-error">
            <p class="error-message">{failedSetup.error}</p>
          </div>

          <div class="failed-setup-actions">
            <button
              class="btn btn-primary btn-sm"
              onclick={() => handleRetry(failedSetup)}
            >
              <svg
                class="w-4 h-4 mr-1"
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
              Retry
            </button>
            <button
              class="btn btn-danger btn-sm"
              onclick={() => handleRemove(failedSetup.id)}
            >
              <svg
                class="w-4 h-4 mr-1"
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
      {/each}
    </div>
  </div>
{/if}

<style>
  @reference "../app.css";

  /* Chart Styles */
  .chart-section {
    @apply bg-surface rounded-lg shadow-md border border-border p-6 mb-8;
  }

  .chart-container {
    @apply w-full h-52 bg-background-color rounded-lg border border-border;
  }

  /* Button System */
  .btn {
    @apply inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed;
  }

  .btn-primary {
    @apply bg-accent text-overlay-text hover:bg-accent-dark focus:ring-accent shadow-md hover:shadow-lg;
  }

  .btn-secondary {
    @apply bg-accent-lighter text-accent-dark hover:bg-accent-light focus:ring-accent border border-accent-light;
  }

  .btn-danger {
    @apply bg-error text-overlay-text hover:bg-error-hover focus:ring-error shadow-md hover:shadow-lg;
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
    @apply flex flex-col items-center justify-center text-center py-16 px-8 bg-bg-secondary rounded-2xl border-2 border-dashed border-border;
  }

  .empty-state-icon {
    @apply mb-4 p-4 bg-bg-secondary rounded-full;
  }

  /* Downloads Grid */
  .downloads-grid {
    @apply grid gap-3 mb-12;
    grid-template-columns: 1fr;
  }

  .download-card {
    @apply bg-accent-lighter rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden flex flex-col items-center p-4 gap-4;
  }

  .download-image {
    @apply relative w-16 h-16 overflow-hidden rounded-lg flex-shrink-0;
    background: linear-gradient(
      to bottom right,
      var(--theme-border),
      var(--theme-border-strong)
    );
  }

  .game-cover {
    @apply w-full h-full object-cover;
  }

  .status-indicator {
    @apply absolute top-1 right-1 w-2 h-2 rounded-full;
  }

  .status-downloading {
    background: var(--theme-accent);
  }
  .status-completed {
    background: var(--theme-warning);
  }
  .status-setup-complete {
    background: var(--theme-success);
  }
  .status-seeding {
    background: var(--theme-info);
  }
  .status-error {
    background: var(--theme-error);
  }
  .status-rd-downloading {
    background: var(--theme-warning);
  }
  .status-requesting {
    background: var(--theme-accent);
  }
  .status-errored {
    background: var(--theme-error);
  }
  .status-paused {
    background: var(--theme-warning);
  }
  .status-merging {
    background: var(--theme-info);
  }

  .download-content {
    @apply flex-1 flex items-center justify-between gap-4;
  }

  .download-info {
    @apply flex-1 flex flex-col gap-2;
  }

  .download-title {
    @apply text-sm font-semibold text-text-primary truncate;
  }

  .progress-section {
    @apply space-y-1;
  }

  .progress-bar {
    @apply w-full h-2 bg-accent-light rounded-full overflow-hidden;
  }

  .progress-fill {
    @apply h-full bg-accent rounded-full transition-all duration-300;
  }

  .progress-stats {
    @apply flex justify-between text-xs text-text-secondary;
  }

  .progress-percentage {
    @apply font-medium text-accent-dark;
  }

  .progress-eta {
    @apply text-text-muted;
  }

  .download-actions {
    @apply flex-shrink-0;
  }

  /* Status Badges */
  .status-badge {
    @apply inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg;
  }

  .status-badge.seeding {
    background: color-mix(in srgb, var(--theme-info) 18%, transparent);
    color: var(--theme-info);
  }

  .status-badge.redistr-downloading {
    background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
    color: var(--theme-warning-hover);
  }

  .status-badge.installing-redistributables {
    @apply bg-accent-lighter text-accent-dark;
  }

  .status-badge.setup {
    background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
    color: var(--theme-warning-hover);
  }

  .status-badge.error {
    background: color-mix(in srgb, var(--theme-error) 18%, transparent);
    color: var(--theme-error);
  }

  .status-badge.complete {
    background: color-mix(in srgb, var(--theme-success) 18%, transparent);
    color: var(--theme-success-hover);
  }

  .status-badge.downloading {
    @apply bg-accent-lighter text-accent-dark;
  }

  .status-badge.queued {
    @apply bg-accent-lighter text-accent-dark;
  }

  .status-badge.requesting {
    @apply bg-accent-lighter text-accent-dark;
  }

  .status-badge.errored {
    background: color-mix(in srgb, var(--theme-error) 18%, transparent);
    color: var(--theme-error);
  }

  .status-badge.paused {
    background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
    color: var(--theme-warning-hover);
  }

  .status-badge.merging {
    background: color-mix(in srgb, var(--theme-info) 18%, transparent);
    color: var(--theme-info-hover);
  }

  /* Spinner Animation */
  .spinner {
    @apply w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin;
  }

  /* Compact Failed Setups */
  .failed-setups-compact {
    @apply space-y-3;
  }

  .failed-setup-compact {
    @apply bg-surface rounded-lg shadow-sm hover:shadow-md transition-all duration-200 p-4;
    border: 1px solid color-mix(in srgb, var(--theme-error) 35%, transparent);
  }

  .failed-setup-header {
    @apply flex items-center gap-3 mb-3;
  }

  .failed-setup-image {
    @apply relative w-12 h-12 overflow-hidden rounded-lg flex-shrink-0;
    background: linear-gradient(
      to bottom right,
      var(--theme-border),
      var(--theme-border-strong)
    );
  }

  .failed-setup-info {
    @apply flex-1 min-w-0;
  }

  .failed-setup-title {
    @apply text-sm font-semibold text-text-primary truncate mb-1;
  }

  .failed-setup-meta {
    @apply flex items-center gap-2 text-xs text-text-muted;
  }

  .error-time {
    @apply font-medium;
  }

  .retry-count {
    background: color-mix(in srgb, var(--theme-error) 18%, transparent);
    color: var(--theme-error);
    @apply px-2 py-0.5 rounded-md font-medium;
  }

  .failed-setup-error {
    @apply mb-3 p-3 rounded-md;
    background: color-mix(in srgb, var(--theme-error) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
  }

  .error-message {
    @apply text-sm leading-relaxed;
    color: var(--theme-error);
  }

  .failed-setup-actions {
    @apply flex gap-2;
  }

  /* Queue Position Styles */
  .queue-position-badge {
    @apply absolute top-1 left-1 text-overlay-text text-xs font-bold px-2 py-1 rounded-full shadow-lg;
    backdrop-filter: blur(4px);
    background-color: var(--theme-accent-dark);
  }

  .active-download-badge {
    @apply absolute top-1 left-1 text-overlay-text text-xs font-bold px-2 py-1 rounded-full shadow-lg flex items-center gap-1;
    backdrop-filter: blur(4px);
    background-color: var(--theme-success);
  }

  .queue-item {
    @apply opacity-75 bg-linear-to-r from-accent-lighter to-accent-light/50;
    border-left: 3px solid var(--color-accent);
  }

  .queue-item:hover {
    @apply opacity-90;
  }

  .queue-text {
    @apply text-accent-dark font-medium;
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

    .chart-container {
      @apply h-40;
    }

    .queue-position-badge,
    .active-download-badge {
      @apply text-xs px-1.5 py-0.5;
    }
  }

  .status-badge.installing-redistributables {
    background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
    color: var(--theme-warning-hover);
  }
</style>
