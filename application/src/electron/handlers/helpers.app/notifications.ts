/**
 * Notification utility functions
 */
import { sendNotification } from '../../main.js';

/**
 * Generates a short random string suitable for use as a notification ID.
 *
 * @returns Random alphanumeric string
 */
export function generateNotificationId(): string {
  return Math.random().toString(36).substring(2, 9);
}

/**
 * Sends a success notification to the renderer.
 *
 * @param message - Text to show in the notification
 */
export function notifySuccess(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'success',
  });
}

/**
 * Sends an error notification to the renderer.
 *
 * @param message - Text to show in the notification
 */
export function notifyError(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'error',
  });
}

/**
 * Sends an info notification to the renderer.
 *
 * @param message - Text to show in the notification
 */
export function notifyInfo(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'info',
  });
}
