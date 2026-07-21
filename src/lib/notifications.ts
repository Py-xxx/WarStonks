import { tActive } from '../i18n';
import {
  isPermissionGranted as tauriIsPermissionGranted,
  requestPermission as tauriRequestPermission,
  sendNotification as tauriSendNotification,
} from '@tauri-apps/plugin-notification';
import type { NotificationSettings } from '../types';
import { isTauriRuntime } from './tauriClient';
import { playAlertSound } from './alertAudio';

const STORAGE_KEY = 'warstonks.notificationSettings';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktopEnabled: false,
  soundEnabled: true,
  ringtone: 'chime',
  underpricedMinPctBelow: 10,
  events: {
    watchlistAlert: true,
    scannerStale: true,
    appUpdate: true,
    underpricedListing: true,
    listingHealth: false,
  },
};

/** Discount thresholds (percent below recommended) offered in the notification settings. */
export const UNDERPRICED_PCT_BELOW_OPTIONS = [10, 20, 25, 30, 40, 50] as const;

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

export type DesktopNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';

function webNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function isDesktopNotificationSupported(): boolean {
  // In the packaged Tauri app the native notification plugin is always available; in a plain
  // browser (npm run dev) fall back to the web Notification API.
  return isTauriRuntime() || webNotificationSupported();
}

/**
 * Requests OS notification permission, triggering the native OS prompt. In the Tauri app this
 * goes through the notification plugin — the web `Notification` API can't drive the OS prompt
 * from inside the webview, which is why "Enable" previously did nothing. In a browser it falls
 * back to the web API. Returns the resulting permission state.
 */
export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (isTauriRuntime()) {
    try {
      if (await tauriIsPermissionGranted()) {
        return 'granted';
      }
      const result = await tauriRequestPermission();
      return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
    } catch {
      return 'unsupported';
    }
  }

  if (!webNotificationSupported()) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  if (Notification.permission === 'denied') {
    return 'denied';
  }
  try {
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
  } catch {
    return 'unsupported';
  }
}

/** Sends a native desktop notification. Returns false only if the send call itself threw. */
async function showDesktopNotification(title: string, body: string): Promise<boolean> {
  if (isTauriRuntime()) {
    // Send directly — do NOT gate on `isPermissionGranted()`. That getter is unreliable on
    // macOS (it can report `false`/`provisional` even when the OS has granted notifications),
    // and gating on it silently swallows every alert. If the OS truly hasn't granted
    // permission the plugin just no-ops; if it has, the notification shows.
    try {
      tauriSendNotification({ title, body });
      return true;
    } catch {
      return false;
    }
  }

  if (!webNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: 'warstonks-alert' });
    return true;
  } catch {
    // Some webviews throw if the OS notification center is unavailable; ignore.
    return false;
  }
}

/**
 * Fires a one-off desktop notification for the Notifications "Test" button. Returns false if it
 * couldn't be delivered (e.g. the OS permission was revoked after the toggle was enabled).
 */
export async function sendTestDesktopNotification(): Promise<boolean> {
  return showDesktopNotification('WarStonks', tActive('notif.testBody'));
}

export type NotificationEventKind =
  | 'watchlistAlert'
  | 'scannerStale'
  | 'appUpdate'
  | 'underpricedListing'
  | 'listingHealth';

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
    void showDesktopNotification(title, body).catch(() => undefined);
  }
}
