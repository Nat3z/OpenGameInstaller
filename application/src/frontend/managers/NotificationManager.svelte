<script lang="ts">
  import {
    notifications,
    notificationHistory,
    type Notification,
  } from '../store';
  import { onMount } from 'svelte';

  let timers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      progressTimer: ReturnType<typeof setInterval>;
    }
  >();
  let progressValues = new Map<string, number>();

  notifications.subscribe((value) => {
    // Clear timers for notifications that no longer exist
    timers.forEach((timerData, id) => {
      if (!value.find((n) => n.id === id)) {
        clearTimeout(timerData.timer);
        clearInterval(timerData.progressTimer);
        timers.delete(id);
        progressValues.delete(id);
      }
    });

    // Set up timers for new notifications
    value.forEach((notification) => {
      if (!timers.has(notification.id)) {
        startNotificationTimer(notification.id);
      }
    });
  });

  function startNotificationTimer(notificationId: string) {
    const totalDuration = 3000; // 3 seconds
    const fadeDuration = 500;
    let elapsed = 0;
    const progressInterval = 16; // Update progress every 16ms (60fps) for smoother animation

    // Start progress timer
    const progressTimer = setInterval(() => {
      elapsed += progressInterval;
      const progress = Math.min((elapsed / totalDuration) * 100, 100);
      progressValues.set(notificationId, progress);
      progressValues = progressValues; // Trigger reactivity
    }, progressInterval);

    // Start dismiss timer
    const timer = setTimeout(() => {
      const element = document.getElementById('notification-' + notificationId);
      if (!element) return;

      element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: fadeDuration,
        fill: 'forwards',
      });
      setTimeout(() => {
        notifications.update((n) =>
          n.filter((notification) => notification.id !== notificationId)
        );
      }, fadeDuration);
    }, totalDuration);

    timers.set(notificationId, { timer, progressTimer });
  }

  function pauseNotificationTimer(notificationId: string) {
    const timerData = timers.get(notificationId);
    if (timerData) {
      clearTimeout(timerData.timer);
      clearInterval(timerData.progressTimer);
    }
  }

  function resumeNotificationTimer(notificationId: string) {
    const currentProgress = progressValues.get(notificationId) || 0;
    const remainingTime = 3000 * (1 - currentProgress / 100);

    if (remainingTime > 0) {
      const fadeDuration = 500;
      const progressInterval = 16; // Update progress every 16ms (60fps) for smoother animation
      let elapsed = 3000 - remainingTime;

      // Resume progress timer
      const progressTimer = setInterval(() => {
        elapsed += progressInterval;
        const progress = Math.min((elapsed / 3000) * 100, 100);
        progressValues.set(notificationId, progress);
        progressValues = progressValues; // Trigger reactivity
      }, progressInterval);

      // Resume dismiss timer
      const timer = setTimeout(() => {
        const element = document.getElementById(
          'notification-' + notificationId
        );
        if (!element) return;

        element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: fadeDuration,
          fill: 'forwards',
        });
        setTimeout(() => {
          notifications.update((n) =>
            n.filter((notification) => notification.id !== notificationId)
          );
        }, fadeDuration);
      }, remainingTime);

      timers.set(notificationId, { timer, progressTimer });
    }
  }

  function isCustomEvent(event: Event): event is CustomEvent<Notification> {
    return (
      event instanceof CustomEvent &&
      event.detail &&
      event.detail.type &&
      event.detail.message
    );
  }

  document.addEventListener('new-notification', (event) => {
    // @ts-ignore
    if (!isCustomEvent(event)) return;
    const notification = {
      id: Math.random().toString(36).substring(7),
      type: event.detail.type,
      message: event.detail.message,
      timestamp: Date.now(),
    };

    // Add to both stores to ensure it appears in both toast and side view
    notifications.update((update) => [...update, notification]);
    notificationHistory.update((history) => [notification, ...history]);
  });

  onMount(() => {
    return () => {
      // Cleanup timers on component destroy
      timers.forEach((timerData) => {
        clearTimeout(timerData.timer);
        clearInterval(timerData.progressTimer);
      });
    };
  });
</script>

<div
  class="fixed bottom-2 right-2 gap-3 w-5/6 flex justify-end items-end flex-col-reverse pointer-events-none z-40"
>
  {#each $notifications as notification (notification.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="notification-card flex flex-col rounded-xl p-4 w-7/12 relative items-stretch h-fit fly-in-accent pointer-events-auto overflow-hidden"
      id={'notification-' + notification.id}
      on:mouseenter={() => pauseNotificationTimer(notification.id)}
      on:mouseleave={() => resumeNotificationTimer(notification.id)}
    >
      <div class="flex items-center gap-3 pb-3">
        <div class="flex-shrink-0">
          <img
            src={`./${notification.type}.svg`}
            alt={notification.type}
            class="w-5 h-5 notification-icon"
          />
        </div>
        <p
          class="notification-text font-open-sans text-sm font-medium leading-relaxed flex-1"
        >
          {notification.message}
        </p>
      </div>
      <div class="progress-bar">
        <div
          class="progress-fill"
          style="width: {100 - (progressValues.get(notification.id) || 0)}%"
        ></div>
      </div>
    </div>
  {/each}
</div>

<style>
  .fly-in-accent {
    animation: flyInAccent 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }

  @keyframes flyInAccent {
    0% {
      opacity: 0;
      transform: translateX(100%) scale(0.9);
      border-left: 4px solid #428a91;
    }
    40% {
      opacity: 0.9;
      transform: translateX(-5px) scale(1.02);
      border-left: 4px solid #428a91;
    }
    100% {
      opacity: 1;
      transform: translateX(0) scale(1);
      border-left: 4px solid #428a91;
    }
  }

  .notification-card {
    background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
    box-shadow:
      0 4px 6px -1px rgba(0, 0, 0, 0.1),
      0 2px 4px -1px rgba(0, 0, 0, 0.06),
      0 0 0 1px rgba(66, 138, 145, 0.1);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(66, 138, 145, 0.15);
    transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }

  .notification-card:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 25px -1px rgba(0, 0, 0, 0.15),
      0 4px 10px -1px rgba(0, 0, 0, 0.1),
      0 0 0 1px rgba(66, 138, 145, 0.2);
  }

  .notification-icon {
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
  }

  .notification-text {
    color: #1e293b;
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
  }

  .progress-bar {
    background: rgba(66, 138, 145, 0.2);
    border-radius: 0 0 12px 12px;
    overflow: hidden;
    margin: 0 -16px -16px -16px;
    height: 3px;
  }

  .progress-fill {
    background: linear-gradient(90deg, #428a91, #2d626a);
    height: 100%;
    border-radius: 0 0 12px 12px;
    transition: width 0.016s linear;
  }
</style>
