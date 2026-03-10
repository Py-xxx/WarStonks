import { useEffect, useMemo, useState } from 'react';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { VoidTraderInventoryItem } from '../../types';

function formatCategoryLabel(category: string): string {
  return category
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildInventoryGroups(items: VoidTraderInventoryItem[]) {
  const grouped = new Map<string, VoidTraderInventoryItem[]>();

  for (const item of items) {
    const category = item.category.trim().length > 0 ? item.category : 'Other';
    const bucket = grouped.get(category) ?? [];
    bucket.push(item);
    grouped.set(category, bucket);
  }

  return [...grouped.entries()]
    .map(([category, entries]) => ({
      category,
      label: formatCategoryLabel(category),
      items: [...entries].sort((left, right) => left.item.localeCompare(right.item)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function VoidTraderPanel() {
  const voidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateVoidTraderLastUpdatedAt);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);

  const [nowMs, setNowMs] = useState(Date.now());
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const inventoryGroups = useMemo(
    () => buildInventoryGroups(voidTrader?.inventory ?? []),
    [voidTrader?.inventory],
  );
  const inventoryCategories = useMemo(
    () => ['All', ...inventoryGroups.map((group) => group.category)],
    [inventoryGroups],
  );

  useEffect(() => {
    if (!inventoryCategories.includes(selectedCategory)) {
      setSelectedCategory('All');
    }
  }, [inventoryCategories, selectedCategory]);

  const isActive = voidTrader
    ? isWorldStateWindowActive(voidTrader.activation, voidTrader.expiry, nowMs)
    : false;
  const filteredInventory =
    selectedCategory === 'All'
      ? voidTrader?.inventory ?? []
      : inventoryGroups.find((group) => group.category === selectedCategory)?.items ?? [];
  const nextCountdown = formatWorldStateCountdown(
    isActive ? voidTrader?.expiry ?? null : voidTrader?.activation ?? null,
    nowMs,
  );

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">Void Trader</span>
        <span className={`badge ${isActive ? 'badge-green' : 'badge-amber'}`}>
          {isActive ? 'Active' : 'Not active'}
        </span>
        <div className="card-actions">
          <button
            className="text-btn"
            type="button"
            onClick={() => {
              void refreshWorldStateVoidTrader();
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            Last sync: {formatWorldStateDateTime(lastUpdatedAt)}
          </div>
        ) : null}

        {error ? <div className="settings-inline-error">{error}</div> : null}

        {loading && !voidTrader ? (
          <div className="empty-state">
            <span className="empty-primary">Loading Void Trader worldstate…</span>
            <span className="empty-sub">
              Fetching `GET /pc/voidTrader?language=en` from WarframeStat.
            </span>
          </div>
        ) : null}

        {voidTrader ? (
          <div className="void-trader-stack">
            <div className="void-trader-hero">
              <div className="void-trader-hero-main">
                <div className="void-trader-title-row">
                  <span className="void-trader-name">{voidTrader.character}</span>
                  <span className={`badge ${isActive ? 'badge-green' : 'badge-blue'}`}>
                    {isActive ? `${nextCountdown} left` : `${nextCountdown} until arrival`}
                  </span>
                </div>
                <div className="void-trader-location">
                  {voidTrader.location ?? 'Relay location unavailable'}
                </div>
              </div>

              <div className="void-trader-meta-grid">
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">{isActive ? 'Leaves' : 'Arrives'}</span>
                  <span className="void-trader-meta-value">
                    {formatWorldStateDateTime(isActive ? voidTrader.expiry : voidTrader.activation)}
                  </span>
                </div>
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">Countdown</span>
                  <span className="void-trader-meta-value">{nextCountdown}</span>
                </div>
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">Inventory</span>
                  <span className="void-trader-meta-value">
                    {voidTrader.inventory.length} items
                  </span>
                </div>
              </div>
            </div>

            {!isActive ? (
              <div className="empty-state void-trader-idle-state">
                <span className="empty-primary">Baro Ki&apos;Teer is not in relay yet</span>
                <span className="empty-sub">
                  The countdown above tracks his next visit. Inventory will appear here as soon as
                  the worldstate flips active.
                </span>
              </div>
            ) : null}

            {isActive && inventoryGroups.length > 0 ? (
              <>
                <div className="void-trader-tabs" role="tablist" aria-label="Void trader categories">
                  {inventoryCategories.map((category) => (
                    <button
                      key={category}
                      className={`void-trader-tab${selectedCategory === category ? ' active' : ''}`}
                      type="button"
                      onClick={() => setSelectedCategory(category)}
                    >
                      {category === 'All'
                        ? `All (${voidTrader.inventory.length})`
                        : `${formatCategoryLabel(category)} (${
                            inventoryGroups.find((group) => group.category === category)?.items.length ?? 0
                          })`}
                    </button>
                  ))}
                </div>

                <div className="void-trader-grid">
                  {filteredInventory.map((item) => {
                    const imageUrl = resolveWfmAssetUrl(item.imagePath);

                    return (
                      <article key={`${item.category}-${item.item}`} className="void-trader-item-card">
                        <div className="void-trader-item-head">
                          <div className="void-trader-item-thumb" aria-hidden="true">
                            {imageUrl ? <img src={imageUrl} alt="" /> : item.item.slice(0, 2)}
                          </div>
                          <div className="void-trader-item-copy">
                            <div className="void-trader-item-name">{item.item}</div>
                            <div className="void-trader-item-category">
                              {formatCategoryLabel(item.category)}
                            </div>
                          </div>
                        </div>

                        <div className="void-trader-cost-row">
                          <div className="void-trader-cost-pill">
                            <span className="qv-stat-label">Ducats</span>
                            <span className="void-trader-cost-value">{item.ducats ?? '—'}</span>
                          </div>
                          <div className="void-trader-cost-pill">
                            <span className="qv-stat-label">Credits</span>
                            <span className="void-trader-cost-value">{item.credits ?? '—'}</span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : null}

            {isActive && inventoryGroups.length === 0 ? (
              <div className="empty-state">
                <span className="empty-primary">Void Trader inventory is currently unavailable</span>
                <span className="empty-sub">
                  The feed shows Baro as active, but no inventory entries were returned yet.
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {!loading && !voidTrader ? (
          <div className="empty-state">
            <span className="empty-primary">Void Trader data is unavailable</span>
            <span className="empty-sub">
              The first worldstate snapshot did not return Void Trader information.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
