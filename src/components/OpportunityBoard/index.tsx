import { useEffect, useMemo, useState } from 'react';
import { useAppStore, type UnderpricedListingCard } from '../../stores/useAppStore';
import { tActive, useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { formatElapsedTime } from '../../lib/dateTime';
import { tHealth } from '../../lib/healthLabels';
import { copyWhisperMessage } from '../../lib/marketMessages';
import type { Opportunity, OpportunityAction } from '../../lib/tauriClient';

const REFRESH_INTERVAL_MS = 30_000;

// Intent-based filters (not strictly category — "Farm" is any play with a farm action).
const BOARD_FILTERS: { id: string; label: string; match: (opp: Opportunity) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'snipe', label: 'Snipes', match: (opp) => opp.category === 'snipe' },
  { id: 'complete', label: 'Complete', match: (opp) => opp.category === 'setCompletion' },
  { id: 'sell', label: 'Sell', match: (opp) => opp.category === 'sellInventory' },
  { id: 'farm', label: 'Farm', match: (opp) => opp.actions.some((a) => a.kind === 'farmRelic') },
  { id: 'flip', label: 'Flip', match: (opp) => opp.category === 'flip' },
  { id: 'reprice', label: 'Reprice', match: (opp) => opp.category === 'reprice' },
];

// Turn a live underpriced listing that completes one of your sets into a board opportunity:
// urgent, pinnable, and actionable (copy the buy whisper to that seller).
function snipeToOpportunity(card: UnderpricedListingCard): Opportunity {
  const completes = card.completesSet;
  const savings = Math.max(0, Math.round(card.recommendedPrice - card.listedPrice));
  const confidence = card.tier === 'red' ? 0.85 : card.tier === 'yellow' ? 0.7 : 0.6;
  return {
    id: `snipe:${card.orderId}`,
    subjectKey: `snipe:${card.orderId}`,
    category: 'snipe',
    titleKey: 'opp.snipeTitle',
    titleParams: { name: card.itemName },
    subtitleKey: completes ? 'opp.completesYour' : 'opp.underpricedNeed',
    subtitleParams: completes
      ? { set: completes.setName, owned: String(completes.ownedDistinct), needed: String(completes.neededDistinct) }
      : {},
    setSlug: completes?.setSlug ?? null,
    imagePath: null,
    estValue: savings,
    cost: Math.round(card.listedPrice),
    valueBasis: 'savings',
    pricedAt: null,
    confidence,
    confidenceLabel: confidence >= 0.75 ? 'High' : confidence >= 0.45 ? 'Medium' : 'Low',
    urgency: 'expiring',
    reasons: [
      {
        icon: 'inventory',
        textKey: completes ? 'opp.youOwnPartsOf' : 'opp.partYouNeed',
        textParams: completes
          ? { owned: String(completes.ownedDistinct), needed: String(completes.neededDistinct), set: completes.setName }
          : {},
        source: 'inventory',
      },
      {
        icon: 'market',
        textKey: 'opp.listedAt',
        textParams: {
          user: card.username,
          price: String(Math.round(card.listedPrice)),
          pct: String(Math.round(card.pctBelow)),
          rec: String(Math.round(card.recommendedPrice)),
        },
        source: 'market',
      },
    ],
    actions: [
      {
        kind: 'copyWhisper',
        labelKey: 'opp.buyFrom',
        labelParams: { user: card.username },
        itemSlug: card.slug,
        itemName: card.itemName,
        price: Math.round(card.listedPrice),
        username: card.username,
      },
    ],
    score: savings * confidence + 100_000, // pin snipes to the very top — they expire.
  };
}

function ReasonIcon({ kind }: { kind: string }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'inventory':
      return (
        <svg {...common}>
          <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
          <path d="m3 7 9 5 9-5" />
          <path d="M12 12v10" />
        </svg>
      );
    case 'market':
      return (
        <svg {...common}>
          <polyline points="3 17 9 11 13 15 21 7" />
          <polyline points="15 7 21 7 21 13" />
        </svg>
      );
    case 'relics':
      return (
        <svg {...common}>
          <path d="M12 2 2 9l10 13L22 9 12 2Z" />
          <path d="M2 9h20" />
        </svg>
      );
    case 'math':
    default:
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <line x1="8" y1="7" x2="16" y2="7" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="13" y2="16" />
        </svg>
      );
  }
}

function valueBasisLabel(basis: string): string {
  if (basis === 'profit') return tActive('opp.basisProfit');
  if (basis === 'liquidation') return tActive('opp.basisToSell');
  return basis;
}

function ActionButton({ action }: { action: OpportunityAction }) {
  const requestTradeListing = useAppStore((state) => state.requestTradeListing);
  const requestOpportunitiesTab = useAppStore((state) => state.requestOpportunitiesTab);
  const openItemAnalysis = useAppStore((state) => state.openItemAnalysis);
  const setActivePage = useAppStore((state) => state.setActivePage);
  const setTradesSubTab = useAppStore((state) => state.setTradesSubTab);
  const pushToast = useAppStore((state) => state.pushToast);

  // Every action stays inside WarStonks — open the right page/flow, don't leave for the website.
  const handle = () => {
    switch (action.kind) {
      case 'buyPart':
      case 'viewItem':
        if (action.itemName) {
          void openItemAnalysis({ name: action.itemName, slug: action.itemSlug });
        }
        break;
      case 'sellPart':
      case 'sellSet':
        if (action.itemName) {
          requestTradeListing({
            orderType: 'sell',
            name: action.itemName,
            slug: action.itemSlug,
            rank: null,
            price: action.price,
          });
        }
        break;
      case 'copyWhisper':
        // Live snipe — copy the buy whisper to that exact seller.
        if (action.username && action.itemName) {
          void copyWhisperMessage(
            { username: action.username, platinum: action.price ?? 0, rank: null },
            action.itemName,
          )
            .then(() => pushToast(tActive('opp.whisperCopied'), 'success'))
            .catch(() => pushToast(tActive('opp.whisperCopyFailed'), 'error'));
        }
        break;
      case 'farmRelic':
        // Jump to "What To Farm Now" and pre-search for the part you need.
        requestOpportunitiesTab('farm-now', action.itemName ?? undefined);
        break;
      case 'editOrder':
        setTradesSubTab('orders');
        setActivePage('trades');
        break;
      default:
        break;
    }
  };

  return (
    <button type="button" className="opp-action" onClick={handle}>
      {tActive(action.labelKey as TranslationKey, action.labelParams)}
      {action.price !== null ? <span className="opp-action-price">{action.price}p</span> : null}
    </button>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="opp-dismiss"
      onClick={onClick}
      title={t('a11y.notInterested')}
      aria-label={t('a11y.dismissOpportunity')}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`opp-pin${pinned ? ' is-pinned' : ''}`}
      onClick={onClick}
      title={pinned ? tActive('opp.unpin') : tActive('opp.accept')}
      aria-label={pinned ? tActive('opp.unpinAria') : tActive('opp.acceptAria')}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      >
        <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
      </svg>
      {pinned ? tActive('opp.accepted') : tActive('opp.accept')}
    </button>
  );
}

function OpportunityCard({
  opp,
  pinned,
  onPin,
  onUnpin,
  onDismiss,
}: {
  opp: Opportunity;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const confidenceClass = `opp-conf-${opp.confidenceLabel.toLowerCase()}`;
  const imageUrl = resolveWfmAssetUrl(opp.imagePath);
  const urgent = opp.urgency === 'expiring';
  return (
    <article
      className={`opp-card opp-card-${opp.category}${pinned ? ' is-pinned' : ''}${
        urgent ? ' is-urgent' : ''
      }`}
    >
      <div className="opp-card-head">
        {imageUrl ? (
          <img className="opp-card-icon" src={imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="opp-card-icon opp-card-icon-empty" aria-hidden="true" />
        )}
        <div className="opp-card-titles">
          <h4 className="opp-card-title">
            {urgent ? <span className="opp-urgent-tag">{t('wl.live')}</span> : null}
            {t(opp.titleKey as TranslationKey, opp.titleParams)}
          </h4>
          {opp.subtitleKey ? (
            <p className="opp-card-subtitle">{t(opp.subtitleKey as TranslationKey, opp.subtitleParams)}</p>
          ) : null}
        </div>
        <div className="opp-card-value">
          <span className="opp-card-value-num">+{opp.estValue}p</span>
          <span className="opp-card-value-basis">{valueBasisLabel(opp.valueBasis)}</span>
        </div>
        <DismissButton onClick={onDismiss} />
      </div>

      <ul className="opp-reasons">
        {opp.reasons.map((reason, index) => (
          <li key={index} className="opp-reason">
            <span className="opp-reason-icon" aria-hidden="true">
              <ReasonIcon kind={reason.icon} />
            </span>
            {t(reason.textKey as TranslationKey, reason.textParams)}
          </li>
        ))}
      </ul>

      <div className="opp-card-foot">
        <span className="opp-card-meta">
          <span
            className={`opp-conf ${confidenceClass}`}
            title={t('opp.confidenceWithColon', { label: tHealth(t, opp.confidenceLabel) })}
          >
            {t('opp.confidenceSuffix', { label: tHealth(t, opp.confidenceLabel) })}
          </span>
          {opp.cost > 0 ? <span className="opp-card-cost">{t('opp.costIn', { cost: opp.cost })}</span> : null}
          {opp.pricedAt ? (
            <span className="opp-card-priced" title={t('a11y.thesePricesLastComputed')}>
              {t('opp.pricedElapsed', { time: formatElapsedTime(opp.pricedAt) })}
            </span>
          ) : null}
        </span>
        <div className="opp-actions">
          {opp.actions.map((action, index) => (
            <ActionButton key={index} action={action} />
          ))}
          <PinButton pinned={pinned} onClick={pinned ? onUnpin : onPin} />
        </div>
      </div>
    </article>
  );
}

export function OpportunityBoard() {
  const { t } = useTranslation();
  const opportunities = useAppStore((state) => state.opportunities);
  const underpricedListings = useAppStore((state) => state.underpricedListings);
  const loading = useAppStore((state) => state.opportunitiesLoading);
  const error = useAppStore((state) => state.opportunitiesError);
  const loadedAt = useAppStore((state) => state.opportunitiesLoadedAt);
  const loadCached = useAppStore((state) => state.loadCachedOpportunities);
  const refresh = useAppStore((state) => state.refreshOpportunities);
  const pinnedOpportunities = useAppStore((state) => state.pinnedOpportunities);
  const pin = useAppStore((state) => state.pinOpportunity);
  const unpin = useAppStore((state) => state.unpinOpportunity);
  const dismissedKeys = useAppStore((state) => state.dismissedOpportunityKeys);
  const dismiss = useAppStore((state) => state.dismissOpportunity);
  const restoreDismissed = useAppStore((state) => state.restoreDismissedOpportunities);
  const [activeFilter, setActiveFilter] = useState('all');
  const [budget, setBudget] = useState('');

  // Live snipes that complete a set you own become board opportunities — urgent, top of the list.
  const snipeOpps = useMemo(
    () =>
      underpricedListings
        .filter((card) => card.completesSet && card.status !== 'gone')
        .map(snipeToOpportunity)
        .sort((a, b) => b.score - a.score),
    [underpricedListings],
  );
  const allOpps = useMemo(() => [...snipeOpps, ...opportunities], [snipeOpps, opportunities]);

  // Pinned ("accepted") quests sit on top and never disappear; the rest is the recompute minus
  // anything pinned or dismissed this session.
  const pinnedAll = useMemo(
    () => Object.values(pinnedOpportunities).sort((a, b) => b.score - a.score),
    [pinnedOpportunities],
  );
  const unpinnedAll = useMemo(
    () =>
      allOpps.filter(
        (opp) => !(opp.subjectKey in pinnedOpportunities) && !dismissedKeys.has(opp.subjectKey),
      ),
    [allOpps, pinnedOpportunities, dismissedKeys],
  );

  // Budget filter — only show plays whose upfront buy-in fits (sell/farm/reprice cost 0, always pass).
  const budgetNum = budget.trim() ? Number.parseInt(budget, 10) : null;
  const budgetMatch = (opp: Opportunity) =>
    budgetNum === null || !Number.isFinite(budgetNum) || opp.cost <= budgetNum;

  // Only show a filter pill when something matches it (plus "All" and whichever is selected).
  const filters = useMemo(() => {
    const combined = [...pinnedAll, ...unpinnedAll];
    return BOARD_FILTERS.filter(
      (filter) =>
        filter.id === 'all' || filter.id === activeFilter || combined.some(filter.match),
    );
  }, [pinnedAll, unpinnedAll, activeFilter]);

  const activeMatch =
    BOARD_FILTERS.find((filter) => filter.id === activeFilter)?.match ?? (() => true);
  const matches = (opp: Opportunity) => activeMatch(opp) && budgetMatch(opp);
  const pinnedList = pinnedAll.filter(matches);
  const unpinnedList = unpinnedAll.filter(matches);
  const pricedAt = opportunities.find((opp) => opp.pricedAt)?.pricedAt ?? null;

  // Stale-while-revalidate: paint the last persisted board instantly, then recompute. A slow timer
  // keeps it fresh while open (the backend computes from caches, so this is cheap).
  useEffect(() => {
    void loadCached();
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadCached, refresh]);

  return (
    <div className="opp-board">
      <div className="opp-board-header">
        <div>
          <span className="panel-title-eyebrow">
            <span className="panel-dot panel-dot-purple" aria-hidden="true" />
            {t('opp.whatToDoNow')}
          </span>
          <p className="opp-board-sub">
            {t('opp.boardSubtitle')}
          </p>
        </div>
        <div className="opp-board-header-right">
          {pricedAt ? (
            <span className="opp-freshness" title={t('a11y.pricesLastComputed')}>
              {t('opp.pricesElapsed', { time: formatElapsedTime(pricedAt) })}
            </span>
          ) : null}
          <button
            type="button"
            className="btn-secondary opp-refresh"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? t('opp.scanning') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="opp-controls">
        <div className="opp-filters" role="tablist" aria-label={t('a11y.filterOpportunities')}>
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={activeFilter === filter.id}
              className={`opp-filter-pill${activeFilter === filter.id ? ' is-active' : ''}`}
              onClick={() => setActiveFilter(filter.id)}
            >
              {t(`oppf.${filter.id}` as TranslationKey)}
            </button>
          ))}
        </div>
        <label className="opp-budget">
          <span>{t('wl.budget')}</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            className="settings-input opp-budget-input"
            placeholder={t('a11y.any')}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          <span className="opp-budget-unit">p</span>
        </label>
      </div>

      {error ? <div className="opp-board-error">{error}</div> : null}

      {pinnedList.length > 0 ? (
        <div className="opp-section">
          <span className="opp-section-label">{t('wl.accepted')}</span>
          <div className="opp-list">
            {pinnedList.map((opp) => (
              <OpportunityCard
                key={opp.id}
                opp={opp}
                pinned
                onPin={() => pin(opp)}
                onUnpin={() => unpin(opp.subjectKey)}
                onDismiss={() => dismiss(opp.subjectKey)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {unpinnedList.length === 0 && pinnedList.length === 0 ? (
        <div className="opp-board-empty">
          {loading && loadedAt === null
            ? t('opp.lookingForOpportunities')
            : activeFilter !== 'all' || budgetNum !== null
              ? t('opp.nothingMatchesFilters')
              : t('opp.noStandoutMoves')}
        </div>
      ) : unpinnedList.length > 0 ? (
        <div className="opp-section">
          {pinnedList.length > 0 ? <span className="opp-section-label">{t('wl.more')}</span> : null}
          <div className="opp-list">
            {unpinnedList.map((opp) => (
              <OpportunityCard
                key={opp.id}
                opp={opp}
                pinned={false}
                onPin={() => pin(opp)}
                onUnpin={() => unpin(opp.subjectKey)}
                onDismiss={() => dismiss(opp.subjectKey)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {dismissedKeys.size > 0 ? (
        <button type="button" className="opp-restore" onClick={() => restoreDismissed()}>
          {dismissedKeys.size} hidden — show again
        </button>
      ) : null}
    </div>
  );
}
