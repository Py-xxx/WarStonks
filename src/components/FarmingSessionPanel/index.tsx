import { useEffect, useRef } from 'react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { resolveRelicAssetUrl, resolveWfmAssetUrl } from '../../lib/wfmAssets';
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
  const cycleRelic = useAppStore((state) => state.cycleFarmingRelic);
  const loading = useAppStore((state) => state.farmingSessionLoading);
  const panelRef = useRef<HTMLElement | null>(null);

  // Get out of the way as soon as attention moves elsewhere — the panel sits over page content,
  // and the bubble keeps the session one click away. Uses pointerdown so it collapses on press
  // rather than after the click resolves; a "Farm this" click elsewhere still wins because
  // startFarmingSession re-expands on the click that follows.
  useEffect(() => {
    if ((!session && !loading) || !expanded) {
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
  }, [session, loading, expanded, setExpanded]);

  // A session still resolving renders the panel shell straight away — the whole point is that
  // clicking "Farm this" feels instant rather than dead for a second or two.
  if (!session && loading) {
    if (!expanded) {
      return (
        <button
          type="button"
          className="farm-fab is-loading"
          aria-label={t('farm.reopen')}
          title={loading.label}
          onClick={() => setExpanded(true)}
        >
          <span className="farm-fab-spinner" aria-hidden="true" />
        </button>
      );
    }
    return (
      <section ref={panelRef} className="farm-panel" aria-busy="true" aria-label={t('farm.nowFarming')}>
        <header className="farm-panel-head">
          <div className="farm-panel-title">
            <span className="farm-panel-eyebrow">{t('farm.huntingItem', { item: loading.label })}</span>
            <strong>{t('farm.findingRelics')}</strong>
          </div>
          <button
            type="button"
            className="farm-panel-minimize"
            aria-label={t('farm.minimize')}
            title={t('farm.minimize')}
            onClick={() => setExpanded(false)}
          >
            <i className="ti ti-chevron-down" aria-hidden="true" />
          </button>
        </header>
        <div className="farm-panel-loading">
          <span className="farm-panel-spinner" aria-hidden="true" />
          <span>{t('farm.loadingRelics')}</span>
        </div>
      </section>
    );
  }

  if (!session) {
    return null;
  }

  const active = session.cycle[session.activeIndex];
  // Era art, not WFM's per-item relic picture: a relic's era is its whole visual identity, and
  // the four refinements would otherwise be four near-identical images.
  const activeRelicImage = active
    ? resolveRelicAssetUrl(active) ?? resolveWfmAssetUrl(active.relicImagePath)
    : null;
  // Per-relic count: cycling back to a relic keeps its history (session totals stay global).
  const runCount = active
    ? session.runs.filter((run) => run.relicSlug === active.relicSlug).length
    : 0;
  const totalRuns = session.runs.length;
  const lastRun = session.runs[totalRuns - 1] ?? null;
  const canCycle = session.cycle.length > 1;
  // Session-local depletion: what's left of this relic after the runs logged here. Display only —
  // the real inventory still comes from AlecaFrame.
  const remaining = active ? Math.max(0, active.ownedCount - runCount) : 0;
  const allSpent =
    session.cycle.every(
      (relic) =>
        session.runs.filter((run) => run.relicSlug === relic.relicSlug).length >= relic.ownedCount,
    );

  if (!expanded) {
    return (
      <button
        type="button"
        className="farm-fab"
        aria-label={t('farm.reopen')}
        title={`${t('farm.nowFarming')}: ${active?.relicName ?? ''}`}
        onClick={() => setExpanded(true)}
      >
        <i className="ti ti-flame" aria-hidden="true" />
        {totalRuns > 0 ? <span className="farm-fab-badge">{totalRuns}</span> : null}
      </button>
    );
  }

  // Plat added this session, counting only real parts (filler is worth nothing to us).
  const platGained = session.runs.reduce((sum, run) => {
    const drop = session.cycle
      .flatMap((relic) => relic.drops)
      .find((entry) => entry.slug === run.dropSlug);
    return sum + (run.isFiller ? 0 : drop?.recommendedExitPrice ?? 0);
  }, 0);

  // Live odds: across the runs logged so far, how likely you'd have seen the best drop by now.
  // Item-targeted sessions track the item you're hunting; otherwise fall back to the relic's
  // most valuable drop.
  const drops = active?.drops ?? [];
  const bestDrop = session.targetDropSlug
    ? drops.find((drop) => drop.slug === session.targetDropSlug)
    : drops
        .filter((drop) => !drop.isFiller && drop.chance !== null)
        .sort((a, b) => (b.recommendedExitPrice ?? 0) - (a.recommendedExitPrice ?? 0))[0];
  const seenOdds =
    bestDrop?.chance != null && runCount > 0
      ? atLeastOneChance([{ chance: bestDrop.chance, count: runCount }])
      : null;

  const renderDrop = (drop: FarmingSessionDrop) => {
    const image = resolveWfmAssetUrl(drop.imagePath, drop.slug);
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

  const realDrops = drops.filter((drop) => !drop.isFiller);
  const fillerDrops = drops.filter((drop) => drop.isFiller);

  return (
    <section ref={panelRef} className="farm-panel" aria-label={t('farm.nowFarming')}>
      <header className="farm-panel-head">
        <div className="farm-panel-title">
          <span className="farm-panel-eyebrow">
            {session.targetDropName
              ? t('farm.huntingItem', { item: session.targetDropName })
              : t('farm.nowFarming')}
          </span>
          <strong>{active?.relicName ?? ''}</strong>
          <span className="farm-panel-refinement">
            <span className="farm-refine-current">
              {t('farm.runningAt', { refinement: active?.refinement ?? '' })}
            </span>
            {active && active.recommendedRefinement !== active.refinement ? (
              <span className="farm-refine-recommended" title={t('farm.upgradeHint')}>
                {t('farm.recommends', { refinement: active.recommendedRefinement })}
              </span>
            ) : (
              <span className="farm-refine-best">{t('farm.bestAlready')}</span>
            )}
          </span>
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

      {/* Relic carousel: the cycle is frozen at selection time, so changing filters afterwards
          can't reorder what the user is stepping through. */}
      {canCycle ? (
        <div className="farm-cycle">
          <button
            type="button"
            className="farm-cycle-arrow"
            aria-label={t('farm.previousRelic')}
            onClick={() => cycleRelic(-1)}
          >
            <i className="ti ti-chevron-left" aria-hidden="true" />
          </button>
          <div className="farm-cycle-card">
            <span className="farm-cycle-thumb relic-art" aria-hidden="true">
              {activeRelicImage ? (
                <img src={activeRelicImage} alt="" />
              ) : (
                <span>{(active?.relicName ?? '?').slice(0, 2)}</span>
              )}
            </span>
            <div className="farm-cycle-copy">
              <span className="farm-cycle-name">{active?.relicName}</span>
              <span className="farm-cycle-meta">
                {t('farm.relicsLeft', { n: remaining, total: active?.ownedCount ?? 0 })}
                {active?.targetChance != null
                  ? ` · ${Math.round(active.targetChance * 100)}% ${t('opp.oddsPerRun')}`
                  : ''}
                {active?.targetOdds != null
                  ? ` · ${Math.round(active.targetOdds * 100)}% ${t('farm.overall')}`
                  : ''}
              </span>
            </div>
            <span className="farm-cycle-index">
              {session.activeIndex + 1}/{session.cycle.length}
            </span>
          </div>
          <button
            type="button"
            className="farm-cycle-arrow"
            aria-label={t('farm.nextRelic')}
            onClick={() => cycleRelic(1)}
          >
            <i className="ti ti-chevron-right" aria-hidden="true" />
          </button>
        </div>
      ) : null}

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

      <div className="farm-panel-prompt">
        {allSpent ? t('farm.allSpent') : t('farm.whatDidYouGet')}
      </div>

      {drops.length === 0 ? (
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
