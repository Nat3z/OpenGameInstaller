<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { onMount, onDestroy } from 'svelte';
  import {
    notificationHistory,
    showNotificationSideView,
    deferredTasks,
    type Notification,
    removedTasks,
  } from '../store';
  import { loadDeferredTasks, clearAllTasks } from '../utils';

  let sideViewElement: HTMLElement | null = $state(null);
  let currentTab: 'notifications' | 'tasks' = $state('notifications');
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let scrollContainer: HTMLDivElement | null = $state(null);
  let logContainers: Map<string, HTMLDivElement> = $state(new Map());
  let previousLogLengths: Map<string, number> = new Map();

  function startTaskPolling() {
    const pollInterval = setInterval(async () => {
      await loadDeferredTasks($removedTasks);
    }, 1000);

    return pollInterval;
  }

  function stopTaskPolling(intervalId: ReturnType<typeof setInterval>) {
    clearInterval(intervalId);
  }

  // Load tasks when component mounts
  onMount(async () => {
    await loadDeferredTasks();
    pollInterval = startTaskPolling();
  });

  // Cleanup polling on destroy
  onDestroy(() => {
    if (pollInterval) {
      stopTaskPolling(pollInterval);
    }
  });

  $effect(() => {
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Auto-scroll logs when new log entries are added
  $effect(() => {
    $deferredTasks.forEach((task) => {
      if (task.logs && task.logs.length > 0) {
        const container = logContainers.get(task.id);
        const previousLength = previousLogLengths.get(task.id) || 0;

        if (container && task.logs.length > previousLength) {
          // New logs were added, scroll to bottom
          container.scrollTop = container.scrollHeight;
        }

        previousLogLengths.set(task.id, task.logs.length);
      }
    });
  });

  function formatTimestamp(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  function formatDuration(milliseconds?: number): string {
    if (!milliseconds) return '0s';
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  function getNotificationIcon(type: Notification['type']): string {
    return `./${type}.svg`;
  }

  function getTaskStatusIcon(status: string): string {
    switch (status) {
      case 'running':
        return './tasks.svg';
      case 'completed':
        return './success.svg';
      case 'error':
        return './error.svg';
      case 'pending':
        return './warning.svg';
      case 'cancelled':
        return './close.svg';
      default:
        return './info.svg';
    }
  }

  function closeSideView() {
    showNotificationSideView.set(false);
  }

  function clearAllNotifications() {
    notificationHistory.set([]);
  }

  function handleClearCompletedTasks() {
    clearAllTasks(
      $deferredTasks
        .map((task) => {
          if (
            task.status === 'completed' ||
            task.status === 'error' ||
            task.status === 'cancelled'
          ) {
            return task.id;
          } else {
            return undefined;
          }
        })
        .filter((task) => task !== undefined)
    );
  }

  function handleClearAllTasks() {
    clearAllTasks($deferredTasks.map((task) => task.id));
  }

  function handleClickOutside(event: MouseEvent) {
    if (
      sideViewElement &&
      event.target &&
      !sideViewElement.contains(event.target as Node)
    ) {
      closeSideView();
    }
  }

  function registerLogContainer(element: HTMLDivElement, taskId: string) {
    logContainers.set(taskId, element);

    return {
      destroy() {
        logContainers.delete(taskId);
      },
    };
  }
</script>

{#if $showNotificationSideView}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black bg-opacity-25 z-[100] pointer-events-auto"
    in:fade={{ duration: 200 }}
    out:fade={{ duration: 200 }}
    onclick={handleClickOutside}
  ></div>

  <!-- Side Panel -->
  <div
    bind:this={sideViewElement}
    class="fixed right-0 top-0 h-full w-96 bg-background-color shadow-2xl z-[101] flex flex-col"
    in:fly={{ x: 384, duration: 300, easing: quintOut }}
    out:fly={{ x: 384, duration: 200 }}
  >
    <!-- Header with Tabs -->
    <div class="flex flex-col">
      <div class="flex items-center justify-between p-6 pb-3">
        <div class="flex items-center gap-3">
          {#if currentTab === 'notifications'}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 50 50"
              fill="none"
              class="w-6 h-6 fill-accent-dark"
            >
              <g clip-path="url(#clip0_22_1842)">
                <path
                  d="M25 45.8333C27.2917 45.8333 29.1667 43.9583 29.1667 41.6666H20.8333C20.8333 43.9583 22.6875 45.8333 25 45.8333ZM37.5 33.3333V22.9166C37.5 16.5208 34.0833 11.1666 28.125 9.74998V8.33331C28.125 6.60415 26.7292 5.20831 25 5.20831C23.2708 5.20831 21.875 6.60415 21.875 8.33331V9.74998C15.8958 11.1666 12.5 16.5 12.5 22.9166V33.3333L9.81249 36.0208C8.49999 37.3333 9.41665 39.5833 11.2708 39.5833H38.7083C40.5625 39.5833 41.5 37.3333 40.1875 36.0208L37.5 33.3333Z"
                  fill="#2D626A"
                />
              </g>
              <defs>
                <clipPath id="clip0_22_1842">
                  <rect width="50" height="50" fill="white" />
                </clipPath>
              </defs>
            </svg>
            <h2 class="text-xl font-archivo font-bold text-accent-dark">
              Notifications
            </h2>
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              class="w-6 h-6 fill-accent-dark"
            >
              <path d="M0 0h24v24H0V0z" fill="none" /><path
                d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm1 14H8c-.55 0-1-.45-1-1s.45-1 1-1h5c.55 0 1 .45 1 1s-.45 1-1 1zm3-4H8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1zm0-4H8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1z"
              /></svg
            >
            <h2 class="text-xl font-archivo font-bold text-accent-dark">
              Tasks
            </h2>
          {/if}
        </div>

        <button
          class="p-2 bg-accent-lighter rounded-lg transition-colors duration-200 border-none hover:bg-accent-dark/25"
          onclick={closeSideView}
          aria-label="Close panel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-5 h-5 text-accent-dark"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <!-- Tab Navigation -->
      <div class="flex px-6 pb-3 gap-2">
        <button
          class="flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors duration-200 border-none {currentTab ===
          'notifications'
            ? 'bg-accent text-white'
            : 'text-accent-dark bg-accent-lighter hover:bg-accent-dark/25'}"
          onclick={() => (currentTab = 'notifications')}
        >
          Notifications
          {#if $notificationHistory.length > 0}
            <span class="ml-2 bg-white/20 px-1.5 py-0.5 rounded text-xs">
              {$notificationHistory.length}
            </span>
          {/if}
        </button>
        <button
          class="flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors duration-200 border-none {currentTab ===
          'tasks'
            ? 'bg-accent text-white'
            : 'text-accent-dark bg-accent-lighter hover:bg-accent-dark/25'}"
          onclick={() => (currentTab = 'tasks')}
        >
          Tasks
          {#if $deferredTasks.length > 0}
            <span class="ml-2 bg-white/20 px-1.5 py-0.5 rounded text-xs">
              {$deferredTasks.length}
            </span>
          {/if}
        </button>
      </div>
    </div>

    <div
      class="h-4 w-full pointer-events-none bg-gradient-to-b from-background-color to-transparent"
    ></div>

    <!-- Content -->
    <div
      class="flex-1 overflow-y-auto relative h-full w-full"
      bind:this={scrollContainer}
    >
      {#key currentTab}
        <div
          class="absolute inset-0 w-full h-full overflow-x-hidden"
          in:fade={{ duration: 200, easing: quintOut }}
          out:fade={{ duration: 200, easing: quintOut }}
        >
          {#if currentTab === 'notifications'}
            <!-- Notifications Content -->
            {#if $notificationHistory.length === 0}
              <div
                class="flex flex-col items-center justify-center h-full text-center p-8 w-full"
              >
                <div
                  class="w-16 h-16 bg-accent-lighter rounded-full flex items-center justify-center mb-4"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 50 50"
                    fill="none"
                    class="w-8 h-8 fill-accent-dark opacity-50"
                  >
                    <g clip-path="url(#clip0_22_1842)">
                      <path
                        d="M25 45.8333C27.2917 45.8333 29.1667 43.9583 29.1667 41.6666H20.8333C20.8333 43.9583 22.6875 45.8333 25 45.8333ZM37.5 33.3333V22.9166C37.5 16.5208 34.0833 11.1666 28.125 9.74998V8.33331C28.125 6.60415 26.7292 5.20831 25 5.20831C23.2708 5.20831 21.875 6.60415 21.875 8.33331V9.74998C15.8958 11.1666 12.5 16.5 12.5 22.9166V33.3333L9.81249 36.0208C8.49999 37.3333 9.41665 39.5833 11.2708 39.5833H38.7083C40.5625 39.5833 41.5 37.3333 40.1875 36.0208L37.5 33.3333Z"
                        fill="#2D626A"
                      />
                    </g>
                    <defs>
                      <clipPath id="clip0_22_1842">
                        <rect width="50" height="50" fill="white" />
                      </clipPath>
                    </defs>
                  </svg>
                </div>
                <h3
                  class="text-lg font-archivo font-semibold text-gray-600 mb-2"
                >
                  No Notifications
                </h3>
                <p class="text-gray-500 text-sm">
                  You don't have any notifications yet.
                </p>
              </div>
            {:else}
              <div class="p-4 space-y-3">
                <div class="flex items-center justify-between mb-3">
                  <span class="text-sm text-gray-600">
                    {$notificationHistory.length} notification{$notificationHistory.length !==
                    1
                      ? 's'
                      : ''}
                  </span>
                  <button
                    class="px-3 py-1 text-xs text-accent-dark bg-accent-lighter border-none hover:bg-accent-dark/25 rounded-lg transition-colors duration-200"
                    onclick={clearAllNotifications}
                  >
                    Clear All
                  </button>
                </div>
                {#each $notificationHistory as notification, index (notification.id)}
                  <div
                    class="flex gap-3 p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all duration-200"
                    in:fly={{ y: 20, duration: 300, delay: 50 * index }}
                    out:fly={{ y: 20, duration: 300, delay: 50 * index }}
                  >
                    <div class="flex-shrink-0 mt-0.5">
                      <img
                        src={getNotificationIcon(notification.type)}
                        alt={notification.type}
                        class="w-5 h-5"
                      />
                    </div>
                    <div class="flex-1 min-w-0">
                      <p
                        class="text-sm font-medium text-gray-900 leading-relaxed mb-1"
                      >
                        {notification.message}
                      </p>
                      {#if notification.timestamp}
                        <p class="text-xs text-gray-500">
                          {formatTimestamp(notification.timestamp)}
                        </p>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {:else}
            <!-- Tasks Content -->
            {#if $deferredTasks.length === 0}
              <div
                class="flex flex-col items-center justify-center h-full text-center p-8"
              >
                <div
                  class="w-16 h-16 bg-accent-lighter rounded-full flex items-center justify-center mb-4"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    class="w-6 h-6 fill-accent-dark opacity-50"
                    ><path d="M0 0h24v24H0V0z" fill="none" /><path
                      d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm1 14H8c-.55 0-1-.45-1-1s.45-1 1-1h5c.55 0 1 .45 1 1s-.45 1-1 1zm3-4H8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1zm0-4H8c-.55 0-1-.45-1-1s.45-1 1-1h8c.55 0 1 .45 1 1s-.45 1-1 1z"
                    /></svg
                  >
                </div>
                <h3
                  class="text-lg font-archivo font-semibold text-gray-600 mb-2"
                >
                  No Active Tasks
                </h3>
                <p class="text-gray-500 text-sm">
                  Background tasks will appear here when they're running.
                </p>
              </div>
            {:else}
              <div class="p-4 space-y-3">
                <div class="flex items-center justify-between mb-3">
                  <span class="text-sm text-gray-600">
                    {$deferredTasks.length} active task{$deferredTasks.length !==
                    1
                      ? 's'
                      : ''}
                  </span>
                  <div class="flex gap-2">
                    <button
                      class="px-2 py-1 text-xs text-accent-dark bg-accent-lighter border-none hover:bg-accent-dark/25 rounded-lg transition-colors duration-200"
                      onclick={handleClearCompletedTasks}
                    >
                      Clear Completed
                    </button>
                    <button
                      class="px-2 py-1 text-xs text-red-700 bg-red-100 border-none hover:bg-red-200 rounded-lg transition-colors duration-200"
                      onclick={handleClearAllTasks}
                    >
                      Clear All
                    </button>
                  </div>
                </div>
                {#each $deferredTasks as task, index (task.id)}
                  <div
                    class="flex gap-3 p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all duration-200"
                    data-task-id={task.id}
                    in:fly={{ y: 20, duration: 300, delay: 50 * index }}
                    out:fly={{ y: 20, duration: 300, delay: 50 * index }}
                  >
                    <div class="flex-shrink-0 mt-0.5">
                      <img
                        src={getTaskStatusIcon(task.status)}
                        alt={task.status}
                        class="w-5 h-5"
                      />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-start justify-between mb-1">
                        <div class="flex items-center gap-2">
                          <p class="text-sm font-medium text-gray-900">
                            {task.name}
                          </p>
                        </div>
                        {#if task.status === 'running'}
                          <div
                            class="flex items-center gap-1 text-xs text-blue-600"
                          >
                            <div
                              class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"
                            ></div>
                            {Math.floor(task.progress)}%
                          </div>
                        {:else if task.status === 'completed'}
                          <div
                            class="flex items-center gap-1 text-xs text-green-600"
                          >
                            <div
                              class="w-2 h-2 bg-green-500 rounded-full"
                            ></div>
                            Done
                          </div>
                        {:else if task.status === 'error'}
                          <div
                            class="flex items-center gap-1 text-xs text-red-600"
                          >
                            <div class="w-2 h-2 bg-red-500 rounded-full"></div>
                            Failed
                          </div>
                        {:else if task.status === 'pending'}
                          <div
                            class="flex items-center gap-1 text-xs text-yellow-600"
                          >
                            <div
                              class="w-2 h-2 bg-yellow-500 rounded-full"
                            ></div>
                            Waiting
                          </div>
                        {/if}
                      </div>

                      <p class="text-xs text-gray-600 mb-2">
                        {task.description}
                      </p>

                      {#if task.status === 'running' && task.progress > 0}
                        <div class="w-full bg-gray-200 rounded-full h-1.5 mb-2">
                          <div
                            class="bg-accent h-1.5 rounded-full transition-all duration-300"
                            style="width: {task.progress}%"
                          ></div>
                        </div>
                      {/if}

                      <div
                        class="flex items-center justify-between text-xs text-gray-500"
                      >
                        <span>by {task.addonOwner}</span>
                        <div class="flex items-center gap-2">
                          {#if task.duration && task.status === 'completed'}
                            <span>in {formatDuration(task.duration)}</span>
                          {/if}
                          <span>{formatTimestamp(task.timestamp)}</span>
                        </div>
                      </div>

                      {#if task.error || task.failed}
                        <div
                          class="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700"
                        >
                          <strong>Error:</strong>
                          {task.error || task.failed}
                        </div>
                      {/if}

                      {#if task.logs && task.logs.length > 0}
                        <details class="mt-2">
                          <summary
                            class="text-xs text-gray-600 cursor-pointer hover:text-gray-800"
                          >
                            View logs ({task.logs.length} lines)
                          </summary>
                          <div
                            class="mt-1 p-2 bg-gray-900 rounded text-xs text-green-400 font-mono max-h-20 overflow-y-auto"
                            use:registerLogContainer={task.id}
                          >
                            {#each task.logs as log}
                              {log}<br />
                            {/each}
                          </div>
                        </details>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/key}
    </div>
  </div>
{/if}
