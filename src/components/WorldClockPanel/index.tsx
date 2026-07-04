import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { useAppStore } from '../../stores/useAppStore';

type CycleConfig = {
  key: string;
  label: string;
  // Maps the raw worldstate state string → a display label + tone class.
  // Fass/Vome are Warframe-specific proper nouns and stay in English like Archwing/Sharkwing.
  tone: (state: string) => { labelKey: TranslationKey | null; label?: string; tone: string };
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
      <div className="world-clock world-clock-empty">
        {entry.loading ? t('evt.loadingWorldCycles') : t('evt.worldCyclesUnavailable')}
      </div>
    );
  }

  return (
    <div className="world-clock" aria-label={t('a11y.openWorldCycles')}>
      {cycles.map(({ config, data }) => {
        const display = config.tone(data!.state);
        return (
          <div key={config.key} className={`world-clock-cell world-clock-${display.tone}`}>
            <span className="world-clock-place">{config.label}</span>
            <span className={`world-clock-state world-clock-state-${display.tone}`}>
              {display.labelKey ? t(display.labelKey) : display.label}
            </span>
            <span className="world-clock-countdown">{formatCountdown(data!.expiry, now, t('evt.now'))}</span>
          </div>
        );
      })}
    </div>
  );
}
