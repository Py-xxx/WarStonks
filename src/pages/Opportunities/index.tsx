import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { InventorySubTab, OpportunitiesSubTab } from '../../lib/navigation';
import {
  applySetCompletionScreenshotImportRows,
  getArbitrageScannerState,
  getWfmAutocompleteItems,
  getSetCompletionOwnedItems,
  getSetCompletionOwnedItemPrices,
  setSetCompletionOwnedItemQuantity,
  syncOwnedItemsFromAlecaframe,
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
import { resolveRelicAssetUrl, resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { OpportunitiesOverview } from './Overview';
import { SetPlanner } from './SetPlanner';
import {
  PLANNER_SUMMARY_THRESHOLD,
  type PlannerOwnedRelicHint,
  type PlannerSetEntry,
  type SetPlannerGate,
} from './setPlannerModel';
import { FarmNow, type FarmNowSuggestion } from './FarmNow';
import {
  formatChance,
  formatPlat,
  relicRarityTone,
  relicRefinementTone,
  type FarmNowGate,
  type FarmNowRelicRow,
  type FarmNowSetCompletionDrop,
  type FarmNowSetCompletionRow,
  type RefinementGuidance,
  type RefinementMetric,
} from './farmNowModel';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import {
  clearWatchlistAddFeedbackTimeouts,
  markWatchlistAddFeedback,
} from '../../lib/watchlistAddFeedback';
import { PageHeading } from '../../components/PageHeading';
import { selectAlecaframeInventoryAvailable, useAppStore } from '../../stores/useAppStore';
import { AlecaframeInventoryPanel } from '../../components/AlecaframeInventory';
import { useModalA11y } from '../../hooks/useModalA11y';
import { useLocalizedName } from '../../hooks/useLocalizedName';
import { useItemQueryMatcher } from '../../hooks/useItemSearch';
import { tActive, useTranslation } from '../../i18n';
import { buildFarmingRelic, parseRelicTierCode } from '../../lib/farmingSession';
import {
  REFINEMENT_KEYS,
  computeDropOdds,
  type ChanceProfile,
  type RelicOddsInput,
} from '../../lib/relicDropOdds';
import type { TranslationKey } from '../../i18n/en';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerResponse,
  ArbitrageScannerState,
  OwnedRelicEntry,
  RelicRefinementChanceProfile,
  SetCompletionOwnedItem,
  WfmAutocompleteItem,
} from '../../types';

type OppTab =
  | 'opportunities'
  | 'farm-now'
  | 'set-planner'
  | 'owned-relics'
  | 'inventory'
  | 'prime-parts'
  | 'mods'
  | 'arcanes';
type FarmNowTab = 'part-profit' | 'set-completion';

const RELIC_REFINEMENT_COLUMNS = [
  { key: 'intact', labelKey: 'refine.intact' },
  { key: 'exceptional', labelKey: 'refine.exceptional' },
  { key: 'flawless', labelKey: 'refine.flawless' },
  { key: 'radiant', labelKey: 'refine.radiant' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];

/** A set counts as "meaningfully underway" for the summary strip when it's at least half owned
 *  by part count, OR the parts already owned are worth at least half the set's total part value
 *  (so owning one expensive part of a cheap-remainder set still qualifies). */

/** How many relics the odds panel lists inline before collapsing the rest into "+N more" —
 *  the full inventory is already in the relic rows below. */
type PlannerCatalogItem = {
  itemId: number | null;
  itemKey: string | null;
  slug: string;
  name: string;
  imagePath: string | null;
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
        itemKey: item.wfmId ?? null,
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

// Renders a translated sentence with one embedded phrase wrapped in <strong>, since the
// translation string itself is plain text and can't carry JSX markup.
function splitAroundEmphasis(sentence: string, emphasis: string, className?: string): ReactNode {
  const index = sentence.indexOf(emphasis);
  if (index === -1) {
    return sentence;
  }
  return (
    <>
      {sentence.slice(0, index)}
      <strong className={className}>{emphasis}</strong>
      {sentence.slice(index + emphasis.length)}
    </>
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  // Never surface "[object Object]" from a non-Error throw — fall back to friendly copy.
  return tActive('opp.somethingWentWrong');
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
    blockedReasons.push(row.matchReviewReason ?? tActive('opp.noMatch'));
  }

  if (quantity === null) {
    blockedReasons.push(row.quantityReviewReason ?? tActive('opp.invalidQuantity'));
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

function buildRefinementOrder(): { key: string; label: string }[] {
  return [
    { key: 'intact', label: tActive('refine.intact') },
    { key: 'exceptional', label: tActive('refine.exceptional') },
    { key: 'flawless', label: tActive('refine.flawless') },
    { key: 'radiant', label: tActive('refine.radiant') },
  ];
}

/**
 * Turns a per-refinement metric (plat-per-run for profit, % chance at a needed part for set
 * completion) into a recommendation: which refinement to run, and whether refining beyond Intact
 * is actually worth it.
 */
function buildRefinementGuidance(
  metrics: RefinementMetric[],
  unit: 'plat' | 'pct',
  subject = tActive('opp.chanceAtNeededPart'),
): RefinementGuidance {
  const best = metrics
    .filter((metric) => metric.value !== null)
    .reduce<RefinementMetric | null>(
      (acc, metric) => (acc === null || (metric.value ?? 0) > (acc.value ?? 0) ? metric : acc),
      null,
    );
  const intactValue = metrics.find((metric) => metric.key === 'intact')?.value ?? null;

  let hint = tActive('opp.runAnyRefinement');
  if (best) {
    if (best.key === 'intact' || intactValue === null) {
      hint =
        unit === 'plat'
          ? tActive('opp.intactFineLittle')
          : tActive('opp.intactChanceAt', { chance: formatChance(best.value), subject });
    } else {
      const delta = (best.value ?? 0) - intactValue;
      const worthRefining =
        unit === 'plat' ? delta >= 5 && (best.value ?? 0) >= intactValue * 1.15 : delta >= 5;
      if (worthRefining) {
        hint =
          unit === 'plat'
            ? tActive('opp.refineToBestPlat', { label: best.label, delta: Math.round(delta) })
            : tActive('opp.refineToBestPct', {
                label: best.label,
                best: formatChance(best.value),
                intact: formatChance(intactValue),
                subject,
              });
      } else {
        hint = tActive('opp.intactFineBarely');
      }
    }
  }

  // If the user owns none of the recommended refinement but does own another, surface it —
  // running what you already have often beats farming/refining fresh copies.
  let ownedNote: RefinementGuidance['ownedNote'] = null;
  if (best && (best.owned ?? 0) === 0) {
    const fallback = metrics
      .filter((metric) => metric.owned > 0 && metric.value !== null)
      .reduce<RefinementMetric | null>(
        (acc, metric) => (acc === null || (metric.value ?? 0) > (acc.value ?? 0) ? metric : acc),
        null,
      );
    if (fallback) {
      ownedNote = { count: fallback.owned, label: fallback.label };
    }
  }

  return {
    metrics,
    bestKey: best?.key ?? 'intact',
    bestLabel: best?.label ?? tActive('refine.intact'),
    hint,
    ownedNote,
  };
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
  const { t } = useTranslation();
  const modalRef = useModalA11y<HTMLDivElement>({ onClose, active: open });

  if (!open) {
    return null;
  }

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('a11y.closeImport')}
        onClick={onClose}
      />
      <div
        ref={modalRef}
        className="settings-modal screenshot-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('a11y.importPrimeComponents')}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('opp.setCompletionImport')}</span>
            <h3>
              Import Prime Components Screenshot{' '}
              <span className="scanner-run-pill scanner-run-pill-warning screenshot-import-experimental-pill">{t('opp.experimental')}</span>
            </h3>
          </div>
          <div className="settings-modal-actions">
            <button className="settings-close-btn" type="button" aria-label={t('a11y.close')} onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="settings-modal-body screenshot-import-body">
          <div className="settings-form-card screenshot-import-left">
            <div className="screenshot-import-example">
              <div className="screenshot-import-example-copy">
                <span className="panel-title-eyebrow">{t('opp.exampleOnly')}</span>
                <strong>{t('opp.framingReference')}</strong>
                <span>{t('opp.screenshotFramingHint')}</span>
              </div>
              <div className="screenshot-import-example-image">
                <img src={setCompletionImportExample} alt={t('opp.exampleScreenshotAlt')} />
              </div>
            </div>

            <div className="screenshot-import-toolbar">
              <button
                type="button"
                className="settings-primary-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={processing || confirming}
              >
                {processing ? t('opp.processing') : t('opp.chooseScreenshot')}
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
                {scanning ? t('opp.scanning') : t('opp.scan')}
              </button>
            </div>

            <p className="watchlist-form-note">
              {splitAroundEmphasis(t('opp.usePrimeComponentsTab', { tab: t('opp.primeComponents') }), t('opp.primeComponents'))}
            </p>
            <p className="watchlist-form-note">
              {splitAroundEmphasis(t('opp.screenshotWorkflowHint', { scan: t('opp.scan') }), t('opp.scan'))}
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
                      <span className="card-label">{t('opp.screenshotLabel', { n: index + 1 })}</span>
                      <strong>{screenshot.fileName}</strong>
                    </div>
                    <div className="screenshot-import-original-preview-shell">
                      <img
                        className="screenshot-import-original-image"
                        src={screenshot.previewUrl}
                        alt={t('opp.screenshotPreviewAlt', { n: index + 1 })}
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
                {t('opp.chooseScreenshots')}
              </div>
            )}
          </div>

          <div className="settings-form-card screenshot-import-right">
            <div className="screenshot-import-summary">
              <div>
                <span className="card-label">{t('opp.reviewMatches')}</span>
                <h3>{t('opp.detectedComponents')}</h3>
              </div>
              <div className="scanner-run-summary">
                <span className="scanner-run-pill scanner-run-pill-blue">
                  {t('opp.rowsCount', { n: reviewRows.length })}
                </span>
                {hasReviewRows ? (
                  <span className="scanner-run-pill scanner-run-pill-warning">{t('opp.needsReview')}</span>
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
                            <strong>{t('opp.matchedName')}</strong>
                            <span className="screenshot-import-row-source">
                              {t('opp.screenshotSourceLabel', { n: row.state.screenshotIndex + 1, fileName: row.state.screenshotFileName })}
                            </span>
                            <input
                              className="set-planner-search-input"
                              list="set-completion-screenshot-candidates"
                              type="text"
                              value={row.state.nameInput}
                              onChange={(event) => onNameChange(row.state.rowId, event.target.value)}
                              placeholder={row.state.suggestedMatch?.name ?? t('opp.selectValidComponent')}
                            />
                            <span>
                              O: {row.state.originalText || '—'} | P: {row.state.processedText || '—'}
                            </span>
                          </div>
                          <div className="screenshot-import-qty-field">
                            <span>{t('opp.quantity')}</span>
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
                {t('opp.uploadThenScan')}
              </div>
            )}

            <div className="screenshot-import-footer">
              <button type="button" className="settings-secondary-btn" onClick={onClose}>
                {t('opp.cancel')}
              </button>
              <button
                type="button"
                className="settings-primary-btn"
                disabled={processing || scanning || confirming || !reviewRows.length || hasBlockedRows}
                onClick={() => {
                  void onConfirm();
                }}
              >
                {confirming ? t('opp.confirming') : t('opp.confirm')}
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
  const { t } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('a11y.closeImportGuidance')}
        onClick={onClose}
      />
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('a11y.importRequirements')}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('opp.setCompletionImport')}</span>
            <h3>
              {t('opp.screenshotImportGuidanceTitle')}{' '}
              <span className="scanner-run-pill scanner-run-pill-warning screenshot-import-experimental-pill">{t('opp.experimental')}</span>
            </h3>
          </div>
          <div className="settings-modal-actions">
            <button className="settings-close-btn" type="button" aria-label={t('a11y.close')} onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="settings-modal-body">
          <div className="settings-form-card screenshot-import-guidance-card">
            <p className="watchlist-form-note screenshot-import-guidance-note">
              {splitAroundEmphasis(t('opp.vitruvianThemeOnly', { theme: 'Vitruvian' }), 'Vitruvian', 'screenshot-import-guidance-theme')}
            </p>
            <p className="watchlist-form-note screenshot-import-guidance-note">
              {splitAroundEmphasis(t('opp.cursorNotVisible', { notVisible: t('opp.notVisible') }), t('opp.notVisible'))}
            </p>
            <p className="watchlist-form-note screenshot-import-guidance-note">
              {splitAroundEmphasis(t('opp.gridMatchExample', { grid: t('opp.primeComponentsGrid') }), t('opp.primeComponentsGrid'))}
            </p>
            <div className="settings-form-actions">
              <button type="button" className="settings-secondary-btn" onClick={onClose}>
                {t('opp.cancel')}
              </button>
              <button type="button" className="settings-primary-btn" onClick={onContinue}>
                {t('opp.continue')}
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
  // Sub-view selection lives in the store, because the sidebar renders this page's
  // sub-navigation and cannot read component state. This component serves BOTH the Opportunities
  // and Inventory pages (via `mode`), and their tab sets are disjoint, so they get one store key
  // each rather than sharing one that would hold an id the other mode cannot render.
  const opportunitiesSubTab = useAppStore((state) => state.opportunitiesSubTab);
  const inventorySubTab = useAppStore((state) => state.inventorySubTab);
  const setOpportunitiesSubTab = useAppStore((state) => state.setOpportunitiesSubTab);
  const setInventorySubTab = useAppStore((state) => state.setInventorySubTab);
  const activeTab: OppTab = mode === 'inventory' ? inventorySubTab : opportunitiesSubTab;
  const setActiveTab = useCallback(
    (next: OppTab | ((current: OppTab) => OppTab)) => {
      if (mode === 'inventory') {
        setInventorySubTab(
          (typeof next === 'function' ? next(inventorySubTab) : next) as InventorySubTab,
        );
        return;
      }
      setOpportunitiesSubTab(
        (typeof next === 'function' ? next(opportunitiesSubTab) : next) as OpportunitiesSubTab,
      );
    },
    [mode, inventorySubTab, opportunitiesSubTab, setInventorySubTab, setOpportunitiesSubTab],
  );
  const localizeName = useLocalizedName();
  // Searches the localized name the row displays, not just the English name behind it.
  const matchesItem = useItemQueryMatcher();
  const { t } = useTranslation();

  // Honour a subtab request from an opportunity action button (e.g. a "Farm" action → farm-now).
  const requestedOpportunitiesTab = useAppStore((state) => state.requestedOpportunitiesTab);
  const requestedFarmNowSearch = useAppStore((state) => state.requestedFarmNowSearch);
  const clearRequestedOpportunitiesTab = useAppStore(
    (state) => state.clearRequestedOpportunitiesTab,
  );
  const requestOpportunitiesTab = useAppStore((state) => state.requestOpportunitiesTab);
  const requestTradeListing = useAppStore((state) => state.requestTradeListing);
  const startFarmingSession = useAppStore((state) => state.startFarmingSession);
  const startFarmingForItem = useAppStore((state) => state.startFarmingForItem);
  const activeFarmingRelicSlug = useAppStore(
    (state) => state.farmingSession?.cycle[state.farmingSession.activeIndex]?.relicSlug ?? null,
  );

  /**
   * Starts a session from a relic the user picked out of a list. The whole *currently displayed*
   * list becomes the cycle, in its current order — snapshotted now, so changing filters or sort
   * afterwards can't reorder what they're stepping through.
   */
  const beginFarmingRelic = (
    row: FarmNowRelicRow | FarmNowSetCompletionRow,
    visibleRows: Array<FarmNowRelicRow | FarmNowSetCompletionRow>,
  ) => {
    const ownedByKey = new Map(ownedRelics.map((relic) => [`${relic.tier}:${relic.code}`, relic]));
    const cycle = visibleRows.map((candidate) => {
      const parsed = parseRelicTierCode(candidate.relic.name);
      return buildFarmingRelic(
        candidate.relic,
        parsed ? ownedByKey.get(`${parsed.tier}:${parsed.code}`) : undefined,
        parsed?.tier ?? '',
        parsed?.code ?? '',
        { fallbackRefinement: candidate.guidance.bestKey },
      );
    });
    const activeIndex = Math.max(
      0,
      visibleRows.findIndex((candidate) => candidate.relic.slug === row.relic.slug),
    );
    startFarmingSession({ cycle, activeIndex, targetDropSlug: null, targetDropName: null });
  };

  // AlecaFrame replaces the manual inventory rather than supplementing it: when it's the
  // source, hand-edits would be silently overwritten at the next session boundary, so the
  // manual tab is swapped out entirely instead of left there to mislead.
  //
  // Availability is **both** halves: the file has to exist *and* the setting has to be on.
  // The backend already refuses to read AlecaFrame when the setting is off, so gating the UI
  // on the probe alone left the Prime Parts / Mods / Arcanes tabs in place, rendering nothing,
  // with the manual Inventory tab unreachable.
  // Probed once at app start (`useAlecaframeProbe`) rather than here, because the sidebar renders
  // this page's sub-items and needs the answer before the page is ever opened.
  const alecaframeInventoryAvailable = useAppStore(selectAlecaframeInventoryAvailable);

  // Toggling AlecaFrame swaps which inventory tabs exist, so a tab that was open can vanish
  // underneath the user. Move them to the equivalent tab in the other mode rather than
  // leaving them on a tab that renders nothing.
  useEffect(() => {
    setActiveTab((current) => {
      if (!alecaframeInventoryAvailable && (current === 'prime-parts' || current === 'mods' || current === 'arcanes')) {
        return 'inventory';
      }
      if (alecaframeInventoryAvailable && current === 'inventory') {
        return 'prime-parts';
      }
      return current;
    });
  }, [alecaframeInventoryAvailable]);

  const [farmNowSearch, setFarmNowSearch] = useState('');
  useEffect(() => {
    const validTabs: OppTab[] =
      mode === 'inventory'
        ? ['set-planner', 'inventory', 'prime-parts', 'mods', 'arcanes', 'owned-relics']
        : ['opportunities', 'farm-now'];
    if (requestedOpportunitiesTab && validTabs.includes(requestedOpportunitiesTab as OppTab)) {
      setActiveTab(requestedOpportunitiesTab as OppTab);
      if (requestedFarmNowSearch !== null) {
        setFarmNowSearch(requestedFarmNowSearch);
        // Arrived via a deep link ("Farm this item") — the query is already the intended one, so
        // don't pop the suggestion list over the results the user came here to see.
        setFarmNowSuggestOpen(false);
      }
      clearRequestedOpportunitiesTab();
    }
  }, [requestedOpportunitiesTab, requestedFarmNowSearch, mode, clearRequestedOpportunitiesTab]);
  const [farmNowSuggestOpen, setFarmNowSuggestOpen] = useState(false);
  const [farmNowTab, setFarmNowTab] = useState<FarmNowTab>('part-profit');
  const [farmNowEra, setFarmNowEra] = useState<string>('all');
  const [farmNowSort, setFarmNowSort] = useState<string>('default');
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
  // Owned relics live in the store now (persist across navigation; cooldown-gated refresh).
  const ownedRelics = useAppStore((state) => state.ownedRelics);
  const ownedRelicsLoading = useAppStore((state) => state.ownedRelicsLoading);
  const ownedRelicsRefreshing = useAppStore((state) => state.ownedRelicsRefreshing);
  const ownedRelicsError = useAppStore((state) => state.ownedRelicsError);
  const ownedRelicsCacheLoaded = useAppStore((state) => state.ownedRelicsCacheLoaded);
  const ownedRelicsUpdatedAt = useAppStore((state) => state.ownedRelicsUpdatedAt);
  const loadOwnedRelicsCache = useAppStore((state) => state.loadOwnedRelicsCache);
  const refreshOwnedRelics = useAppStore((state) => state.refreshOwnedRelics);
  const [expandedRelicKey, setExpandedRelicKey] = useState<string | null>(null);
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


  useEffect(() => {
    if (activeTab !== 'set-planner' && activeTab !== 'inventory') {
      return;
    }

    let cancelled = false;

    const loadPlannerState = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        // Refresh owned parts from AlecaFrame before reading them, so the planner reflects
        // the current inventory rather than a stale manual import. A null result means
        // AlecaFrame is off — the existing baseline is then left alone.
        await syncOwnedItemsFromAlecaframe().catch((error) => {
          // Not fatal — the planner still renders the stored baseline — but it must not be
          // silent, or a broken sync looks exactly like an unchanged inventory.
          console.error('[inventory] AlecaFrame owned-item sync failed', error);
          return null;
        });
        if (cancelled) {
          return;
        }

        const [scannerState, owned, autocompleteItems, ownedPrices] = await Promise.all([
          getArbitrageScannerState(),
          getSetCompletionOwnedItems(),
          getWfmAutocompleteItems(useAppStore.getState().language),
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

  // Relics: read the local cache once (instant, survives navigation), then ask for a cooldown-gated
  // AlecaFrame refresh. Reopening the Opportunities page is what triggers a refresh — never a tab
  // switch — and the 3-min cooldown in the store stops it hammering AlecaFrame.
  useEffect(() => {
    void loadOwnedRelicsCache();
    void refreshOwnedRelics(false);
  }, [loadOwnedRelicsCache, refreshOwnedRelics]);

  const plannerScanSource =
    activeTab === 'farm-now' ? farmNowScan ?? scannerResponse : scannerResponse ?? farmNowScan;

  const plannerCatalog = useMemo<PlannerCatalogItem[]>(() => {
    const bySlug = new Map<string, PlannerCatalogItem>();
    for (const setEntry of plannerScanSource?.results ?? []) {
      for (const component of setEntry.components) {
        if (!bySlug.has(component.slug)) {
          bySlug.set(component.slug, {
            itemId: null,
            itemKey: component.itemKey,
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
      const totalPartsNeeded = componentStates.reduce(
        (sum, component) => sum + component.component.quantityInSet,
        0,
      );
      const ownedPartsCount = componentStates.reduce(
        (sum, component) => sum + component.coveredQuantity,
        0,
      );

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

      // Value the owned parts against the whole set so a single expensive part counts for more
      // than its share of the part *count* (per-unit entry price is the value proxy we have).
      let ownedPartsValue = 0;
      let totalPartsValue = 0;
      for (const component of componentStates) {
        const unitValue = component.component.recommendedEntryPrice ?? 0;
        totalPartsValue += component.component.quantityInSet * unitValue;
        ownedPartsValue += component.coveredQuantity * unitValue;
      }
      const partCountRatio = totalPartsNeeded > 0 ? ownedPartsCount / totalPartsNeeded : 0;
      const ownedValueRatio = totalPartsValue > 0 ? ownedPartsValue / totalPartsValue : 0;

      computed.push({
        entry,
        ownedComponentCount,
        totalComponentCount,
        totalPartsNeeded,
        ownedPartsCount,
        remainingInvestment: normalizedRemainingInvestment,
        completionProfit,
        completionRoiPct,
        partCountRatio,
        ownedValueRatio,
        components: componentStates,
      });
    }

    return computed.sort((left, right) => {
      // Sort by quantity-weighted completion fraction — a 4/5 parts set outranks a 2/3 parts set.
      const leftRatio = left.partCountRatio;
      const rightRatio = right.partCountRatio;
      if (rightRatio !== leftRatio) {
        return rightRatio - leftRatio;
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

      // Only count sets you're genuinely underway on — half the parts, or half the value.
      const isUnderway =
        planner.partCountRatio >= PLANNER_SUMMARY_THRESHOLD ||
        planner.ownedValueRatio >= PLANNER_SUMMARY_THRESHOLD;
      if (!isUnderway) {
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
          drop.itemKey !== null ? `item:${drop.itemKey}` : null,
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
      if (!ownedEntry || (ownedEntry.counts.total ?? 0) <= 0) {
        continue; // one row per OWNED relic
      }

      // Expected plat per run at each refinement (chance × exit summed over drops).
      const metrics: RefinementMetric[] = buildRefinementOrder().map((refinement) => {
        let value: number | null = null;
        for (const drop of relic.drops) {
          const chance = chanceForRefinement(drop.chanceProfile, refinement.key);
          const exit = drop.recommendedExitPrice;
          if (chance !== null && exit !== null) {
            value = (value ?? 0) + (chance / 100) * exit;
          }
        }
        const owned = ownedEntry.counts[refinement.key as keyof OwnedRelicEntry['counts']] ?? 0;
        return {
          key: refinement.key,
          label: refinement.label,
          value: value === null ? null : Math.round(value),
          owned,
        };
      });
      const guidance = buildRefinementGuidance(metrics, 'plat');

      // Drop breakdown at the recommended refinement.
      let bestDropSlug: string | null = null;
      let bestValue = -1;
      const drops = relic.drops.map((drop) => {
        const chance = chanceForRefinement(drop.chanceProfile, guidance.bestKey);
        const exitPrice = drop.recommendedExitPrice;
        const expectedValue =
          chance !== null && exitPrice !== null ? (chance / 100) * exitPrice : null;
        if (expectedValue !== null && expectedValue > bestValue) {
          bestValue = expectedValue;
          bestDropSlug = drop.slug;
        }
        return { drop, chance, expectedValue };
      });

      const expectedProfit =
        metrics.find((metric) => metric.key === guidance.bestKey)?.value ?? null;

      rows.push({
        relic,
        tier: parsed?.tier ?? '',
        ownedCount: ownedEntry.counts.total ?? 0,
        expectedProfit,
        platPerHour: expectedProfit !== null ? expectedProfit * 12 : null,
        guidance,
        bestDropSlug,
        drops,
      });
    }

    return rows;
  }, [ownedRelics, farmNowScan]);

  // Search (relic name + drops) + era filter + sort — shared controls for the part-profit list.
  const displayedFarmNowRelics = useMemo(() => {
    const query = farmNowSearch.trim();
    let rows = farmNowRelics;
    if (query) {
      rows = rows.filter(
        (row) =>
          matchesItem(query, row.relic) ||
          row.drops.some((entry) => matchesItem(query, entry.drop)),
      );
      // Item-targeted mode: when the query matches a DROP (and not the relic's own name),
      // re-aim the refinement suggestion at that item — best refinement = highest chance of
      // pulling the searched part, not best overall plat per run. Searching a relic name
      // keeps the normal plat-per-run guidance.
      rows = rows.map((row) => {
        if (matchesItem(query, row.relic)) {
          return row;
        }
        const matchedDrops = row.drops.filter((entry) => matchesItem(query, entry.drop));
        if (matchedDrops.length === 0) {
          return row;
        }
        const metrics: RefinementMetric[] = buildRefinementOrder().map((refinement) => {
          let value: number | null = null;
          for (const entry of matchedDrops) {
            const chance = chanceForRefinement(entry.drop.chanceProfile, refinement.key);
            if (chance !== null) {
              value = (value ?? 0) + chance;
            }
          }
          const owned =
            row.guidance.metrics.find((metric) => metric.key === refinement.key)?.owned ?? 0;
          return {
            key: refinement.key,
            label: refinement.label,
            value: value === null ? null : Math.round(value * 10) / 10,
            owned,
          };
        });
        const targetName = localizeName(matchedDrops[0].drop);
        const guidance = buildRefinementGuidance(metrics, 'pct', `“${targetName}”`);
        let bestDropSlug = row.bestDropSlug;
        let bestChance = -1;
        for (const entry of matchedDrops) {
          const chance = chanceForRefinement(entry.drop.chanceProfile, guidance.bestKey);
          if (chance !== null && chance > bestChance) {
            bestChance = chance;
            bestDropSlug = entry.drop.slug;
          }
        }
        return { ...row, guidance, bestDropSlug, targetedDropName: targetName };
      });
    }
    if (farmNowEra !== 'all') {
      rows = rows.filter((row) => row.tier === farmNowEra);
    }
    const sorted = [...rows];
    sorted.sort((left, right) => {
      if (farmNowSort === 'owned' && right.ownedCount !== left.ownedCount) {
        return right.ownedCount - left.ownedCount;
      }
      // Default: best plat-per-hour first.
      const leftValue = left.platPerHour ?? Number.NEGATIVE_INFINITY;
      const rightValue = right.platPerHour ?? Number.NEGATIVE_INFINITY;
      if (rightValue !== leftValue) {
        return rightValue - leftValue;
      }
      return left.relic.name.localeCompare(right.relic.name);
    });
    return sorted;
  }, [farmNowRelics, farmNowSearch, farmNowEra, farmNowSort, localizeName, matchesItem]);

  /**
   * "Farm this item" odds: when the search targets a specific DROP, work out the real chance of
   * pulling it from the relics you actually hold, at the refinements you hold them in. Scanner
   * chances are percentages, so they're normalized to 0..1 for the odds math.
   */
  const farmNowDropOdds = useMemo(() => {
    const query = farmNowSearch.trim();
    if (!query) {
      return null;
    }

    const ownedByKey = new Map<string, OwnedRelicEntry>();
    for (const relic of ownedRelics) {
      ownedByKey.set(`${relic.tier}:${relic.code}`, relic);
    }

    const inputs: RelicOddsInput[] = [];
    let targetName: string | null = null;
    let targetSlug: string | null = null;
    let bestExitPrice: number | null = null;

    for (const row of farmNowRelics) {
      // Only drops matching the query — a relic-name match isn't item targeting.
      const matched = row.drops.filter((entry) => matchesItem(query, entry.drop));
      if (matched.length === 0) {
        continue;
      }
      const parsed = parseRelicTierCode(row.relic.name);
      const owned = parsed ? ownedByKey.get(`${parsed.tier}:${parsed.code}`) : undefined;
      if (!owned) {
        continue;
      }

      // Combine the per-refinement chance across every matching drop in this relic.
      const chances: ChanceProfile = {};
      for (const refinement of REFINEMENT_KEYS) {
        let total = 0;
        for (const entry of matched) {
          const chance = chanceForRefinement(entry.drop.chanceProfile, refinement);
          if (chance !== null) {
            total += chance / 100;
          }
        }
        chances[refinement] = total;
      }

      if (!targetName) {
        targetName = localizeName(matched[0].drop);
        targetSlug = matched[0].drop.slug;
      }
      for (const entry of matched) {
        if (entry.drop.recommendedExitPrice !== null) {
          bestExitPrice = Math.max(bestExitPrice ?? 0, entry.drop.recommendedExitPrice);
        }
      }

      inputs.push({
        label: `${parsed?.tier ?? ''} ${parsed?.code ?? row.relic.name}`.trim(),
        chances,
        counts: {
          intact: owned.counts.intact ?? 0,
          exceptional: owned.counts.exceptional ?? 0,
          flawless: owned.counts.flawless ?? 0,
          radiant: owned.counts.radiant ?? 0,
        },
      });
    }

    if (!targetName || inputs.length === 0) {
      return null;
    }
    const summary = computeDropOdds(inputs);
    if (summary.totalRelics === 0) {
      return null;
    }
    return { targetName, targetSlug: targetSlug ?? '', exitPrice: bestExitPrice, ...summary };
  }, [farmNowSearch, farmNowRelics, ownedRelics, localizeName, matchesItem]);

  /**
   * Autofill source for the farm-now search: every relic name plus every drop it can yield, so a
   * user can find "Bronco Prime Barrel" without knowing which relic carries it. Built from the
   * same scan the list renders from, so suggestions can never point at rows that don't exist.
   */
  const farmNowSuggestions = useMemo<FarmNowSuggestion[]>(() => {
    const query = farmNowSearch.trim();
    if (query.length < 2) {
      return [];
    }
    const relics = new Map<string, { label: string; kind: 'relic'; detail: string }>();
    const drops = new Map<string, { label: string; kind: 'drop'; detail: string }>();

    for (const row of farmNowRelics) {
      const relicName = localizeName(row.relic);
      if (matchesItem(query, row.relic) && !relics.has(relicName)) {
        relics.set(relicName, {
          label: relicName,
          kind: 'relic',
          detail: t('opp.ownedTimes', { n: row.ownedCount }),
        });
      }
      for (const entry of row.drops) {
        const dropName = localizeName(entry.drop);
        if (!matchesItem(query, entry.drop) || drops.has(dropName)) {
          continue;
        }
        drops.set(dropName, {
          label: dropName,
          kind: 'drop',
          detail: entry.drop.recommendedExitPrice != null
            ? formatPlat(entry.drop.recommendedExitPrice)
            : '',
        });
      }
    }

    // Drops first: searching for a part you need is the common case.
    return [...drops.values(), ...relics.values()].slice(0, 8);
  }, [farmNowSearch, farmNowRelics, localizeName, t, matchesItem]);

  const farmNowMissingComponents = useMemo(() => {
    const byKey = new Map<
      string,
      {
        missingQuantity: number;
        // Per set this component is missing from, the set's completion progress.
        sets: Map<string, { name: string; owned: number; total: number }>;
      }
    >();

    for (const planner of plannerEntries) {
      const progress = {
        name: planner.entry.name,
        owned: planner.ownedComponentCount,
        total: planner.totalComponentCount,
      };
      for (const component of planner.components) {
        if (component.missingQuantity <= 0) {
          continue;
        }

        const keys = [
          component.component.itemKey !== null ? `item:${component.component.itemKey}` : null,
          component.component.slug ? `slug:${component.component.slug}` : null,
        ].filter((value): value is string => Boolean(value));

        for (const key of keys) {
          const current = byKey.get(key) ?? {
            missingQuantity: 0,
            sets: new Map<string, { name: string; owned: number; total: number }>(),
          };
          current.missingQuantity += component.missingQuantity;
          current.sets.set(planner.entry.name, progress);
          byKey.set(key, current);
        }
      }
    }

    return byKey;
  }, [plannerEntries]);

  const farmNowSetCompletionRelics = useMemo<FarmNowSetCompletionRow[]>(() => {
    const relics = farmNowScan?.relicRoiResults ?? [];
    const ownedMap = new Map<string, OwnedRelicEntry>();
    for (const relic of ownedRelics) {
      ownedMap.set(`${relic.tier}:${relic.code}`, relic);
    }

    const ratio = (progress: { owned: number; total: number }) =>
      progress.total > 0 ? progress.owned / progress.total : 0;

    const rows: FarmNowSetCompletionRow[] = [];

    for (const relic of relics) {
      const parsedRelic = parseRelicTierCode(relic.name);
      const ownedEntry = parsedRelic
        ? ownedMap.get(`${parsedRelic.tier}:${parsedRelic.code}`)
        : undefined;
      const ownedCount = ownedEntry?.counts.total ?? 0;
      if (!ownedCount) {
        continue;
      }
      const coveredSetNames = new Set<string>();
      let rowBestProgress: { owned: number; total: number; name: string } | null = null;
      let completionScore = 0;

      const drops = relic.drops.map<FarmNowSetCompletionDrop>((drop) => {
        const neededMatch =
          (drop.itemKey !== null ? farmNowMissingComponents.get(`item:${drop.itemKey}`) : undefined) ??
          farmNowMissingComponents.get(`slug:${drop.slug}`);
        const setNames = neededMatch ? [...neededMatch.sets.keys()].sort() : [];
        for (const setName of setNames) {
          coveredSetNames.add(setName);
        }

        // The closest-to-complete set this drop helps — that's what we prioritise.
        let dropBest: { owned: number; total: number } | null = null;
        if (neededMatch) {
          for (const setProgress of neededMatch.sets.values()) {
            if (dropBest === null || ratio(setProgress) > ratio(dropBest)) {
              dropBest = { owned: setProgress.owned, total: setProgress.total };
            }
            if (rowBestProgress === null || ratio(setProgress) > ratio(rowBestProgress)) {
              rowBestProgress = {
                owned: setProgress.owned,
                total: setProgress.total,
                name: setProgress.name,
              };
            }
          }
          completionScore += dropBest ? ratio(dropBest) : 0;
        }

        return {
          drop,
          isNeeded: Boolean(neededMatch),
          missingQuantity: neededMatch?.missingQuantity ?? 0,
          coveredSetCount: setNames.length,
          setNames,
          bestSetProgress: dropBest,
        };
      });

      const neededDrops = drops.filter((drop) => drop.isNeeded);
      if (!neededDrops.length) {
        continue;
      }

      // Refinement guidance: chance your single reward is one of the NEEDED parts, per refinement.
      const metrics: RefinementMetric[] = buildRefinementOrder().map((refinement) => {
        let chanceSum: number | null = null;
        for (const needed of neededDrops) {
          const chance = chanceForRefinement(needed.drop.chanceProfile, refinement.key);
          if (chance !== null) {
            chanceSum = (chanceSum ?? 0) + chance;
          }
        }
        const owned = ownedEntry?.counts[refinement.key as keyof OwnedRelicEntry['counts']] ?? 0;
        return { key: refinement.key, label: refinement.label, value: chanceSum, owned };
      });
      const guidance = buildRefinementGuidance(metrics, 'pct');

      rows.push({
        relic,
        tier: parsedRelic?.tier ?? '',
        ownedCount,
        neededDropCount: neededDrops.length,
        totalMissingQuantity: neededDrops.reduce((sum, drop) => sum + drop.missingQuantity, 0),
        coveredSetCount: coveredSetNames.size,
        coveredSetNames: [...coveredSetNames].sort(),
        completionScore,
        bestSetProgress: rowBestProgress,
        guidance,
        drops,
      });
    }

    return rows;
  }, [farmNowScan, ownedRelics, farmNowMissingComponents]);

  const displayedFarmNowSetCompletionRelics = useMemo(() => {
    const query = farmNowSearch.trim();
    let rows = farmNowSetCompletionRelics;
    if (query) {
      rows = rows.filter(
        (row) =>
          matchesItem(query, row.relic) ||
          row.drops.some((entry) => matchesItem(query, entry.drop)),
      );
    }
    if (farmNowEra !== 'all') {
      rows = rows.filter((row) => row.tier === farmNowEra);
    }
    const sorted = [...rows];
    sorted.sort((left, right) => {
      if (farmNowSort === 'coverage' && right.coveredSetCount !== left.coveredSetCount) {
        return right.coveredSetCount - left.coveredSetCount;
      }
      if (farmNowSort === 'owned' && right.ownedCount !== left.ownedCount) {
        return right.ownedCount - left.ownedCount;
      }
      // Default: completion priority — relics that finish near-complete sets first.
      if (right.completionScore !== left.completionScore) {
        return right.completionScore - left.completionScore;
      }
      if (right.coveredSetCount !== left.coveredSetCount) {
        return right.coveredSetCount - left.coveredSetCount;
      }
      return left.relic.name.localeCompare(right.relic.name);
    });
    return sorted;
  }, [farmNowSetCompletionRelics, farmNowSearch, farmNowEra, farmNowSort, matchesItem]);

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
    const normalizedQuery = componentQuery.trim();
    if (!normalizedQuery) {
      return plannerCatalog;
    }
    return plannerCatalog.filter((item) => matchesItem(normalizedQuery, item));
  }, [componentQuery, plannerCatalog, matchesItem]);

  // Right panel: only the parts the user owns, filtered by the same search bar and
  // sorted by the user's chosen order (name A–Z, or value high→low).
  const filteredOwnedItems = useMemo(() => {
    const normalizedQuery = componentQuery.trim();
    const base = normalizedQuery
      ? ownedItems.filter((item) => matchesItem(normalizedQuery, item))
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
  }, [componentQuery, ownedItems, ownedSort, ownedItemPrices, matchesItem]);

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
  type OwnedQuantityItem = { itemKey: string | null; slug: string; name: string; imagePath: string | null };
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
          itemKey: item.itemKey,
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
          itemKey: item.itemKey,
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
      detail: t('opp.preparingScreenshotDetector'),
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
      itemKey: row.candidate?.itemKey ?? null,
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

  /**
   * "Sell Now" on a completed set — same route the Opportunities board's sell actions take:
   * hand the draft to the store, which switches to Trades → Orders and opens the create-order
   * form pre-filled. Price is the set's recommended exit; the form still lets you edit it.
   */
  const handleSellCompletedSet = (planner: PlannerSetEntry) => {
    const exitPrice = planner.entry.recommendedSetExitPrice;
    requestTradeListing({
      orderType: 'sell',
      name: planner.entry.name,
      slug: planner.entry.slug,
      rank: null,
      // A missing/zero exit price means we have no pricing for this set; leave the field empty
      // rather than pre-filling a 0p listing the user might not notice before posting.
      price: typeof exitPrice === 'number' && exitPrice > 0 ? Math.round(exitPrice) : null,
    });
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
    missingQuantity: number,
  ) => {
    if (!component.itemKey) {
      return;
    }

    const value = plannerTargetInputs[`${setSlug}:${component.slug}`] ?? buildPlannerDefaultTarget(component);
    const targetPrice = Number.parseInt(value, 10);
    if (!Number.isInteger(targetPrice) || targetPrice <= 0) {
      setErrorMessage(t('opp.enterPositiveWatchTarget'));
      return;
    }

    const watchlistItem: WfmAutocompleteItem = {
      itemId: 0,
      wfmId: component.itemKey,
      name: component.name,
      slug: component.slug,
      maxRank: null,
      itemFamily: 'prime-part',
      imagePath: component.imagePath,
      bulkTradable: false,
    };

    // Want only what's still missing — owning 1 of 2 should watch for 1, not 2.
    addExplicitItemToWatchlist(
      watchlistItem,
      'base',
      'Base Market',
      targetPrice,
      Math.max(1, missingQuantity),
    );
    markWatchlistAddFeedback(
      `${setSlug}:${component.slug}`,
      setWatchlistAddFeedback,
      watchlistAddFeedbackTimeoutsRef,
    );
  };

  const noScanAvailable = !loading && !(scannerResponse?.results?.length);

  /** The planner's gate, resolved once — same pattern as `farmNowGate`. Order is the shipped one:
   *  you cannot judge "no owned parts" before the scan that lists the sets exists. */
  const setPlannerGate = useMemo<SetPlannerGate>(() => {
    if (loading) return { kind: 'loading' };
    if (noScanAvailable) return { kind: 'noScan' };
    if (plannerEntries.length === 0) return { kind: 'noOwnedParts' };
    return { kind: 'ready' };
  }, [loading, noScanAvailable, plannerEntries.length]);
  const noFarmScan = !farmNowLoading && !(farmNowScan?.relicRoiResults?.length);

  /**
   * Everything that can stand between the user and a list of relics, resolved to one value.
   *
   * Order matters and is the shipped order: you cannot judge "no relics" before the scan exists,
   * and the inventory check is last because it only applies to set completion. This used to be a
   * nine-deep nested ternary written out once per mode; the *states* were all real, the
   * duplication was in rendering them.
   */
  const farmNowGate = useMemo<FarmNowGate>(() => {
    if (farmNowLoading) return { kind: 'loading' };
    if (noFarmScan) return { kind: 'noScan' };
    if (ownedRelicsLoading) return { kind: 'relicsLoading' };
    if (ownedRelicsError) return { kind: 'relicsError', message: ownedRelicsError };
    if (ownedRelicsCacheLoaded && !ownedRelicsUpdatedAt) return { kind: 'needsRelicLoad' };
    if (ownedRelics.length === 0) return { kind: 'noOwnedRelics' };
    // Set completion joins the planner inventory; part profit does not need it.
    if (farmNowTab === 'set-completion' && ownedItems.length === 0) return { kind: 'noInventory' };
    return { kind: 'ready' };
  }, [
    farmNowLoading,
    noFarmScan,
    ownedRelicsLoading,
    ownedRelicsError,
    ownedRelicsCacheLoaded,
    ownedRelicsUpdatedAt,
    ownedRelics.length,
    farmNowTab,
    ownedItems.length,
  ]);

  return (
    <>
      <PageHeading page={mode === 'inventory' ? 'inventory' : 'opportunities'} />

      <div className="page-content">
        {activeTab === 'set-planner' ? (
          <SetPlanner
            gate={setPlannerGate}
            errorMessage={errorMessage}
            entries={plannerEntries}
            expandedSlug={expandedSetSlug}
            onToggle={(slug) =>
              setExpandedSetSlug((current) => (current === slug ? null : slug))
            }
            summary={plannerPositiveSummary}
            targetInputs={plannerTargetInputs}
            ownedRelicHints={plannerOwnedRelicHints}
            recentlyAddedKeys={watchlistAddFeedback}
            onTargetChange={handlePlannerTargetChange}
            onAddToWatchlist={(component, setSlug, missingQuantity) =>
              handleAddMissingComponentToWatchlist(component, setSlug, missingQuantity)
            }
            // Jump to What to farm now with this part searched, so the odds panel immediately
            // shows what your relics give you for it.
            onFarmComponent={(component) => requestOpportunitiesTab('farm-now', component.name)}
            onSellSet={handleSellCompletedSet}
            onOpenScanners={() => setActivePage('scanners')}
            defaultTargetFor={buildPlannerDefaultTarget}
            localizeName={localizeName}
          />
        ) : activeTab === 'inventory' ? (
          <div className="inventory-manager">
            <div className="inventory-manager-searchbar">
              <div className="inventory-search-field">
                <span className="inventory-search-icon" aria-hidden="true">⌕</span>
                <input
                  className="inventory-search-input"
                  type="text"
                  placeholder={plannerCatalog.length ? t('opp.searchPrimeParts') : t('opp.loadingComponentCatalog')}
                  value={componentQuery}
                  onChange={(event) => setComponentQuery(event.target.value)}
                  disabled={!plannerCatalog.length}
                />
                {componentQuery ? (
                  <button
                    type="button"
                    className="inventory-search-clear"
                    onClick={() => setComponentQuery('')}
                    aria-label={t('a11y.clearSearch')}
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
                    <span className="panel-title-eyebrow">{t('opp.primeParts')}</span>
                    <h3>{t('opp.addToInventory')}</h3>
                  </div>
                </div>

                {!plannerCatalog.length ? (
                  <div className="inventory-empty">{t('opp.catalogLoading')}</div>
                ) : filteredCatalog.length === 0 ? (
                  <div className="inventory-empty">No prime parts match “{componentQuery.trim()}”.</div>
                ) : (
                  <div className="inventory-list">
                    {filteredCatalog.map((item) => {
                      const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
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
                          <span className="inventory-row-name" title={localizeName(item)}>{localizeName(item)}</span>
                          {ownedQty > 0 ? (
                            <div className="inventory-stepper">
                              <button
                                type="button"
                                className="inventory-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => adjustOwnedQuantity(item, ownedQty, -1)}
                                aria-label={t('opp.removeOne', { name: item.name })}
                              >
                                −
                              </button>
                              <span className="inventory-qty-value">{ownedQty}</span>
                              <button
                                type="button"
                                className="inventory-qty-button"
                                disabled={savingSlug === item.slug}
                                onClick={() => adjustOwnedQuantity(item, ownedQty, 1)}
                                aria-label={t('opp.addOne', { name: item.name })}
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
                              {t('common.add')}
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
                    <span className="panel-title-eyebrow">{t('opp.ownedInventory')}</span>
                    <h3>
                      {t('opp.partsCount', { n: ownedItems.length })}
                      {componentQuery.trim() ? ` · ${t('opp.shownCount', { n: filteredOwnedItems.length })}` : ''}
                    </h3>
                  </div>
                  {confirmingClear ? (
                    <div className="inventory-clear-confirm" role="alertdialog">
                      <span className="inventory-clear-confirm-msg">
                        {componentQuery.trim()
                          ? t('opp.deleteConfirmVisible', { n: filteredOwnedItems.length })
                          : t('opp.deleteConfirmAll', { n: filteredOwnedItems.length })}
                      </span>
                      <div className="inventory-clear-confirm-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setConfirmingClear(false)}
                        >
                          {t('opp.cancel')}
                        </button>
                        <button
                          type="button"
                          className="inventory-clear-confirm-delete"
                          disabled={clearingInventory}
                          onClick={() => { void clearFilteredOwnedItems(); }}
                        >
                          {clearingInventory ? t('opp.deleting') : t('opp.delete')}
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
                      {t('opp.clearFiltered')}
                    </button>
                  )}
                </div>

                {ownedItems.length > 0 ? (
                  <div className="inventory-owned-toolbar">
                    <span className="inventory-sort-label">{t('opp.sortBy')}</span>
                    <div className="inventory-sort-group">
                      <button
                        type="button"
                        className={`inventory-sort-btn${ownedSort === 'name' ? ' active' : ''}`}
                        onClick={() => setOwnedSort('name')}
                      >
                        {t('opp.sortName')}
                      </button>
                      <button
                        type="button"
                        className={`inventory-sort-btn${ownedSort === 'price' ? ' active' : ''}`}
                        onClick={() => setOwnedSort('price')}
                      >
                        {t('opp.sortValue')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {ownedItems.length === 0 ? (
                  <div className="inventory-empty">{t('opp.noOwnedParts')}</div>
                ) : filteredOwnedItems.length === 0 ? (
                  <div className="inventory-empty">No owned parts match “{componentQuery.trim()}”.</div>
                ) : (
                  <div className="inventory-list">
                    {filteredOwnedItems.map((item) => {
                      const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                      return (
                        <div key={item.slug} className="inventory-row is-owned">
                          <span className="inventory-thumb">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" loading="lazy" />
                            ) : (
                              <span>{item.name.slice(0, 1)}</span>
                            )}
                          </span>
                          <span className="inventory-row-name" title={localizeName(item)}>{localizeName(item)}</span>
                          <span
                            className={`inventory-row-value${ownedItemPrices[item.slug] == null ? ' unpriced' : ''}`}
                            title={t('a11y.recommendedExitPerUnit')}
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
                              aria-label={t('opp.removeOne', { name: item.name })}
                            >
                              −
                            </button>
                            <span className="inventory-qty-value">{item.quantity}</span>
                            <button
                              type="button"
                              className="inventory-qty-button"
                              disabled={savingSlug === item.slug}
                              onClick={() => adjustOwnedQuantity(item, item.quantity, 1)}
                              aria-label={t('opp.addOne', { name: item.name })}
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
              title={t('a11y.importFromScreenshot')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <span>{t('opp.importScreenshot')}</span>
              <span className="scanner-run-pill scanner-run-pill-warning inventory-import-fab-pill">{t('opp.beta')}</span>
            </button>
          </div>
        ) : activeTab === 'prime-parts' || activeTab === 'mods' || activeTab === 'arcanes' ? (
          <AlecaframeInventoryPanel tab={activeTab} />
        ) : activeTab === 'owned-relics' && alecaframeInventoryAvailable ? (
          // AlecaFrame knows the real relic counts per refinement, so it supersedes the
          // manually-imported view rather than sitting beside it.
          <AlecaframeInventoryPanel tab="relics" />
        ) : activeTab === 'owned-relics' ? (
          <div className="owned-relics-layout">
            <section className="market-panel owned-relics-panel">
              <div className="owned-relics-header">
                <div>
                  <span className="panel-title-eyebrow">{t('opp.ownedRelicsTitle')}</span>
                  <h3>{t('opp.relicInventory')}</h3>
                  <p>{t('opp.pullsAlecaframeDesc')}</p>
                </div>
                <div className="owned-relics-actions">
                  {ownedRelicsUpdatedAt ? (
                    <span className="owned-relics-updated">
                      {t('common.updatedAt', { time: formatShortLocalDateTime(ownedRelicsUpdatedAt) })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="market-refresh-button"
                    onClick={() => { void refreshOwnedRelics(true); }}
                    disabled={ownedRelicsLoading}
                    aria-label={t('a11y.refreshRelicInventory')}
                  >
                    ↻
                  </button>
                </div>
              </div>

              {ownedRelicsError ? <div className="scanner-inline-error">{ownedRelicsError}</div> : null}

              {/* Only show the blocking placeholder when there's nothing cached yet — otherwise
                  the cached relics stay on screen while a background refresh runs. */}
              {ownedRelicsLoading && ownedRelics.length === 0 ? (
                <div className="opportunities-placeholder">{t('opp.loadingRelicInventory')}</div>
              ) : ownedRelics.length === 0 ? (
                <div className="set-planner-empty">
                  <div>
                    <span className="panel-title-eyebrow">{t('opp.noRelicsFound')}</span>
                    <h3>{t('opp.inventoryEmpty')}</h3>
                    <p>{t('opp.relicsAlecaframeEmpty')}</p>
                  </div>
                </div>
              ) : (
                <div className="owned-relics-list">
                  {ownedRelics.map((relic) => {
                    const relicKey = `${relic.tier}:${relic.code}`;
                    const expanded = expandedRelicKey === relicKey;
                    const imageUrl = resolveRelicAssetUrl(relic) ?? resolveWfmAssetUrl(relic.imagePath);
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
                              <span className="farm-now-thumb owned-relics-thumb relic-art">
                                {imageUrl ? (
                                  <img src={imageUrl} alt="" loading="lazy" />
                                ) : (
                                  <span>{relic.name.slice(0, 1)}</span>
                                )}
                              </span>
                              <div className="farm-now-copy owned-relics-copy">
                                <strong>{localizeName(relic)}</strong>
                                <span className="farm-now-subtitle owned-relics-subtitle">
                                  {relic.tier} {relic.code}
                                </span>
                              </div>
                            </div>
                            <span className="farm-now-cell owned-relics-cell-total">
                              <span className="owned-relics-total-label">{t('opp.total')}</span>
                              <strong>{relic.counts.total}</strong>
                            </span>
                            <div className="farm-now-cell owned-relics-refinement-pills">
                              {RELIC_REFINEMENT_COLUMNS.filter(
                                (column) => relic.counts[column.key] > 0,
                              ).map((column) => (
                                <span
                                  key={`${relicKey}-${column.key}`}
                                  className={`relic-refinement-pill relic-refinement-pill-${relicRefinementTone(column.key)}`}
                                >
                                  {t(column.labelKey)} · {relic.counts[column.key]}
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
                              <div className="owned-relics-empty">{t('opp.noDropData')}</div>
                            ) : (
                              <div className="owned-relics-drop-grid">
                                {relic.drops.map((drop) => {
                                  const dropImage = resolveWfmAssetUrl(drop.imagePath, drop.slug);
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
                                        <span className="owned-relics-drop-name">{localizeName(drop)}</span>
                                        <span className={`owned-relics-rarity owned-relics-rarity-${tone}`}>
                                          {drop.rarity ?? t('opp.unknown')}
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
          <FarmNow
            mode={farmNowTab}
            onModeChange={(next) => {
              setFarmNowTab(next);
              // Sort options differ per mode, so a sort carried across leaves the control
              // showing an order the list is not using (`coverage` has no meaning for part
              // profit and silently fell through to the default).
              setFarmNowSort('default');
            }}
            search={farmNowSearch}
            onSearchChange={setFarmNowSearch}
            suggestions={farmNowSuggestions}
            suggestOpen={farmNowSuggestOpen}
            onSuggestOpenChange={setFarmNowSuggestOpen}
            era={farmNowEra}
            onEraChange={setFarmNowEra}
            sort={farmNowSort}
            onSortChange={setFarmNowSort}
            ownedRelicTotal={ownedRelicTotal}
            setsInProgress={farmNowSetCompletionSetCount}
            missingComponentCount={farmNowSetCompletionMissingCount}
            relicsWorthRunning={farmNowRelics.length}
            bestRunProfit={farmNowRelics[0]?.expectedProfit ?? null}
            lastScan={farmNowLastScan}
            relicsRefreshing={ownedRelicsRefreshing}
            onRunScan={() => setActivePage('scanners')}
            dropOdds={farmNowDropOdds}
            onFarmItem={(slug, name) => void startFarmingForItem(slug, name)}
            gate={farmNowGate}
            errorMessage={farmNowError}
            partRows={displayedFarmNowRelics}
            setRows={displayedFarmNowSetCompletionRelics}
            expandedKey={expandedFarmRelicKey}
            onToggleExpanded={(key) =>
              setExpandedFarmRelicKey((current) => (current === key ? null : key))
            }
            activeFarmingRelicSlug={activeFarmingRelicSlug}
            onFarmPartRelic={(row) => beginFarmingRelic(row, displayedFarmNowRelics)}
            onFarmSetRelic={(row) =>
              beginFarmingRelic(row, displayedFarmNowSetCompletionRelics)
            }
            onOpenScanners={() => setActivePage('scanners')}
            onRetryRelics={() => void refreshOwnedRelics(true)}
            onOpenOwnedRelics={() => setActiveTab('owned-relics')}
            onOpenInventory={() => setActivePage('inventory')}
            localizeName={localizeName}
          />
        ) : (
          /* `opportunities` is the only remaining tab, and every other branch above is
             exhaustive — the old fallback was an unreachable untranslated sentence. */
          <OpportunitiesOverview />
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
