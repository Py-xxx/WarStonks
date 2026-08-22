import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';

import { ItemThumb } from '../../components/ListRow';
import { useTranslation } from '../../i18n';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';

/**
 * Inventory → Inventory: the manual parts list, used when AlecaFrame is not connected.
 *
 * A **structural migration only** — same two columns, same controls, same behaviour, rebuilt on the
 * primitives so it stops rendering UA-styled inputs and buttons. Deliberately not redesigned: it is
 * the fallback path for users without AlecaFrame, and the automatic tabs are where the effort goes.
 */

export type ManualInventoryItem = {
  /** Carried through to the save path, which persists against the catalog key, not the slug. */
  itemKey: string | null;
  slug: string;
  name: string;
  imagePath: string | null;
};

export type ManualInventoryOwnedItem = ManualInventoryItem & { quantity: number };

export type ManualInventoryProps = {
  query: string;
  onQueryChange: (value: string) => void;
  catalogLoaded: boolean;

  catalog: ManualInventoryItem[];
  filteredCatalog: ManualInventoryItem[];
  ownedItems: ManualInventoryOwnedItem[];
  filteredOwnedItems: ManualInventoryOwnedItem[];
  ownedQuantityFor: (slug: string) => number;
  ownedPrices: Record<string, number | null>;

  sort: 'name' | 'price';
  onSortChange: (sort: 'name' | 'price') => void;

  savingSlug: string | null;
  onAdjustQuantity: (item: ManualInventoryItem, baseQuantity: number, delta: number) => void;

  confirmingClear: boolean;
  clearing: boolean;
  onRequestClear: () => void;
  onCancelClear: () => void;
  onConfirmClear: () => void;

  onImportScreenshot: () => void;

  errorMessage: string | null;
  localizeName: (item: { name: string; slug?: string | null }) => string;
};

/** −/n/+ around a count. The two buttons are icon-only and repeat on every row, so they are the
 *  density exception: 24px targets in a 32px row, not the 40px standalone minimum. */
function QuantityStepper({
  quantity,
  disabled,
  onAdjust,
  itemName,
}: {
  quantity: number;
  disabled: boolean;
  onAdjust: (delta: number) => void;
  itemName: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-bg-base p-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        static
        disabled={disabled}
        onClick={() => onAdjust(-1)}
        aria-label={t('opp.removeOne', { name: itemName })}
        className="size-6 rounded-sm"
      >
        <i className="ti ti-minus text-[12px]" aria-hidden="true" />
      </Button>
      <span className="w-6 text-center font-mono text-xs font-bold text-ink tabular-nums">
        {quantity}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        static
        disabled={disabled}
        onClick={() => onAdjust(1)}
        aria-label={t('opp.addOne', { name: itemName })}
        className="size-6 rounded-sm"
      >
        <i className="ti ti-plus text-[12px]" aria-hidden="true" />
      </Button>
    </div>
  );
}

function ItemRow({
  item,
  owned,
  children,
  localizeName,
}: {
  item: ManualInventoryItem;
  owned: boolean;
  children: React.ReactNode;
  localizeName: (item: { name: string; slug?: string | null }) => string;
}) {
  const label = localizeName(item);
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 ${
        owned ? 'border-accent-green/25 bg-accent-green/[0.04]' : 'border-line-subtle bg-bg-panel'
      }`}
    >
      <ItemThumb
        src={resolveWfmAssetUrl(item.imagePath, item.slug)}
        fallback={item.name.slice(0, 1)}
        size="size-7"
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink" title={label}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function ManualInventory(props: ManualInventoryProps) {
  const { t } = useTranslation();
  const query = props.query.trim();

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* One search box drives both columns — it filters what you can add and what you own, which
          is what makes "clear filtered" meaningful. */}
      <div className="relative">
        <i
          className="ti ti-search pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-faint"
          aria-hidden="true"
        />
        <Input
          type="search"
          className="h-9 pl-8"
          placeholder={
            props.catalogLoaded ? t('opp.searchPrimeParts') : t('opp.loadingComponentCatalog')
          }
          value={props.query}
          disabled={!props.catalogLoaded}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        {props.query ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('a11y.clearSearch')}
            onClick={() => props.onQueryChange('')}
            className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-ink-faint"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {props.errorMessage ? (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
          {props.errorMessage}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Catalogue — what you can add. */}
        <Panel className="gap-0">
          <PanelHeader>
            <PanelTitle variant="heading">{t('opp.addToInventory')}</PanelTitle>
          </PanelHeader>
          <div className="p-3">
            {!props.catalogLoaded ? (
              <EmptyState icon="ti-database" title={t('opp.catalogLoading')} />
            ) : props.filteredCatalog.length === 0 ? (
              <EmptyState icon="ti-search-off" title={t('opp.noPartsMatch', { query })} />
            ) : (
              <div className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto overscroll-contain">
                {props.filteredCatalog.map((item) => {
                  const owned = props.ownedQuantityFor(item.slug);
                  return (
                    <ItemRow
                      key={item.slug}
                      item={item}
                      owned={owned > 0}
                      localizeName={props.localizeName}
                    >
                      {owned > 0 ? (
                        <QuantityStepper
                          quantity={owned}
                          disabled={props.savingSlug === item.slug}
                          onAdjust={(delta) => props.onAdjustQuantity(item, owned, delta)}
                          itemName={item.name}
                        />
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={props.savingSlug === item.slug}
                          onClick={() => props.onAdjustQuantity(item, 0, 1)}
                          className="h-7 shrink-0 border-line text-[11px]"
                        >
                          <i className="ti ti-plus" aria-hidden="true" />
                          {t('common.add')}
                        </Button>
                      )}
                    </ItemRow>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        {/* Owned — what you have, and what it is worth. */}
        <Panel className="gap-0">
          <PanelHeader className="flex-wrap gap-2">
            <PanelTitle variant="heading">
              {t('opp.partsCount', { n: props.ownedItems.length })}
            </PanelTitle>
            {query ? (
              <span className="font-mono text-[10px] text-ink-dim tabular-nums">
                {t('opp.shownCount', { n: props.filteredOwnedItems.length })}
              </span>
            ) : null}

            <span className="ml-auto flex items-center gap-2">
              {props.confirmingClear ? (
                // The consequence goes in the question and the verb on the button, so there is no
                // "are you sure" to read past.
                <span className="flex items-center gap-2" role="alertdialog" aria-label={t('opp.delete')}>
                  <span className="text-[11px] text-ink-soft">
                    {query
                      ? t('opp.deleteConfirmVisible', { n: props.filteredOwnedItems.length })
                      : t('opp.deleteConfirmAll', { n: props.filteredOwnedItems.length })}
                  </span>
                  <Button variant="ghost" size="sm" onClick={props.onCancelClear}>
                    {t('opp.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={props.clearing}
                    onClick={props.onConfirmClear}
                  >
                    {props.clearing ? t('opp.deleting') : t('opp.delete')}
                  </Button>
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.clearing || props.filteredOwnedItems.length === 0}
                  onClick={props.onRequestClear}
                >
                  {t('opp.clearFiltered')}
                </Button>
              )}
            </span>
          </PanelHeader>

          {props.ownedItems.length > 0 ? (
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <span className="font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
                {t('opp.sortBy')}
              </span>
              {(
                [
                  ['name', t('opp.sortName')],
                  ['price', t('opp.sortValue')],
                ] as const
              ).map(([id, label]) => {
                const active = props.sort === id;
                return (
                  <Button
                    key={id}
                    variant="ghost"
                    size="sm"
                    static
                    aria-pressed={active}
                    onClick={() => props.onSortChange(id)}
                    className={`h-7 rounded-md px-2.5 text-[11px] font-medium ${
                      active
                        ? 'bg-bg-elevated text-ink'
                        : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                    }`}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          ) : null}

          <div className="p-3">
            {props.ownedItems.length === 0 ? (
              <EmptyState
                icon="ti-box"
                title={t('opp.noOwnedParts')}
                action={
                  <Button variant="secondary" size="sm" onClick={props.onImportScreenshot}>
                    <i className="ti ti-photo" aria-hidden="true" />
                    {t('opp.importScreenshot')}
                  </Button>
                }
              />
            ) : props.filteredOwnedItems.length === 0 ? (
              <EmptyState icon="ti-search-off" title={t('opp.noOwnedPartsMatch', { query })} />
            ) : (
              <div className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto overscroll-contain">
                {props.filteredOwnedItems.map((item) => {
                  const price = props.ownedPrices[item.slug];
                  return (
                    <ItemRow key={item.slug} item={item} owned localizeName={props.localizeName}>
                      <span
                        className={`shrink-0 font-mono text-[11px] tabular-nums ${
                          price == null ? 'text-ink-faint' : 'text-ink-soft'
                        }`}
                        title={t('a11y.recommendedExitPerUnit')}
                      >
                        {price == null ? '—' : `${Math.round(price)}p`}
                      </span>
                      <QuantityStepper
                        quantity={item.quantity}
                        disabled={props.savingSlug === item.slug}
                        onAdjust={(delta) => props.onAdjustQuantity(item, item.quantity, delta)}
                        itemName={item.name}
                      />
                    </ItemRow>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* Was a floating FAB over the page. It is one of two ways to fill this list, so it belongs
          with the list rather than hovering above it — and the empty state offers it too, which is
          where a first-time user actually needs it. */}
      <div className="flex justify-center">
        <Button
          variant="outline"
          size="sm"
          disabled={!props.catalogLoaded}
          onClick={props.onImportScreenshot}
        >
          <i className="ti ti-photo" aria-hidden="true" />
          {t('opp.importScreenshot')}
          <span className="rounded bg-accent-amber/15 px-1 py-px font-mono text-[9px] font-semibold text-accent-amber">
            {t('opp.beta')}
          </span>
        </Button>
      </div>
    </div>
  );
}
