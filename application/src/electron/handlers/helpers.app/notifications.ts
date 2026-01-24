/**
 * Notification utility functions
 */
import { sendNotification } from '../../main.js';

export function generateNotificationId(): string {
  return Math.random().toString(36).substring(7);
}

export function notifySuccess(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'success',
  });
}

export function notifyError(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'error',
  });
}

export function notifyInfo(message: string): void {
  sendNotification({
    message,
    id: generateNotificationId(),
    type: 'info',
  });
}
