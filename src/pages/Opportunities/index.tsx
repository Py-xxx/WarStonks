import { useEffect, useMemo, useState } from 'react';
import {
  getArbitrageScannerState,
  getSetCompletionOwnedItems,
  getWfmAutocompleteItems,
  setSetCompletionOwnedItemQuantity,
} from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerResponse,
  ArbitrageScannerSetEntry,
  SetCompletionOwnedItem,
  WfmAutocompleteItem,
} from '../../types';

type OppTab = 'opportunities' | 'farm-now' | 'set-planner' | 'owned-relics';

type PlannerComponentState = {
  component: ArbitrageScannerComponentEntry;
  ownedQuantity: number;
  coveredQuantity: number;
  missingQuantity: number;
  isOwned: boolean;
};

type PlannerSetEntry = {
  entry: ArbitrageScannerSetEntry;
  ownedComponentCount: number;
  totalComponentCount: number;
  remainingInvestment: number | null;
  completionProfit: number | null;
  completionRoiPct: number | null;
  components: PlannerComponentState[];
};

type PlannerCatalogItem = {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
};

function formatPlat(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${Math.round(value)}p`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${Math.round(value)}%`;
}

function confidenceTone(level: string): string {
  switch (level) {
    case 'high':
      return 'green';
    case 'low':
      return 'amber';
    default:
      return 'blue';
  }
}

function isPlannerCatalogCandidate(item: WfmAutocompleteItem): boolean {
  const family = item.itemFamily?.toLowerCase() ?? '';
  const name = item.name.toLowerCase();

  if (family) {
    if (family.includes('set')) {
      return false;
    }
    if (family.includes('prime')) {
      return true;
    }
    if (family.includes('component')) {
      return true;
    }
  }

  if (!name.includes('prime')) {
    return false;
  }
  if (name.endsWith(' set')) {
    return false;
  }

  return true;
}

function buildPlannerDefaultTarget(component: ArbitrageScannerComponentEntry): string {
  if (
    component.recommendedEntryLow !== null &&
    component.recommendedEntryHigh !== null
  ) {
    return String(
      Math.max(
        1,
        Math.round((component.recommendedEntryLow + component.recommendedEntryHigh) / 2),
      ),
    );
  }

  if (component.recommendedEntryPrice !== null) {
    return String(Math.max(1, Math.round(component.recommendedEntryPrice)));
  }

  return '';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function SetPlannerRow({
  planner,
  expanded,
  onToggle,
  targetInputs,
  onTargetChange,
  onAddToWatchlist,
}: {
  planner: PlannerSetEntry;
  expanded: boolean;
  onToggle: () => void;
  targetInputs: Record<string, string>;
  onTargetChange: (component: ArbitrageScannerComponentEntry, value: string) => void;
  onAddToWatchlist: (component: ArbitrageScannerComponentEntry) => void;
}) {
  const imageUrl = resolveWfmAssetUrl(planner.entry.imagePath);

  return (
    <article className={`planner-set-row${expanded ? ' is-expanded' : ''}`}>
      <button type="button" className="planner-set-button" onClick={onToggle}>
        <div className="planner-set-main">
          <span className="planner-set-thumb">
            {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{planner.entry.name.slice(0, 1)}</span>}
          </span>
          <div className="planner-set-copy">
            <span className="panel-title-eyebrow">Set Completion Planner</span>
            <strong>{planner.entry.name}</strong>
            <span className="planner-set-note">
              {planner.ownedComponentCount}/{planner.totalComponentCount} components owned
            </span>
          </div>
          <div className="planner-set-pills">
            <span className="market-panel-badge tone-green">
              {planner.ownedComponentCount}/{planner.totalComponentCount} owned
            </span>
            <span className="market-panel-badge tone-blue">
              Invest {formatPlat(planner.remainingInvestment)}
            </span>
            <span className="market-panel-badge tone-blue">
              Exit {formatPlat(planner.entry.recommendedSetExitPrice)}
            </span>
            <span className="market-panel-badge tone-green">
              Profit {formatPlat(planner.completionProfit)}
            </span>
            <span className="market-panel-badge tone-blue">
              ROI {formatPercent(planner.completionRoiPct)}
            </span>
            <span className="market-panel-badge tone-blue">
              Liquidity {Math.round(planner.entry.liquidityScore)}%
            </span>
            <span className={`market-panel-badge tone-${confidenceTone(planner.entry.confidenceSummary.level)}`}>
              {planner.entry.confidenceSummary.label}
            </span>
            <span className="planner-set-chevron">{expanded ? '−' : '+'}</span>
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="planner-set-body">
          <div className="planner-component-list">
            {planner.components.map((componentState) => {
              const { component } = componentState;
              const imagePath = resolveWfmAssetUrl(component.imagePath);
              const targetKey = `${planner.entry.slug}:${component.slug}`;
              const effectiveTarget =
                targetInputs[targetKey] ?? buildPlannerDefaultTarget(component);

              return (
                <div
                  key={`${planner.entry.slug}-${component.slug}`}
                  className={`planner-component-row${componentState.isOwned ? ' is-owned' : ' is-missing'}`}
                >
                  <div className="planner-component-main">
                    <span className="planner-component-thumb">
                      {imagePath ? (
                        <img src={imagePath} alt="" loading="lazy" />
                      ) : (
                        <span>{component.name.slice(0, 1)}</span>
                      )}
                    </span>
                    <div className="planner-component-copy">
                      <div className="planner-component-name-row">
                        <strong>{component.name}</strong>
                        <span
                          className={`market-panel-badge ${componentState.isOwned ? 'tone-green' : 'tone-red'}`}
                        >
                          {componentState.coveredQuantity}/{component.quantityInSet} owned
                        </span>
                        <span className={`market-panel-badge tone-${confidenceTone(component.confidenceSummary.level)}`}>
                          {component.confidenceSummary.label}
                        </span>
                      </div>
                      <div className="planner-component-pills">
                        <span className="scanner-stat-pill">
                          <span className="scanner-stat-pill-label">Stats price</span>
                          <span className="scanner-stat-pill-value">{formatPlat(component.currentStatsPrice)}</span>
                        </span>
                        <span className="scanner-stat-pill scanner-stat-pill-highlight">
                          <span className="scanner-stat-pill-label">Entry</span>
                          <span className="scanner-stat-pill-value">{formatPlat(component.recommendedEntryPrice)}</span>
                        </span>
                        <span className="scanner-stat-pill scanner-stat-pill-highlight">
                          <span className="scanner-stat-pill-label">Entry Zone</span>
                          <span className="scanner-stat-pill-value">
                            {formatPlat(component.recommendedEntryLow)} - {formatPlat(component.recommendedEntryHigh)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {componentState.missingQuantity > 0 ? (
                    <div className="planner-component-actions">
                      <input
                        className="price-input scanner-component-input"
                        type="number"
                        min="1"
                        step="1"
                        value={effectiveTarget}
                        onChange={(event) => onTargetChange(component, event.target.value)}
                      />
                      <button
                        className="btn-sm scanner-component-watch-button"
                        type="button"
                        disabled={!effectiveTarget.trim() || !component.itemId}
                        onClick={() => onAddToWatchlist(component)}
                      >
                        Add to Watchlist
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function OpportunitiesPage() {
  const [activeTab, setActiveTab] = useState<OppTab>('set-planner');
  const [scannerResponse, setScannerResponse] = useState<ArbitrageScannerResponse | null>(null);
  const [ownedItems, setOwnedItems] = useState<SetCompletionOwnedItem[]>([]);
  const [fallbackCatalog, setFallbackCatalog] = useState<PlannerCatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [expandedSetSlug, setExpandedSetSlug] = useState<string | null>(null);
  const [componentQuery, setComponentQuery] = useState('');
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [plannerTargetInputs, setPlannerTargetInputs] = useState<Record<string, string>>({});

  const setActivePage = useAppStore((state) => state.setActivePage);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);

  const tabs: { id: OppTab; label: string }[] = [
    { id: 'opportunities', label: 'Opportunities' },
    { id: 'farm-now', label: 'What To Farm Now' },
    { id: 'set-planner', label: 'Set Completion Planner' },
    { id: 'owned-relics', label: 'Owned Relics' },
  ];

  useEffect(() => {
    if (activeTab !== 'set-planner') {
      return;
    }

    let cancelled = false;

    const loadPlannerState = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const [scannerState, owned] = await Promise.all([
          getArbitrageScannerState(),
          getSetCompletionOwnedItems(),
        ]);
        if (cancelled) {
          return;
        }

        setScannerResponse(scannerState.latestScan);
        setOwnedItems(owned);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMessage(toErrorMessage(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadPlannerState();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'set-planner') {
      return;
    }
    if ((scannerResponse?.results?.length ?? 0) > 0) {
      return;
    }
    if (fallbackCatalog.length > 0 || catalogLoading) {
      return;
    }

    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);

    getWfmAutocompleteItems()
      .then((items) => {
        if (cancelled) {
          return;
        }
        const catalog = items
          .filter(isPlannerCatalogCandidate)
          .map((item) => ({
            itemId: item.itemId,
            slug: item.slug,
            name: item.name,
            imagePath: item.imagePath,
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setFallbackCatalog(catalog);
      })
      .catch((error) => {
        if (!cancelled) {
          setCatalogError(toErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, catalogLoading, fallbackCatalog.length, scannerResponse]);

  const plannerCatalog = useMemo<PlannerCatalogItem[]>(() => {
    if (!(scannerResponse?.results?.length ?? 0)) {
      return fallbackCatalog;
    }

    const bySlug = new Map<string, PlannerCatalogItem>();
    for (const setEntry of scannerResponse?.results ?? []) {
      for (const component of setEntry.components) {
        if (!bySlug.has(component.slug)) {
          bySlug.set(component.slug, {
            itemId: component.itemId,
            slug: component.slug,
            name: component.name,
            imagePath: component.imagePath,
          });
        }
      }
    }

    return [...bySlug.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [fallbackCatalog, scannerResponse]);

  const ownedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of ownedItems) {
      map.set(item.slug, item.quantity);
    }
    return map;
  }, [ownedItems]);

  const plannerEntries = useMemo<PlannerSetEntry[]>(() => {
    const results = scannerResponse?.results ?? [];
    const computed: PlannerSetEntry[] = [];

    for (const entry of results) {
      const componentStates = entry.components.map((component) => {
        const ownedQuantity = ownedMap.get(component.slug) ?? 0;
        const coveredQuantity = Math.min(ownedQuantity, component.quantityInSet);
        const missingQuantity = Math.max(component.quantityInSet - coveredQuantity, 0);
        return {
          component,
          ownedQuantity,
          coveredQuantity,
          missingQuantity,
          isOwned: missingQuantity === 0,
        };
      });

      if (!componentStates.some((component) => component.ownedQuantity > 0)) {
        continue;
      }

      const totalComponentCount = componentStates.length;
      const ownedComponentCount = componentStates.filter((component) => component.isOwned).length;

      let remainingInvestment = 0;
      let hasPricingGap = false;
      for (const component of componentStates) {
        if (component.missingQuantity === 0) {
          continue;
        }
        if (component.component.recommendedEntryPrice === null) {
          hasPricingGap = true;
          break;
        }
        remainingInvestment += component.missingQuantity * component.component.recommendedEntryPrice;
      }

      const normalizedRemainingInvestment = hasPricingGap ? null : remainingInvestment;
      const completionProfit =
        normalizedRemainingInvestment !== null && entry.recommendedSetExitPrice !== null
          ? entry.recommendedSetExitPrice - normalizedRemainingInvestment
          : null;
      const completionRoiPct =
        completionProfit !== null && normalizedRemainingInvestment && normalizedRemainingInvestment > 0
          ? (completionProfit / normalizedRemainingInvestment) * 100
          : null;

      computed.push({
        entry,
        ownedComponentCount,
        totalComponentCount,
        remainingInvestment: normalizedRemainingInvestment,
        completionProfit,
        completionRoiPct,
        components: componentStates,
      });
    }

    return computed.sort((left, right) => {
      if (right.ownedComponentCount !== left.ownedComponentCount) {
        return right.ownedComponentCount - left.ownedComponentCount;
      }

      const leftProfit = left.completionProfit ?? Number.NEGATIVE_INFINITY;
      const rightProfit = right.completionProfit ?? Number.NEGATIVE_INFINITY;
      if (rightProfit !== leftProfit) {
        return rightProfit - leftProfit;
      }

      return right.entry.liquidityScore - left.entry.liquidityScore;
    });
  }, [ownedMap, scannerResponse]);

  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = componentQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return plannerCatalog.slice(0, 8);
    }

    return plannerCatalog
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 8);
  }, [componentQuery, plannerCatalog]);

  const upsertOwnedItem = async (item: PlannerCatalogItem, quantity: number) => {
    setSavingSlug(item.slug);
    setErrorMessage(null);
    try {
      const nextOwnedItems = await setSetCompletionOwnedItemQuantity({
        itemId: item.itemId,
        slug: item.slug,
        name: item.name,
        imagePath: item.imagePath,
        quantity,
      });
      setOwnedItems(nextOwnedItems);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setSavingSlug(null);
    }
  };

  const addOwnedComponent = async (item: PlannerCatalogItem) => {
    const currentQuantity = ownedMap.get(item.slug) ?? 0;
    await upsertOwnedItem(item, currentQuantity + 1);
    setComponentQuery('');
  };

  const updateOwnedQuantityByDelta = async (item: SetCompletionOwnedItem, delta: number) => {
    await upsertOwnedItem(
      {
        itemId: item.itemId,
        slug: item.slug,
        name: item.name,
        imagePath: item.imagePath,
      },
      Math.max(item.quantity + delta, 0),
    );
  };

  const handlePlannerTargetChange = (
    component: ArbitrageScannerComponentEntry,
    value: string,
    setSlug: string,
  ) => {
    setPlannerTargetInputs((current) => ({
      ...current,
      [`${setSlug}:${component.slug}`]: value,
    }));
  };

  const handleAddMissingComponentToWatchlist = (
    component: ArbitrageScannerComponentEntry,
    setSlug: string,
  ) => {
    if (!component.itemId) {
      return;
    }

    const value = plannerTargetInputs[`${setSlug}:${component.slug}`] ?? buildPlannerDefaultTarget(component);
    const targetPrice = Number.parseFloat(value);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      setErrorMessage('Enter a valid watch target before adding the component to the watchlist.');
      return;
    }

    const watchlistItem: WfmAutocompleteItem = {
      itemId: component.itemId,
      wfmId: null,
      name: component.name,
      slug: component.slug,
      maxRank: null,
      itemFamily: 'prime-part',
      imagePath: component.imagePath,
    };

    addExplicitItemToWatchlist(watchlistItem, 'base', 'Base Market', targetPrice);
  };

  const noScanAvailable = !loading && !(scannerResponse?.results?.length);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Opportunities</span>
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className={`subtab${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              tabIndex={0}
            >
              {tab.label}
            </span>
          ))}
        </div>
      </div>

      <div className="page-content">
        {activeTab !== 'set-planner' ? (
          <div className="opportunities-placeholder">
            No opportunities found — try adjusting strategy filters
          </div>
        ) : (
          <div className={`set-planner-layout${drawerOpen ? '' : ' drawer-collapsed'}`}>
            <section className="market-panel set-planner-main-panel">
              <div className="set-planner-header">
                <div>
                  <span className="panel-title-eyebrow">Completion Opportunities</span>
                  <h3>Set Completion Planner</h3>
                  <p>
                    Uses your owned prime parts plus the cached Arbitrage scan to estimate the remaining
                    investment and completion profit for one set at a time.
                  </p>
                </div>
                <div className="set-planner-header-actions">
                  <button
                    type="button"
                    className="btn-secondary set-planner-drawer-toggle"
                    onClick={() => setDrawerOpen((current) => !current)}
                  >
                    {drawerOpen ? 'Hide Owned Parts' : 'Show Owned Parts'}
                  </button>
                </div>
              </div>

              {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}

              {loading ? (
                <div className="opportunities-placeholder">Loading planner data…</div>
              ) : noScanAvailable ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">Scanner Cache Required</span>
                    <h3>Run an Arbitrage scan first</h3>
                    <p>
                      You can still add or edit owned parts now. Run the scan when you want completion
                      pricing and profit projections to appear.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setActivePage('scanners')}
                  >
                    Open Scanners
                  </button>
                </div>
              ) : plannerEntries.length === 0 ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">Owned Parts Needed</span>
                    <h3>Add prime parts you already own</h3>
                    <p>
                      Use the owned-parts drawer to add prime components. The planner will then show only
                      the sets where you already own at least one required piece.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="set-planner-results">
                  {plannerEntries.map((planner) => (
                    <SetPlannerRow
                      key={planner.entry.slug}
                      planner={planner}
                      expanded={expandedSetSlug === planner.entry.slug}
                      onToggle={() =>
                        setExpandedSetSlug((current) =>
                          current === planner.entry.slug ? null : planner.entry.slug,
                        )
                      }
                      targetInputs={plannerTargetInputs}
                      onTargetChange={(component, value) =>
                        handlePlannerTargetChange(component, value, planner.entry.slug)
                      }
                      onAddToWatchlist={(component) =>
                        handleAddMissingComponentToWatchlist(component, planner.entry.slug)
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <aside className={`market-panel set-planner-drawer${drawerOpen ? '' : ' is-collapsed'}`}>
              <div className="set-planner-drawer-header">
                <div>
                  <span className="panel-title-eyebrow">Owned Inventory</span>
                  <h3>Prime Parts</h3>
                </div>
                <button
                  type="button"
                  className="btn-icon set-planner-drawer-icon"
                  onClick={() => setDrawerOpen((current) => !current)}
                  aria-label={drawerOpen ? 'Collapse owned parts drawer' : 'Expand owned parts drawer'}
                >
                  {drawerOpen ? '→' : '←'}
                </button>
              </div>

              {drawerOpen ? (
                <>
                  <div className="set-planner-add-card">
                    <label className="watchlist-add-label" htmlFor="planner-component-search">
                      Add owned component
                    </label>
                    <input
                      id="planner-component-search"
                      className="top-search-input set-planner-search-input"
                      type="text"
                      placeholder={plannerCatalog.length ? 'Search prime components' : 'Loading catalog…'}
                      value={componentQuery}
                      onChange={(event) => setComponentQuery(event.target.value)}
                      disabled={!plannerCatalog.length}
                    />
                    {plannerCatalog.length ? (
                      <div className="set-planner-suggestions">
                        {filteredSuggestions.map((item) => (
                          <button
                            key={item.slug}
                            type="button"
                            className="set-planner-suggestion"
                            onClick={() => {
                              void addOwnedComponent(item);
                            }}
                          >
                            <span className="set-planner-suggestion-name">{item.name}</span>
                            <span className="set-planner-suggestion-action">Add</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="watchlist-form-note">
                        {catalogLoading
                          ? 'Loading local component catalog…'
                          : catalogError ?? 'Component catalog is not available yet.'}
                      </div>
                    )}
                  </div>

                  <div className="set-planner-owned-list">
                    {ownedItems.length ? (
                      ownedItems.map((item) => {
                        const imageUrl = resolveWfmAssetUrl(item.imagePath);
                        return (
                          <div key={item.slug} className="set-planner-owned-row">
                            <div className="set-planner-owned-main">
                              <span className="set-planner-owned-thumb">
                                {imageUrl ? (
                                  <img src={imageUrl} alt="" loading="lazy" />
                                ) : (
                                  <span>{item.name.slice(0, 1)}</span>
                                )}
                              </span>
                              <div className="set-planner-owned-copy">
                                <strong>{item.name}</strong>
                                <span>{item.quantity} owned</span>
                              </div>
                            </div>
                            <div className="set-planner-owned-actions">
                              <button
                                type="button"
                                className="set-planner-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => {
                                  void updateOwnedQuantityByDelta(item, -1);
                                }}
                              >
                                −
                              </button>
                              <span className="set-planner-qty-value">{item.quantity}</span>
                              <button
                                type="button"
                                className="set-planner-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => {
                                  void updateOwnedQuantityByDelta(item, 1);
                                }}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="watchlist-form-note">
                        No owned prime parts added yet.
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </aside>
          </div>
        )}
      </div>
    </>
  );
}
