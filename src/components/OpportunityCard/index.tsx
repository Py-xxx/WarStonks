import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { formatElapsedTime } from '../../lib/dateTime';
import { tHealth } from '../../lib/healthLabels';
import { copyWhisperMessage } from '../../lib/marketMessages';
import {
  confidenceTone,
  formatPlatinumDelta,
  opportunityTone,
  valueBasisKey,
  type ConfidenceTone,
  type OpportunityTone,
} from '../../lib/opportunityView';
import type { Opportunity, OpportunityAction } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useLocalizedParams } from '../../hooks/useLocalizedParams';
import { useAppStore } from '../../stores/useAppStore';

/**
 * The full-anatomy `Opportunity` card, and every presentation rule the compressed views share.
 *
 * There are two surfaces rendering these objects — the Opportunities board and Home's "Act now"
 * queue — and they had drifted into two implementations: the board in `.opp-*` legacy CSS with
 * inline SVG icons, Home in Tailwind with the Tabler icon font. Each had rules the other lacked.
 * The board translated its confidence label and Home did not; Home resolved nothing through
 * `resolveWfmAssetUrl` and so showed no art at all; **Home's action chips had no click handler,
 * so every one of them did nothing.** None of that is visible to types or to a rendering test.
 *
 * So: one card, one action router, one set of tone maps. Home stays compressed — that split is
 * settled and deliberate — but it composes the same parts rather than re-deriving them.
 */

/**
 * Tone follows the shipped board exactly: category decides the colour, except that `expiring`
 * overrides everything to amber — the `.opp-card.is-urgent` rule, which exists because a play
 * that vanishes if ignored outranks what kind of play it is.
 *
 * Note this is why urgency does NOT map to red: red is `reprice`'s colour on the board.
 */
export function toneFor(opportunity: Opportunity): OpportunityTone {
  return opportunity.urgency === 'expiring' ? 'amber' : opportunityTone(opportunity.category);
}

export const TONE_CLASS: Record<OpportunityTone, string> = {
  red: 'border-l-accent-red bg-accent-red/[0.06]',
  green: 'border-l-accent-green bg-accent-green/[0.05]',
  amber: 'border-l-accent-amber bg-accent-amber/[0.05]',
  purple: 'border-l-accent-purple bg-accent-purple/[0.05]',
  blue: 'border-l-accent-blue bg-accent-blue/[0.05]',
};

/**
 * Card tone: the 3px left border only, ported from `.opp-card-*`.
 *
 * Deliberately NOT `TONE_CLASS`. A row is a stripe on the panel ground, so it needs a tint to read
 * as its own object; a card already has a border and a lighter ground, and a tint on top of both
 * makes the accent compete with the border for the same job. The shipped card spent the colour on
 * the left edge alone, and it was right.
 */
export const CARD_TONE_CLASS: Record<OpportunityTone, string> = {
  red: 'border-l-accent-red',
  green: 'border-l-accent-green',
  amber: 'border-l-accent-amber',
  purple: 'border-l-accent-purple',
  blue: 'border-l-accent-blue',
};

export const BADGE_CLASS: Record<OpportunityTone, string> = {
  red: 'bg-accent-red/15 text-accent-red',
  green: 'bg-accent-green/15 text-accent-green',
  amber: 'bg-accent-amber/15 text-accent-amber',
  purple: 'bg-accent-purple/15 text-accent-purple',
  blue: 'bg-accent-blue/15 text-accent-blue',
};

/** Ported from `.opp-conf-*`, and pinned against it by `opportunityView.test.ts`. */
const CONFIDENCE_CLASS: Record<ConfidenceTone, string> = {
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  muted: 'text-ink-faint',
};

/** Glyph plus a one-word verb per action kind.
 *
 *  Unlike the watchlist — where the same three actions repeat on every row and are learnable as
 *  icons alone — the queue's actions differ per row, so the glyph alone leaves you guessing
 *  whether `ti-tag` means reprice or list. One word resolves it without spending the width a
 *  full label would. The tooltip still carries the item and price. */
export const ACTION_ICON: Record<string, string> = {
  copyWhisper: 'ti-copy',
  buyPart: 'ti-shopping-cart',
  viewItem: 'ti-chart-line',
  sellPart: 'ti-tag',
  sellSet: 'ti-tag',
  farmRelic: 'ti-map-pin',
  editOrder: 'ti-pencil',
  openWfm: 'ti-external-link',
};

export const ACTION_WORD: Record<string, TranslationKey> = {
  copyWhisper: 'home.actWhisper',
  buyPart: 'home.actBuy',
  viewItem: 'home.actOpen',
  sellPart: 'home.actSell',
  sellSet: 'home.actSell',
  farmRelic: 'home.actFarm',
  editOrder: 'home.actOpen',
  openWfm: 'home.actOpen',
};

/** Reason glyphs, mapping the backend's `reason.icon` onto our icon font. The shipped board drew
 *  these as inline SVG at a different stroke weight from everything around them; Tabler keeps one
 *  icon system per screen. */
export const REASON_ICON: Record<string, string> = {
  inventory: 'ti-box',
  market: 'ti-chart-line',
  relics: 'ti-diamond',
  math: 'ti-calculator',
};

/**
 * What an action button does. Every action stays **inside** WarStonks — open the right page or
 * flow, never leave for the website.
 *
 * A hook rather than a component, because the compressed row and the full card draw different
 * chips around identical behaviour, and duplicating this switch is how Home ended up with chips
 * that routed nowhere.
 */
export function useOpportunityAction(action: OpportunityAction): () => void {
  const requestTradeListing = useAppStore((state) => state.requestTradeListing);
  const requestOpportunitiesTab = useAppStore((state) => state.requestOpportunitiesTab);
  const openItemAnalysis = useAppStore((state) => state.openItemAnalysis);
  const openItemInQuickView = useAppStore((state) => state.openItemInQuickView);
  const setActivePage = useAppStore((state) => state.setActivePage);
  const setTradesSubTab = useAppStore((state) => state.setTradesSubTab);
  const pushToast = useAppStore((state) => state.pushToast);
  const { t } = useTranslation();

  return () => {
    switch (action.kind) {
      case 'buyPart':
        // Buying means finding a seller, and the live sell orders are in Market's Quick View.
        if (action.itemName) {
          void openItemInQuickView({ name: action.itemName, slug: action.itemSlug }, 'market');
        }
        break;
      case 'viewItem':
        // "View analysis" means the deep market view, not the summary.
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
            .then(() => pushToast(t('opp.whisperCopied'), 'success'))
            .catch(() => pushToast(t('opp.whisperCopyFailed'), 'error'));
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
}

/**
 * The full chip: verb + subject + price, e.g. `Buy from MagSnake 8p`.
 *
 * The label holds the item and the price, and reducing it to an icon destroys the information the
 * user needs in order to decide — which is why the compressed row keeps a tooltip carrying it.
 *
 * `secondary` matches the shipped `.opp-action`: elevated ground, real border, one treatment for
 * every action. An earlier pass gave the first chip `variant="destructive"`, painting "Buy" in the
 * colour the app reserves for loss.
 */
export function OpportunityActionChip({ action }: { action: OpportunityAction }) {
  const { t } = useTranslation();
  const localizeParams = useLocalizedParams();
  const handle = useOpportunityAction(action);

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handle}
      className="h-7 max-w-full border-line px-2.5 text-[11px] font-semibold"
    >
      <i className={`ti ${ACTION_ICON[action.kind] ?? 'ti-arrow-right'}`} aria-hidden="true" />
      <span className="truncate">
        {t(action.labelKey as TranslationKey, localizeParams(action.labelParams))}
      </span>
      {action.price !== null ? (
        <span className="font-mono text-accent-green tabular-nums">{action.price}p</span>
      ) : null}
    </Button>
  );
}

/** The compressed chip: glyph + one verb, with the full label on the tooltip. */
export function OpportunityActionIcon({ action }: { action: OpportunityAction }) {
  const { t } = useTranslation();
  const localizeParams = useLocalizedParams();
  const handle = useOpportunityAction(action);
  const label = t(action.labelKey as TranslationKey, localizeParams(action.labelParams));

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            variant="secondary"
            size="sm"
            static
            onClick={handle}
            className="h-6 border-line px-2 text-[11px] font-semibold"
          />
        }
      >
        <i className={`ti ${ACTION_ICON[action.kind] ?? 'ti-arrow-right'}`} aria-hidden="true" />
        {t(ACTION_WORD[action.kind] ?? 'home.actOpen')}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Value and its basis. `+114p profit` and `+8p savings` are different quantities that the queue
 * ranks against each other, so a bare number invites a comparison that isn't valid.
 */
export function OpportunityValue({
  opportunity,
  size = 'lead',
}: {
  opportunity: Opportunity;
  size?: 'lead' | 'row';
}) {
  const { t } = useTranslation();
  const positive = opportunity.estValue >= 0;
  return (
    <>
      <span
        className={`font-mono font-bold tabular-nums ${
          size === 'lead' ? 'text-xl leading-none' : 'text-[13px]'
        } ${positive ? 'text-accent-green' : 'text-accent-red'}`}
      >
        {formatPlatinumDelta(opportunity.estValue)}
      </span>
      <span
        className={`font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase ${
          size === 'lead' ? 'mt-1' : 'ml-1'
        }`}
      >
        {t(valueBasisKey(opportunity.valueBasis) as TranslationKey)}
      </span>
    </>
  );
}

/** The confidence label: plain coloured uppercase text, never a pill (`.opp-conf`). */
export function OpportunityConfidence({
  opportunity,
  compact = false,
}: {
  opportunity: Opportunity;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = tHealth(t, opportunity.confidenceLabel);
  return (
    <span
      className={`shrink-0 font-mono text-[9px] font-semibold tracking-[0.06em] uppercase ${
        CONFIDENCE_CLASS[confidenceTone(opportunity.confidenceLabel)]
      }`}
      title={t('opp.confidenceWithColon', { label })}
    >
      {/* The row spends one word on this where the card spends a full `MEDIUM CONFIDENCE`
          footer — the label alone still separates a play worth acting on from one worth
          opening first, which is all a single line has room to say. */}
      {compact ? label : t('opp.confidenceSuffix', { label })}
    </span>
  );
}

/** Item art. No slug, deliberately — an opportunity is about the *set*, so the parent art is the
 *  right picture, not a lone component icon. */
export function OpportunityArt({
  opportunity,
  className,
}: {
  opportunity: Opportunity;
  className: string;
}) {
  const url = resolveWfmAssetUrl(opportunity.imagePath);
  return (
    <div
      className={`shrink-0 overflow-hidden bg-bg-elevated outline outline-1 -outline-offset-1 outline-white/10 ${className}`}
    >
      {url ? <img src={url} alt="" loading="lazy" className="size-full object-cover" /> : null}
    </div>
  );
}

/** `.opp-urgent-tag`: a play that expires says so before it says anything else, because that is
 *  the only fact that changes whether you read the rest. */
export function UrgentTag() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-full bg-accent-amber px-1.5 font-mono text-[9px] font-bold tracking-[0.05em] text-bg-base uppercase">
      {t('wl.live')}
    </span>
  );
}

/**
 * The card. Art, title, value, the reasons behind the recommendation, provenance, and the actions
 * worth taking — the anatomy the compressed row deliberately gives up.
 *
 * `onPin` / `onDismiss` are optional: Home's lead play renders the same card without them, because
 * accepting and hiding are board verbs and Home is a read-and-go surface.
 */
export function OpportunityCard({
  opportunity,
  pinned = false,
  onPin,
  onDismiss,
  className,
}: {
  opportunity: Opportunity;
  pinned?: boolean;
  onPin?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const localizeParams = useLocalizedParams();
  const tone = toneFor(opportunity);
  const urgent = opportunity.urgency === 'expiring';

  const title = t(opportunity.titleKey as TranslationKey, opportunity.titleParams);
  const subtitle = opportunity.subtitleKey
    ? t(opportunity.subtitleKey as TranslationKey, localizeParams(opportunity.subtitleParams))
    : null;

  return (
    <article
      className={[
        // A real card, not a stripe in a list. `line-strong` because `line`/`line-subtle` sit at
        // ~1.1:1 against the panel ground — invisible in practice, which made it impossible to
        // tell which buttons belonged to which play.
        'flex h-full flex-col gap-3 rounded-lg border border-l-[3px] bg-bg-elevated p-3.5',
        'transition-[border-color,box-shadow] duration-150 ease-out',
        CARD_TONE_CLASS[tone],
        // Accepted and expiring override the frame colour, the way the shipped board did — both
        // are states of the whole card, not of one field in it.
        pinned
          ? 'border-accent-green/60 ring-1 ring-accent-green/25'
          : urgent
            ? 'border-accent-amber/55 ring-1 ring-accent-amber/20'
            : 'border-line-strong hover:border-ink-faint hover:shadow-float',
        className ?? '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        {/* Real item art, at a size where you can actually recognise the item. This is a
            Warframe app; the art is the fastest identifier the game gives us. */}
        <OpportunityArt opportunity={opportunity} className="size-12 rounded-md" />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {urgent ? <UrgentTag /> : null}
            <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
          </div>
          {subtitle ? <p className="truncate text-[11px] text-ink-dim">{subtitle}</p> : null}
        </div>

        <span className="flex shrink-0 flex-col items-end">
          <OpportunityValue opportunity={opportunity} />
        </span>

        {onDismiss ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('a11y.dismissOpportunity')}
                  onClick={onDismiss}
                  className="-my-1 -mr-1 size-10 shrink-0 text-ink-faint hover:text-ink"
                />
              }
            >
              <i className="ti ti-x text-sm" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{t('a11y.notInterested')}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {opportunity.reasons.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {opportunity.reasons.slice(0, 3).map((reason, index) => (
            <li key={index} className="flex items-start gap-2 text-[11px] text-ink-soft">
              <i
                className={`ti ${REASON_ICON[reason.icon] ?? 'ti-info-circle'} mt-px shrink-0 text-ink-faint`}
                aria-hidden="true"
              />
              <span className="min-w-0">
                {t(reason.textKey as TranslationKey, localizeParams(reason.textParams))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* `mt-auto` pins the action row to the card's bottom edge. In a grid every card is as
          tall as the tallest in its row, so without this the buttons sit at a different height on
          every card and stop reading as a row of controls. */}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-0.5">
        <OpportunityConfidence opportunity={opportunity} />
        {opportunity.cost > 0 ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-dim tabular-nums">
            {t('opp.costIn', { cost: opportunity.cost })}
          </span>
        ) : null}
        {/* One freshness fact, and only where there is one: synthesized snipes carry no
            `pricedAt` because their price came off the live listing itself. */}
        {opportunity.pricedAt ? (
          <span
            className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums"
            title={t('a11y.thesePricesLastComputed')}
          >
            {t('opp.pricedElapsed', { time: formatElapsedTime(opportunity.pricedAt) })}
          </span>
        ) : null}

        <span className="min-w-0 flex-1" />

        {opportunity.actions.slice(0, 2).map((action) => (
          <OpportunityActionChip key={action.kind + (action.itemSlug ?? '')} action={action} />
        ))}

        {onPin ? (
          <Button
            variant={pinned ? 'secondary' : 'outline'}
            size="sm"
            onClick={onPin}
            aria-label={pinned ? t('opp.unpinAria') : t('opp.acceptAria')}
            className={`h-7 px-2.5 text-[11px] font-semibold ${pinned ? 'text-ink' : ''}`}
          >
            {/* `ti-bookmark-filled` is not in the bundled Tabler subset — it renders as nothing,
                which is worse than the wrong glyph. A tick is also the better verb for a state
                the label already calls "Accepted". */}
            <i className={`ti ${pinned ? 'ti-check' : 'ti-bookmark'}`} aria-hidden="true" />
            {pinned ? t('opp.accepted') : t('opp.acceptLabel')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
