import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applySetCompletionScreenshotImport,
  getArbitrageScannerState,
  getOwnedRelicInventoryCache,
  refreshOwnedRelicInventory,
  getSetCompletionOwnedItems,
  matchSetCompletionScreenshotRows,
  setSetCompletionOwnedItemQuantity,
} from '../../lib/tauriClient';
import {
  getDefaultSetCompletionImportCrop,
  processSetCompletionInventoryScreenshot,
  type SetCompletionImportCrop,
  type SetCompletionScreenshotOcrRow,
  type SetCompletionScreenshotProgress,
} from '../../lib/setCompletionScreenshotImport';
import setCompletionImportExample from '../../assets/set-completion-import-example.png';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useAppStore } from '../../stores/useAppStore';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerResponse,
  ArbitrageScannerState,
  ArbitrageScannerSetEntry,
  OwnedRelicEntry,
  RelicRefinementChanceProfile,
  RelicRoiDropEntry,
  RelicRoiEntry,
  SetCompletionImportCandidate,
  SetCompletionOwnedItem,
  WfmAutocompleteItem,
} from '../../types';

type OppTab = 'opportunities' | 'farm-now' | 'set-planner' | 'owned-relics';
type FarmNowTab = 'part-profit' | 'set-completion';

const RELIC_REFINEMENT_COLUMNS = [
  { key: 'intact', label: 'Intact' },
  { key: 'exceptional', label: 'Exceptional' },
  { key: 'flawless', label: 'Flawless' },
  { key: 'radiant', label: 'Radiant' },
] as const;

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

type FarmNowRelicRow = {
  relic: RelicRoiEntry;
  refinementKey: string;
  refinementLabel: string;
  expectedProfit: number | null;
  platPerHour: number | null;
  ownedCount: number;
  bestDropSlug: string | null;
  drops: Array<{
    drop: RelicRoiDropEntry;
    chance: number | null;
    expectedValue: number | null;
  }>;
};

type PlannerCatalogItem = {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
};

type ScreenshotImportPreviewRow = SetCompletionScreenshotOcrRow & {
  matchedItem: SetCompletionImportCandidate | null;
  matchConfidence: number;
  matchKind: 'exact' | 'alias' | 'slug' | 'fuzzy' | 'none' | 'manual';
  matchStatus: 'matched' | 'matched-low-confidence' | 'unmatched';
  matchReason: string;
  removed: boolean;
  remapQuery: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function mergeScreenshotImportRows(
  ocrRows: SetCompletionScreenshotOcrRow[],
  matchRows: Array<{
    rowId: string;
    matchedItem: SetCompletionImportCandidate | null;
    confidence: number;
    matchKind: 'exact' | 'alias' | 'slug' | 'fuzzy' | 'none';
    status: 'matched' | 'matched-low-confidence' | 'unmatched';
    reason: string;
  }>,
): ScreenshotImportPreviewRow[] {
  const byId = new Map(matchRows.map((row) => [row.rowId, row]));
  return ocrRows.map((row) => {
    const matched = byId.get(row.rowId);
    return {
      ...row,
      matchedItem: matched?.matchedItem ?? null,
      matchConfidence: matched?.confidence ?? 0,
      matchKind: matched?.matchKind ?? 'none',
      matchStatus: matched?.status ?? 'unmatched',
      matchReason: matched?.reason ?? 'No planner component match found.',
      removed: false,
      remapQuery: matched?.matchedItem?.name ?? row.detectedName,
    };
  });
}

function describeScreenshotImportRowState(row: ScreenshotImportPreviewRow): string {
  if (row.removed) {
    return 'Removed from import';
  }
  if (row.quantityState === 'unresolved') {
    return 'Quantity unresolved';
  }
  if (row.matchStatus === 'unmatched' || !row.matchedItem) {
    return 'Match required';
  }
  if (row.matchStatus === 'matched-low-confidence') {
    return 'Low-confidence match';
  }
  return 'Ready to import';
}

function buildScreenshotImportApplyRows(
  rows: ScreenshotImportPreviewRow[],
): {
  readyRows: Array<{
    itemId: number | null;
    slug: string;
    name: string;
    imagePath: string | null;
    quantity: number;
  }>;
  blockedRows: ScreenshotImportPreviewRow[];
} {
  const readyRows: Array<{
    itemId: number | null;
    slug: string;
    name: string;
    imagePath: string | null;
    quantity: number;
  }> = [];
  const blockedRows: ScreenshotImportPreviewRow[] = [];
  const seenSlugs = new Set<string>();

  for (const row of rows) {
    if (row.removed) {
      continue;
    }
    if (!row.matchedItem || row.quantity === null || row.quantityState === 'unresolved') {
      blockedRows.push(row);
      continue;
    }
    if (seenSlugs.has(row.matchedItem.slug)) {
      blockedRows.push(row);
      continue;
    }
    seenSlugs.add(row.matchedItem.slug);
    readyRows.push({
      itemId: row.matchedItem.itemId,
      slug: row.matchedItem.slug,
      name: row.matchedItem.name,
      imagePath: row.matchedItem.imagePath,
      quantity: row.quantity,
    });
  }

  return { readyRows, blockedRows };
}

function filterPlannerCandidates(
  candidates: PlannerCatalogItem[],
  query: string,
): PlannerCatalogItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return candidates.slice(0, 6);
  }

  return candidates
    .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
    .slice(0, 6);
}

function formatPlat(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${Math.round(value)}p`;
}

function formatPlatDecimal(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${(Math.round(value * 10) / 10).toFixed(1)}p`;
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

function chanceForRefinement(
  chanceProfile: RelicRefinementChanceProfile,
  refinementKey: string,
): number | null {
  switch (refinementKey) {
    case 'exceptional':
      return chanceProfile.exceptional;
    case 'flawless':
      return chanceProfile.flawless;
    case 'radiant':
      return chanceProfile.radiant;
    default:
      return chanceProfile.intact;
  }
}

function formatChance(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function parseRelicTierCode(name: string): { tier: string; code: string } | null {
  const tokens = name.trim().split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const tier = tokens[0];
  const code = tokens[1];
  if (!tier || !code) {
    return null;
  }

  return { tier, code };
}

function relicRarityTone(rarity: string | null): string {
  const normalized = rarity?.toLowerCase() ?? '';
  if (normalized.includes('rare')) {
    return 'rare';
  }
  if (normalized.includes('uncommon')) {
    return 'uncommon';
  }
  if (normalized.includes('common')) {
    return 'common';
  }
  return 'unknown';
}

function relicRefinementTone(refinementKey: string): string {
  switch (refinementKey) {
    case 'exceptional':
      return 'exceptional';
    case 'flawless':
      return 'flawless';
    case 'radiant':
      return 'radiant';
    case 'intact':
      return 'intact';
    default:
      return 'unknown';
  }
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

function SetCompletionScreenshotImportModal({
  open,
  fileInputRef,
  previewUrl,
  crop,
  rows,
  plannerCatalog,
  processing,
  applying,
  progress,
  errorMessage,
  blockedRowCount,
  readyRowCount,
  activeRemapRowId,
  onClose,
  onPickFile,
  onCropChange,
  onReprocess,
  onToggleRemove,
  onRemapQueryChange,
  onSelectRemap,
  onSetActiveRemapRow,
  onApply,
}: {
  open: boolean;
  fileInputRef: { current: HTMLInputElement | null };
  previewUrl: string | null;
  crop: SetCompletionImportCrop;
  rows: ScreenshotImportPreviewRow[];
  plannerCatalog: PlannerCatalogItem[];
  processing: boolean;
  applying: boolean;
  progress: SetCompletionScreenshotProgress | null;
  errorMessage: string | null;
  blockedRowCount: number;
  readyRowCount: number;
  activeRemapRowId: string | null;
  onClose: () => void;
  onPickFile: (file: File | null) => Promise<void>;
  onCropChange: (nextCrop: SetCompletionImportCrop) => void;
  onReprocess: () => Promise<void>;
  onToggleRemove: (rowId: string) => void;
  onRemapQueryChange: (rowId: string, value: string) => void;
  onSelectRemap: (rowId: string, item: PlannerCatalogItem) => void;
  onSetActiveRemapRow: (rowId: string | null) => void;
  onApply: () => Promise<void>;
}) {
  if (!open) {
    return null;
  }

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close screenshot import"
        onClick={onClose}
      />
      <div
        className="settings-modal screenshot-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import prime components from screenshot"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Set Completion Import</span>
            <h3>Import Prime Components Screenshot</h3>
          </div>
          <div className="settings-modal-actions">
            <button className="settings-close-btn" type="button" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="settings-modal-body screenshot-import-body">
          <div className="settings-form-card screenshot-import-left">
            <div className="screenshot-import-toolbar">
              <button
                type="button"
                className="settings-primary-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose Screenshot
              </button>
              <button
                type="button"
                className="settings-secondary-btn"
                onClick={() => {
                  void onReprocess();
                }}
                disabled={!previewUrl || processing}
              >
                {processing ? 'Processing…' : 'Reprocess Crop'}
              </button>
              <input
                ref={fileInputRef}
                className="screenshot-import-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  void onPickFile(event.target.files?.[0] ?? null);
                }}
              />
            </div>

            <p className="watchlist-form-note">
              Use a single screenshot from the in-game <strong>Prime Components</strong> tab. Only
              the visible items in the image will be overwritten. The importer is now locked to a
              fixed <strong>7 × 3</strong> visible grid and will only process up to <strong>21 items</strong>{' '}
              per screenshot.
            </p>

            <div className="screenshot-import-example">
              <div className="screenshot-import-example-copy">
                <span className="panel-title-eyebrow">Required Layout</span>
                <strong>Screenshot must match this framing</strong>
                <span>
                  Use the in-game inventory view with the grid fully visible and no extra overlays.
                  If your screenshot does not match this shape closely, the import will be unreliable.
                </span>
              </div>
              <div className="screenshot-import-example-image">
                <img src={setCompletionImportExample} alt="Example Prime Components screenshot layout" />
              </div>
            </div>

            {progress ? (
              <div className="scanner-inline-progress screenshot-import-progress">
                <span className="scanner-progress-label">{progress.stage.toUpperCase()}</span>
                <strong>{progress.detail}</strong>
              </div>
            ) : null}

            {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}

            {previewUrl ? (
              <>
                <div className="screenshot-import-preview-shell">
                  <img src={previewUrl} alt="Prime components screenshot preview" />
                  <div
                    className="screenshot-import-crop-overlay"
                    style={{
                      left: `${crop.left * 100}%`,
                      top: `${crop.top * 100}%`,
                      right: `${crop.right * 100}%`,
                      bottom: `${crop.bottom * 100}%`,
                    }}
                  />
                </div>

                <div className="screenshot-import-crop-grid">
                  {(
                    [
                      ['left', 'Left'],
                      ['top', 'Top'],
                      ['right', 'Right'],
                      ['bottom', 'Bottom'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="settings-field">
                      <span className="settings-field-label">{label} Crop</span>
                      <input
                        type="range"
                        min={0}
                        max={key === 'top' || key === 'bottom' ? 25 : 40}
                        step={1}
                        value={Math.round(crop[key] * 100)}
                        onChange={(event) =>
                          onCropChange({
                            ...crop,
                            [key]: Number(event.target.value) / 100,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="watchlist-form-note">
                  Adjust the crop only so the blue guide cleanly wraps the fixed 7-column by 3-row
                  inventory grid.
                </div>
              </>
            ) : (
              <div className="opportunities-placeholder">
                Choose a screenshot to start local OCR and preview up to 21 visible prime
                components.
              </div>
            )}
          </div>

          <div className="settings-form-card screenshot-import-right">
            <div className="screenshot-import-summary">
              <div>
                <span className="panel-title-eyebrow">Preview</span>
                <h3>{rows.length ? `${rows.length} rows detected` : 'No rows detected yet'}</h3>
              </div>
              <div className="scanner-run-summary">
                <span className="scanner-run-pill">{readyRowCount} READY</span>
                <span className="scanner-run-pill scanner-run-pill-warning">
                  {blockedRowCount} NEED REVIEW
                </span>
              </div>
            </div>

            <div className="screenshot-import-rows">
              {rows.length === 0 ? (
                <div className="watchlist-form-note">
                  After OCR finishes, each visible inventory tile will appear here for review.
                </div>
              ) : (
                rows.map((row) => {
                  const suggestions = activeRemapRowId === row.rowId
                    ? filterPlannerCandidates(plannerCatalog, row.remapQuery || row.detectedName)
                    : [];
                  return (
                    <article
                      key={row.rowId}
                      className={`screenshot-import-row${row.removed ? ' removed' : ''}`}
                    >
                      <div className="screenshot-import-row-main">
                        <span className="screenshot-import-row-thumb">
                          <img src={row.thumbnailDataUrl} alt="" />
                        </span>
                        <div className="screenshot-import-row-copy">
                          <strong>{row.matchedItem?.name ?? (row.detectedName || 'Unreadable tile')}</strong>
                          <span>
                            OCR: {row.detectedName || 'No text detected'} · Qty:{' '}
                            {row.quantity === null ? 'Unreadable' : row.quantity}
                          </span>
                          <span>{describeScreenshotImportRowState(row)}</span>
                        </div>
                        <div className="screenshot-import-row-actions">
                          <button
                            type="button"
                            className="settings-secondary-btn screenshot-import-row-toggle"
                            onClick={() => onToggleRemove(row.rowId)}
                          >
                            {row.removed ? 'Restore' : 'Remove'}
                          </button>
                        </div>
                      </div>

                      {!row.removed ? (
                        <div className="screenshot-import-row-editor">
                          <label className="settings-field">
                            <span className="settings-field-label">Remap matched component</span>
                            <input
                              className="settings-input"
                              type="text"
                              value={row.remapQuery}
                              onFocus={() => onSetActiveRemapRow(row.rowId)}
                              onChange={(event) => onRemapQueryChange(row.rowId, event.target.value)}
                              placeholder="Search planner components…"
                            />
                          </label>
                          {suggestions.length > 0 ? (
                            <div className="trade-listing-autocomplete-list">
                              {suggestions.map((item) => {
                                const imageUrl = resolveWfmAssetUrl(item.imagePath);
                                return (
                                  <button
                                    key={`${row.rowId}-${item.slug}`}
                                    type="button"
                                    className="trade-listing-autocomplete-option"
                                    onClick={() => onSelectRemap(row.rowId, item)}
                                  >
                                    <span className="trade-listing-autocomplete-thumb">
                                      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : item.name[0]}
                                    </span>
                                    <span className="trade-listing-autocomplete-copy">
                                      <span className="trade-listing-autocomplete-name">{item.name}</span>
                                      <span className="trade-listing-autocomplete-meta">{item.slug}</span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                          <div className="watchlist-form-note">{row.matchReason}</div>
                        </div>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>

            <div className="settings-nav-footer screenshot-import-footer">
              <button
                type="button"
                className="settings-secondary-btn"
                onClick={onClose}
                disabled={processing || applying}
              >
                Cancel
              </button>
              <button
                type="button"
                className="settings-primary-btn"
                onClick={() => {
                  void onApply();
                }}
                disabled={processing || applying || !rows.length}
              >
                {applying ? 'Applying…' : 'Apply Visible Import'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function OpportunitiesPage() {
  const [activeTab, setActiveTab] = useState<OppTab>('set-planner');
  const [farmNowTab, setFarmNowTab] = useState<FarmNowTab>('part-profit');
  const [farmNowScan, setFarmNowScan] = useState<ArbitrageScannerResponse | null>(null);
  const [farmNowScanState, setFarmNowScanState] = useState<ArbitrageScannerState | null>(null);
  const [farmNowLoading, setFarmNowLoading] = useState(false);
  const [farmNowError, setFarmNowError] = useState<string | null>(null);
  const [expandedFarmRelicKey, setExpandedFarmRelicKey] = useState<string | null>(null);
  const [scannerResponse, setScannerResponse] = useState<ArbitrageScannerResponse | null>(null);
  const [ownedItems, setOwnedItems] = useState<SetCompletionOwnedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ownedRelics, setOwnedRelics] = useState<OwnedRelicEntry[]>([]);
  const [ownedRelicsLoading, setOwnedRelicsLoading] = useState(false);
  const [ownedRelicsError, setOwnedRelicsError] = useState<string | null>(null);
  const [expandedRelicKey, setExpandedRelicKey] = useState<string | null>(null);
  const [ownedRelicsLoaded, setOwnedRelicsLoaded] = useState(false);
  const [ownedRelicsUpdatedAt, setOwnedRelicsUpdatedAt] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedSetSlug, setExpandedSetSlug] = useState<string | null>(null);
  const [componentQuery, setComponentQuery] = useState('');
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [plannerTargetInputs, setPlannerTargetInputs] = useState<Record<string, string>>({});
  const [screenshotImportOpen, setScreenshotImportOpen] = useState(false);
  const [screenshotImportCrop, setScreenshotImportCrop] = useState<SetCompletionImportCrop>(
    getDefaultSetCompletionImportCrop,
  );
  const [screenshotImportPreviewUrl, setScreenshotImportPreviewUrl] = useState<string | null>(null);
  const [screenshotImportFile, setScreenshotImportFile] = useState<File | null>(null);
  const [screenshotImportRows, setScreenshotImportRows] = useState<ScreenshotImportPreviewRow[]>([]);
  const [screenshotImportProcessing, setScreenshotImportProcessing] = useState(false);
  const [screenshotImportApplying, setScreenshotImportApplying] = useState(false);
  const [screenshotImportProgress, setScreenshotImportProgress] =
    useState<SetCompletionScreenshotProgress | null>(null);
  const [screenshotImportError, setScreenshotImportError] = useState<string | null>(null);
  const [activeRemapRowId, setActiveRemapRowId] = useState<string | null>(null);
  const screenshotFileInputRef = useRef<HTMLInputElement | null>(null);

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
    if (activeTab !== 'farm-now') {
      return;
    }

    let cancelled = false;

    const loadFarmNow = async () => {
      setFarmNowLoading(true);
      setFarmNowError(null);

      try {
        const scannerState = await getArbitrageScannerState();
        if (cancelled) {
          return;
        }
        setFarmNowScan(scannerState.latestScan);
        setFarmNowScanState(scannerState);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setFarmNowError(toErrorMessage(error));
      } finally {
        if (!cancelled) {
          setFarmNowLoading(false);
        }
      }
    };

    void loadFarmNow();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'farm-now') {
      return;
    }

    void loadOwnedRelics();
  }, [activeTab]);

  const loadOwnedRelics = async (force = false) => {
    if (ownedRelicsLoading) {
      return;
    }
    if (!force && ownedRelicsLoaded) {
      return;
    }

    setOwnedRelicsLoading(true);
    setOwnedRelicsError(null);

    try {
      const cache = force
        ? await refreshOwnedRelicInventory()
        : await getOwnedRelicInventoryCache();
      setOwnedRelics(cache.entries);
      setOwnedRelicsLoaded(true);
      setOwnedRelicsUpdatedAt(cache.updatedAt);
    } catch (error) {
      setOwnedRelicsError(toErrorMessage(error));
    } finally {
      setOwnedRelicsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'owned-relics') {
      return;
    }

    void loadOwnedRelics();
  }, [activeTab]);

  const plannerCatalog = useMemo<PlannerCatalogItem[]>(() => {
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
  }, [scannerResponse]);

  const plannerImportCandidates = useMemo<SetCompletionImportCandidate[]>(
    () =>
      plannerCatalog.map((item) => ({
        itemId: item.itemId,
        slug: item.slug,
        name: item.name,
        imagePath: item.imagePath,
      })),
    [plannerCatalog],
  );

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

  const farmNowRelics = useMemo<FarmNowRelicRow[]>(() => {
    const relics = farmNowScan?.relicRoiResults ?? [];
    const ownedMap = new Map<string, OwnedRelicEntry>();
    for (const relic of ownedRelics) {
      ownedMap.set(`${relic.tier}:${relic.code}`, relic);
    }
    const rows: FarmNowRelicRow[] = [];

    for (const relic of relics) {
      const parsed = parseRelicTierCode(relic.name);
      const ownedEntry = parsed ? ownedMap.get(`${parsed.tier}:${parsed.code}`) : undefined;

      for (const refinement of relic.refinements) {
        const ownedCount = ownedEntry
          ? ownedEntry.counts[refinement.refinementKey as keyof OwnedRelicEntry['counts']] ?? 0
          : 0;
        if (!ownedCount) {
          continue;
        }

        let expectedProfit = 0;
        let hasContribution = false;
        let bestDropSlug: string | null = null;
        let bestValue = -1;

        const drops = relic.drops.map((drop) => {
          const chance = chanceForRefinement(drop.chanceProfile, refinement.refinementKey);
          const exitPrice = drop.recommendedExitPrice;
          const expectedValue =
            chance !== null && exitPrice !== null ? (chance / 100) * exitPrice : null;

          if (expectedValue !== null) {
            hasContribution = true;
            expectedProfit += expectedValue;
            if (expectedValue > bestValue) {
              bestValue = expectedValue;
              bestDropSlug = drop.slug;
            }
          }

          return {
            drop,
            chance,
            expectedValue,
          };
        });

        rows.push({
          relic,
          refinementKey: refinement.refinementKey,
          refinementLabel: refinement.refinementLabel,
          expectedProfit: hasContribution ? expectedProfit : null,
          platPerHour: hasContribution ? expectedProfit * 12 : null,
          ownedCount,
          bestDropSlug,
          drops,
        });
      }
    }

    return rows.sort((left, right) => {
      const leftProfit = left.expectedProfit ?? Number.NEGATIVE_INFINITY;
      const rightProfit = right.expectedProfit ?? Number.NEGATIVE_INFINITY;
      if (rightProfit !== leftProfit) {
        return rightProfit - leftProfit;
      }
      if (right.ownedCount !== left.ownedCount) {
        return right.ownedCount - left.ownedCount;
      }
      return left.relic.name.localeCompare(right.relic.name);
    });
  }, [ownedRelics, farmNowScan]);

  const farmNowTopRelics = useMemo(() => farmNowRelics.slice(0, 3), [farmNowRelics]);
  const ownedRelicTotal = useMemo(
    () =>
      ownedRelics.reduce((sum, relic) => sum + (relic.counts?.total ?? 0), 0),
    [ownedRelics],
  );
  const farmNowLastScan = farmNowScanState?.progress.lastCompletedAt ?? farmNowScan?.computedAt ?? null;

  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = componentQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return plannerCatalog.slice(0, 8);
    }

    return plannerCatalog
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 8);
  }, [componentQuery, plannerCatalog]);

  const screenshotImportCandidateBlockedRows = useMemo(
    () => buildScreenshotImportApplyRows(screenshotImportRows).blockedRows,
    [screenshotImportRows],
  );

  const screenshotImportReadyRows = useMemo(
    () => buildScreenshotImportApplyRows(screenshotImportRows).readyRows,
    [screenshotImportRows],
  );

  useEffect(() => {
    if (!screenshotImportPreviewUrl) {
      return undefined;
    }

    return () => {
      URL.revokeObjectURL(screenshotImportPreviewUrl);
    };
  }, [screenshotImportPreviewUrl]);

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

  const resetScreenshotImportSession = () => {
    setScreenshotImportRows([]);
    setScreenshotImportError(null);
    setScreenshotImportProgress(null);
    setScreenshotImportProcessing(false);
    setScreenshotImportApplying(false);
    setActiveRemapRowId(null);
    setScreenshotImportCrop(getDefaultSetCompletionImportCrop());
    setScreenshotImportFile(null);
    setScreenshotImportPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    if (screenshotFileInputRef.current) {
      screenshotFileInputRef.current.value = '';
    }
  };

  const closeScreenshotImport = () => {
    setScreenshotImportOpen(false);
    resetScreenshotImportSession();
  };

  const processScreenshotImportFile = async (
    file: File,
    crop: SetCompletionImportCrop,
    previewUrl: string,
  ) => {
    setScreenshotImportProcessing(true);
    setScreenshotImportApplying(false);
    setScreenshotImportError(null);
    setScreenshotImportRows([]);
    setScreenshotImportProgress({
      progress: 0,
      stage: 'prepare',
      detail: 'Preparing local OCR worker…',
    });

    try {
      const ocrRows = await processSetCompletionInventoryScreenshot(file, crop, (progress) => {
        setScreenshotImportProgress(progress);
      });
      const matchRows = await matchSetCompletionScreenshotRows({
        rows: ocrRows.map((row) => ({
          rowId: row.rowId,
          detectedName: row.detectedName,
        })),
        allowedItems: plannerImportCandidates,
      });
      setScreenshotImportPreviewUrl((current) => {
        if (current && current !== previewUrl) {
          URL.revokeObjectURL(current);
        }
        return previewUrl;
      });
      setScreenshotImportRows(mergeScreenshotImportRows(ocrRows, matchRows));
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      setScreenshotImportPreviewUrl(null);
      setScreenshotImportError(toErrorMessage(error));
    } finally {
      setScreenshotImportProcessing(false);
    }
  };

  const handleScreenshotFilePicked = async (file: File | null) => {
    if (!file) {
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setScreenshotImportFile(file);
    await processScreenshotImportFile(file, screenshotImportCrop, previewUrl);
  };

  const reprocessScreenshotImport = async () => {
    if (!screenshotImportFile) {
      return;
    }
    const previewUrl = screenshotImportPreviewUrl ?? URL.createObjectURL(screenshotImportFile);
    await processScreenshotImportFile(screenshotImportFile, screenshotImportCrop, previewUrl);
  };

  const updateScreenshotImportRow = (
    rowId: string,
    updater: (row: ScreenshotImportPreviewRow) => ScreenshotImportPreviewRow,
  ) => {
    setScreenshotImportRows((current) =>
      current.map((row) => (row.rowId === rowId ? updater(row) : row)),
    );
  };

  const handleApplyScreenshotImport = async () => {
    if (!screenshotImportReadyRows.length || screenshotImportCandidateBlockedRows.length) {
      setScreenshotImportError(
        'Resolve or remove every unmatched, duplicate, or unreadable row before applying the screenshot import.',
      );
      return;
    }

    setScreenshotImportApplying(true);
    setScreenshotImportError(null);
    try {
      const nextOwnedItems = await applySetCompletionScreenshotImport(screenshotImportReadyRows);
      setOwnedItems(nextOwnedItems);
      closeScreenshotImport();
    } catch (error) {
      setScreenshotImportError(toErrorMessage(error));
      setScreenshotImportApplying(false);
    }
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
  const noFarmScan = !farmNowLoading && !(farmNowScan?.relicRoiResults?.length);

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
        {activeTab === 'set-planner' ? (
          <div className={`set-planner-layout${drawerOpen ? ' drawer-open' : ''}`}>
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
                      Set Completion Planner reuses the cached component pricing from Arbitrage. Run the
                      scan once, then come back here to plan missing parts and completion profit.
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

            <aside className={`market-panel set-planner-drawer${drawerOpen ? ' is-open' : ''}`}>
              <div className="set-planner-drawer-header">
                <div>
                  <span className="panel-title-eyebrow">Owned Inventory</span>
                  {!drawerOpen && ownedItems.length > 0 && (
                    <span className="set-planner-drawer-count">{ownedItems.length} {ownedItems.length === 1 ? 'part' : 'parts'}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-icon set-planner-drawer-icon"
                  onClick={() => setDrawerOpen((current) => !current)}
                  aria-label={drawerOpen ? 'Collapse owned parts drawer' : 'Expand owned parts drawer'}
                >
                  {drawerOpen ? '✕' : '☰'}
                </button>
              </div>

              {!drawerOpen ? (
                <div className="set-planner-mini-grid">
                  {ownedItems.length === 0 ? (
                    <span className="set-planner-mini-empty">No parts added yet</span>
                  ) : (
                    ownedItems.map((item) => {
                      const imageUrl = resolveWfmAssetUrl(item.imagePath);
                      return (
                        <div key={item.slug} className="set-planner-mini-item">
                          <span className="set-planner-mini-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.name.slice(0, 1)}</span>
                            )}
                          </span>
                          <span className="set-planner-mini-name" title={item.name}>{item.name}</span>
                          <span className="set-planner-mini-qty">×{item.quantity}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <div className="set-planner-drawer-body">
                  <div className="set-planner-drawer-search-col">
                    <label className="watchlist-add-label" htmlFor="planner-component-search">
                      Add owned component
                    </label>
                    <button
                      type="button"
                      className="settings-secondary-btn screenshot-import-launch"
                      onClick={() => setScreenshotImportOpen(true)}
                      disabled={!plannerCatalog.length}
                    >
                      Import Screenshot
                    </button>
                    <div className="set-planner-search-wrap">
                      <input
                        id="planner-component-search"
                        className="set-planner-search-input"
                        type="text"
                        placeholder={plannerCatalog.length ? 'Search set components…' : 'Run scan to unlock components'}
                        value={componentQuery}
                        onChange={(event) => setComponentQuery(event.target.value)}
                        disabled={!plannerCatalog.length}
                      />
                      {componentQuery ? (
                        <button
                          type="button"
                          className="set-planner-search-clear"
                          onClick={() => setComponentQuery('')}
                          aria-label="Clear search"
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                    {plannerCatalog.length ? (
                      <div className="set-planner-suggestions">
                        {filteredSuggestions.map((item) => (
                          <button
                            key={item.slug}
                            type="button"
                            className="set-planner-suggestion"
                            onClick={() => { void addOwnedComponent(item); }}
                          >
                            <span className="set-planner-suggestion-name">{item.name}</span>
                            <span className="set-planner-suggestion-action">Add</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="watchlist-form-note">Arbitrage cache not available yet.</div>
                    )}
                  </div>

                  <div className="set-planner-drawer-divider" aria-hidden="true" />

                  <div className="set-planner-drawer-owned-col">
                    <span className="watchlist-add-label">
                      {ownedItems.length} {ownedItems.length === 1 ? 'part' : 'parts'} owned
                    </span>
                    {ownedItems.length === 0 ? (
                      <div className="watchlist-form-note">No owned prime parts added yet.</div>
                    ) : (
                      <div className="set-planner-owned-grid">
                        {ownedItems.map((item) => {
                          const imageUrl = resolveWfmAssetUrl(item.imagePath);
                          return (
                            <div key={item.slug} className="set-planner-owned-card">
                              <div className="set-planner-owned-card-main">
                                <span className="set-planner-owned-thumb">
                                  {imageUrl ? (
                                    <img src={imageUrl} alt="" loading="lazy" />
                                  ) : (
                                    <span>{item.name.slice(0, 1)}</span>
                                  )}
                                </span>
                                <span className="set-planner-owned-card-name" title={item.name}>
                                  {item.name}
                                </span>
                              </div>
                              <div className="set-planner-owned-actions">
                                <button
                                  type="button"
                                  className="set-planner-qty-button"
                                  disabled={savingSlug === item.slug}
                                  onClick={() => { void updateOwnedQuantityByDelta(item, -1); }}
                                >
                                  −
                                </button>
                                <span className="set-planner-qty-value">{item.quantity}</span>
                                <button
                                  type="button"
                                  className="set-planner-qty-button"
                                  disabled={savingSlug === item.slug}
                                  onClick={() => { void updateOwnedQuantityByDelta(item, 1); }}
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </aside>
          </div>
        ) : activeTab === 'owned-relics' ? (
          <div className="owned-relics-layout">
            <section className="market-panel owned-relics-panel">
              <div className="owned-relics-header">
                <div>
                  <span className="panel-title-eyebrow">Owned Relics</span>
                  <h3>Relic Inventory</h3>
                  <p>
                    Pulls your Alecaframe relic inventory and breaks down counts by refinement.
                    Expand a relic to see its possible rewards and rarities.
                  </p>
                </div>
                <div className="owned-relics-actions">
                  {ownedRelicsUpdatedAt ? (
                    <span className="owned-relics-updated">
                      Updated {formatShortLocalDateTime(ownedRelicsUpdatedAt)}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="market-refresh-button"
                    onClick={() => { void loadOwnedRelics(true); }}
                    disabled={ownedRelicsLoading}
                    aria-label="Refresh owned relic inventory"
                  >
                    ↻
                  </button>
                </div>
              </div>

              {ownedRelicsError ? <div className="scanner-inline-error">{ownedRelicsError}</div> : null}

              {ownedRelicsLoading ? (
                <div className="opportunities-placeholder">Loading relic inventory…</div>
              ) : ownedRelics.length === 0 ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">No Relics Found</span>
                    <h3>Inventory is empty</h3>
                    <p>
                      Alecaframe did not report any relics for this account. Double-check your
                      public link in Settings and try again.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="owned-relics-list">
                  {ownedRelics.map((relic) => {
                    const relicKey = `${relic.tier}:${relic.code}`;
                    const expanded = expandedRelicKey === relicKey;
                    const imageUrl = resolveWfmAssetUrl(relic.imagePath);
                    return (
                      <article
                        key={relicKey}
                        className={`farm-now-row owned-relics-row${expanded ? ' is-expanded' : ''}`}
                      >
                        <button
                          type="button"
                          className="farm-now-row-button owned-relics-row-button"
                          onClick={() => setExpandedRelicKey((current) => (current === relicKey ? null : relicKey))}
                        >
                          <div className="farm-now-row-main owned-relics-row-main">
                            <div className="farm-now-cell farm-now-cell-name owned-relics-cell-name">
                              <span className="farm-now-thumb owned-relics-thumb">
                                {imageUrl ? (
                                  <img src={imageUrl} alt="" loading="lazy" />
                                ) : (
                                  <span>{relic.name.slice(0, 1)}</span>
                                )}
                              </span>
                              <div className="farm-now-copy owned-relics-copy">
                                <strong>{relic.name}</strong>
                                <span className="farm-now-subtitle owned-relics-subtitle">
                                  {relic.tier} {relic.code}
                                </span>
                              </div>
                            </div>
                            <span className="farm-now-cell owned-relics-cell-total">
                              <span className="owned-relics-total-label">Total</span>
                              <strong>{relic.counts.total}</strong>
                            </span>
                            <div className="farm-now-cell owned-relics-refinement-pills">
                              {RELIC_REFINEMENT_COLUMNS.map((column) => (
                                <span
                                  key={`${relicKey}-${column.key}`}
                                  className={`relic-refinement-pill relic-refinement-pill-${relicRefinementTone(column.key)}`}
                                >
                                  {column.label} · {relic.counts[column.key]}
                                </span>
                              ))}
                            </div>
                            <span className="farm-now-cell farm-now-cell-action owned-relics-action">
                              {expanded ? '−' : '+'}
                            </span>
                          </div>
                        </button>

                        {expanded ? (
                          <div className="owned-relics-row-body">
                            {relic.drops.length === 0 ? (
                              <div className="owned-relics-empty">No drop data available for this relic.</div>
                            ) : (
                              <div className="owned-relics-drop-grid">
                                {relic.drops.map((drop) => {
                                  const dropImage = resolveWfmAssetUrl(drop.imagePath);
                                  const tone = relicRarityTone(drop.rarity);
                                  return (
                                    <div key={`${relicKey}-${drop.slug}`} className="owned-relics-drop-card">
                                      <span className="owned-relics-drop-thumb">
                                        {dropImage ? (
                                          <img src={dropImage} alt="" loading="lazy" />
                                        ) : (
                                          <span>{drop.name.slice(0, 1)}</span>
                                        )}
                                      </span>
                                      <div className="owned-relics-drop-copy">
                                        <span className="owned-relics-drop-name">{drop.name}</span>
                                        <span className={`owned-relics-rarity owned-relics-rarity-${tone}`}>
                                          {drop.rarity ?? 'Unknown'}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : activeTab === 'farm-now' ? (
          <div className="farm-now-layout">
            <section className="market-panel farm-now-panel">
              <div className="farm-now-header">
                <div>
                  <span className="panel-title-eyebrow">What To Farm Now</span>
                  <h3>Relic Profit Planner</h3>
                  <p>
                    Uses the cached Relic ROI scan to rank relics by expected part profit for each
                    refinement. No buy cost is assumed, so profit equals expected value per relic.
                  </p>
                </div>
                <div className="farm-now-tabs">
                  <button
                    type="button"
                    className={`farm-now-tab-button${farmNowTab === 'part-profit' ? ' is-active' : ''}`}
                    onClick={() => setFarmNowTab('part-profit')}
                  >
                    For Part Profit
                  </button>
                  <button
                    type="button"
                    className={`farm-now-tab-button${farmNowTab === 'set-completion' ? ' is-active' : ''}`}
                    onClick={() => setFarmNowTab('set-completion')}
                  >
                    For Set Completion
                  </button>
                </div>
              </div>

              <div className="farm-now-summary">
                <div className="farm-now-summary-main">
                  <div className="farm-now-metrics">
                    <span className="market-panel-badge tone-blue">
                      Relics scanned {farmNowScan?.scannedRelicCount ?? 0}
                    </span>
                    <span className="market-panel-badge tone-blue">
                      Profit rows {farmNowRelics.length}
                    </span>
                    <span className="market-panel-badge tone-green">
                      Owned relics {ownedRelics.length} ({ownedRelicTotal})
                    </span>
                  </div>
                  <div className="farm-now-meta">
                    {farmNowLastScan ? (
                      <span>Last scan {formatShortLocalDateTime(farmNowLastScan)}</span>
                    ) : (
                      <span>No scan data yet</span>
                    )}
                  </div>
                </div>
                <div className="farm-now-summary-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setActivePage('scanners')}
                  >
                    Run Scan
                  </button>
                </div>
              </div>

              {farmNowTopRelics.length > 0 ? (
                <div className="farm-now-toplist">
                  {farmNowTopRelics.map((row) => (
                    <div key={`${row.relic.slug}-${row.refinementKey}`} className="farm-now-top-card">
                      <span className="panel-title-eyebrow">Top pick</span>
                      <strong>{row.relic.name}</strong>
                      <span className="farm-now-top-meta">
                        {row.refinementLabel} · {formatPlatDecimal(row.expectedProfit)} · {formatPlatDecimal(row.platPerHour)}/hr · x{row.ownedCount}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {farmNowError ? <div className="scanner-inline-error">{farmNowError}</div> : null}

              {farmNowTab === 'set-completion' ? (
                <div className="opportunities-placeholder">Set completion farming is coming next.</div>
              ) : farmNowLoading ? (
                <div className="opportunities-placeholder">Loading relic profitability…</div>
              ) : noFarmScan ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">Scanner Cache Required</span>
                    <h3>Run a Relic ROI scan first</h3>
                    <p>
                      This view uses the cached Relic ROI data from the Arbitrage scanner. Run a scan
                      in Scanners, then return here to see refinement-level profit.
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
              ) : ownedRelicsLoading ? (
                <div className="opportunities-placeholder">Loading owned relic inventory…</div>
              ) : ownedRelicsLoaded && !ownedRelicsUpdatedAt ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">Owned Relics Required</span>
                    <h3>Load relic inventory first</h3>
                    <p>
                      This view requires a cached relic inventory. Open Owned Relics and press Refresh
                      to load your inventory, then return here.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setActiveTab('owned-relics')}
                  >
                    Open Owned Relics
                  </button>
                </div>
              ) : ownedRelics.length === 0 ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">Owned Relics Required</span>
                    <h3>No owned relics detected</h3>
                    <p>
                      Alecaframe returned an empty relic inventory. Make sure your public link is
                      correct, then refresh in Owned Relics.
                    </p>
                  </div>
                </div>
              ) : farmNowRelics.length === 0 ? (
                <div className="opportunities-placeholder">No owned relic refinements available.</div>
              ) : (
                <div className="farm-now-list">
                  <div className="farm-now-header-row">
                    <span className="farm-now-header-label">Relic</span>
                    <span className="farm-now-header-label">Refinement</span>
                    <span className="farm-now-header-label">Owned</span>
                    <span className="farm-now-header-label farm-now-header-value">Profit / Relic</span>
                    <span className="farm-now-header-label farm-now-header-value">Plat / Hour</span>
                    <span className="farm-now-header-label farm-now-header-action" aria-hidden="true" />
                  </div>

                  {farmNowRelics.map((row) => {
                    const relicKey = `${row.relic.slug}:${row.refinementKey}`;
                    const expanded = expandedFarmRelicKey === relicKey;
                    const imageUrl = resolveWfmAssetUrl(row.relic.imagePath);
                    return (
                      <article key={relicKey} className={`farm-now-row${expanded ? ' is-expanded' : ''}`}>
                        <button
                          type="button"
                          className="farm-now-row-button"
                          onClick={() =>
                            setExpandedFarmRelicKey((current) =>
                              current === relicKey ? null : relicKey,
                            )
                          }
                        >
                          <div className="farm-now-row-main">
                            <div className="farm-now-cell farm-now-cell-name">
                              <span className="farm-now-thumb">
                                {imageUrl ? (
                                  <img src={imageUrl} alt="" loading="lazy" />
                                ) : (
                                  <span>{row.relic.name.slice(0, 1)}</span>
                                )}
                              </span>
                              <div className="farm-now-copy">
                                <strong>{row.relic.name}</strong>
                                <span className="farm-now-subtitle">{row.relic.dropCount} drops</span>
                              </div>
                            </div>
                            <span className="farm-now-cell farm-now-cell-refinement">
                              <span
                                className={`relic-refinement-pill relic-refinement-pill-${relicRefinementTone(row.refinementKey)}`}
                              >
                                {row.refinementLabel}
                              </span>
                            </span>
                            <span className="farm-now-cell farm-now-cell-owned">
                              ×{row.ownedCount}
                            </span>
                            <span className="farm-now-cell farm-now-cell-profit">
                              {formatPlatDecimal(row.expectedProfit)}
                            </span>
                            <span className="farm-now-cell farm-now-cell-profit">
                              {formatPlatDecimal(row.platPerHour)}
                            </span>
                            <span className="farm-now-cell farm-now-cell-action">{expanded ? '−' : '+'}</span>
                          </div>
                        </button>

                        {expanded ? (
                          <div className="farm-now-row-body">
                            <div className="farm-now-drop-grid">
                              {row.drops.map((entry) => {
                                const drop = entry.drop;
                                const dropImage = resolveWfmAssetUrl(drop.imagePath);
                                const tone = relicRarityTone(drop.rarity);
                                const isBest = row.bestDropSlug === drop.slug;
                                return (
                                  <div
                                    key={`${relicKey}-${drop.slug}`}
                                    className={`farm-now-drop-card${isBest ? ' is-best' : ''}`}
                                  >
                                    <span className="farm-now-drop-thumb">
                                      {dropImage ? (
                                        <img src={dropImage} alt="" loading="lazy" />
                                      ) : (
                                        <span>{drop.name.slice(0, 1)}</span>
                                      )}
                                    </span>
                                    <div className="farm-now-drop-copy">
                                      <span className="farm-now-drop-name">{drop.name}</span>
                                      <div className="farm-now-drop-meta">
                                        <span className={`owned-relics-rarity owned-relics-rarity-${tone}`}>
                                          {drop.rarity ?? 'Unknown'}
                                        </span>
                                        <span className="farm-now-drop-stat">
                                          {formatChance(entry.chance)}
                                        </span>
                                        <span className="farm-now-drop-stat">
                                          Exit {formatPlat(drop.recommendedExitPrice)}
                                        </span>
                                        {isBest ? (
                                          <span className="market-panel-badge tone-green">Top pick</span>
                                        ) : null}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="opportunities-placeholder">
            No opportunities found — try adjusting strategy filters
          </div>
        )}
      </div>
      <SetCompletionScreenshotImportModal
        open={screenshotImportOpen}
        fileInputRef={screenshotFileInputRef}
        previewUrl={screenshotImportPreviewUrl}
        crop={screenshotImportCrop}
        rows={screenshotImportRows}
        plannerCatalog={plannerCatalog}
        processing={screenshotImportProcessing}
        applying={screenshotImportApplying}
        progress={screenshotImportProgress}
        errorMessage={screenshotImportError}
        blockedRowCount={screenshotImportCandidateBlockedRows.length}
        readyRowCount={screenshotImportReadyRows.length}
        activeRemapRowId={activeRemapRowId}
        onClose={closeScreenshotImport}
        onPickFile={handleScreenshotFilePicked}
        onCropChange={setScreenshotImportCrop}
        onReprocess={reprocessScreenshotImport}
        onToggleRemove={(rowId) => {
          updateScreenshotImportRow(rowId, (row) => ({ ...row, removed: !row.removed }));
        }}
        onRemapQueryChange={(rowId, value) => {
          updateScreenshotImportRow(rowId, (row) => ({
            ...row,
            remapQuery: value,
            matchedItem:
              row.matchedItem && value.trim().toLowerCase() === row.matchedItem.name.toLowerCase()
                ? row.matchedItem
                : null,
            matchStatus:
              row.matchedItem && value.trim().toLowerCase() === row.matchedItem.name.toLowerCase()
                ? row.matchStatus
                : 'unmatched',
            matchKind:
              row.matchedItem && value.trim().toLowerCase() === row.matchedItem.name.toLowerCase()
                ? row.matchKind
                : 'none',
            matchReason:
              row.matchedItem && value.trim().toLowerCase() === row.matchedItem.name.toLowerCase()
                ? row.matchReason
                : 'Search for the correct planner component to continue.',
          }));
        }}
        onSelectRemap={(rowId, item) => {
          updateScreenshotImportRow(rowId, (row) => ({
            ...row,
            matchedItem: {
              itemId: item.itemId,
              slug: item.slug,
              name: item.name,
              imagePath: item.imagePath,
            },
            remapQuery: item.name,
            matchConfidence: 1,
            matchKind: 'manual',
            matchStatus: 'matched',
            matchReason: 'Manually remapped to the selected planner component.',
          }));
          setActiveRemapRowId(null);
        }}
        onSetActiveRemapRow={setActiveRemapRowId}
        onApply={handleApplyScreenshotImport}
      />
    </>
  );
}
