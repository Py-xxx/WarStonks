import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applySetCompletionScreenshotImportRows,
  getArbitrageScannerState,
  getOwnedRelicInventoryCache,
  getWfmAutocompleteItems,
  refreshOwnedRelicInventory,
  getSetCompletionOwnedItems,
  getSetCompletionOwnedItemPrices,
  setSetCompletionOwnedItemQuantity,
} from '../../lib/tauriClient';
import {
  analyzeSetCompletionInventoryScreenshot,
  getDefaultSetCompletionImportCrop,
  scanAndMatchSetCompletionDetectionPreview,
  type SetCompletionImportCandidate,
  type SetCompletionImportCrop,
  type SetCompletionScreenshotDetectionPreview,
  type SetCompletionScreenshotProgress,
  type SetCompletionScreenshotReviewEntry,
  type SetCompletionTraceSettings,
} from '../../lib/setCompletionScreenshotImport';
import setCompletionImportExample from '../../assets/set-completion-import-example.png';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { ItemName } from '../../components/ItemName';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import {
  clearWatchlistAddFeedbackTimeouts,
  markWatchlistAddFeedback,
  WATCHLIST_ADD_SUCCESS_MESSAGE,
} from '../../lib/watchlistAddFeedback';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerResponse,
  ArbitrageScannerState,
  ArbitrageScannerSetEntry,
  OwnedRelicEntry,
  OwnedRelicInventoryCache,
  RelicRefinementChanceProfile,
  RelicRoiDropEntry,
  RelicRoiEntry,
  SetCompletionOwnedItem,
  WfmAutocompleteItem,
} from '../../types';

type OppTab = 'opportunities' | 'farm-now' | 'set-planner' | 'owned-relics' | 'inventory';
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

type FarmNowSetCompletionDrop = {
  drop: RelicRoiDropEntry;
  isNeeded: boolean;
  missingQuantity: number;
  coveredSetCount: number;
  setNames: string[];
};

type FarmNowSetCompletionRow = {
  relic: RelicRoiEntry;
  ownedCount: number;
  neededDropCount: number;
  totalMissingQuantity: number;
  coveredSetCount: number;
  coveredSetNames: string[];
  drops: FarmNowSetCompletionDrop[];
};

type PlannerCatalogItem = {
  itemId: number | null;
  slug: string;
  name: string;
  imagePath: string | null;
};

type PlannerOwnedRelicHint = {
  key: string;
  label: string;
  fullName: string;
  totalCount: number;
};

function isLikelyPrimeComponentItem(item: WfmAutocompleteItem): boolean {
  const normalizedName = item.name.trim().toLowerCase();
  const normalizedFamily = item.itemFamily?.trim().toLowerCase() ?? '';

  if (!normalizedName.includes(' prime ')) {
    return false;
  }

  if (
    normalizedName.endsWith(' set') ||
    normalizedName.includes(' relic') ||
    normalizedFamily.includes('relic') ||
    normalizedFamily.includes('set')
  ) {
    return false;
  }

  return true;
}

function mapAutocompleteItemsToPlannerCatalog(
  items: WfmAutocompleteItem[],
): PlannerCatalogItem[] {
  const bySlug = new Map<string, PlannerCatalogItem>();

  for (const item of items) {
    if (!isLikelyPrimeComponentItem(item)) {
      continue;
    }

    if (!bySlug.has(item.slug)) {
      bySlug.set(item.slug, {
        itemId: item.itemId,
        slug: item.slug,
        name: item.name,
        imagePath: item.imagePath,
      });
    }
  }

  return [...bySlug.values()].sort((left, right) => left.name.localeCompare(right.name));
}

type ScreenshotImportPreparedScreenshot = {
  id: string;
  fileName: string;
  previewUrl: string;
  detectionPreview: SetCompletionScreenshotDetectionPreview;
};

function renderScreenshotCellOverlays(screenshot: ScreenshotImportPreparedScreenshot) {
  const width = screenshot.detectionPreview.overlayWidth;
  const height = screenshot.detectionPreview.overlayHeight;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return screenshot.detectionPreview.cells.map((cell) => {
    const left = (cell.itemBox.x / width) * 100;
    const top = (cell.itemBox.y / height) * 100;
    const boxWidth = (cell.itemBox.width / width) * 100;
    const boxHeight = (cell.itemBox.height / height) * 100;
    return (
      <span
        key={cell.rowId}
        className="screenshot-import-cell-overlay"
        style={{
          left: `${left}%`,
          top: `${top}%`,
          width: `${boxWidth}%`,
          height: `${boxHeight}%`,
        }}
      />
    );
  });
}

type ScreenshotImportRowState = {
  rowId: string;
  screenshotId: string;
  screenshotFileName: string;
  screenshotIndex: number;
  tileIndex: number;
  originalCellDataUrl: string;
  originalText: string;
  processedText: string;
  originalQuantity: string | null;
  processedQuantity: string | null;
  hasQuantityBox: boolean;
  suggestedMatch: SetCompletionScreenshotReviewEntry['matchedCandidate'];
  matchReviewReason: string | null;
  quantityReviewReason: string | null;
  nameInput: string;
  quantityInput: string;
  matchReviewed: boolean;
  quantityReviewed: boolean;
};

type ScreenshotImportResolvedRow = {
  state: ScreenshotImportRowState;
  candidate: PlannerCatalogItem | null;
  quantity: number | null;
  reviewReasons: string[];
  blockedReasons: string[];
  sortWeight: number;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  // Never surface "[object Object]" from a non-Error throw — fall back to friendly copy.
  return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
}

function normalizeScreenshotImportMatchValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildScreenshotImportRowState(
  entry: SetCompletionScreenshotReviewEntry,
  screenshot: ScreenshotImportPreparedScreenshot,
  screenshotIndex: number,
): ScreenshotImportRowState {
  return {
    rowId: `${screenshot.id}:${entry.rowId}`,
    screenshotId: screenshot.id,
    screenshotFileName: screenshot.fileName,
    screenshotIndex,
    tileIndex: entry.tileIndex,
    originalCellDataUrl: entry.originalCellDataUrl,
    originalText: entry.originalText,
    processedText: entry.processedText,
    originalQuantity: entry.originalQuantity,
    processedQuantity: entry.processedQuantity,
    hasQuantityBox: entry.hasQuantityBox,
    suggestedMatch: entry.matchedCandidate,
    matchReviewReason: entry.matchReviewReason,
    quantityReviewReason: entry.quantityReviewReason,
    nameInput: entry.matchedCandidate?.name ?? '',
    quantityInput: entry.suggestedQuantity !== null ? String(entry.suggestedQuantity) : '',
    matchReviewed: entry.matchReviewReason === null,
    quantityReviewed: entry.quantityReviewReason === null,
  };
}

function resolveScreenshotImportCandidate(
  catalogMap: Map<string, PlannerCatalogItem>,
  value: string,
): PlannerCatalogItem | null {
  const normalized = normalizeScreenshotImportMatchValue(value);
  return normalized ? catalogMap.get(normalized) ?? null : null;
}

function parseScreenshotImportQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveScreenshotImportRow(
  row: ScreenshotImportRowState,
  catalogMap: Map<string, PlannerCatalogItem>,
): ScreenshotImportResolvedRow {
  const candidate = resolveScreenshotImportCandidate(catalogMap, row.nameInput);
  const quantity = parseScreenshotImportQuantity(row.quantityInput);
  const reviewReasons: string[] = [];
  const blockedReasons: string[] = [];

  if (row.matchReviewReason) {
    reviewReasons.push(row.matchReviewReason);
  }
  if (row.quantityReviewReason) {
    reviewReasons.push(row.quantityReviewReason);
  }

  if (!candidate) {
    blockedReasons.push(row.matchReviewReason ?? 'No match');
  }

  if (quantity === null) {
    blockedReasons.push(row.quantityReviewReason ?? 'Invalid quantity');
  }

  return {
    state: row,
    candidate,
    quantity,
    reviewReasons,
    blockedReasons,
    sortWeight: reviewReasons.length ? 0 : 1,
  };
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
  ownedRelicHints,
  recentlyAddedKeys,
  onTargetChange,
  onAddToWatchlist,
}: {
  planner: PlannerSetEntry;
  expanded: boolean;
  onToggle: () => void;
  targetInputs: Record<string, string>;
  ownedRelicHints: Map<string, PlannerOwnedRelicHint[]>;
  recentlyAddedKeys: Record<string, boolean>;
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
            <strong>{planner.entry.name}</strong>
            <span className="planner-set-note">
              {planner.ownedComponentCount}/{planner.totalComponentCount} components owned
            </span>
          </div>
          <div className="planner-set-status-pills">
            <span className="market-panel-badge tone-green">
              {planner.ownedComponentCount}/{planner.totalComponentCount} owned
            </span>
            <span className="market-panel-badge tone-green">
              Profit {formatPlat(planner.completionProfit)}
            </span>
          </div>
          <div className="planner-set-metrics">
            <div className="planner-set-metric">
              <span className="planner-set-metric-label">Investment</span>
              <strong>{formatPlat(planner.remainingInvestment)}</strong>
            </div>
            <div className="planner-set-metric">
              <span className="planner-set-metric-label">Exit</span>
              <strong>{formatPlat(planner.entry.recommendedSetExitPrice)}</strong>
            </div>
            <div className="planner-set-metric">
              <span className="planner-set-metric-label">ROI</span>
              <strong>{formatPercent(planner.completionRoiPct)}</strong>
            </div>
            <div className="planner-set-metric">
              <span className="planner-set-metric-label">Liquidity</span>
              <strong>{Math.round(planner.entry.liquidityScore)}%</strong>
            </div>
            <div className="planner-set-metric">
              <span className="planner-set-metric-label">Confidence</span>
              <strong>{planner.entry.confidenceSummary.label}</strong>
            </div>
          </div>
          <div className="planner-set-pills">
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
              const relicHints =
                (component.itemId !== null
                  ? ownedRelicHints.get(`item:${component.itemId}`)
                  : undefined) ??
                ownedRelicHints.get(`slug:${component.slug}`) ??
                [];

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
                        <strong>
                          <ItemName
                            name={component.name}
                            slug={component.slug}
                            itemId={component.itemId ?? undefined}
                            imagePath={component.imagePath}
                          />
                        </strong>
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
                        <span className="scanner-stat-pill scanner-stat-pill-highlight">
                          <span className="scanner-stat-pill-label">Entry Zone</span>
                          <span className="scanner-stat-pill-value">
                            {formatPlat(component.recommendedEntryLow)} - {formatPlat(component.recommendedEntryHigh)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                  {componentState.missingQuantity > 0 && relicHints.length > 0 ? (
                    <div className="planner-component-relics planner-component-relics-middle">
                      <span className="planner-component-relics-label">Owned relics</span>
                      <div className="planner-component-relic-pill-list">
                        {relicHints.slice(0, 4).map((relic) => (
                          <span
                            key={`${component.slug}-${relic.key}`}
                            className="planner-component-relic-pill"
                            title={relic.fullName}
                          >
                            {relic.label} ×{relic.totalCount}
                          </span>
                        ))}
                        {relicHints.length > 4 ? (
                          <span className="planner-component-relic-pill planner-component-relic-pill-more">
                            +{relicHints.length - 4} more
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

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
                      <div className="watchlist-add-feedback-stack">
                        {recentlyAddedKeys[targetKey] ? (
                          <span className="watchlist-add-success">{WATCHLIST_ADD_SUCCESS_MESSAGE}</span>
                        ) : null}
                        <button
                          className="btn-sm scanner-component-watch-button"
                          type="button"
                          disabled={!effectiveTarget.trim() || !component.itemId}
                          onClick={() => onAddToWatchlist(component)}
                        >
                          Add to Watchlist
                        </button>
                      </div>
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
  screenshots,
  processing,
  scanning,
  confirming,
  progress,
  errorMessage,
  reviewRows,
  hasReviewRows,
  hasBlockedRows,
  candidateOptions,
  onClose,
  onPickFile,
  onScan,
  onNameChange,
  onQuantityChange,
  onConfirm,
}: {
  open: boolean;
  fileInputRef: { current: HTMLInputElement | null };
  screenshots: ScreenshotImportPreparedScreenshot[];
  processing: boolean;
  scanning: boolean;
  confirming: boolean;
  progress: SetCompletionScreenshotProgress | null;
  errorMessage: string | null;
  reviewRows: ScreenshotImportResolvedRow[];
  hasReviewRows: boolean;
  hasBlockedRows: boolean;
  candidateOptions: PlannerCatalogItem[];
  onClose: () => void;
  onPickFile: (files: File[]) => Promise<void>;
  onScan: () => Promise<void>;
  onNameChange: (rowId: string, value: string) => void;
  onQuantityChange: (rowId: string, value: string) => void;
  onConfirm: () => Promise<void>;
}) {
  const modalRef = useModalA11y<HTMLDivElement>({ onClose, active: open });

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
        ref={modalRef}
        className="settings-modal screenshot-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import prime components from screenshot"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Set Completion Import</span>
            <h3>
              Import Prime Components Screenshot{' '}
              <span className="scanner-run-pill scanner-run-pill-warning screenshot-import-experimental-pill">Experimental</span>
            </h3>
          </div>
          <div className="settings-modal-actions">
            <button className="settings-close-btn" type="button" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="settings-modal-body screenshot-import-body">
          <div className="settings-form-card screenshot-import-left">
            <div className="screenshot-import-example">
              <div className="screenshot-import-example-copy">
                <span className="panel-title-eyebrow">Example Only</span>
                <strong>Use this as a framing reference</strong>
                <span>
                  Screenshot from the in-game inventory view with the grid fully visible and no
                  extra overlays. If your screenshot does not match this shape closely, the import
                  will be unreliable.
                </span>
              </div>
              <div className="screenshot-import-example-image">
                <img src={setCompletionImportExample} alt="Example Prime Components screenshot layout" />
              </div>
            </div>

            <div className="screenshot-import-toolbar">
              <button
                type="button"
                className="settings-primary-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={processing || confirming}
              >
                {processing ? 'Processing…' : 'Choose Screenshot'}
              </button>
              <input
                ref={fileInputRef}
                className="screenshot-import-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(event) => {
                  void onPickFile(event.target.files ? Array.from(event.target.files) : []);
                }}
              />
              <button
                type="button"
                className="settings-secondary-btn"
                disabled={processing || scanning || confirming || !screenshots.length}
                onClick={() => {
                  void onScan();
                }}
              >
                {scanning ? 'Scanning…' : 'Scan'}
              </button>
            </div>

            <p className="watchlist-form-note">
              Use one or more screenshots from the in-game <strong>Prime Components</strong> tab.
              Each screenshot is prepared independently and then merged into one review list.
            </p>
            <p className="watchlist-form-note">
              Workflow: choose the screenshots and the detector will immediately extract the fixed
              palette and isolate the OCR crops for each one. Then press <strong>Scan</strong> to OCR
              each screenshot separately, match the rows against the set map, review any flagged rows,
              and confirm them into the planner.
            </p>

            {progress ? (
              <div className="scanner-inline-progress screenshot-import-progress">
                <span className="scanner-progress-label">{progress.stage.toUpperCase()}</span>
                <strong>{progress.detail}</strong>
              </div>
            ) : null}

            {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}
            {screenshots.length ? (
              <div className="screenshot-import-preview-list">
                {screenshots.map((screenshot, index) => (
                  <div key={screenshot.id} className="screenshot-import-original-preview">
                    <div className="screenshot-import-original-preview-meta">
                      <span className="card-label">Screenshot {index + 1}</span>
                      <strong>{screenshot.fileName}</strong>
                    </div>
                    <div className="screenshot-import-original-preview-shell">
                      <img
                        className="screenshot-import-original-image"
                        src={screenshot.previewUrl}
                        alt={`Prime components screenshot preview ${index + 1}`}
                      />
                      <div className="screenshot-import-cell-overlays">
                        {renderScreenshotCellOverlays(screenshot)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="opportunities-placeholder">
                Choose one or more screenshots first to generate the preview list.
              </div>
            )}
          </div>

          <div className="settings-form-card screenshot-import-right">
            <div className="screenshot-import-summary">
              <div>
                <span className="card-label">Review Matches</span>
                <h3>Detected Components</h3>
              </div>
              <div className="scanner-run-summary">
                <span className="scanner-run-pill scanner-run-pill-blue">
                  {reviewRows.length} rows
                </span>
                {hasReviewRows ? (
                  <span className="scanner-run-pill scanner-run-pill-warning">Needs review</span>
                ) : null}
              </div>
            </div>

            <datalist id="set-completion-screenshot-candidates">
              {candidateOptions.map((candidate) => (
                <option key={candidate.slug} value={candidate.name} />
              ))}
            </datalist>

            {reviewRows.length ? (
              <div className="screenshot-import-rows">
                {reviewRows.map((row) => {
                  const reviewReason = row.reviewReasons.join(' · ');
                  return (
                    <article
                      key={row.state.rowId}
                      className={`screenshot-import-row${row.reviewReasons.length ? ' needs-review' : ''}`}
                    >
                      {row.reviewReasons.length ? (
                        <span className="screenshot-import-row-review-badge">{reviewReason}</span>
                      ) : null}
                      <div className="screenshot-import-row-main">
                        <span className="screenshot-import-row-thumb">
                          <img src={row.state.originalCellDataUrl} alt="" />
                        </span>
                        <div className="screenshot-import-row-editor">
                          <div className="screenshot-import-row-copy">
                            <strong>Matched name</strong>
                            <span className="screenshot-import-row-source">
                              Screenshot {row.state.screenshotIndex + 1}: {row.state.screenshotFileName}
                            </span>
                            <input
                              className="set-planner-search-input"
                              list="set-completion-screenshot-candidates"
                              type="text"
                              value={row.state.nameInput}
                              onChange={(event) => onNameChange(row.state.rowId, event.target.value)}
                              placeholder={row.state.suggestedMatch?.name ?? 'Select a valid set component'}
                            />
                            <span>
                              O: {row.state.originalText || '—'} | P: {row.state.processedText || '—'}
                            </span>
                          </div>
                          <div className="screenshot-import-qty-field">
                            <span>Quantity</span>
                            <input
                              className="screenshot-import-qty-input"
                              type="number"
                              min="1"
                              step="1"
                              value={row.state.quantityInput}
                              onChange={(event) => onQuantityChange(row.state.rowId, event.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="opportunities-placeholder">
                Upload a screenshot, then press Scan to build the editable review list.
              </div>
            )}

            <div className="screenshot-import-footer">
              <button type="button" className="settings-secondary-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="settings-primary-btn"
                disabled={processing || scanning || confirming || !reviewRows.length || hasBlockedRows}
                onClick={() => {
                  void onConfirm();
                }}
              >
                {confirming ? 'Confirming…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SetCompletionScreenshotImportWarningModal({
  open,
  onClose,
  onContinue,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close screenshot import guidance"
        onClick={onClose}
      />
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Screenshot import requirements"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Set Completion Import</span>
            <h3>
              Screenshot Import Guidance{' '}
              <span className="scanner-run-pill scanner-run-pill-warning screenshot-import-experimental-pill">Experimental</span>
            </h3>
          </div>
          <div className="settings-modal-actions">
            <button className="settings-close-btn" type="button" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="settings-modal-body">
          <div className="settings-form-card screenshot-import-guidance-card">
            <p className="watchlist-form-note screenshot-import-guidance-note">
              This importer currently only works reliably with the in-game <strong className="screenshot-import-guidance-theme">Vitruvian</strong> theme.
            </p>
            <p className="watchlist-form-note screenshot-import-guidance-note">
              Make sure your mouse cursor is <strong>not visible</strong> in the screenshot.
            </p>
            <p className="watchlist-form-note screenshot-import-guidance-note">
              The screenshot should show the full <strong>7×3 Prime Components grid</strong>, matching the example layout.
            </p>
            <div className="settings-form-actions">
              <button type="button" className="settings-secondary-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="settings-primary-btn" onClick={onContinue}>
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function OpportunitiesPage({
  mode = 'opportunities',
}: {
  mode?: 'opportunities' | 'inventory';
} = {}) {
  const [activeTab, setActiveTab] = useState<OppTab>(
    mode === 'inventory' ? 'set-planner' : 'farm-now',
  );
  const [farmNowTab, setFarmNowTab] = useState<FarmNowTab>('part-profit');
  const [farmNowScan, setFarmNowScan] = useState<ArbitrageScannerResponse | null>(null);
  const [farmNowScanState, setFarmNowScanState] = useState<ArbitrageScannerState | null>(null);
  const [farmNowLoading, setFarmNowLoading] = useState(false);
  const [farmNowError, setFarmNowError] = useState<string | null>(null);
  const [expandedFarmRelicKey, setExpandedFarmRelicKey] = useState<string | null>(null);
  const [scannerResponse, setScannerResponse] = useState<ArbitrageScannerResponse | null>(null);
  const [plannerFallbackCatalog, setPlannerFallbackCatalog] = useState<PlannerCatalogItem[]>([]);
  const [ownedItems, setOwnedItems] = useState<SetCompletionOwnedItem[]>([]);
  const [ownedItemPrices, setOwnedItemPrices] = useState<Record<string, number | null>>({});
  const [ownedSort, setOwnedSort] = useState<'name' | 'price'>('name');
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ownedRelics, setOwnedRelics] = useState<OwnedRelicEntry[]>([]);
  const [ownedRelicsLoading, setOwnedRelicsLoading] = useState(false);
  const [farmNowRelicsRefreshing, setFarmNowRelicsRefreshing] = useState(false);
  const [ownedRelicsError, setOwnedRelicsError] = useState<string | null>(null);
  const [expandedRelicKey, setExpandedRelicKey] = useState<string | null>(null);
  const [ownedRelicsLoaded, setOwnedRelicsLoaded] = useState(false);
  const [ownedRelicsUpdatedAt, setOwnedRelicsUpdatedAt] = useState<string | null>(null);
  const [expandedSetSlug, setExpandedSetSlug] = useState<string | null>(null);
  const [componentQuery, setComponentQuery] = useState('');
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [plannerTargetInputs, setPlannerTargetInputs] = useState<Record<string, string>>({});
  const [screenshotImportGuidanceOpen, setScreenshotImportGuidanceOpen] = useState(false);
  const [screenshotImportOpen, setScreenshotImportOpen] = useState(false);
  const [screenshotImportScreenshots, setScreenshotImportScreenshots] = useState<
    ScreenshotImportPreparedScreenshot[]
  >([]);
  const [screenshotImportProcessing, setScreenshotImportProcessing] = useState(false);
  const [screenshotImportScanning, setScreenshotImportScanning] = useState(false);
  const [screenshotImportConfirming, setScreenshotImportConfirming] = useState(false);
  const [screenshotImportProgress, setScreenshotImportProgress] =
    useState<SetCompletionScreenshotProgress | null>(null);
  const [screenshotImportError, setScreenshotImportError] = useState<string | null>(null);
  const [screenshotImportRows, setScreenshotImportRows] = useState<
    ScreenshotImportRowState[]
  >([]);
  const [watchlistAddFeedback, setWatchlistAddFeedback] = useState<Record<string, boolean>>({});
  const screenshotFileInputRef = useRef<HTMLInputElement | null>(null);
  const watchlistAddFeedbackTimeoutsRef = useRef(new Map<string, number>());

  const screenshotImportTraceSettings = useMemo<SetCompletionTraceSettings>(
    () => ({
      smoothness: 4,
      thickness: 3,
      noiseCutoff: 10,
    }),
    [],
  );

  const setActivePage = useAppStore((state) => state.setActivePage);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);

  const tabs: { id: OppTab; label: string }[] =
    mode === 'inventory'
      ? [
          { id: 'set-planner', label: 'Set Completion Planner' },
          { id: 'inventory', label: 'Inventory' },
        ]
      : [
          // The "Opportunities" subtab is temporarily disabled; "What To Farm Now" is the
          // default. Re-add `{ id: 'opportunities', label: 'Opportunities' }` here to restore it.
          { id: 'farm-now', label: 'What To Farm Now' },
          { id: 'owned-relics', label: 'Owned Relics' },
        ];

  useEffect(() => {
    if (activeTab !== 'set-planner' && activeTab !== 'inventory') {
      return;
    }

    let cancelled = false;

    const loadPlannerState = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const [scannerState, owned, autocompleteItems, ownedPrices] = await Promise.all([
          getArbitrageScannerState(),
          getSetCompletionOwnedItems(),
          getWfmAutocompleteItems(),
          getSetCompletionOwnedItemPrices(),
        ]);
        if (cancelled) {
          return;
        }

        setScannerResponse(scannerState.latestScan);
        setOwnedItems(owned);
        setOwnedItemPrices(
          Object.fromEntries(ownedPrices.map((entry) => [entry.slug, entry.recommendedExitPrice])),
        );
        setPlannerFallbackCatalog(mapAutocompleteItemsToPlannerCatalog(autocompleteItems));
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

  useEffect(
    () => () => {
      clearWatchlistAddFeedbackTimeouts(watchlistAddFeedbackTimeoutsRef);
    },
    [],
  );

  useEffect(() => {
    if (activeTab !== 'farm-now') {
      return;
    }

    let cancelled = false;

    const loadFarmNow = async () => {
      setFarmNowLoading(true);
      setFarmNowError(null);

      try {
        const [scannerState, owned] = await Promise.all([
          getArbitrageScannerState(),
          getSetCompletionOwnedItems(),
        ]);
        if (cancelled) {
          return;
        }
        setFarmNowScan(scannerState.latestScan);
        setFarmNowScanState(scannerState);
        setOwnedItems(owned);
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
    if (activeTab !== 'set-planner' && activeTab !== 'inventory') {
      return;
    }

    void loadOwnedRelics();
  }, [activeTab]);

  const applyOwnedRelicCache = (cache: OwnedRelicInventoryCache) => {
    setOwnedRelics(cache.entries);
    setOwnedRelicsLoaded(true);
    setOwnedRelicsUpdatedAt(cache.updatedAt);
  };

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
      applyOwnedRelicCache(cache);
    } catch (error) {
      setOwnedRelicsError(toErrorMessage(error));
    } finally {
      setOwnedRelicsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'farm-now') {
      return;
    }

    let cancelled = false;

    const primeFarmNowRelics = async () => {
      setOwnedRelicsError(null);

      try {
        const cache = await getOwnedRelicInventoryCache();
        if (cancelled) {
          return;
        }
        applyOwnedRelicCache(cache);
      } catch (error) {
        if (!cancelled) {
          setOwnedRelicsError(toErrorMessage(error));
        }
      }

      setFarmNowRelicsRefreshing(true);
      try {
        const refreshedCache = await refreshOwnedRelicInventory();
        if (cancelled) {
          return;
        }
        applyOwnedRelicCache(refreshedCache);
        setOwnedRelicsError(null);
      } catch (error) {
        if (!cancelled) {
          setOwnedRelicsError(toErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setFarmNowRelicsRefreshing(false);
        }
      }
    };

    void primeFarmNowRelics();

    return () => {
      cancelled = true;
      setFarmNowRelicsRefreshing(false);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'owned-relics') {
      return;
    }

    void loadOwnedRelics();
  }, [activeTab]);

  const plannerScanSource =
    activeTab === 'farm-now' ? farmNowScan ?? scannerResponse : scannerResponse ?? farmNowScan;

  const plannerCatalog = useMemo<PlannerCatalogItem[]>(() => {
    const bySlug = new Map<string, PlannerCatalogItem>();
    for (const setEntry of plannerScanSource?.results ?? []) {
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

    const scanCatalog = [...bySlug.values()].sort((left, right) => left.name.localeCompare(right.name));
    return scanCatalog.length > 0 ? scanCatalog : plannerFallbackCatalog;
  }, [plannerFallbackCatalog, plannerScanSource]);

  const screenshotImportCandidates = useMemo<SetCompletionImportCandidate[]>(
    () =>
      plannerCatalog.map((candidate) => ({
        itemId: candidate.itemId,
        slug: candidate.slug,
        name: candidate.name,
        imagePath: candidate.imagePath,
      })),
    [plannerCatalog],
  );

  const screenshotImportCatalogMap = useMemo(() => {
    const map = new Map<string, PlannerCatalogItem>();
    for (const candidate of plannerCatalog) {
      map.set(normalizeScreenshotImportMatchValue(candidate.name), candidate);
    }
    return map;
  }, [plannerCatalog]);

  const resolvedScreenshotImportRows = useMemo(() => {
    return screenshotImportRows
      .map((row) => resolveScreenshotImportRow(row, screenshotImportCatalogMap))
      .sort((left, right) => {
        if (left.sortWeight !== right.sortWeight) {
          return left.sortWeight - right.sortWeight;
        }
        if (left.state.screenshotIndex !== right.state.screenshotIndex) {
          return left.state.screenshotIndex - right.state.screenshotIndex;
        }
        return left.state.tileIndex - right.state.tileIndex;
      });
  }, [screenshotImportCatalogMap, screenshotImportRows]);

  const screenshotImportHasBlockedRows = useMemo(
    () => resolvedScreenshotImportRows.some((row) => row.blockedReasons.length > 0),
    [resolvedScreenshotImportRows],
  );
  const screenshotImportHasReviewRows = useMemo(
    () => resolvedScreenshotImportRows.some((row) => row.reviewReasons.length > 0),
    [resolvedScreenshotImportRows],
  );

  const ownedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of ownedItems) {
      map.set(item.slug, item.quantity);
    }
    return map;
  }, [ownedItems]);

  const plannerEntries = useMemo<PlannerSetEntry[]>(() => {
    const results = plannerScanSource?.results ?? [];
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
  }, [ownedMap, plannerScanSource]);

  const plannerPositiveSummary = useMemo(() => {
    let expectedInvestment = 0;
    let expectedProfit = 0;
    let profitableSetCount = 0;

    for (const planner of plannerEntries) {
      if (
        planner.remainingInvestment === null ||
        planner.completionProfit === null ||
        planner.completionProfit <= 0
      ) {
        continue;
      }

      expectedInvestment += planner.remainingInvestment;
      expectedProfit += planner.completionProfit;
      profitableSetCount += 1;
    }

    const expectedMarginPct =
      expectedInvestment > 0 ? (expectedProfit / expectedInvestment) * 100 : null;
    const expectedValue = expectedInvestment + expectedProfit;

    return {
      expectedInvestment,
      expectedValue,
      expectedProfit,
      expectedMarginPct,
      profitableSetCount,
    };
  }, [plannerEntries]);

  const plannerOwnedRelicHints = useMemo(() => {
    const byDropKey = new Map<string, PlannerOwnedRelicHint[]>();

    for (const relic of ownedRelics) {
      if ((relic.counts?.total ?? 0) <= 0) {
        continue;
      }

      const hint: PlannerOwnedRelicHint = {
        key: `${relic.tier}:${relic.code}`,
        label: `${relic.tier} ${relic.code}`,
        fullName: relic.name,
        totalCount: relic.counts.total,
      };

      for (const drop of relic.drops) {
        const keys = [
          drop.itemId !== null ? `item:${drop.itemId}` : null,
          drop.slug ? `slug:${drop.slug}` : null,
        ].filter((value): value is string => Boolean(value));

        for (const key of keys) {
          const existing = byDropKey.get(key) ?? [];
          if (!existing.some((entry) => entry.key === hint.key)) {
            existing.push(hint);
            byDropKey.set(key, existing);
          }
        }
      }
    }

    for (const hints of byDropKey.values()) {
      hints.sort((left, right) => {
        if (right.totalCount !== left.totalCount) {
          return right.totalCount - left.totalCount;
        }
        return left.label.localeCompare(right.label);
      });
    }

    return byDropKey;
  }, [ownedRelics]);

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
  const farmNowMissingComponents = useMemo(() => {
    const byKey = new Map<
      string,
      {
        missingQuantity: number;
        setNames: Set<string>;
      }
    >();

    for (const planner of plannerEntries) {
      for (const component of planner.components) {
        if (component.missingQuantity <= 0) {
          continue;
        }

        const keys = [
          component.component.itemId !== null ? `item:${component.component.itemId}` : null,
          component.component.slug ? `slug:${component.component.slug}` : null,
        ].filter((value): value is string => Boolean(value));

        for (const key of keys) {
          const current = byKey.get(key) ?? {
            missingQuantity: 0,
            setNames: new Set<string>(),
          };
          current.missingQuantity += component.missingQuantity;
          current.setNames.add(planner.entry.name);
          byKey.set(key, current);
        }
      }
    }

    return byKey;
  }, [plannerEntries]);

  const farmNowSetCompletionRelics = useMemo<FarmNowSetCompletionRow[]>(() => {
    const relics = farmNowScan?.relicRoiResults ?? [];
    const ownedByRelic = new Map<string, number>();

    for (const relic of ownedRelics) {
      ownedByRelic.set(`${relic.tier}:${relic.code}`, relic.counts.total ?? 0);
    }

    const rows: FarmNowSetCompletionRow[] = [];

    for (const relic of relics) {
      const parsedRelic = parseRelicTierCode(relic.name);
      const ownedCount = parsedRelic
        ? ownedByRelic.get(`${parsedRelic.tier}:${parsedRelic.code}`) ?? 0
        : 0;
      if (!ownedCount) {
        continue;
      }
      const coveredSetNames = new Set<string>();

      const drops = relic.drops.map<FarmNowSetCompletionDrop>((drop) => {
        const neededMatch =
          (drop.itemId !== null ? farmNowMissingComponents.get(`item:${drop.itemId}`) : undefined) ??
          farmNowMissingComponents.get(`slug:${drop.slug}`);
        const setNames = neededMatch ? [...neededMatch.setNames].sort() : [];

        for (const setName of setNames) {
          coveredSetNames.add(setName);
        }

        return {
          drop,
          isNeeded: Boolean(neededMatch),
          missingQuantity: neededMatch?.missingQuantity ?? 0,
          coveredSetCount: setNames.length,
          setNames,
        };
      });

      const neededDrops = drops.filter((drop) => drop.isNeeded);
      if (!neededDrops.length) {
        continue;
      }

      rows.push({
        relic,
        ownedCount,
        neededDropCount: neededDrops.length,
        totalMissingQuantity: neededDrops.reduce((sum, drop) => sum + drop.missingQuantity, 0),
        coveredSetCount: coveredSetNames.size,
        coveredSetNames: [...coveredSetNames].sort(),
        drops,
      });
    }

    return rows.sort((left, right) => {
      if (right.neededDropCount !== left.neededDropCount) {
        return right.neededDropCount - left.neededDropCount;
      }
      if (right.coveredSetCount !== left.coveredSetCount) {
        return right.coveredSetCount - left.coveredSetCount;
      }
      if (right.totalMissingQuantity !== left.totalMissingQuantity) {
        return right.totalMissingQuantity - left.totalMissingQuantity;
      }
      if (right.ownedCount !== left.ownedCount) {
        return right.ownedCount - left.ownedCount;
      }
      return left.relic.name.localeCompare(right.relic.name);
    });
  }, [farmNowScan, ownedRelics, farmNowMissingComponents]);

  const farmNowSetCompletionTopRelics = useMemo(
    () => farmNowSetCompletionRelics.slice(0, 3),
    [farmNowSetCompletionRelics],
  );
  const farmNowSetCompletionSetCount = useMemo(
    () => plannerEntries.filter((planner) => planner.components.some((component) => component.missingQuantity > 0))
      .length,
    [plannerEntries],
  );
  const farmNowSetCompletionMissingCount = useMemo(() => {
    const slugs = new Set<string>();
    for (const planner of plannerEntries) {
      for (const component of planner.components) {
        if (component.missingQuantity > 0) {
          slugs.add(component.component.slug);
        }
      }
    }
    return slugs.size;
  }, [plannerEntries]);
  const ownedRelicTotal = useMemo(
    () =>
      ownedRelics.reduce((sum, relic) => sum + (relic.counts?.total ?? 0), 0),
    [ownedRelics],
  );
  const farmNowLastScan = farmNowScanState?.progress.lastCompletedAt ?? farmNowScan?.computedAt ?? null;

  // Left panel: every known prime component, filtered by the shared search bar.
  const filteredCatalog = useMemo(() => {
    const normalizedQuery = componentQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return plannerCatalog;
    }
    return plannerCatalog.filter((item) =>
      item.name.toLowerCase().includes(normalizedQuery),
    );
  }, [componentQuery, plannerCatalog]);

  // Right panel: only the parts the user owns, filtered by the same search bar and
  // sorted by the user's chosen order (name A–Z, or value high→low).
  const filteredOwnedItems = useMemo(() => {
    const normalizedQuery = componentQuery.trim().toLowerCase();
    const base = normalizedQuery
      ? ownedItems.filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      : ownedItems;
    const sorted = [...base];
    if (ownedSort === 'price') {
      sorted.sort((a, b) => {
        const pa = ownedItemPrices[a.slug] ?? -1;
        const pb = ownedItemPrices[b.slug] ?? -1;
        if (pb !== pa) return pb - pa;
        return a.name.localeCompare(b.name);
      });
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [componentQuery, ownedItems, ownedSort, ownedItemPrices]);

  useEffect(() => {
    if (!screenshotImportScreenshots.length) {
      return undefined;
    }

    const urls = screenshotImportScreenshots.map((screenshot) => screenshot.previewUrl);
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [screenshotImportScreenshots]);

  // Synchronous running target + in-flight guard per slug. Rapid +/- clicks accumulate against
  // the ref (updated synchronously) instead of each computing from the same render-time base —
  // which previously lost increments — and one write per slug runs at a time, coalescing any
  // clicks that arrived while it was in flight.
  type OwnedQuantityItem = { itemId: number | null; slug: string; name: string; imagePath: string | null };
  const ownedTargetRef = useRef(new Map<string, number>());
  const ownedPersistInFlightRef = useRef(new Set<string>());

  const flushOwnedQuantity = async (item: OwnedQuantityItem) => {
    const slug = item.slug;
    if (ownedPersistInFlightRef.current.has(slug)) {
      return;
    }
    ownedPersistInFlightRef.current.add(slug);
    setSavingSlug(slug);
    setErrorMessage(null);
    try {
      let persisted: number | null = null;
      // Keep writing until the persisted value matches the latest target, coalescing clicks
      // that landed mid-write.
      while (ownedTargetRef.current.get(slug) !== persisted) {
        const target = ownedTargetRef.current.get(slug) ?? 0;
        const nextOwnedItems = await setSetCompletionOwnedItemQuantity({
          itemId: item.itemId,
          slug,
          name: item.name,
          imagePath: item.imagePath,
          quantity: target,
        });
        persisted = target;
        setOwnedItems(nextOwnedItems);
      }
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      ownedPersistInFlightRef.current.delete(slug);
      ownedTargetRef.current.delete(slug);
      setSavingSlug((current) => (current === slug ? null : current));
    }
  };

  const adjustOwnedQuantity = (item: OwnedQuantityItem, baseQuantity: number, delta: number) => {
    const base = ownedTargetRef.current.get(item.slug) ?? baseQuantity;
    ownedTargetRef.current.set(item.slug, Math.max(base + delta, 0));
    void flushOwnedQuantity(item);
  };

  const [clearingInventory, setClearingInventory] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Cancel a pending clear-confirmation whenever the search filter changes, so the
  // confirmation can't apply to a different set of items than the user saw.
  useEffect(() => {
    setConfirmingClear(false);
  }, [componentQuery]);

  // Removes every owned part currently visible on the right panel (i.e. matching the
  // active search filter). With an empty search this clears the whole inventory.
  const clearFilteredOwnedItems = async () => {
    const targets = filteredOwnedItems;
    if (targets.length === 0) {
      return;
    }
    setClearingInventory(true);
    setConfirmingClear(false);
    setErrorMessage(null);
    try {
      let latest: SetCompletionOwnedItem[] | null = null;
      for (const item of targets) {
        latest = await setSetCompletionOwnedItemQuantity({
          itemId: item.itemId,
          slug: item.slug,
          name: item.name,
          imagePath: item.imagePath,
          quantity: 0,
        });
      }
      if (latest) {
        setOwnedItems(latest);
      }
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setClearingInventory(false);
    }
  };

  // Monotonic id so an in-flight scan whose session was reset/superseded can't write stale rows.
  const screenshotScanIdRef = useRef(0);

  const resetScreenshotImportSession = () => {
    screenshotScanIdRef.current += 1;
    setScreenshotImportScreenshots((current) => {
      for (const screenshot of current) {
        URL.revokeObjectURL(screenshot.previewUrl);
      }
      return [];
    });
    setScreenshotImportError(null);
    setScreenshotImportProgress(null);
    setScreenshotImportProcessing(false);
    setScreenshotImportScanning(false);
    setScreenshotImportConfirming(false);
    setScreenshotImportRows([]);
    if (screenshotFileInputRef.current) {
      screenshotFileInputRef.current.value = '';
    }
  };

  const closeScreenshotImport = () => {
    setScreenshotImportOpen(false);
    resetScreenshotImportSession();
  };

  const closeScreenshotImportGuidance = () => {
    setScreenshotImportGuidanceOpen(false);
  };

  const continueScreenshotImportFromGuidance = () => {
    setScreenshotImportGuidanceOpen(false);
    setScreenshotImportOpen(true);
  };

  const processScreenshotImportFiles = async (
    files: File[],
    crop: SetCompletionImportCrop,
  ) => {
    screenshotScanIdRef.current += 1;
    setScreenshotImportProcessing(true);
    setScreenshotImportScanning(false);
    setScreenshotImportConfirming(false);
    setScreenshotImportError(null);
    setScreenshotImportScreenshots((current) => {
      for (const screenshot of current) {
        URL.revokeObjectURL(screenshot.previewUrl);
      }
      return [];
    });
    setScreenshotImportRows([]);
    setScreenshotImportProgress({
      progress: 0,
      stage: 'prepare',
      detail: 'Preparing screenshot detector…',
    });

    try {
      const preparedScreenshots: ScreenshotImportPreparedScreenshot[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const previewUrl = URL.createObjectURL(file);
        try {
          const detectionPreview = await analyzeSetCompletionInventoryScreenshot(
            file,
            crop,
            screenshotImportTraceSettings,
            (progress) => {
              setScreenshotImportProgress({
                ...progress,
                detail: `${progress.detail} (${index + 1}/${files.length})`,
              });
            },
          );
          preparedScreenshots.push({
            id: `${Date.now()}-${index}`,
            fileName: file.name,
            previewUrl,
            detectionPreview,
          });
        } catch (error) {
          URL.revokeObjectURL(previewUrl);
          throw error;
        }
      }
      setScreenshotImportScreenshots(preparedScreenshots);
    } catch (error) {
      setScreenshotImportScreenshots((current) => {
        for (const screenshot of current) {
          URL.revokeObjectURL(screenshot.previewUrl);
        }
        return [];
      });
      setScreenshotImportError(toErrorMessage(error));
    } finally {
      setScreenshotImportProcessing(false);
    }
  };

  const handleScreenshotFilePicked = async (files: File[]) => {
    if (!files.length) {
      return;
    }
    setScreenshotImportError(null);
    setScreenshotImportProgress(null);
    setScreenshotImportProcessing(false);
    setScreenshotImportScanning(false);
    setScreenshotImportConfirming(false);
    setScreenshotImportRows([]);
    await processScreenshotImportFiles(files, getDefaultSetCompletionImportCrop());
  };

  const handleScreenshotScan = async () => {
    // Ignore a second trigger while a scan is already running; tag this run so a stale OCR
    // result (from a superseded scan or a reset session) can't overwrite newer rows.
    if (!screenshotImportScreenshots.length || screenshotImportScanning) {
      return;
    }
    const scanId = (screenshotScanIdRef.current += 1);

    setScreenshotImportScanning(true);
    setScreenshotImportError(null);
    setScreenshotImportRows([]);
    try {
      const results: ScreenshotImportRowState[] = [];
      for (let index = 0; index < screenshotImportScreenshots.length; index += 1) {
        const screenshot = screenshotImportScreenshots[index];
        const screenshotResults = await scanAndMatchSetCompletionDetectionPreview(
          screenshot.detectionPreview,
          screenshotImportCandidates,
          (progress) => {
            if (screenshotScanIdRef.current !== scanId) {
              return;
            }
            setScreenshotImportProgress({
              ...progress,
              detail: `${progress.detail} (${index + 1}/${screenshotImportScreenshots.length})`,
            });
          },
        );
        if (screenshotScanIdRef.current !== scanId) {
          return;
        }
        results.push(
          ...screenshotResults.map((entry) =>
            buildScreenshotImportRowState(entry, screenshot, index),
          ),
        );
      }
      if (screenshotScanIdRef.current === scanId) {
        setScreenshotImportRows(results);
      }
    } catch (error) {
      if (screenshotScanIdRef.current === scanId) {
        setScreenshotImportError(toErrorMessage(error));
      }
    } finally {
      if (screenshotScanIdRef.current === scanId) {
        setScreenshotImportScanning(false);
      }
    }
  };

  const handleScreenshotImportNameChange = (rowId: string, value: string) => {
    setScreenshotImportRows((current) =>
      current.map((row) =>
        row.rowId !== rowId
          ? row
          : {
              ...row,
              nameInput: value,
              matchReviewed:
                row.matchReviewReason === null ||
                resolveScreenshotImportCandidate(screenshotImportCatalogMap, value) !== null,
            },
      ),
    );
  };

  const handleScreenshotImportQuantityChange = (rowId: string, value: string) => {
    setScreenshotImportRows((current) =>
      current.map((row) =>
        row.rowId !== rowId
          ? row
          : {
              ...row,
              quantityInput: value,
              quantityReviewed:
                row.quantityReviewReason === null || parseScreenshotImportQuantity(value) !== null,
            },
      ),
    );
  };

  const handleConfirmScreenshotImport = async () => {
    if (!resolvedScreenshotImportRows.length || screenshotImportHasBlockedRows) {
      return;
    }

    const rows = resolvedScreenshotImportRows.map((row) => ({
      itemId: row.candidate?.itemId ?? null,
      slug: row.candidate?.slug ?? '',
      name: row.candidate?.name ?? '',
      imagePath: row.candidate?.imagePath ?? null,
      quantity: row.quantity ?? 0,
    }));

    setScreenshotImportConfirming(true);
    setScreenshotImportError(null);
    try {
      const nextOwnedItems = await applySetCompletionScreenshotImportRows(rows);
      setOwnedItems(nextOwnedItems);
      closeScreenshotImport();
    } catch (error) {
      setScreenshotImportError(toErrorMessage(error));
    } finally {
      setScreenshotImportConfirming(false);
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
    const targetPrice = Number.parseInt(value, 10);
    if (!Number.isInteger(targetPrice) || targetPrice <= 0) {
      setErrorMessage('Enter a positive whole-number watch target before adding the component to the watchlist.');
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
      bulkTradable: false,
    };

    addExplicitItemToWatchlist(watchlistItem, 'base', 'Base Market', targetPrice);
    markWatchlistAddFeedback(
      `${setSlug}:${component.slug}`,
      setWatchlistAddFeedback,
      watchlistAddFeedbackTimeoutsRef,
    );
  };

  const noScanAvailable = !loading && !(scannerResponse?.results?.length);
  const noFarmScan = !farmNowLoading && !(farmNowScan?.relicRoiResults?.length);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">{mode === 'inventory' ? 'Inventory' : 'Opportunities'}</span>
          <div className="subnav-tabs" role="tablist" aria-label={mode === 'inventory' ? 'Inventory sections' : 'Opportunities sections'}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`subtab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={activeTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="page-content">
        {activeTab === 'set-planner' ? (
          <div className="set-planner-layout inventory-detached">
            <section className="market-panel set-planner-main-panel">
              <div className="set-planner-header">
                <div>
                  <span className="panel-title-eyebrow"><span className="panel-dot panel-dot-purple" aria-hidden="true" />Completion Opportunities</span>
                  <h3>Set Completion Planner</h3>
                  <p>
                    Uses your owned prime parts plus the cached Arbitrage scan to estimate the remaining
                    investment and completion profit for one set at a time.
                  </p>
                </div>
              </div>

              {plannerPositiveSummary.profitableSetCount > 0 ? (
                <div className="set-planner-summary-grid">
                  <article className="set-planner-summary-card">
                    <span className="card-label">Expected Investment</span>
                    <strong>{formatPlat(plannerPositiveSummary.expectedInvestment)}</strong>
                  </article>
                  <article className="set-planner-summary-card">
                    <span className="card-label">Expected Value</span>
                    <strong>{formatPlat(plannerPositiveSummary.expectedValue)}</strong>
                  </article>
                  <article className="set-planner-summary-card">
                    <span className="card-label">Expected Profit</span>
                    <strong className="set-planner-summary-value-positive">
                      {formatPlat(plannerPositiveSummary.expectedProfit)}
                    </strong>
                  </article>
                  <article className="set-planner-summary-card">
                    <span className="card-label">Expected Margin</span>
                    <strong className="set-planner-summary-value-positive">
                      {formatPercent(plannerPositiveSummary.expectedMarginPct)}
                    </strong>
                  </article>
                </div>
              ) : null}

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
                      ownedRelicHints={plannerOwnedRelicHints}
                      recentlyAddedKeys={watchlistAddFeedback}
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
          </div>
        ) : activeTab === 'inventory' ? (
          <div className="inventory-manager">
            <div className="inventory-manager-searchbar">
              <div className="inventory-search-field">
                <span className="inventory-search-icon" aria-hidden="true">⌕</span>
                <input
                  className="inventory-search-input"
                  type="text"
                  placeholder={plannerCatalog.length ? 'Search prime parts — filters both panels…' : 'Loading component catalog…'}
                  value={componentQuery}
                  onChange={(event) => setComponentQuery(event.target.value)}
                  disabled={!plannerCatalog.length}
                />
                {componentQuery ? (
                  <button
                    type="button"
                    className="inventory-search-clear"
                    onClick={() => setComponentQuery('')}
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>

            {errorMessage ? <div className="scanner-inline-error">{errorMessage}</div> : null}

            <div className="inventory-manager-grid">
              <section className="market-panel inventory-catalog-panel">
                <div className="inventory-panel-header">
                  <div>
                    <span className="panel-title-eyebrow"><span className="panel-dot panel-dot-blue" aria-hidden="true" />Prime Parts</span>
                    <h3>Add to Inventory</h3>
                  </div>
                </div>

                {!plannerCatalog.length ? (
                  <div className="inventory-empty">Component catalog is still loading.</div>
                ) : filteredCatalog.length === 0 ? (
                  <div className="inventory-empty">No prime parts match “{componentQuery.trim()}”.</div>
                ) : (
                  <div className="inventory-list">
                    {filteredCatalog.map((item) => {
                      const imageUrl = resolveWfmAssetUrl(item.imagePath);
                      const ownedQty = ownedMap.get(item.slug) ?? 0;
                      return (
                        <div key={item.slug} className={`inventory-row${ownedQty > 0 ? ' is-owned' : ''}`}>
                          <span className="inventory-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.name.slice(0, 1)}</span>
                            )}
                          </span>
                          <span className="inventory-row-name" title={item.name}>{item.name}</span>
                          {ownedQty > 0 ? (
                            <div className="inventory-stepper">
                              <button
                                type="button"
                                className="inventory-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => adjustOwnedQuantity(item, ownedQty, -1)}
                                aria-label={`Remove one ${item.name}`}
                              >
                                −
                              </button>
                              <span className="inventory-qty-value">{ownedQty}</span>
                              <button
                                type="button"
                                className="inventory-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => adjustOwnedQuantity(item, ownedQty, 1)}
                                aria-label={`Add one ${item.name}`}
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="inventory-add-button"
                              disabled={savingSlug === item.slug}
                              onClick={() => adjustOwnedQuantity(item, 0, 1)}
                            >
                              Add
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="market-panel inventory-owned-panel">
                <div className="inventory-panel-header">
                  <div>
                    <span className="panel-title-eyebrow"><span className="panel-dot panel-dot-purple" aria-hidden="true" />Owned Inventory</span>
                    <h3>
                      {ownedItems.length} {ownedItems.length === 1 ? 'part' : 'parts'}
                      {componentQuery.trim() ? ` · ${filteredOwnedItems.length} shown` : ''}
                    </h3>
                  </div>
                  {confirmingClear ? (
                    <div className="inventory-clear-confirm" role="alertdialog">
                      <span className="inventory-clear-confirm-msg">
                        Delete {filteredOwnedItems.length}{' '}
                        {componentQuery.trim() ? 'visible ' : ''}
                        {filteredOwnedItems.length === 1 ? 'item' : 'items'}? This cannot be undone.
                      </span>
                      <div className="inventory-clear-confirm-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setConfirmingClear(false)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="inventory-clear-confirm-delete"
                          disabled={clearingInventory}
                          onClick={() => { void clearFilteredOwnedItems(); }}
                        >
                          {clearingInventory ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary inventory-clear-button"
                      disabled={clearingInventory || filteredOwnedItems.length === 0}
                      onClick={() => setConfirmingClear(true)}
                    >
                      Clear Filtered Items
                    </button>
                  )}
                </div>

                {ownedItems.length > 0 ? (
                  <div className="inventory-owned-toolbar">
                    <span className="inventory-sort-label">Sort by</span>
                    <div className="inventory-sort-group">
                      <button
                        type="button"
                        className={`inventory-sort-btn${ownedSort === 'name' ? ' active' : ''}`}
                        onClick={() => setOwnedSort('name')}
                      >
                        Name
                      </button>
                      <button
                        type="button"
                        className={`inventory-sort-btn${ownedSort === 'price' ? ' active' : ''}`}
                        onClick={() => setOwnedSort('price')}
                      >
                        Value
                      </button>
                    </div>
                  </div>
                ) : null}

                {ownedItems.length === 0 ? (
                  <div className="inventory-empty">No owned prime parts yet. Add parts from the left panel.</div>
                ) : filteredOwnedItems.length === 0 ? (
                  <div className="inventory-empty">No owned parts match “{componentQuery.trim()}”.</div>
                ) : (
                  <div className="inventory-list">
                    {filteredOwnedItems.map((item) => {
                      const imageUrl = resolveWfmAssetUrl(item.imagePath);
                      return (
                        <div key={item.slug} className="inventory-row is-owned">
                          <span className="inventory-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.name.slice(0, 1)}</span>
                            )}
                          </span>
                          <span className="inventory-row-name" title={item.name}>{item.name}</span>
                          <span
                            className={`inventory-row-value${ownedItemPrices[item.slug] == null ? ' unpriced' : ''}`}
                            title="Recommended exit price (per unit)"
                          >
                            {ownedItemPrices[item.slug] != null
                              ? `${Math.round(ownedItemPrices[item.slug] as number)} pt`
                              : '—'}
                          </span>
                          <div className="inventory-stepper">
                            <button
                              type="button"
                              className="inventory-qty-button"
                              disabled={savingSlug === item.slug}
                              onClick={() => adjustOwnedQuantity(item, item.quantity, -1)}
                              aria-label={`Remove one ${item.name}`}
                            >
                              −
                            </button>
                            <span className="inventory-qty-value">{item.quantity}</span>
                            <button
                              type="button"
                              className="inventory-qty-button"
                              disabled={savingSlug === item.slug}
                              onClick={() => adjustOwnedQuantity(item, item.quantity, 1)}
                              aria-label={`Add one ${item.name}`}
                            >
                              +
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <button
              type="button"
              className="inventory-import-fab"
              onClick={() => setScreenshotImportGuidanceOpen(true)}
              disabled={!plannerCatalog.length}
              title="Import your inventory from a screenshot"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <span>Import Screenshot</span>
              <span className="scanner-run-pill scanner-run-pill-warning inventory-import-fab-pill">Beta</span>
            </button>
          </div>
        ) : activeTab === 'owned-relics' ? (
          <div className="owned-relics-layout">
            <section className="market-panel owned-relics-panel">
              <div className="owned-relics-header">
                <div>
                  <span className="panel-title-eyebrow"><span className="panel-dot panel-dot-purple" aria-hidden="true" />Owned Relics</span>
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
                  <span className="panel-title-eyebrow"><span className="panel-dot panel-dot-purple" aria-hidden="true" />What To Farm Now</span>
                  <h3>
                    {farmNowTab === 'set-completion'
                      ? 'Relics For Set Completion'
                      : 'Relic Profit Planner'}
                  </h3>
                  <p>
                    {farmNowTab === 'set-completion'
                      ? 'Ranks relics by how many missing set-completion components they can cover, using your owned component inventory as the baseline.'
                      : 'Uses the cached Relic ROI scan to rank relics by expected part profit for each refinement. No buy cost is assumed, so profit equals expected value per relic.'}
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
                    {farmNowTab === 'set-completion' ? (
                      <>
                        <span className="market-panel-badge tone-blue">
                          Relics ranked {farmNowSetCompletionRelics.length}
                        </span>
                        <span className="market-panel-badge tone-blue">
                          Missing components {farmNowSetCompletionMissingCount}
                        </span>
                        <span className="market-panel-badge tone-green">
                          Sets in progress {farmNowSetCompletionSetCount}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="market-panel-badge tone-blue">
                          Relics scanned {farmNowScan?.scannedRelicCount ?? 0}
                        </span>
                        <span className="market-panel-badge tone-blue">
                          Profit rows {farmNowRelics.length}
                        </span>
                        <span className="market-panel-badge tone-green">
                          Owned relics {ownedRelics.length} ({ownedRelicTotal})
                        </span>
                      </>
                    )}
                  </div>
                  <div className="farm-now-meta">
                    {farmNowLastScan ? (
                      <span>Last scan {formatShortLocalDateTime(farmNowLastScan)}</span>
                    ) : (
                      <span>No scan data yet</span>
                    )}
                    {farmNowRelicsRefreshing ? (
                      <span className="farm-now-refresh-indicator" title="Refreshing owned relic cache">
                        <span className="farm-now-refresh-spinner" aria-hidden="true" />
                        Refreshing relics
                      </span>
                    ) : null}
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

              {(farmNowTab === 'set-completion'
                ? farmNowSetCompletionTopRelics.length > 0
                : farmNowTopRelics.length > 0) ? (
                <div className="farm-now-toplist">
                  {farmNowTab === 'set-completion'
                    ? farmNowSetCompletionTopRelics.map((row) => (
                        <div key={row.relic.slug} className="farm-now-top-card">
                          <span className="panel-title-eyebrow">Best coverage</span>
                          <strong>{row.relic.name}</strong>
                          <span className="farm-now-top-meta">
                            {row.neededDropCount} needed drops · {row.coveredSetCount} sets helped · x
                            {row.ownedCount} owned
                          </span>
                        </div>
                      ))
                    : farmNowTopRelics.map((row) => (
                        <div
                          key={`${row.relic.slug}-${row.refinementKey}`}
                          className="farm-now-top-card"
                        >
                          <span className="panel-title-eyebrow">Top pick</span>
                          <strong>{row.relic.name}</strong>
                          <span className="farm-now-top-meta">
                            {row.refinementLabel} · {formatPlatDecimal(row.expectedProfit)} ·{' '}
                            {formatPlatDecimal(row.platPerHour)}/hr · x{row.ownedCount}
                          </span>
                        </div>
                      ))}
                </div>
              ) : null}

              {farmNowError ? <div className="scanner-inline-error">{farmNowError}</div> : null}

              {farmNowTab === 'set-completion' ? (
                farmNowLoading ? (
                  <div className="opportunities-placeholder">Loading set completion relic coverage…</div>
                ) : noFarmScan ? (
                  <div className="set-planner-empty">
                    <div>
                      <span className="panel-title-eyebrow">Scanner Cache Required</span>
                      <h3>Run a Relic ROI scan first</h3>
                      <p>
                        This view uses the cached Relic ROI data from the Arbitrage scanner. Run a
                        scan in Scanners, then return here to rank relics for set completion.
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
                        This view only ranks relics you already own. Open Owned Relics and press
                        Refresh to load your inventory, then return here.
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
                ) : ownedItems.length === 0 ? (
                  <div className="set-planner-empty">
                    <div>
                      <span className="panel-title-eyebrow">Owned Inventory Required</span>
                      <h3>Add your components first</h3>
                      <p>
                        This view needs your Set Completion Planner inventory so it can see which
                        components are still missing from partial sets.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setActivePage('inventory')}
                    >
                      Open Set Completion Planner
                    </button>
                  </div>
                ) : farmNowSetCompletionRelics.length === 0 ? (
                  <div className="opportunities-placeholder">
                    None of your owned relics currently cover your missing set-completion parts.
                  </div>
                ) : (
                  <div className="farm-now-list farm-now-list-set-completion">
                    <div className="farm-now-header-row">
                      <span className="farm-now-header-label">Relic</span>
                      <span className="farm-now-header-label">Needed Drops</span>
                      <span className="farm-now-header-label">Sets Helped</span>
                      <span className="farm-now-header-label">Owned</span>
                      <span className="farm-now-header-label farm-now-header-action" aria-hidden="true" />
                    </div>

                    {farmNowSetCompletionRelics.map((row) => {
                      const relicKey = `${row.relic.slug}:set-completion`;
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
                                  <span className="farm-now-subtitle">
                                    {row.totalMissingQuantity} missing parts covered
                                  </span>
                                </div>
                              </div>
                              <span className="farm-now-cell farm-now-cell-owned">
                                {row.neededDropCount}
                              </span>
                              <span className="farm-now-cell farm-now-cell-owned">
                                {row.coveredSetCount}
                              </span>
                              <span className="farm-now-cell farm-now-cell-owned">
                                ×{row.ownedCount}
                              </span>
                              <span className="farm-now-cell farm-now-cell-action">{expanded ? '−' : '+'}</span>
                            </div>
                          </button>

                          {expanded ? (
                            <div className="farm-now-row-body">
                              <div className="farm-now-drop-grid">
                                {row.drops.map((entry) => {
                                  const dropImage = resolveWfmAssetUrl(entry.drop.imagePath);
                                  const tone = relicRarityTone(entry.drop.rarity);
                                  return (
                                    <div
                                      key={`${relicKey}-${entry.drop.slug}`}
                                      className={`farm-now-drop-card${entry.isNeeded ? ' is-needed' : ''}`}
                                    >
                                      <span className="farm-now-drop-thumb">
                                        {dropImage ? (
                                          <img src={dropImage} alt="" loading="lazy" />
                                        ) : (
                                          <span>{entry.drop.name.slice(0, 1)}</span>
                                        )}
                                      </span>
                                      <div className="farm-now-drop-copy">
                                        <span className="farm-now-drop-name">{entry.drop.name}</span>
                                        <div className="farm-now-drop-meta">
                                          <span className={`owned-relics-rarity owned-relics-rarity-${tone}`}>
                                            {entry.drop.rarity ?? 'Unknown'}
                                          </span>
                                          {entry.isNeeded ? (
                                            <>
                                              <span className="market-panel-badge tone-green">Needed</span>
                                              <span className="farm-now-drop-stat">
                                                Missing {entry.missingQuantity}
                                              </span>
                                              <span className="farm-now-drop-stat">
                                                {entry.coveredSetCount} set{entry.coveredSetCount === 1 ? '' : 's'}
                                              </span>
                                            </>
                                          ) : null}
                                        </div>
                                        {entry.isNeeded && entry.setNames.length ? (
                                          <span className="farm-now-drop-needed-sets">
                                            {entry.setNames.join(' · ')}
                                          </span>
                                        ) : null}
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
                )
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
      <SetCompletionScreenshotImportWarningModal
        open={screenshotImportGuidanceOpen}
        onClose={closeScreenshotImportGuidance}
        onContinue={continueScreenshotImportFromGuidance}
      />
      <SetCompletionScreenshotImportModal
        open={screenshotImportOpen}
        fileInputRef={screenshotFileInputRef}
        screenshots={screenshotImportScreenshots}
        processing={screenshotImportProcessing}
        scanning={screenshotImportScanning}
        confirming={screenshotImportConfirming}
        progress={screenshotImportProgress}
        errorMessage={screenshotImportError}
        reviewRows={resolvedScreenshotImportRows}
        hasReviewRows={screenshotImportHasReviewRows}
        hasBlockedRows={screenshotImportHasBlockedRows}
        candidateOptions={plannerCatalog}
        onClose={closeScreenshotImport}
        onPickFile={handleScreenshotFilePicked}
        onScan={handleScreenshotScan}
        onNameChange={handleScreenshotImportNameChange}
        onQuantityChange={handleScreenshotImportQuantityChange}
        onConfirm={handleConfirmScreenshotImport}
      />
    </>
  );
}
