import { writable } from 'svelte/store';
export const currentDownloads = writable([]);
export const failedSetups = writable([]);
export const deferredTasks = writable([]);
export const removedTasks = writable([]);
export const notifications = writable([]);
export const notificationHistory = writable([]);
export const readNotificationIds = writable(new Set());
export const showNotificationSideView = writable(false);
export const setupLogs = writable({});
export const protonPrefixSetups = writable({});
export const oobeLog = writable({
    logs: [],
    isActive: false,
});
export const currentStorePageOpened = writable();
export const currentStorePageOpenedStorefront = writable();
export const gameFocused = writable();
export const launchGameTrigger = writable(undefined);
export const gamesLaunched = writable({});
export const selectedView = writable('library');
export const viewOpenedWhenChanged = writable(undefined);
export const addonUpdates = writable([]);
export const searchResults = writable([]);
export const searchResultsByAddon = writable([]);
export const searchQuery = writable('');
export const loadingResults = writable(false);
export const isOnline = writable(true);
export const headerBackButton = writable({
    visible: false,
    onClick: null,
    ariaLabel: 'Go back',
});
export function setHeaderBackButton(onClick, ariaLabel) {
    headerBackButton.set({
        visible: true,
        onClick,
        ariaLabel: ariaLabel || 'Go back',
    });
}
export function clearHeaderBackButton() {
    headerBackButton.set({
        visible: false,
        onClick: null,
        ariaLabel: 'Go back',
    });
}
export function createNotification(notification) {
    const notificationWithTimestamp = {
        ...notification,
        timestamp: notification.timestamp || Date.now(),
    };
    notifications.update((n) => [...n, notificationWithTimestamp]);
    notificationHistory.update((h) => [notificationWithTimestamp, ...h]);
}
export const priorityToNumber = {
    'addon-ask': 0,
    ui: 1,
    urgent: 2,
};
export const modalQueue = writable([]);
export const communityAddonsLocal = writable([]);
export async function fetchCommunityAddons() {
    window.electronAPI.app
        .axios({
        method: 'GET',
        url: 'https://ogi.nat3z.com/api/community.json',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'OpenGameInstaller Client/Rest1.0',
        },
    })
        .then((response) => {
        communityAddonsLocal.set(response.data);
    });
}
//# sourceMappingURL=store.js.map