<script lang="ts">
  import { notifications, type Notification } from "../store";

  notifications.subscribe((value) => {
    // latest value is the last element in the array
    const latest = value[value.length - 1];
    if (!latest) return;
    setTimeout(() => {
      const element = document.getElementById("notification-" + latest.id);
      if (!element) return;
      element.animate([{ opacity: 1, right: "0px" }, { opacity: 0, right: "-120px" }], { duration: 500, fill: "forwards" });
      setTimeout(() => {
        notifications.update((n) => n.filter((notification) => notification.id !== latest.id));
      }, 500);
    }, 3000);
  });

  function isCustomEvent(event: Event): event is CustomEvent<Notification> {
    return event instanceof CustomEvent && event.detail && event.detail.type && event.detail.message;
  }

  document.addEventListener('new-notification', (event) => {
    // @ts-ignore
    if (!isCustomEvent(event)) return;
    notifications.update((update) => [
      ...update,
      {
        id: Math.random().toString(36).substring(7),
        type: event.detail.type,
        message: event.detail.message,
      },
    ]);
  });

</script>
<div class="fixed bottom-2 right-2 gap-2 w-5/6 flex justify-end items-end flex-col-reverse">
  {#each $notifications as notification (notification.id)}
    <div class="flex bg-gray-300 border border-black p-2 w-7/12 relative items-center gap-2 h-fit" id={"notification-" + notification.id}>
      <img src={`./${notification.type}.svg`} alt={notification.type} class="w-4 h-4" />
      {notification.message}
    </div>
  {/each}
</div>