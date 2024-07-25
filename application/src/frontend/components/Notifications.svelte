<script lang="ts">
  import { notifications } from "../store";

  notifications.subscribe((value) => {
    // latest value is the last element in the array
    const latest = value[value.length - 1];
    setTimeout(() => {
      const element = document.getElementById("notification-" + latest.id);
      if (!element) return;
      element.animate([{ opacity: 1, right: "0px" }, { opacity: 0, right: "-120px" }], { duration: 500, fill: "forwards" });
      setTimeout(() => {
        notifications.update((n) => n.filter((notification) => notification.id !== latest.id));
      }, 500);
    }, 3000);
  });

  setInterval(() => {
    notifications.update((update) => [
      ...update,
      {
        id: Math.random().toString(36).substring(7),
        type: "info",
        message: "This is a test notification",
      },
    ]);
  }, 2000)

</script>
<div class="fixed bottom-2 right-2 gap-2 w-5/6 flex justify-end items-end flex-col-reverse">
  {#each $notifications as notification (notification.id)}
    <div class="flex bg-gray-300 p-2 w-5/12 relative items-center gap-[2px] h-fit" id={"notification-" + notification.id}>
      <img src={`./${notification.type}.svg`} alt={notification.type} class="w-4 h-4" />
      {notification.message}
    </div>
  {/each}
</div>