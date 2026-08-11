import { useEffect, useRef } from 'react';
import {
  isTauriRuntime,
  pollEeLogEvents,
  sendPrivateMessageDiscordNotification,
} from '../lib/tauriClient';
import { fireAlertNotification, loadNotificationSettings } from '../lib/notifications';
import { tActive } from '../i18n';

/**
 * How often to drain Warframe's `EE.log`. The log is written as events happen, so this
 * interval is the notification latency. A second is responsive without being wasteful —
 * the poll is a `stat` plus a read of only what was appended, and returns immediately
 * when nothing has been.
 */
const POLL_INTERVAL_MS = 1000;

/**
 * Notifies when someone opens a DM with the user in-game.
 *
 * Unlike the other alert hooks this one polls rather than subscribing: the backend has no
 * event to push, because it only learns about a message by reading the game's log. That
 * read is what `poll_ee_log_events` does, and the tailer's own offset state makes repeat
 * calls cheap and idempotent.
 *
 * Two limits are inherent to the source and should not be papered over in the UI copy:
 * the game logs that a conversation *tab opened*, never the message text, and a follow-up
 * message on an already-open tab produces no new event at all.
 */
export function usePrivateMessageAlerts(): void {
  // Survives re-renders so a slow poll can't overlap itself.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;

    const drain = async () => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        const events = await pollEeLogEvents();
        if (cancelled || events.length === 0) {
          return;
        }
        // Read settings per batch rather than per mount, so toggling the setting takes
        // effect immediately instead of on the next reload.
        const settings = loadNotificationSettings();
        for (const event of events) {
          if (event.kind !== 'directMessage') {
            continue;
          }
          const body = tActive('notif.privateMessage.body', { user: event.user });

          // Desktop is gated locally; Discord is gated in the backend against the saved
          // webhook settings, so it is dispatched unconditionally and no-ops when off.
          fireAlertNotification(
            settings,
            'privateMessage',
            tActive('notif.event.privateMessage.label'),
            body,
          );
          void sendPrivateMessageDiscordNotification({
            user: event.user,
            labels: {
              title: tActive('notif.event.privateMessage.label'),
              body,
              note: tActive('discord.privateMessage.note'),
              footer: tActive('discord.privateMessage.footer'),
            },
          }).catch(() => undefined);
        }
      } catch {
        // The game not running, or the log rotating mid-read, are ordinary states here.
        // Failing loudly every second would be noise, not signal.
      } finally {
        inFlight.current = false;
      }
    };

    void drain();
    const timer = window.setInterval(() => void drain(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
