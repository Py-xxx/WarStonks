import { useEffect, useMemo, useState } from 'react';
import {
  closeWfmSellOrder,
  createWfmBuyOrder,
  createWfmSellOrder,
  deleteWfmBuyOrder,
  deleteWfmSellOrder,
  getWfmAutocompleteItems,
  getWfmTradeOverview,
  updateWfmBuyOrder,
  updateWfmSellOrder,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue, formatTradeStatusLabel, getTradeStatusToneClass } from '../../lib/trades';
import { rankWfmAutocompleteItems } from '../../lib/wfmAutocomplete';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type {
  TradeCreateListingInput,
  TradeOverview,
  TradeSellOrder,
  TradeUpdateListingInput,
  WfmAutocompleteItem,
  SellerMode,
} from '../../types';

type ListingModalMode = 'create' | 'edit';
type TradeListingKind = 'sell' | 'buy';

interface ListingModalState {
  mode: ListingModalMode;
  orderType: TradeListingKind;
  orderId: string | null;
  selectedItem: WfmAutocompleteItem | null;
  itemName: string;
  price: string;
  quantity: string;
  rank: string;
  visible: boolean;
}

const DEFAULT_MARK_SOLD_QTY = '1';
const tradeOverviewCache = new Map<SellerMode, TradeOverview>();
const tradeOverviewLoadPromises = new Map<SellerMode, Promise<TradeOverview>>();

async function loadTradeOverviewSnapshot(sellerMode: SellerMode): Promise<TradeOverview> {
  const inFlight = tradeOverviewLoadPromises.get(sellerMode);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = getWfmTradeOverview(sellerMode)
    .then((overview) => {
      tradeOverviewCache.set(sellerMode, overview);
      return overview;
    })
    .finally(() => {
      if (tradeOverviewLoadPromises.get(sellerMode) === loadPromise) {
        tradeOverviewLoadPromises.delete(sellerMode);
      }
    });

  tradeOverviewLoadPromises.set(sellerMode, loadPromise);
  return loadPromise;
}

function buildItemFromOrder(order: TradeSellOrder): WfmAutocompleteItem {
  return {
    itemId: order.itemId ?? 0,
    wfmId: order.wfmId,
    name: order.name,
    slug: order.slug,
    maxRank: order.maxRank,
    itemFamily: null,
    imagePath: order.imagePath,
  };
}

function createListingModalState(
  mode: ListingModalMode,
  orderType: TradeListingKind,
  item: WfmAutocompleteItem | null,
  order?: TradeSellOrder,
): ListingModalState {
  const maxRank = item?.maxRank ?? order?.maxRank ?? null;
  const rankValue =
    maxRank && maxRank > 0
      ? String(order?.rank ?? 0)
      : '';

  return {
    mode,
    orderType: order?.orderType ?? orderType,
    orderId: order?.orderId ?? null,
    selectedItem: item,
    itemName: item?.name ?? order?.name ?? '',
    price: order ? String(order.yourPrice) : '',
    quantity: order ? String(order.quantity) : '1',
    rank: rankValue,
    visible: order?.visible ?? true,
  };
}

function isRankApplicable(item: WfmAutocompleteItem | null): boolean {
  return Boolean(item?.maxRank && item.maxRank > 0);
}

function formatGap(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${value > 0 ? '+' : ''}${value}p`;
}

function getGapClassName(value: number | null): string {
  if (value === null || value === undefined) {
    return 'neutral';
  }

  if (value > 0) {
    return 'bad';
  }

  if (value < 0) {
    return 'good';
  }

  return 'neutral';
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function TradeAvatar({ imageUrl, name }: { imageUrl: string | null; name: string }) {
  if (imageUrl) {
    return (
      <span className="trade-avatar">
        <img src={imageUrl} alt="" />
      </span>
    );
  }

  return <span className="trade-avatar fallback">{initialsForName(name)}</span>;
}

function ListingModal({
  form,
  suggestions,
  submitting,
  errorMessage,
  autocompleteReady,
  autocompleteError,
  onClose,
  onSubmit,
  onChange,
  onSelectItem,
}: {
  form: ListingModalState;
  suggestions: WfmAutocompleteItem[];
  submitting: boolean;
  errorMessage: string | null;
  autocompleteReady: boolean;
  autocompleteError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  onChange: (patch: Partial<ListingModalState>) => void;
  onSelectItem: (item: WfmAutocompleteItem) => void;
}) {
  const rankApplicable = isRankApplicable(form.selectedItem);
  const typeLocked = form.mode === 'edit';

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings-modal trade-listing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-listing-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Trades</span>
            <h3 id="trade-listing-modal-title">
              {form.mode === 'create'
                ? `Create ${form.orderType === 'sell' ? 'Sell' : 'Buy'} Listing`
                : `Edit ${form.orderType === 'sell' ? 'Sell' : 'Buy'} Listing`}
            </h3>
          </div>
          <button className="settings-close-btn" type="button" onClick={onClose} aria-label="Close listing modal">
            ×
          </button>
        </div>

        <div className="settings-modal-body trade-listing-modal-body">
          <div className="trade-listing-type-tabs" role="tablist" aria-label="Listing type">
            {(['sell', 'buy'] as TradeListingKind[]).map((type) => (
              <button
                key={type}
                className={`trade-listing-type-tab${form.orderType === type ? ' active' : ''}`}
                type="button"
                role="tab"
                aria-selected={form.orderType === type}
                disabled={typeLocked}
                onClick={() => onChange({ orderType: type })}
              >
                {type === 'sell' ? 'Sell' : 'Buy'}
              </button>
            ))}
          </div>
          <div className="trade-listing-fieldset">
            <label className="trade-listing-label" htmlFor="trade-listing-item">
              Item name
            </label>
            <input
              id="trade-listing-item"
              className="field-input"
              value={form.itemName}
              onChange={(event) => onChange({ itemName: event.target.value, selectedItem: null, rank: '' })}
              placeholder="Search local WFM catalog…"
              disabled={form.mode === 'edit'}
            />
            {form.mode === 'create' ? (
              <div className="trade-listing-autocomplete">
                {!autocompleteReady && !autocompleteError ? (
                  <div className="trade-listing-autocomplete-state">Loading catalog…</div>
                ) : null}
                {autocompleteError ? (
                  <div className="trade-listing-autocomplete-state error">{autocompleteError}</div>
                ) : null}
                {autocompleteReady && suggestions.length > 0 ? (
                  <div className="trade-listing-autocomplete-list">
                    {suggestions.map((item) => (
                      <button
                        key={item.wfmId ?? item.slug}
                        className="trade-listing-autocomplete-option"
                        type="button"
                        onClick={() => onSelectItem(item)}
                      >
                        <span className="trade-listing-autocomplete-thumb">
                          {resolveWfmAssetUrl(item.imagePath) ? (
                            <img src={resolveWfmAssetUrl(item.imagePath) ?? undefined} alt="" />
                          ) : (
                            <span>{item.name.slice(0, 1)}</span>
                          )}
                        </span>
                        <span className="trade-listing-autocomplete-copy">
                          <span className="trade-listing-autocomplete-name">{item.name}</span>
                          <span className="trade-listing-autocomplete-meta">
                            {item.itemFamily ?? 'Item'}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="trade-listing-grid">
            <div className="trade-listing-fieldset">
              <label className="trade-listing-label" htmlFor="trade-listing-price">
                Price
              </label>
              <input
                id="trade-listing-price"
                className="field-input"
                type="number"
                min={1}
                step={1}
                value={form.price}
                onChange={(event) => onChange({ price: event.target.value })}
                placeholder="Price"
              />
            </div>
            <div className="trade-listing-fieldset">
              <label className="trade-listing-label" htmlFor="trade-listing-quantity">
                Quantity
              </label>
              <input
                id="trade-listing-quantity"
                className="field-input"
                type="number"
                min={1}
                step={1}
                value={form.quantity}
                onChange={(event) => onChange({ quantity: event.target.value })}
                placeholder="Quantity"
              />
            </div>
            {rankApplicable ? (
              <div className="trade-listing-fieldset">
                <label className="trade-listing-label" htmlFor="trade-listing-rank">
                  Rank
                </label>
                <select
                  id="trade-listing-rank"
                  className="field-input"
                  value={form.rank}
                  onChange={(event) => onChange({ rank: event.target.value })}
                >
                  {Array.from({ length: (form.selectedItem?.maxRank ?? 0) + 1 }, (_, index) => (
                    <option key={index} value={String(index)}>
                      {index}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="trade-listing-fieldset trade-listing-toggle-field">
              <span className="trade-listing-label">Visibility</span>
              <button
                className={`trade-visibility-toggle${form.visible ? ' on' : ''}`}
                type="button"
                onClick={() => onChange({ visible: !form.visible })}
              >
                <span className="trade-visibility-toggle-track" />
                <span className="trade-visibility-toggle-copy">
                  {form.visible ? 'On' : 'Off'}
                </span>
              </button>
            </div>
          </div>

          {errorMessage ? <div className="trade-inline-error">{errorMessage}</div> : null}
        </div>

        <div className="settings-modal-actions">
          <button className="act-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="button" onClick={onSubmit} disabled={submitting}>
            {submitting
              ? 'Saving…'
              : form.mode === 'create'
                ? `Post ${form.orderType === 'sell' ? 'Sell' : 'Buy'} Order`
                : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SignInPanel() {
  const tradeAccountLoading = useAppStore((s) => s.tradeAccountLoading);
  const tradeAccountError = useAppStore((s) => s.tradeAccountError);
  const signInTradeAccount = useAppStore((s) => s.signInTradeAccount);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stayLoggedIn, setStayLoggedIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();
    if (!trimmedEmail || !trimmedPassword) {
      setLocalError('Enter both your Warframe Market email and password.');
      return;
    }

    setLocalError(null);
    try {
      await signInTradeAccount({
        email: trimmedEmail,
        password: trimmedPassword,
        stayLoggedIn,
      });
    } catch {
      // Store error is surfaced below.
    }
  };

  return (
    <div className="trade-auth-shell">
      <div className="trade-auth-card">
        <span className="card-label">Warframe Market</span>
        <h2 className="trade-auth-title">Sign in to manage your listings</h2>
        <p className="trade-auth-copy">
          WarStonks uses Warframe Market V1 sign-in to load your profile and sell orders.
          Once connected, this tab will let you create, edit, close, and remove listings.
        </p>

        <div className="trade-auth-grid">
          <label className="trade-listing-label" htmlFor="trade-signin-email">
            Email
          </label>
          <input
            id="trade-signin-email"
            className="field-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="your@email.com"
          />

          <label className="trade-listing-label" htmlFor="trade-signin-password">
            Password
          </label>
          <input
            id="trade-signin-password"
            className="field-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Warframe Market password"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleSubmit();
              }
            }}
          />
        </div>

        <div className="trade-auth-options">
          <div className="toggle-wrap">
            <button
              className={`toggle${stayLoggedIn ? ' on' : ''}`}
              type="button"
              aria-pressed={stayLoggedIn}
              onClick={() => setStayLoggedIn((current) => !current)}
            />
            <span>Stay Logged In</span>
          </div>
        </div>

        {localError || tradeAccountError ? (
          <div className="trade-inline-error">{localError ?? tradeAccountError}</div>
        ) : null}

        <div className="trade-auth-actions">
          <button className="btn-primary" type="button" onClick={() => void handleSubmit()} disabled={tradeAccountLoading}>
            {tradeAccountLoading ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HealthTab() {
  return (
    <div className="trade-placeholder-card">
      <span className="card-label">Trades</span>
      <h3>Listing Health</h3>
      <p>Health labels are visible in Sell Orders already, but backend health scoring is still pending.</p>
    </div>
  );
}

function ListingsTab({ listingType }: { listingType: TradeListingKind }) {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const sellerMode = useAppStore((s) => s.sellerMode);
  const autoWatchlistBuyOrdersEnabled = useAppStore((s) => s.autoWatchlistBuyOrdersEnabled);
  const setAutoWatchlistBuyOrdersEnabled = useAppStore((s) => s.setAutoWatchlistBuyOrdersEnabled);
  const signOutTradeAccount = useAppStore((s) => s.signOutTradeAccount);

  const [overview, setOverview] = useState<TradeOverview | null>(() => tradeOverviewCache.get(sellerMode) ?? null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null);
  const [listingModal, setListingModal] = useState<ListingModalState | null>(null);
  const [listingActionPending, setListingActionPending] = useState(false);
  const [listingActionError, setListingActionError] = useState<string | null>(null);
  const [soldQuantities, setSoldQuantities] = useState<Record<string, string>>({});

  const listingSuggestions = useMemo(
    () =>
      listingModal && listingModal.mode === 'create'
        ? rankWfmAutocompleteItems(autocompleteItems, listingModal.itemName, 6)
        : [],
    [autocompleteItems, listingModal],
  );

  useEffect(() => {
    if (!tradeAccount) {
      setOverview(null);
      setOverviewError(null);
      setOverviewLoading(false);
      return;
    }

    let cancelled = false;

    const loadOverview = async () => {
      const cachedOverview = tradeOverviewCache.get(sellerMode) ?? null;
      if (cachedOverview) {
        setOverview(cachedOverview);
      }
      setOverviewLoading(!cachedOverview);
      setOverviewError(null);
      try {
        const nextOverview = await loadTradeOverviewSnapshot(sellerMode);
        if (!cancelled) {
          setOverview(nextOverview);
          setOverviewError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setOverviewError(error instanceof Error ? error.message : String(error));
          void loadTradeAccount();
        }
      } finally {
        if (!cancelled) {
          setOverviewLoading(false);
        }
      }
    };

    void loadOverview();

    return () => {
      cancelled = true;
    };
  }, [tradeAccount, sellerMode]);

  useEffect(() => {
    if (!tradeAccount) {
      return;
    }

    let cancelled = false;

    const loadAutocomplete = async () => {
      setAutocompleteLoading(true);
      setAutocompleteError(null);
      try {
        const items = await getWfmAutocompleteItems();
        if (!cancelled) {
          setAutocompleteItems(items);
        }
      } catch (error) {
        if (!cancelled) {
          setAutocompleteError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setAutocompleteLoading(false);
        }
      }
    };

    void loadAutocomplete();

    return () => {
      cancelled = true;
    };
  }, [tradeAccount]);

  const applyOverview = (nextOverview: TradeOverview) => {
    tradeOverviewCache.set(sellerMode, nextOverview);
    setOverview(nextOverview);
    setOverviewError(null);
  };

  const openCreateListing = () => {
    setListingActionError(null);
    setListingModal(createListingModalState('create', listingType, null));
  };

  const openEditListing = (order: TradeSellOrder) => {
    setListingActionError(null);
    const item = buildItemFromOrder(order);
    setListingModal(createListingModalState('edit', order.orderType, item, order));
  };

  const closeListingModal = () => {
    if (listingActionPending) {
      return;
    }
    setListingActionError(null);
    setListingModal(null);
  };

  const handleListingModalSubmit = async () => {
    if (!listingModal) {
      return;
    }

    const selectedItem = listingModal.selectedItem;
    const price = Number.parseInt(listingModal.price, 10);
    const quantity = Number.parseInt(listingModal.quantity, 10);
    const rank = listingModal.rank === '' ? null : Number.parseInt(listingModal.rank, 10);

    if (!selectedItem) {
      setListingActionError('Select an item from the local catalog first.');
      return;
    }

    if (!selectedItem.wfmId) {
      setListingActionError('That item cannot be listed because its market id is unavailable.');
      return;
    }

    if (!Number.isInteger(price) || price <= 0) {
      setListingActionError('Price must be a whole number greater than zero.');
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setListingActionError('Quantity must be a whole number greater than zero.');
      return;
    }

    if (rank !== null && (!Number.isInteger(rank) || rank < 0)) {
      setListingActionError('Rank must be a whole number.');
      return;
    }

    setListingActionPending(true);
    setListingActionError(null);

    try {
      const nextOverview =
        listingModal.mode === 'create'
          ? await (listingModal.orderType === 'sell' ? createWfmSellOrder : createWfmBuyOrder)(
              {
                wfmId: selectedItem.wfmId,
                price,
                quantity,
                rank,
                visible: listingModal.visible,
              } satisfies TradeCreateListingInput,
              sellerMode,
            )
          : await (listingModal.orderType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder)(
              {
                orderId: listingModal.orderId ?? '',
                price,
                quantity,
                rank,
                visible: listingModal.visible,
              } satisfies TradeUpdateListingInput,
              sellerMode,
            );

      applyOverview(nextOverview);
      setListingModal(null);
    } catch (error) {
      setListingActionError(error instanceof Error ? error.message : String(error));
      void loadTradeAccount();
    } finally {
      setListingActionPending(false);
    }
  };

  const handleMarkAsSold = async (order: TradeSellOrder) => {
    const raw = soldQuantities[order.orderId] ?? DEFAULT_MARK_SOLD_QTY;
    const quantity = Number.parseInt(raw, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setOverviewError('Quantity to mark as sold must be a whole number greater than zero.');
      return;
    }

    try {
      const nextOverview = await closeWfmSellOrder(
        order.orderId,
        Math.min(quantity, order.quantity),
        sellerMode,
      );
      applyOverview(nextOverview);
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : String(error));
      void loadTradeAccount();
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    try {
      const nextOverview =
        listingType === 'sell'
          ? await deleteWfmSellOrder(orderId, sellerMode)
          : await deleteWfmBuyOrder(orderId, sellerMode);
      applyOverview(nextOverview);
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : String(error));
      void loadTradeAccount();
    }
  };

  const handleDisconnect = async () => {
    try {
      await signOutTradeAccount();
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!tradeAccount) {
    return <SignInPanel />;
  }

  const orders = listingType === 'sell' ? (overview?.sellOrders ?? []) : (overview?.buyOrders ?? []);

  return (
    <>
      <div className="trade-hero">
        <div className="trade-hero-main">
          <TradeAvatar imageUrl={overview?.account.avatarUrl ?? tradeAccount.avatarUrl} name={tradeAccount.name} />
          <div className="trade-hero-copy">
            <div className="trade-hero-title-row">
              <h2 className="trade-hero-title">{tradeAccount.name}</h2>
              <span className={`badge ${getTradeStatusToneClass(tradeAccount.status)}`}>
                {formatTradeStatusLabel(tradeAccount.status)}
              </span>
            </div>
            <div className="trade-hero-meta">
              <span>Last updated {formatShortLocalDateTime(overview?.lastUpdatedAt ?? tradeAccount.lastUpdatedAt)}</span>
              <span>Seller filter {sellerMode === 'ingame-online' ? 'Ingame + Online' : 'Ingame'}</span>
            </div>
          </div>
        </div>
        <div className="trade-hero-actions">
          <button className="btn-primary" type="button" onClick={openCreateListing}>
            Create {listingType === 'sell' ? 'Sell' : 'Buy'} Order
          </button>
          <button
            className={`trade-visibility-toggle${autoWatchlistBuyOrdersEnabled ? ' on' : ''}`}
            type="button"
            onClick={() => setAutoWatchlistBuyOrdersEnabled(!autoWatchlistBuyOrdersEnabled)}
            title="Automatically create and manage a linked buy order for watchlist items"
          >
            <span className="trade-visibility-toggle-track" />
            <span className="trade-visibility-toggle-copy">
              Auto Watchlist Buy {autoWatchlistBuyOrdersEnabled ? 'On' : 'Off'}
            </span>
          </button>
          <button className="btn-secondary" type="button" onClick={() => void handleDisconnect()}>
            Disconnect
          </button>
        </div>
      </div>

      <div className="stats-strip trade-stats-strip">
        <div className="stat-mini">
          <div className="stat-mini-label">Active Trade Value</div>
          <div className="stat-mini-val neutral">
            {overview ? formatPlatinumValue(overview.activeTradeValue) : '—'}
          </div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Completed Trades</div>
          <div className="stat-mini-val neutral">
            {overview?.totalCompletedTrades ?? '—'}
          </div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">Open Positions</div>
          <div className="stat-mini-val neutral">
            {overview?.openPositions ?? '—'}
          </div>
        </div>
      </div>

      {overviewError ? <div className="trade-inline-error">{overviewError}</div> : null}

      <div className="card trade-list-card">
        {overviewLoading && !overview ? (
          <div className="empty-state">
            <span className="empty-primary">
              Loading {listingType === 'sell' ? 'sell' : 'buy'} orders…
            </span>
            <span className="empty-sub">Warframe Market data is being synced for this account.</span>
          </div>
        ) : null}

        {!overviewLoading || overview ? (
          <table className="listing-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Your Price</th>
                <th>Market Low</th>
                <th>Price Gap</th>
                <th>Listing Health</th>
                <th>Quantity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderId}>
                  <td>
                    <div className="item-cell">
                      <span className="item-thumb trade-item-thumb">
                        {resolveWfmAssetUrl(order.imagePath) ? (
                          <img src={resolveWfmAssetUrl(order.imagePath) ?? undefined} alt="" />
                        ) : (
                          <span>{order.name.slice(0, 1)}</span>
                        )}
                      </span>
                      <div>
                        <div className="item-name">{order.name}</div>
                        <div className="item-id">
                          {order.slug}
                          {order.rank !== null ? ` · Rank ${order.rank}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="trade-cell-label">Your price</div>
                    <div className="trade-cell-value">{formatPlatinumValue(order.yourPrice)}</div>
                  </td>
                  <td>
                    <div className="trade-cell-label">Market low</div>
                    <div className="trade-cell-value">{formatPlatinumValue(order.marketLow)}</div>
                  </td>
                  <td>
                    <div className="trade-cell-label">Gap</div>
                    <div className={`trade-cell-value ${getGapClassName(order.priceGap)}`}>
                      {formatGap(order.priceGap)}
                    </div>
                  </td>
                  <td>
                    <div className="trade-health-stack">
                      <span className="badge badge-muted">Pending</span>
                      <span className="health-note">Backend health scoring not wired yet.</span>
                    </div>
                  </td>
                  <td>
                    <div className="trade-cell-value">{order.quantity}</div>
                  </td>
                  <td>
                    <div className="actions-cell trade-actions-cell">
                      {listingType === 'sell' ? (
                        <div className="trade-sold-action">
                          <input
                            className="qty-input"
                            type="number"
                            min={1}
                            max={order.quantity}
                            value={soldQuantities[order.orderId] ?? DEFAULT_MARK_SOLD_QTY}
                            onChange={(event) =>
                              setSoldQuantities((current) => ({
                                ...current,
                                [order.orderId]: event.target.value,
                              }))
                            }
                          />
                          <button className="act-btn" type="button" onClick={() => void handleMarkAsSold(order)}>
                            Mark as Sold
                          </button>
                        </div>
                      ) : null}
                      <button className="act-btn" type="button" onClick={() => openEditListing(order)}>
                        Edit
                      </button>
                      <button className="act-btn danger" type="button" onClick={() => void handleDeleteOrder(order.orderId)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {overview && orders.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <span className="empty-primary">
                        No {listingType === 'sell' ? 'sell' : 'buy'} orders
                      </span>
                      <span className="empty-sub">
                        Create a listing to start managing your live {listingType} orders.
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>

      {listingModal ? (
        <ListingModal
          form={listingModal}
          suggestions={listingSuggestions}
          submitting={listingActionPending}
          errorMessage={listingActionError}
          autocompleteReady={!autocompleteLoading}
          autocompleteError={autocompleteError}
          onClose={closeListingModal}
          onSubmit={() => void handleListingModalSubmit()}
          onChange={(patch) =>
            setListingModal((current) => (current ? { ...current, ...patch } : current))
          }
          onSelectItem={(item) =>
            setListingModal((current) =>
              current
                ? {
                    ...current,
                    selectedItem: item,
                    itemName: item.name,
                    rank: isRankApplicable(item) ? '0' : '',
                  }
                : current,
            )
          }
        />
      ) : null}
    </>
  );
}

export function TradesPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const tradesSubTab = useAppStore((s) => s.tradesSubTab);
  const setTradesSubTab = useAppStore((s) => s.setTradesSubTab);

  useEffect(() => {
    void loadTradeAccount();
  }, [loadTradeAccount]);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Trades</span>
          <span className={`subtab${tradesSubTab === 'sell-orders' ? ' active' : ''}`} onClick={() => setTradesSubTab('sell-orders')} role="tab" tabIndex={0}>
            Sell Orders
          </span>
          <span className={`subtab${tradesSubTab === 'buy-orders' ? ' active' : ''}`} onClick={() => setTradesSubTab('buy-orders')} role="tab" tabIndex={0}>
            Buy Orders
          </span>
          <span className={`subtab${tradesSubTab === 'health' ? ' active' : ''}`} onClick={() => setTradesSubTab('health')} role="tab" tabIndex={0}>
            Health
          </span>
        </div>
        {tradeAccount && (tradesSubTab === 'sell-orders' || tradesSubTab === 'buy-orders') ? (
          <div className="subnav-right">
            <span className="trade-subnav-hint">
              Live WFM {tradesSubTab === 'sell-orders' ? 'sell' : 'buy'} orders
            </span>
          </div>
        ) : null}
      </div>
      <div className="page-content">
        {!tradeAccount ? (
          <SignInPanel />
        ) : (
          <>
            {tradesSubTab === 'sell-orders' && <ListingsTab listingType="sell" />}
            {tradesSubTab === 'buy-orders' && <ListingsTab listingType="buy" />}
            {tradesSubTab === 'health' && <HealthTab />}
          </>
        )}
      </div>
    </>
  );
}
