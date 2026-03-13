import { useEffect, useMemo, useState } from 'react';
import {
  getCachedWfmProfileTradeLog,
  getWfmProfileTradeLog,
  migrateAlecaframeTradeLog,
  setWfmTradeLogKeepItem,
  updateTradeGroupAllocations,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue } from '../../lib/trades';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { PortfolioTradeLogEntry } from '../../types';
import { mockPortfolioStats } from '../../mocks/portfolio';

const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

function CumulativeProfitChart() {
  return (
    <div className="chart-card">
      <div className="chart-header">Cumulative Profit Curve</div>
      <div className="chart-body" style={{ padding: 16, display: 'block', position: 'relative' }}>
        <svg width="100%" height="130" viewBox="0 0 400 130" preserveAspectRatio="none">
          <line x1="0" y1="0" x2="0" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <line x1="0" y1="110" x2="400" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <text x="5" y="15" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">60</text>
          <text x="5" y="42" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">45</text>
          <text x="5" y="69" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">30</text>
          <text x="5" y="96" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">15</text>
          <polyline points="20,75 120,55 200,50 280,30 380,12" fill="none" stroke="var(--accent-blue)" strokeWidth="2"/>
          <polyline points="20,75 120,55 200,50 280,30 380,12 380,110 20,110" fill="rgba(74,158,255,0.06)" stroke="none"/>
          <text x="20" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">2026-03-09</text>
          <text x="320" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">2026-03-10</text>
        </svg>
      </div>
    </div>
  );
}

function ProfitPerTradeChart() {
  return (
    <div className="chart-card">
      <div className="chart-header">Profit Per Trade</div>
      <div className="chart-body" style={{ padding: 16, display: 'block' }}>
        <svg width="100%" height="130" viewBox="0 0 300 130" preserveAspectRatio="none">
          <line x1="0" y1="110" x2="300" y2="110" stroke="var(--border)" strokeWidth="1"/>
          <text x="2" y="15" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">36</text>
          <text x="2" y="42" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">27</text>
          <text x="2" y="69" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">18</text>
          <text x="2" y="96" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">9</text>
          <rect x="30" y="10" width="80" height="100" fill="rgba(61,214,140,0.5)" rx="2"/>
          <rect x="160" y="40" width="80" height="70" fill="rgba(61,214,140,0.5)" rx="2"/>
          <text x="50" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
          <text x="165" y="124" fill="var(--text-muted)" fontSize="9" fontFamily="JetBrains Mono">Wisp Prime Set</text>
        </svg>
      </div>
    </div>
  );
}

function renderTradeType(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'Buy' : 'Sell';
}

function buildTradeTypeClassName(orderType: PortfolioTradeLogEntry['orderType']): string {
  return orderType === 'buy' ? 'badge-blue' : 'badge-green';
}

function buildTradeStatusClassName(status: string | null): string {
  switch (status) {
    case 'Flip':
      return 'badge-green';
    case 'Sold As Set':
      return 'badge-purple';
    case 'Kept':
      return 'badge-amber';
    case 'Open':
      return 'badge-blue';
    default:
      return 'badge';
  }
}

function formatMarginValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }

  const rounded = Math.round(value * 10) / 10;
  const normalized = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
  return `${normalized}%`;
}

function buildDefaultMigrationDate(): string {
  const baseline = new Date();
  baseline.setDate(baseline.getDate() - 90);
  return baseline.toISOString().slice(0, 10);
}

type TradeLogDisplayRow =
  | { kind: 'single'; entry: PortfolioTradeLogEntry }
  | {
      kind: 'group';
      groupId: string;
      label: string;
      totalPlatinum: number;
      itemCount: number;
      orderType: PortfolioTradeLogEntry['orderType'];
      closedAt: string;
      updatedAt: string;
      children: PortfolioTradeLogEntry[];
    };

function buildTradeLogDisplayRows(entries: PortfolioTradeLogEntry[]): TradeLogDisplayRow[] {
  const groupedEntries = new Map<string, PortfolioTradeLogEntry[]>();
  for (const entry of entries) {
    if (!entry.groupId) {
      continue;
    }

    const group = groupedEntries.get(entry.groupId) ?? [];
    group.push(entry);
    groupedEntries.set(entry.groupId, group);
  }

  const rows: TradeLogDisplayRow[] = [];
  const seenGroupIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.groupId) {
      rows.push({ kind: 'single', entry });
      continue;
    }

    if (seenGroupIds.has(entry.groupId)) {
      continue;
    }
    seenGroupIds.add(entry.groupId);

    const children = (groupedEntries.get(entry.groupId) ?? [entry]).slice().sort((left, right) => {
      const leftOrder = left.groupSortOrder ?? 0;
      const rightOrder = right.groupSortOrder ?? 0;
      return leftOrder - rightOrder || left.itemName.localeCompare(right.itemName);
    });

    rows.push({
      kind: 'group',
      groupId: entry.groupId,
      label: entry.groupLabel ?? 'Multiple Item Trade',
      totalPlatinum:
        entry.groupTotalPlatinum ??
        children.reduce(
          (sum, child) => sum + (child.allocationTotalPlatinum ?? child.platinum),
          0,
        ),
      itemCount: entry.groupItemCount ?? children.length,
      orderType: entry.orderType,
      closedAt: entry.closedAt,
      updatedAt: entry.updatedAt,
      children,
    });
  }

  return rows;
}

function buildTradeGroupSummary(children: PortfolioTradeLogEntry[]): string {
  if (children.length === 0) {
    return 'No items in this trade';
  }

  const names = children.slice(0, 2).map((child) => child.itemName);
  const suffix = children.length > 2 ? ` +${children.length - 2} more` : '';
  return `${names.join(' • ')}${suffix}`;
}

function TradeLogTab({ username }: { username: string | null }) {
  const appSettings = useAppStore((state) => state.appSettings);
  const [entries, setEntries] = useState<PortfolioTradeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [savingAllocations, setSavingAllocations] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [migrateModalOpen, setMigrateModalOpen] = useState(false);
  const [migrationBaselineDate, setMigrationBaselineDate] = useState(buildDefaultMigrationDate);
  const [allocationGroupId, setAllocationGroupId] = useState<string | null>(null);
  const [allocationDrafts, setAllocationDrafts] = useState<Record<string, string>>({});

  const displayRows = useMemo(() => buildTradeLogDisplayRows(entries), [entries]);
  const allocationGroup = useMemo(
    () =>
      displayRows.find(
        (row): row is Extract<TradeLogDisplayRow, { kind: 'group' }> =>
          row.kind === 'group' && row.groupId === allocationGroupId,
      ) ?? null,
    [allocationGroupId, displayRows],
  );
  const allocationTotal = allocationGroup
    ? allocationGroup.children.reduce((sum, child) => {
        const nextValue = Number.parseInt(allocationDrafts[child.id] ?? '', 10);
        return sum + (Number.isFinite(nextValue) ? nextValue : 0);
      }, 0)
    : 0;
  const allocationExpectedTotal = allocationGroup?.totalPlatinum ?? 0;
  const allocationMatches = allocationGroup ? allocationTotal === allocationExpectedTotal : true;

  const applyTradeLogState = (nextState: { entries: PortfolioTradeLogEntry[]; lastUpdatedAt: string | null }) => {
    setEntries(nextState.entries);
    setLastUpdatedAt(nextState.lastUpdatedAt);
  };

  const handleRefresh = async () => {
    if (!username) {
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const nextState = await getWfmProfileTradeLog(username);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const handleToggleKeepItem = async (entry: PortfolioTradeLogEntry) => {
    if (!username || entry.orderType !== 'buy') {
      return;
    }

    setUpdatingOrderId(entry.id);
    setErrorMessage(null);

    try {
      const nextState = await setWfmTradeLogKeepItem(username, entry.id, !entry.keepItem);
      applyTradeLogState(nextState);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleToggleGroupExpanded = (groupId: string) => {
    setExpandedGroupIds((current) =>
      current.includes(groupId)
        ? current.filter((value) => value !== groupId)
        : [...current, groupId],
    );
  };

  const handleOpenAllocationModal = (
    row: Extract<TradeLogDisplayRow, { kind: 'group' }>,
  ) => {
    setAllocationGroupId(row.groupId);
    setAllocationDrafts(
      Object.fromEntries(
        row.children.map((child) => [
          child.id,
          String(child.allocationTotalPlatinum ?? child.platinum),
        ]),
      ),
    );
  };

  const handleMigrate = async () => {
    if (!username) {
      setErrorMessage('Connect your Warframe Market account in Trades first.');
      return;
    }

    setMigrating(true);
    setErrorMessage(null);

    try {
      const nextState = await migrateAlecaframeTradeLog(username, {
        baselineDate: migrationBaselineDate,
      });
      applyTradeLogState(nextState);
      setMigrateModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrating(false);
    }
  };

  const handleSaveAllocations = async () => {
    if (!username || !allocationGroup) {
      return;
    }

    if (!allocationMatches) {
      setErrorMessage(
        `Adjusted totals must add up to ${formatPlatinumValue(allocationExpectedTotal)}.`,
      );
      return;
    }

    setSavingAllocations(true);
    setErrorMessage(null);

    try {
      const nextState = await updateTradeGroupAllocations(
        username,
        allocationGroup.groupId,
        allocationGroup.children.map((child) => ({
          orderId: child.id,
          totalPlatinum: Number.parseInt(allocationDrafts[child.id] ?? '0', 10) || 0,
        })),
      );
      applyTradeLogState(nextState);
      setAllocationGroupId(null);
      setAllocationDrafts({});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingAllocations(false);
    }
  };

  useEffect(() => {
    if (!username) {
      setEntries([]);
      setLastUpdatedAt(null);
      setErrorMessage(null);
      return;
    }

    let cancelled = false;

    const loadOnOpen = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const cachedState = await getCachedWfmProfileTradeLog(username);
        if (!cancelled) {
          applyTradeLogState(cachedState);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }

      try {
        const nextState = await getWfmProfileTradeLog(username);
        if (!cancelled) {
          applyTradeLogState(nextState);
          setErrorMessage(null);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadOnOpen();

    return () => {
      cancelled = true;
    };
  }, [username]);

  return (
    <>
      <div className="period-bar">
        <label>Trade Log</label>
        <div className="period-right portfolio-log-toolbar">
          {lastUpdatedAt ? (
            <span className="portfolio-log-updated">
              Last updated {formatShortLocalDateTime(lastUpdatedAt)}
            </span>
          ) : null}
          {appSettings.alecaframe.enabled && username ? (
            <button
              className="act-btn portfolio-secondary-btn"
              type="button"
              onClick={() => {
                setMigrationBaselineDate(buildDefaultMigrationDate());
                setMigrateModalOpen(true);
              }}
            >
              Migrate
            </button>
          ) : null}
          <button
            className="act-btn portfolio-refresh-btn"
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading}
          >
            <RefreshIcon />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="scanner-inline-error">{errorMessage}</div>
      ) : null}

      {!username ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">Connect your Warframe Market account first</span>
          <span className="empty-sub">Trade Log uses your public WFM profile statistics.</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 40, minHeight: 160 }}>
          <span className="empty-primary">{loading ? 'Loading trade history…' : 'No trade history loaded yet'}</span>
          <span className="empty-sub">
            {loading
              ? 'Loading your cached trade log and updating it from Warframe Market.'
              : 'Open the tab or press Refresh to load your last 90 days of buy and sell orders.'}
          </span>
        </div>
      ) : (
        <div className="portfolio-log-card">
          <div className="portfolio-log-header">
            <span>Item</span>
            <span>Type</span>
            <span>Price</span>
            <span>Qty</span>
            <span>Rank</span>
            <span>Profit</span>
            <span>Margin</span>
            <span>Status</span>
            <span>Closed</span>
            <span>Action</span>
          </div>

          <div className="portfolio-log-list">
            {displayRows.map((row) =>
              row.kind === 'single' ? (
                <div key={row.entry.id} className="portfolio-log-row">
                  <div className="portfolio-log-item">
                    <span className="portfolio-log-thumb">
                      {row.entry.imagePath ? (
                        <img src={resolveWfmAssetUrl(row.entry.imagePath) ?? undefined} alt="" />
                      ) : (
                        <span className="portfolio-log-thumb-fallback">{row.entry.itemName.charAt(0)}</span>
                      )}
                    </span>
                    <div className="portfolio-log-item-copy">
                      <span className="portfolio-log-item-name">{row.entry.itemName}</span>
                      <span className="portfolio-log-item-slug">{row.entry.slug}</span>
                    </div>
                  </div>

                  <span className={`badge ${buildTradeTypeClassName(row.entry.orderType)}`}>
                    {renderTradeType(row.entry.orderType)}
                  </span>
                  <span className="portfolio-log-value">{formatPlatinumValue(row.entry.platinum)}</span>
                  <span className="portfolio-log-value">{row.entry.quantity}</span>
                  <span className="portfolio-log-value">{row.entry.rank ?? '—'}</span>
                  <span className="portfolio-log-value">
                    {row.entry.profit == null ? '—' : formatPlatinumValue(row.entry.profit)}
                  </span>
                  <span className="portfolio-log-value">{formatMarginValue(row.entry.margin)}</span>
                  <span>
                    {row.entry.status ? (
                      <span className={`badge ${buildTradeStatusClassName(row.entry.status)}`}>{row.entry.status}</span>
                    ) : (
                      <span className="portfolio-log-value">—</span>
                    )}
                  </span>
                  <span className="portfolio-log-date">{formatShortLocalDateTime(row.entry.closedAt)}</span>
                  <span className="portfolio-log-actions">
                    {row.entry.orderType === 'buy' ? (
                      <label className="portfolio-keep-toggle-wrap">
                        <button
                          className={`toggle portfolio-keep-toggle${row.entry.keepItem ? ' on' : ''}`}
                          type="button"
                          role="switch"
                          aria-checked={row.entry.keepItem}
                          aria-label={`Keep ${row.entry.itemName}`}
                          onClick={() => void handleToggleKeepItem(row.entry)}
                          disabled={updatingOrderId === row.entry.id}
                        />
                        <span>{updatingOrderId === row.entry.id ? 'Saving…' : 'Keep Item'}</span>
                      </label>
                    ) : (
                      <span className="portfolio-log-value">—</span>
                    )}
                  </span>
                </div>
              ) : (
                <div key={row.groupId} className="portfolio-log-group">
                  <div className="portfolio-log-row portfolio-log-row-parent">
                    <div className="portfolio-log-item">
                      <button
                        className="portfolio-log-expand-btn"
                        type="button"
                        aria-label={
                          expandedGroupIds.includes(row.groupId)
                            ? `Collapse ${row.label}`
                            : `Expand ${row.label}`
                        }
                        onClick={() => handleToggleGroupExpanded(row.groupId)}
                      >
                        {expandedGroupIds.includes(row.groupId) ? '−' : '+'}
                      </button>
                      <span className="portfolio-log-thumb">
                        {row.children[0]?.imagePath ? (
                          <img src={resolveWfmAssetUrl(row.children[0].imagePath) ?? undefined} alt="" />
                        ) : (
                          <span className="portfolio-log-thumb-fallback">M</span>
                        )}
                      </span>
                      <div className="portfolio-log-item-copy">
                        <span className="portfolio-log-item-name">{row.label}</span>
                        <span className="portfolio-log-item-slug">
                          {buildTradeGroupSummary(row.children)} · {row.itemCount} item{row.itemCount === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                    <span className={`badge ${buildTradeTypeClassName(row.orderType)}`}>
                      {renderTradeType(row.orderType)}
                    </span>
                    <span className="portfolio-log-value">{formatPlatinumValue(row.totalPlatinum)}</span>
                    <span className="portfolio-log-value">—</span>
                    <span className="portfolio-log-value">—</span>
                    <span className="portfolio-log-value">—</span>
                    <span className="portfolio-log-value">—</span>
                    <span className="portfolio-log-value">—</span>
                    <span className="portfolio-log-date">{formatShortLocalDateTime(row.closedAt)}</span>
                    <span className="portfolio-log-actions portfolio-log-actions-parent">
                      <button
                        className="act-btn portfolio-secondary-btn"
                        type="button"
                        onClick={() => handleOpenAllocationModal(row)}
                      >
                        Adjust Amounts
                      </button>
                    </span>
                  </div>
                  {expandedGroupIds.includes(row.groupId)
                    ? row.children.map((child) => (
                        <div key={child.id} className="portfolio-log-row portfolio-log-row-child">
                          <div className="portfolio-log-item portfolio-log-item-child">
                            <span className="portfolio-log-thumb">
                              {child.imagePath ? (
                                <img src={resolveWfmAssetUrl(child.imagePath) ?? undefined} alt="" />
                              ) : (
                                <span className="portfolio-log-thumb-fallback">{child.itemName.charAt(0)}</span>
                              )}
                            </span>
                            <div className="portfolio-log-item-copy">
                              <span className="portfolio-log-item-name">{child.itemName}</span>
                              <span className="portfolio-log-item-slug">{child.slug}</span>
                            </div>
                          </div>
                          <span className={`badge ${buildTradeTypeClassName(child.orderType)}`}>
                            {renderTradeType(child.orderType)}
                          </span>
                          <span className="portfolio-log-value">{formatPlatinumValue(child.platinum)}</span>
                          <span className="portfolio-log-value">{child.quantity}</span>
                          <span className="portfolio-log-value">{child.rank ?? '—'}</span>
                          <span className="portfolio-log-value">
                            {child.profit == null ? '—' : formatPlatinumValue(child.profit)}
                          </span>
                          <span className="portfolio-log-value">{formatMarginValue(child.margin)}</span>
                          <span>
                            {child.status ? (
                              <span className={`badge ${buildTradeStatusClassName(child.status)}`}>{child.status}</span>
                            ) : (
                              <span className="portfolio-log-value">—</span>
                            )}
                          </span>
                          <span className="portfolio-log-date">{formatShortLocalDateTime(child.closedAt)}</span>
                          <span className="portfolio-log-actions">
                            {child.orderType === 'buy' ? (
                              <label className="portfolio-keep-toggle-wrap">
                                <button
                                  className={`toggle portfolio-keep-toggle${child.keepItem ? ' on' : ''}`}
                                  type="button"
                                  role="switch"
                                  aria-checked={child.keepItem}
                                  aria-label={`Keep ${child.itemName}`}
                                  onClick={() => void handleToggleKeepItem(child)}
                                  disabled={updatingOrderId === child.id}
                                />
                                <span>{updatingOrderId === child.id ? 'Saving…' : 'Keep Item'}</span>
                              </label>
                            ) : (
                              <span className="portfolio-log-value">—</span>
                            )}
                          </span>
                        </div>
                      ))
                    : null}
                </div>
              ),
            )}
          </div>
        </div>
      )}

      {migrateModalOpen ? (
        <div className="modal-backdrop" onClick={() => setMigrateModalOpen(false)}>
          <div
            className="settings-modal portfolio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Migrate Alecaframe trades"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">Trade Log</span>
                <h3>Migrate Alecaframe Trades</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close migrate trades dialog"
                onClick={() => setMigrateModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="settings-preview-grid">
                <article className="settings-preview-card">
                  <span className="settings-field-label">Purpose</span>
                  <p className="settings-preview-value">
                    Import missing buy and sell trades from Alecaframe without duplicating existing log rows.
                  </p>
                </article>
                <article className="settings-preview-card">
                  <span className="settings-field-label">Baseline Date</span>
                  <input
                    className="settings-text-input"
                    type="date"
                    value={migrationBaselineDate}
                    onChange={(event) => setMigrationBaselineDate(event.target.value)}
                  />
                </article>
              </div>
              <p className="portfolio-modal-note">
                Only trades from this day forward will be migrated. Existing rows with the same item, quantity, and a timestamp within one minute will be skipped.
              </p>
            </div>
            <div className="settings-modal-actions">
              <button className="period-btn" type="button" onClick={() => setMigrateModalOpen(false)}>
                Cancel
              </button>
              <button
                className="act-btn"
                type="button"
                onClick={() => void handleMigrate()}
                disabled={migrating || !migrationBaselineDate}
              >
                {migrating ? 'Migrating…' : 'Migrate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {allocationGroup ? (
        <div className="modal-backdrop" onClick={() => setAllocationGroupId(null)}>
          <div
            className="settings-modal portfolio-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Adjust grouped trade amounts"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">Trade Log</span>
                <h3>Adjust Amounts</h3>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close adjust amounts dialog"
                onClick={() => setAllocationGroupId(null)}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="portfolio-allocation-summary">
                <span>Total trade value</span>
                <strong>{formatPlatinumValue(allocationExpectedTotal)}</strong>
              </div>
              <div className="portfolio-allocation-list">
                {allocationGroup.children.map((child) => (
                  <div key={child.id} className="portfolio-allocation-row">
                    <div className="portfolio-allocation-copy">
                      <span className="portfolio-allocation-name">{child.itemName}</span>
                      <span className="portfolio-allocation-meta">
                        Qty {child.quantity}{child.rank != null ? ` · Rank ${child.rank}` : ''}
                      </span>
                    </div>
                    <div className="portfolio-allocation-input-wrap">
                      <input
                        className="settings-text-input portfolio-allocation-input"
                        type="number"
                        min="0"
                        step="1"
                        value={allocationDrafts[child.id] ?? ''}
                        onChange={(event) =>
                          setAllocationDrafts((current) => ({
                            ...current,
                            [child.id]: event.target.value,
                          }))
                        }
                      />
                      <span className="portfolio-allocation-unit">pt</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className={`portfolio-allocation-summary${allocationMatches ? '' : ' error'}`}>
                <span>Allocated total</span>
                <strong>
                  {formatPlatinumValue(allocationTotal)} / {formatPlatinumValue(allocationExpectedTotal)}
                </strong>
              </div>
            </div>
            <div className="settings-modal-actions">
              <button className="period-btn" type="button" onClick={() => setAllocationGroupId(null)}>
                Cancel
              </button>
              <button
                className="act-btn"
                type="button"
                onClick={() => void handleSaveAllocations()}
                disabled={savingAllocations || !allocationMatches}
              >
                {savingAllocations ? 'Saving…' : 'Save Amounts'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function PortfolioPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const tradePeriod = useAppStore((s) => s.tradePeriod);
  const setTradePeriod = useAppStore((s) => s.setTradePeriod);
  const [portfolioTab, setPortfolioTab] = useState<'pnl' | 'log'>('pnl');

  const s = mockPortfolioStats;

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Portfolio</span>
          <span className={`subtab${portfolioTab === 'pnl' ? ' active' : ''}`} onClick={() => setPortfolioTab('pnl')} role="tab" tabIndex={0}>P&amp;L Summary</span>
          <span className={`subtab${portfolioTab === 'log' ? ' active' : ''}`} onClick={() => setPortfolioTab('log')} role="tab" tabIndex={0}>Trade Log</span>
        </div>
      </div>
      <div className="page-content">
        {portfolioTab === 'log' ? <TradeLogTab username={tradeAccount?.name ?? null} /> : (
          <>
            <div className="period-bar">
              <label>Period:</label>
              {(['7d', '30d', 'all'] as const).map((p) => (
                <button
                  key={p}
                  className={`period-btn${tradePeriod === p ? ' active' : ''}`}
                  onClick={() => setTradePeriod(p)}
                >
                  {p === 'all' ? 'All Time' : p}
                </button>
              ))}
              <div className="period-right">
                <button className="act-btn" type="button">Refresh Trades</button>
              </div>
            </div>

            <div className="plat-grid">
              <div className="info-card">
                <div className="info-card-label">Total Plat (All Time)</div>
                <div className="info-card-val">{s.totalPlatAllTime.toFixed(2)} pt</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Total Plat (7d)</div>
                <div className="info-card-val">{s.totalPlat7d.toFixed(2)} pt</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Total Plat (30d)</div>
                <div className="info-card-val">{s.totalPlat30d.toFixed(2)} pt</div>
              </div>
            </div>

            <div className="alloc-grid">
              <div className="info-card">
                <div className="info-card-label">Allocator Status</div>
                <div className="info-card-val off" style={{ fontSize: 16 }}>Off</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Allocator Allocated</div>
                <div className="info-card-val neutral" style={{ fontSize: 16 }}>--</div>
              </div>
              <div className="info-card">
                <div className="info-card-label">Allocator Expected Net</div>
                <div className="info-card-val neutral" style={{ fontSize: 16 }}>--</div>
              </div>
            </div>

            <div className="perf-grid">
              <div className="perf-card">
                <div className="perf-label">Profit</div>
                <div className="perf-val green">{s.profit.toFixed(2)}<br/><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>pt</span></div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Trades</div>
                <div className="perf-val">{s.trades}</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Win Rate</div>
                <div className="perf-val blue">{s.winRate.toFixed(2)}%</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Avg Margin</div>
                <div className="perf-val blue">{s.avgMargin.toFixed(2)}%</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Avg Hold</div>
                <div className="perf-val">{s.avgHold.toFixed(2)}h</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Plat/hr</div>
                <div className="perf-val">{s.platPerHour.toFixed(2)}</div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Best Trade</div>
                <div className="perf-val green" style={{ fontSize: 11, lineHeight: 1.3 }}>
                  {s.bestTrade.item.slice(0, 10)}…<br/>{s.bestTrade.profit.toFixed(2)}pt
                </div>
              </div>
              <div className="perf-card">
                <div className="perf-label">Top Category</div>
                <div className="perf-val" style={{ fontSize: 12, lineHeight: 1.3 }}>
                  {s.topCategory.name}<br/><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.topCategory.profit.toFixed(2)}pt</span>
                </div>
              </div>
            </div>

            <div className="chart-grid">
              <CumulativeProfitChart />
              <ProfitPerTradeChart />
            </div>
          </>
        )}
      </div>
    </>
  );
}
