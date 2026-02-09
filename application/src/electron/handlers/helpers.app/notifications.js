/**
 * Notification utility functions
 */
import { sendNotification } from '../../main.js';
export function generateNotificationId() {
    return Math.random().toString(36).substring(7);
}
export function notifySuccess(message) {
    sendNotification({
        message,
        id: generateNotificationId(),
        type: 'success',
    });
}
export function notifyError(message) {
    sendNotification({
        message,
        id: generateNotificationId(),
        type: 'error',
    });
}
export function notifyInfo(message) {
    sendNotification({
        message,
        id: generateNotificationId(),
        type: 'info',
    });
}
//# sourceMappingURL=notifications.js.map