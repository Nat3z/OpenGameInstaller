<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { deferredTasks } from "../store";
  import {
    loadDeferredTasks,
    startTaskPolling,
    stopTaskPolling,
    clearCompletedTasks,
    clearAllTasks,
  } from "../utils";

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function isCustomEvent(event: Event): event is CustomEvent {
    return event instanceof CustomEvent;
  }

  function formatDuration(milliseconds?: number): string {
    if (!milliseconds) return "0s";
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

  function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays}d ago`;
    } else if (diffHours > 0) {
      return `${diffHours}h ago`;
    } else if (diffMins > 0) {
      return `${diffMins}m ago`;
    } else {
      return "Just now";
    }
  }

  function getTaskTypeIcon(type: string): string {
    switch (type) {
      case "setup":
        return "⚙️";
      case "download":
        return "📥";
      case "configure":
        return "🔧";
      case "addon-install":
        return "📦";
      case "addon-update":
        return "🔄";
      case "cleanup":
        return "🧹";
      default:
        return "📝";
    }
  }

  function getTaskTypeColor(type: string): string {
    switch (type) {
      case "setup":
        return "bg-blue-100 text-blue-800";
      case "download":
        return "bg-green-100 text-green-800";
      case "configure":
        return "bg-yellow-100 text-yellow-800";
      case "addon-install":
        return "bg-purple-100 text-purple-800";
      case "addon-update":
        return "bg-indigo-100 text-indigo-800";
      case "cleanup":
        return "bg-orange-100 text-orange-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
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

  function handleClearCompleted() {
    clearCompletedTasks();
  }

  function handleClearAll() {
    clearAllTasks();
  }

  // Listen for task log updates
  document.addEventListener("task:log", (event: Event) => {
    if (!isCustomEvent(event)) return;
    const taskID = event.detail.id;
    const logs: string[] = event.detail.logs;
    const taskElement = document.querySelector(`[data-task-id="${taskID}"]`);
    if (taskElement === null) return;
    const logContainer = taskElement.querySelector(".task-logs code");
    if (logContainer) {
      logContainer.innerHTML = "";
      logs.forEach((line) => {
        const textNode = document.createTextNode(line);
        logContainer.appendChild(textNode);
        logContainer.appendChild(document.createElement("br"));
      });
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });

  document.addEventListener("task:progress", (event: Event) => {
    if (!isCustomEvent(event)) return;
    const taskID = event.detail.id;
    const progress = event.detail.progress;
    const taskElement = document.querySelector(`[data-task-id="${taskID}"]`);
    if (taskElement === null) return;
    const progressBar = taskElement.querySelector("progress");
    if (progressBar) {
      progressBar.value = progress;
    }
  });

  document.addEventListener("task:failed", (event: Event) => {
    if (!isCustomEvent(event)) return;
    const taskID = event.detail.id;
    const error = event.detail.error;

    // Update the task status in the store
    deferredTasks.update((tasks) =>
      tasks.map((task) =>
        task.id === taskID
          ? { ...task, status: "error" as const, error: error }
          : task
      )
    );
  });
</script>

<div class="container mx-auto px-6 py-8 max-w-6xl">
  {#if $deferredTasks.length > 0}
    <div class="tasks-header">
      <div class="flex items-center gap-3 mb-6">
        <div
          class="w-1 h-8 bg-gradient-to-b from-blue-600 to-blue-400 rounded-full"
        ></div>
        <h2 class="text-3xl font-bold text-gray-900">Active Tasks</h2>
        <span
          class="bg-blue-100 text-blue-800 text-sm font-medium px-3 py-1 rounded-full"
        >
          {$deferredTasks.length}
        </span>
      </div>
      <div class="tasks-actions">
        <button class="btn btn-secondary" onclick={handleClearCompleted}>
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
        <button class="btn btn-danger" onclick={handleClearAll}>
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
            d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
          ></path>
        </svg>
      </div>
      <h3 class="text-2xl font-semibold text-gray-900 mb-2">No Active Tasks</h3>
      <p class="text-gray-600">
        Background tasks will appear here when they're running.
      </p>
    </div>
  {/if}

  <div class="tasks-grid">
    {#each $deferredTasks as task}
      <div data-task-id={task.id} class="task-card">
        <div class="task-header">
          <div class="task-type-indicator">
            <span class="task-icon">{getTaskTypeIcon(task.type)}</span>
            <span class="task-type-badge {getTaskTypeColor(task.type)}">
              {task.type.charAt(0).toUpperCase() +
                task.type.slice(1).replace("-", " ")}
            </span>
          </div>
          <div class="status-indicator status-{task.status}"></div>
        </div>

        <div class="task-content">
          <div class="task-info">
            <h3 class="task-title">{task.name}</h3>
            <p class="task-description">{task.description}</p>
            <div class="task-meta">
              <span class="addon-owner">by {task.addonOwner}</span>
              <span class="task-timestamp"
                >{formatTimestamp(task.timestamp)}</span
              >
            </div>
          </div>

          {#if task.status === "running"}
            <div class="status-badge running">
              <div class="spinner"></div>
              Running
            </div>
            <div class="task-progress-section">
              <div class="progress-info">
                <span class="progress-percentage"
                  >{Math.floor(task.progress)}%</span
                >
                {#if task.duration}
                  <span class="duration">{formatDuration(task.duration)}</span>
                {/if}
              </div>
              <progress class="task-progress" value={task.progress} max="100"
              ></progress>
            </div>
          {:else if task.status === "pending"}
            <div class="status-badge pending">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Waiting
            </div>
          {:else if task.status === "completed"}
            <div class="status-badge completed">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Completed
              {#if task.duration}
                <span class="duration-small"
                  >in {formatDuration(task.duration)}</span
                >
              {/if}
            </div>
          {:else if task.status === "error"}
            <div class="status-badge error">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Failed
            </div>
            {#if task.error || task.failed}
              <div class="error-message">
                <span class="error-label">Error:</span>
                {task.error || task.failed || "Task failed"}
              </div>
            {/if}
          {:else if task.status === "cancelled"}
            <div class="status-badge cancelled">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                ></path>
              </svg>
              Cancelled
            </div>
          {/if}

          {#if task.logs && task.logs.length > 0}
            <div class="task-logs">
              <div class="logs-header">
                <h4 class="logs-title">Logs</h4>
                <span class="logs-count">{task.logs.length} lines</span>
              </div>
              <div class="logs-container">
                <code class="logs-content">
                  {#each task.logs as log}
                    {log}<br />
                  {/each}
                </code>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

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
  .tasks-header {
    @apply flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8;
  }

  .tasks-actions {
    @apply flex flex-wrap gap-3;
  }

  .empty-state {
    @apply flex flex-col items-center justify-center text-center py-16 px-8 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-300;
  }

  .empty-state-icon {
    @apply mb-4 p-4 bg-gray-100 rounded-full;
  }

  /* Tasks Grid */
  .tasks-grid {
    @apply grid gap-6;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  }

  .task-card {
    @apply bg-white rounded-xl shadow-md hover:shadow-lg transition-all duration-300 overflow-hidden border border-gray-200;
  }

  .task-header {
    @apply flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200;
  }

  .task-type-indicator {
    @apply flex items-center gap-3;
  }

  .task-icon {
    @apply text-xl;
  }

  .task-type-badge {
    @apply px-2 py-1 text-xs font-medium rounded-md;
  }

  .status-indicator {
    @apply w-3 h-3 rounded-full;
  }

  .status-pending {
    @apply bg-yellow-500;
  }
  .status-running {
    @apply bg-blue-500;
  }
  .status-completed {
    @apply bg-green-500;
  }
  .status-error {
    @apply bg-red-500;
  }
  .status-cancelled {
    @apply bg-gray-500;
  }

  .task-content {
    @apply p-6 space-y-4;
  }

  .task-info {
    @apply space-y-2;
  }

  .task-title {
    @apply text-lg font-semibold text-gray-900;
  }

  .task-description {
    @apply text-sm text-gray-600;
  }

  .task-meta {
    @apply flex items-center justify-between text-xs text-gray-500;
  }

  .addon-owner {
    @apply font-medium;
  }

  .task-timestamp {
    @apply bg-gray-100 px-2 py-1 rounded;
  }

  /* Status Badges */
  .status-badge {
    @apply inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg;
  }

  .status-badge.pending {
    @apply bg-yellow-100 text-yellow-800;
  }

  .status-badge.running {
    @apply bg-blue-100 text-blue-800;
  }

  .status-badge.completed {
    @apply bg-green-100 text-green-800;
  }

  .status-badge.error {
    @apply bg-red-100 text-red-800;
  }

  .status-badge.cancelled {
    @apply bg-gray-100 text-gray-800;
  }

  .duration-small {
    @apply text-xs opacity-75 ml-2;
  }

  /* Progress */
  .task-progress-section {
    @apply space-y-2;
  }

  .progress-info {
    @apply flex items-center justify-between text-sm;
  }

  .progress-percentage {
    @apply font-semibold text-blue-600;
  }

  .duration {
    @apply text-gray-500;
  }

  .task-progress {
    @apply w-full h-2 rounded-full overflow-hidden;
    background-color: #e5e7eb;
  }

  .task-progress::-webkit-progress-bar {
    @apply bg-gray-200 rounded-full;
  }

  .task-progress::-webkit-progress-value {
    @apply bg-gradient-to-r from-blue-500 to-blue-600 rounded-full;
  }

  /* Error Message */
  .error-message {
    @apply p-3 bg-red-50 border border-red-200 rounded-lg text-sm;
  }

  .error-label {
    @apply font-medium text-red-700;
  }

  /* Task Logs */
  .task-logs {
    @apply border border-gray-200 rounded-lg overflow-hidden;
  }

  .logs-header {
    @apply flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200;
  }

  .logs-title {
    @apply text-sm font-medium text-gray-700;
  }

  .logs-count {
    @apply text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded;
  }

  .logs-container {
    @apply bg-gray-900 max-h-32 overflow-y-auto;
  }

  .logs-content {
    @apply block text-green-400 text-xs font-mono leading-relaxed whitespace-pre-wrap p-3;
  }

  /* Task Actions */
  .task-actions {
    @apply flex gap-3 pt-4 border-t border-gray-200;
  }

  /* Spinner Animation */
  .spinner {
    @apply w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin;
  }

  /* Responsive Design */
  @media (max-width: 640px) {
    .tasks-grid {
      grid-template-columns: 1fr;
    }

    .task-header {
      @apply flex-col items-start gap-3;
    }

    .task-type-indicator {
      @apply w-full;
    }

    .status-indicator {
      @apply self-end;
    }
  }
</style>
