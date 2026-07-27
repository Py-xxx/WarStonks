import { useEffect, useRef } from 'react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { atLeastOneChance } from '../../lib/relicDropOdds';
import type { FarmingSessionDrop } from '../../types';

/**
 * "Now farming" session UI. Because the user has declared which relic they're running, logging a
 * reward is one tap from that relic's ~6 drops instead of searching the whole prime catalog —
 * which is the actual friction when farming the same relic repeatedly.
 *
 * Rendered globally (AppShell) so it survives tab changes; collapses to a bubble when minimized.
 */
export function FarmingSessionPanel() {
  const { t } = useTranslation();
  const session = useAppStore((state) => state.farmingSession);
  const expanded = useAppStore((state) => state.farmingPanelExpanded);
  const setExpanded = useAppStore((state) => state.setFarmingPanelExpanded);
  const stop = useAppStore((state) => state.stopFarmingSession);
  const logDrop = useAppStore((state) => state.logFarmingDrop);
  const undoLast = useAppStore((state) => state.undoLastFarmingRun);
  const panelRef = useRef<HTMLElement | null>(null);

  // Get out of the way as soon as attention moves elsewhere — the panel sits over page content,
  // and the bubble keeps the session one click away. Uses pointerdown so it collapses on press
  // rather than after the click resolves; a "Farm this" click elsewhere still wins because
  // startFarmingSession re-expands on the click that follows.
  useEffect(() => {
    if (!session || !expanded) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panelRef.current?.contains(target)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [session, expanded, setExpanded]);

  if (!session) {
    return null;
  }

  const runCount = session.runs.length;
  const lastRun = session.runs[runCount - 1] ?? null;

  if (!expanded) {
    return (
      <button
        type="button"
        className="farm-fab"
        aria-label={t('farm.reopen')}
        title={`${t('farm.nowFarming')}: ${session.relicName}`}
        onClick={() => setExpanded(true)}
      >
        <i className="ti ti-flame" aria-hidden="true" />
        {runCount > 0 ? <span className="farm-fab-badge">{runCount}</span> : null}
      </button>
    );
  }

  // Plat added this session, counting only real parts (filler is worth nothing to us).
  const platGained = session.runs.reduce((sum, run) => {
    const drop = session.drops.find((entry) => entry.slug === run.dropSlug);
    return sum + (run.isFiller ? 0 : drop?.recommendedExitPrice ?? 0);
  }, 0);

  // Live odds: across the runs logged so far, how likely you'd have seen the best drop by now.
  const bestDrop = session.drops
    .filter((drop) => !drop.isFiller && drop.chance !== null)
    .sort((a, b) => (b.recommendedExitPrice ?? 0) - (a.recommendedExitPrice ?? 0))[0];
  const seenOdds =
    bestDrop?.chance != null && runCount > 0
      ? atLeastOneChance([{ chance: bestDrop.chance, count: runCount }])
      : null;

  const renderDrop = (drop: FarmingSessionDrop) => {
    const image = resolveWfmAssetUrl(drop.imagePath);
    return (
      <button
        key={drop.slug}
        type="button"
        className={`farm-drop${drop.isFiller ? ' is-filler' : ''}`}
        onClick={() => void logDrop(drop)}
      >
        <span className="farm-drop-thumb" aria-hidden="true">
          {image ? <img src={image} alt="" loading="lazy" /> : <span>{drop.name.slice(0, 1)}</span>}
        </span>
        <span className="farm-drop-copy">
          <span className="farm-drop-name">{drop.isFiller ? t('farm.filler') : drop.name}</span>
          {!drop.isFiller ? (
            <span className="farm-drop-meta">
              {drop.rarity ?? ''}
              {drop.chance != null ? ` · ${Math.round(drop.chance * 100)}%` : ''}
              {drop.recommendedExitPrice != null ? ` · ${drop.recommendedExitPrice}p` : ''}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  const realDrops = session.drops.filter((drop) => !drop.isFiller);
  const fillerDrops = session.drops.filter((drop) => drop.isFiller);

  return (
    <section ref={panelRef} className="farm-panel" aria-label={t('farm.nowFarming')}>
      <header className="farm-panel-head">
        <div className="farm-panel-title">
          <span className="farm-panel-eyebrow">{t('farm.nowFarming')}</span>
          <strong>{session.relicName}</strong>
          <span className="farm-panel-refinement">{session.refinement}</span>
        </div>
        <div className="farm-panel-actions">
          <button type="button" className="act-btn" onClick={stop}>
            {t('farm.stop')}
          </button>
          <button
            type="button"
            className="farm-panel-minimize"
            aria-label={t('farm.minimize')}
            title={t('farm.minimize')}
            onClick={() => setExpanded(false)}
          >
            <i className="ti ti-chevron-down" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="farm-panel-stats">
        <span className="farm-stat">
          <strong>{runCount}</strong>
          {runCount === 1 ? t('farm.runsLoggedOne') : t('farm.runsLogged', { n: runCount })}
        </span>
        <span className="farm-stat">
          <strong>{platGained}p</strong>
          {t('farm.platGained')}
        </span>
        {seenOdds !== null && bestDrop ? (
          <span className="farm-stat-odds">
            {t('farm.sessionOdds', {
              n: runCount,
              pct: `${Math.round(seenOdds * 100)}%`,
            })}
          </span>
        ) : null}
      </div>

      <div className="farm-panel-prompt">{t('farm.whatDidYouGet')}</div>

      {session.drops.length === 0 ? (
        <div className="farm-panel-empty">{t('farm.noDrops')}</div>
      ) : (
        <div className="farm-drop-list">
          {realDrops.map(renderDrop)}
          {fillerDrops.map(renderDrop)}
        </div>
      )}

      <footer className="farm-panel-foot">
        {lastRun ? (
          <>
            <span className="farm-panel-last">
              {t('farm.lastLogged', {
                item: lastRun.isFiller ? t('farm.fillerShort') : lastRun.dropName,
              })}
            </span>
            <button type="button" className="act-btn" onClick={() => void undoLast()}>
              {t('farm.undo')}
            </button>
          </>
        ) : (
          <span className="farm-panel-note">{t('farm.relicNote')}</span>
        )}
      </footer>
    </section>
  );
}
