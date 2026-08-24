import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ItemThumb } from '../ListRow';
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
        <Button
          variant="ghost"
          aria-label={t('farm.reopen')}
          title={loading.label}
          onClick={() => setExpanded(true)}
          className="fixed right-6 bottom-6 z-(--z-nav) size-13 rounded-full border border-accent-amber/50 bg-bg-elevated text-accent-amber shadow-float"
        >
          {/* A spinner, not a skeleton, and deliberately: this is a *pending action* the user
              just triggered, not content loading into a known shape. Rule 5 is about the
              latter. */}
          <span
            className="size-5 animate-spin rounded-full border-2 border-accent-amber/30 border-t-accent-amber"
            aria-hidden="true"
          />
        </Button>
      );
    }
    return (
      <section
        ref={panelRef}
        className="fixed right-6 bottom-6 z-(--z-nav) flex w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-accent-amber/40 bg-bg-elevated shadow-float"
        aria-busy="true"
        aria-label={t('farm.nowFarming')}
      >
        <header className="flex items-start justify-between gap-2.5 border-b border-line p-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-[9px] tracking-[0.07em] uppercase text-accent-amber">
              {t('farm.huntingItem', { item: loading.label })}
            </span>
            <strong className="truncate text-sm text-ink">{t('farm.findingRelics')}</strong>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('farm.minimize')}
            title={t('farm.minimize')}
            onClick={() => setExpanded(false)}
          >
            <i className="ti ti-chevron-down" aria-hidden="true" />
          </Button>
        </header>
        {/* The relic list is a variable-length list of unknown length, so a skeleton would be
            inventing a shape. A pending line is honest here. */}
        <div className="flex items-center gap-2 p-3.5 text-[11px] text-ink-dim">
          <span
            className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent-amber"
            aria-hidden="true"
          />
          {t('farm.loadingRelics')}
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
      // Amber is the farming session's colour throughout (`ELEMENTS.md` §5) — the one
      // established extension to "accents carry meaning".
      <Button
        variant="ghost"
        aria-label={t('farm.reopen')}
        title={`${t('farm.nowFarming')}: ${active?.relicName ?? ''}`}
        onClick={() => setExpanded(true)}
        className="fixed right-6 bottom-6 z-(--z-nav) size-13 rounded-full border border-accent-amber/50 bg-bg-elevated text-accent-amber shadow-float hover:bg-bg-overlay hover:text-accent-amber"
      >
        <i className="ti ti-flame text-xl" aria-hidden="true" />
        {totalRuns > 0 ? (
          <span className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-accent-amber px-1.5 font-mono text-[10px] font-bold tabular-nums text-bg-base">
            {totalRuns}
          </span>
        ) : null}
      </Button>
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
      // Filler recedes: it is worth nothing and is only here so "I got nothing" is one tap
      // rather than a decision.
      <Button
        key={drop.slug}
        variant="ghost"
        size="sm"
        static
        onClick={() => void logDrop(drop)}
        className={`h-auto w-full justify-start gap-2 rounded-md border px-2 py-1.5 text-left ${
          drop.isFiller
            ? 'border-line bg-bg-base text-ink-dim'
            : 'border-line-strong bg-bg-base hover:border-accent-amber/45 hover:bg-accent-amber/8'
        }`}
      >
        <ItemThumb src={image} fallback={drop.name.slice(0, 1)} size="size-7" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[11px] font-medium text-ink">
            {drop.isFiller ? t('farm.filler') : drop.name}
          </span>
          {!drop.isFiller ? (
            <span className="truncate font-mono text-[10px] font-normal tabular-nums text-ink-dim">
              {drop.rarity ?? ''}
              {drop.chance != null ? ` · ${Math.round(drop.chance * 100)}%` : ''}
              {drop.recommendedExitPrice != null ? ` · ${drop.recommendedExitPrice}p` : ''}
            </span>
          ) : null}
        </span>
      </Button>
    );
  };

  const realDrops = drops.filter((drop) => !drop.isFiller);
  const fillerDrops = drops.filter((drop) => drop.isFiller);

  return (
    // Amber-framed and fixed bottom-right: a farming run is a *session* that outlives whatever
    // page you navigate to, so it floats above the app rather than living on one.
    <section
      ref={panelRef}
      className="fixed right-6 bottom-6 z-(--z-nav) flex max-h-[min(70vh,640px)] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-accent-amber/40 bg-bg-elevated shadow-float"
      aria-label={t('farm.nowFarming')}
    >
      <header className="flex shrink-0 items-start justify-between gap-2.5 border-b border-line p-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase text-accent-amber">
            {session.targetDropName
              ? t('farm.huntingItem', { item: session.targetDropName })
              : t('farm.nowFarming')}
          </span>
          <strong className="truncate text-sm text-ink">{active?.relicName ?? ''}</strong>
          <span className="flex flex-wrap items-baseline gap-x-1.5 text-[10px]">
            <span className="text-ink-dim">
              {t('farm.runningAt', { refinement: active?.refinement ?? '' })}
            </span>
            {/* Running below the recommended refinement costs real odds, so it reads amber. */}
            {active && active.recommendedRefinement !== active.refinement ? (
              <span className="text-accent-amber" title={t('farm.upgradeHint')}>
                {t('farm.recommends', { refinement: active.recommendedRefinement })}
              </span>
            ) : (
              <span className="text-accent-green">{t('farm.bestAlready')}</span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={stop}>
            {t('farm.stop')}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('farm.minimize')}
            title={t('farm.minimize')}
            onClick={() => setExpanded(false)}
          >
            <i className="ti ti-chevron-down" aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* One scroll region: the header, the cycle and the footer stay put while the drop list
          moves, so "what did you get" is always reachable without hunting for it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">

      {/* Relic carousel: the cycle is frozen at selection time, so changing filters afterwards
          can't reorder what the user is stepping through. */}
      {canCycle ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('farm.previousRelic')}
            onClick={() => cycleRelic(-1)}
          >
            <i className="ti ti-chevron-left" aria-hidden="true" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-bg-base px-2 py-1.5">
            {/* Relic art draws no thumbnail chrome — `ELEMENTS.md` §7. */}
            <ItemThumb
              src={activeRelicImage}
              fallback={(active?.relicName ?? '?').slice(0, 2)}
              size="size-8"
              chrome={false}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[11px] font-medium text-ink">{active?.relicName}</span>
              <span className="truncate font-mono text-[10px] tabular-nums text-ink-dim">
                {t('farm.relicsLeft', { n: remaining, total: active?.ownedCount ?? 0 })}
                {active?.targetChance != null
                  ? ` · ${Math.round(active.targetChance * 100)}% ${t('opp.oddsPerRun')}`
                  : ''}
                {active?.targetOdds != null
                  ? ` · ${Math.round(active.targetOdds * 100)}% ${t('farm.overall')}`
                  : ''}
              </span>
            </div>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
              {session.activeIndex + 1}/{session.cycle.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('farm.nextRelic')}
            onClick={() => cycleRelic(1)}
          >
            <i className="ti ti-chevron-right" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

        <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-ink-dim">
          <span>
            <strong className="text-ink">{runCount}</strong>{' '}
            {runCount === 1 ? t('farm.runsLoggedOne') : t('farm.runsLogged', { n: runCount })}
          </span>
          <span>
            <strong className="text-accent-green">{platGained}p</strong> {t('farm.platGained')}
          </span>
          {/* Cumulative odds of having seen the target by now — the number that tells you when
              to stop, and it plots a computed value, not a mood. */}
          {seenOdds !== null && bestDrop ? (
            <span className="text-accent-amber">
              {t('farm.sessionOdds', {
                n: runCount,
                pct: `${Math.round(seenOdds * 100)}%`,
              })}
            </span>
          ) : null}
        </div>

        <div className="shrink-0 text-[11px] font-medium text-ink">
          {allSpent ? t('farm.allSpent') : t('farm.whatDidYouGet')}
        </div>

        {drops.length === 0 ? (
          <p className="text-[11px] text-ink-dim">{t('farm.noDrops')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {realDrops.map(renderDrop)}
            {fillerDrops.map(renderDrop)}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3.5 py-2.5">
        {lastRun ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[10px] text-ink-dim">
              {t('farm.lastLogged', {
                item: lastRun.isFiller ? t('farm.fillerShort') : lastRun.dropName,
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              onClick={() => void undoLast()}
            >
              {t('farm.undo')}
            </Button>
          </>
        ) : (
          <span className="text-[10px] leading-relaxed text-ink-faint">{t('farm.relicNote')}</span>
        )}
      </footer>
    </section>
  );
}
