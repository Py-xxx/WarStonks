import type { NotificationSettings } from '../types';
import { playAlertSound } from './alertAudio';

const STORAGE_KEY = 'warstonks.notificationSettings';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktopEnabled: false,
  soundEnabled: true,
  ringtone: 'chime',
  events: {
    watchlistAlert: true,
    scannerStale: true,
    appUpdate: true,
  },
};

export function loadNotificationSettings(): NotificationSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_NOTIFICATION_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    // Merge with defaults so newly-added fields stay populated.
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...parsed,
      events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, ...(parsed.events ?? {}) },
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort persistence; ignore quota/serialization errors.
  }
}

export function isDesktopNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isDesktopNotificationSupported()) {
    return 'unsupported';
  }
  return Notification.permission;
}

/** Requests OS notification permission. Returns true if granted. */
export async function requestDesktopNotificationPermission(): Promise<boolean> {
  if (!isDesktopNotificationSupported()) {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission === 'denied') {
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

function showDesktopNotification(title: string, body: string): void {
  if (!isDesktopNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: 'warstonks-alert' });
  } catch {
    // Some webviews throw if the OS notification center is unavailable; ignore.
  }
}

export type NotificationEventKind = 'watchlistAlert' | 'scannerStale' | 'appUpdate';

/**
 * Fires an alert through the channels enabled in settings: an in-app tone and/or a
 * native desktop notification, gated by the per-event toggles.
 */
export function fireAlertNotification(
  settings: NotificationSettings,
  kind: NotificationEventKind,
  title: string,
  body: string,
): void {
  if (!settings.events[kind]) {
    return;
  }
  if (settings.soundEnabled) {
    void playAlertSound(settings.ringtone).catch(() => undefined);
  }
  if (settings.desktopEnabled) {
    showDesktopNotification(title, body);
  }
}
