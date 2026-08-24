import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { Panel } from '@/components/ui/panel';
import { useAppStore } from '../../stores/useAppStore';

type CycleConfig = {
  key: string;
  label: string;
  // Maps the raw worldstate state string → a display label + tone class.
  // Fass/Vome are Warframe-specific proper nouns and stay in English like Archwing/Sharkwing.
  tone: (state: string) => { labelKey: TranslationKey | null; label?: string; tone: string };
};

/** Cycle state → colour. Day/warm read warm, night/cold read cool; the dot carries it so the
 *  label does not have to be a coloured pill. */
const STATE_DOT: Record<string, string> = {
  day: 'bg-accent-amber',
  night: 'bg-accent-purple',
  warm: 'bg-accent-amber',
  cold: 'bg-accent-blue',
};
const STATE_TEXT: Record<string, string> = {
  day: 'text-accent-amber',
  night: 'text-accent-purple',
  warm: 'text-accent-amber',
  cold: 'text-accent-blue',
};

const CYCLES: CycleConfig[] = [
  {
    key: 'cetusCycle',
    label: 'Cetus',
    tone: (state) =>
      state === 'day'
        ? { labelKey: 'evt.day', tone: 'day' }
        : { labelKey: 'evt.night', tone: 'night' },
  },
  {
    key: 'vallisCycle',
    label: 'Orb Vallis',
    tone: (state) =>
      state === 'warm'
        ? { labelKey: 'evt.warm', tone: 'warm' }
        : { labelKey: 'evt.cold', tone: 'cold' },
  },
  {
    key: 'cambionCycle',
    label: 'Cambion Drift',
    tone: (state) =>
      state === 'fass'
        ? { labelKey: null, label: 'Fass', tone: 'warm' }
        : { labelKey: null, label: 'Vome', tone: 'night' },
  },
  {
    key: 'earthCycle',
    label: 'Earth',
    tone: (state) =>
      state === 'day'
        ? { labelKey: 'evt.day', tone: 'day' }
        : { labelKey: 'evt.night', tone: 'night' },
  },
];

function readCycle(payload: unknown, key: string): { state: string; expiry: string | null } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const cycle = (payload as Record<string, unknown>)[key];
  if (!cycle || typeof cycle !== 'object') {
    return null;
  }
  const record = cycle as Record<string, unknown>;
  const state =
    typeof record.state === 'string'
      ? record.state
      : record.isDay === true
        ? 'day'
        : record.isWarm === true
          ? 'warm'
          : '';
  const expiry = typeof record.expiry === 'string' ? record.expiry : null;
  return { state, expiry };
}

function formatCountdown(expiry: string | null, now: number, nowLabel: string): string {
  if (!expiry) {
    return '—';
  }
  const remaining = Date.parse(expiry) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return nowLabel;
  }
  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((remaining % 60_000) / 1000);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function WorldClockPanel() {
  const { t } = useTranslation();
  const entry = useAppStore((state) => state.worldStateExtra.cycles);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second so the countdowns stay live; flips trigger a backend refetch on expiry.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const cycles = CYCLES.map((config) => {
    const data = readCycle(entry.payload, config.key);
    return { config, data };
  }).filter((item) => item.data !== null);

  if (cycles.length === 0) {
    return (
      <Panel className="px-3 py-2 text-[11px] text-ink-dim">
        {entry.loading ? t('evt.loadingWorldCycles') : t('evt.worldCyclesUnavailable')}
      </Panel>
    );
  }

  return (
    /* One strip, four cells, no panel header. This is a clock: it has no title worth a row and no
       state worth a refresh button, and it sits above every Events tab, so every pixel of chrome
       here is paid four times over. */
    <Panel
      className="grid divide-x divide-line overflow-hidden [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]"
      aria-label={t('a11y.openWorldCycles')}
    >
      {cycles.map(({ config, data }) => {
        const display = config.tone(data!.state);
        return (
          /* The three facts read as one phrase — "Cetus · Day · 42m" — so they sit together
             and the cell centres them. The place name used to be `flex-1`, which pushed the
             state and the countdown to the far right edge of the cell and left a gap wide
             enough to read them as unrelated. */
          <div
            key={config.key}
            className="flex min-w-0 items-center justify-center gap-2 px-3 py-2"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[display.tone] ?? 'bg-ink-faint'}`}
              aria-hidden="true"
            />
            <span className="truncate text-[11px] text-ink-dim">{config.label}</span>
            <span
              className={`shrink-0 text-[11px] font-semibold ${STATE_TEXT[display.tone] ?? 'text-ink'}`}
            >
              {display.labelKey ? t(display.labelKey) : display.label}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-soft">
              {formatCountdown(data!.expiry, now, t('evt.now'))}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}
