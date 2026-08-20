import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { HomePanel } from './HomePanel';
import {
  BADGE_CLASS,
  OpportunityActionIcon,
  OpportunityArt,
  OpportunityCard,
  OpportunityConfidence,
  OpportunityValue,
  TONE_CLASS,
  UrgentTag,
  toneFor,
} from '../../components/OpportunityCard';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { formatElapsedTime } from '../../lib/dateTime';
import type { Opportunity, OpportunityAction } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import { useRankedOpportunities } from './useRankedOpportunities';

/**
 * "Act now" — a triage queue, deliberately compressed to one line per play.
 *
 * This is a VIEW of the Opportunities board, not a second engine: same `Opportunity` objects, the
 * same ranked queue from `lib/opportunitySnipes`, just truncated to what you need in order to
 * decide whether to look closer. The full anatomy belongs on the Opportunities page, where you go
 * deliberately.
 *
 * Being a view has a consequence two passes have now missed: the colour language, the value
 * semantics, the art resolution and the action routing all have to be the board's, not a fresh
 * set invented here. They live in `components/OpportunityCard` and `lib/opportunityView`; this
 * file composes them and decides only what a *row* leaves out.
 *
 * Each row answers: what it is, how urgent, how much and on what basis, how confident, and the
 * action worth taking.
 */

/**
 * The lead play — Home's one Expressive moment.
 *
 * The queue answers "what should I act on right now", and the top-ranked play IS that answer, but
 * it used to render identically to the fifth-ranked one. A page whose most important element looks
 * exactly like its least important has no focal point, and that flatness is most of what made this
 * board feel unfinished.
 *
 * It is the board's own card, minus the board's verbs: accepting and hiding are things you do on
 * the board, and Home is a read-and-go surface.
 */
function LeadPlay({ opportunity }: { opportunity: Opportunity }) {
  // The card carries its own border and ground now, so it needs margin rather than sitting flush
  // against the panel edge the way the rows below it do.
  return <OpportunityCard opportunity={opportunity} className="m-3" />;
}

function OpportunityRow({ opportunity }: { opportunity: Opportunity }) {
  const { t } = useTranslation();
  const tone = toneFor(opportunity);
  const urgent = opportunity.urgency === 'expiring';

  const title = t(opportunity.titleKey as TranslationKey, opportunity.titleParams);
  const subtitle = opportunity.subtitleKey
    ? t(opportunity.subtitleKey as TranslationKey, opportunity.subtitleParams)
    : null;

  // Two chips is the width budget for a single line; the rest are one click away on the board.
  const actions = opportunity.actions.slice(0, 2);

  return (
    <div
      className={`flex min-h-11 items-center gap-3 border-b border-line-subtle border-l-[3px] px-3 pl-2.5 last:border-b-0 ${TONE_CLASS[tone]} transition-colors duration-150 ease-out hover:bg-bg-elevated`}
    >
      <OpportunityArt opportunity={opportunity} className="size-6 rounded-sm" />

      {/* A play that expires says so before it says anything else, because that is the only fact
          that changes whether you read the rest. */}
      {urgent ? <UrgentTag /> : null}

      <span className="truncate text-xs font-semibold">{title}</span>

      {subtitle ? (
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${BADGE_CLASS[tone]}`}
        >
          {subtitle}
        </span>
      ) : null}

      <span className="min-w-0 flex-1" />

      {/* Provenance, compressed to one word — anything asserting a number says how much to
          trust it. */}
      <OpportunityConfidence opportunity={opportunity} compact />

      {/* Fixed width and right-aligned: rows carry between one and two action chips of differing
          word lengths, which pushed the value's left edge around by ~60px between rows and left
          the numbers in no column at all. This only shows up with real data. */}
      <span className="w-24 shrink-0 text-right">
        <OpportunityValue opportunity={opportunity} size="row" />
      </span>

      {/* Also fixed, and right-aligned, so a row with one action doesn't drag the value column
          with it. Sized for two chips at the longest verb we ship; a longer translation wraps the
          cell wider rather than clipping. */}
      <div className="flex w-40 shrink-0 items-center justify-end gap-1">
        {actions.map((action: OpportunityAction) => (
          <OpportunityActionIcon key={action.kind + (action.itemSlug ?? '')} action={action} />
        ))}
      </div>
    </div>
  );
}

/** Mirrors `OpportunityRow`'s box model exactly — same height, same columns, same gaps — so
 *  nothing shifts when the real rows land. A skeleton that doesn't match causes the layout jump
 *  it exists to prevent.
 *
 *  Built from the `Skeleton` primitive rather than bare pulsing divs, so there is exactly one
 *  pulse implementation in the app: change the primitive and every loading state follows. */
function SkeletonRow() {
  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-line-subtle border-l-[3px] border-l-line-strong px-3 pl-2.5 last:border-b-0">
      <Skeleton type="avatar" className="w-auto shrink-0" leafClassName="size-6 rounded-sm" />
      <Skeleton type="text" className="w-32 shrink-0" />
      <Skeleton type="chip" className="w-auto shrink-0" />
      <span className="min-w-0 flex-1" />
      <Skeleton type="text" className="w-16 shrink-0" />
      <Skeleton type="button" className="w-auto shrink-0" leafClassName="h-6 w-16" />
    </div>
  );
}

export function ActNow() {
  const { t } = useTranslation();
  const setActivePage = useAppStore((s) => s.setActivePage);
  const { ranked, status, stalestPricedAt } = useRankedOpportunities();

  return (
    <HomePanel
      title={t('home.actNow')}
      dotClass="bg-accent-amber"
      count={status === 'ready' ? ranked.length : undefined}
      meta={stalestPricedAt ? t('home.pricedAt', { time: formatElapsedTime(stalestPricedAt) }) : null}
      linkLabel={t('home.fullBoard')}
      onLink={() => setActivePage('opportunities')}
    >
      {status === 'loading' ? (
        <div>
          {Array.from({ length: 5 }, (_, index) => (
            <SkeletonRow key={index} />
          ))}
        </div>
      ) : status === 'empty' ? (
        <EmptyState icon="ti-checks" tone="positive" title={t('home.actNowEmpty')} detail={t('home.actNowEmptyDetail')} />
      ) : (
        /* Capped and scrollable so the watchlist below stays above the fold no matter how
           many plays the engine returns. */
        <div className="max-h-[26rem] overflow-y-auto overscroll-contain">
          <LeadPlay opportunity={ranked[0]} />
          {ranked.slice(1).map((opportunity) => (
            <OpportunityRow key={opportunity.id} opportunity={opportunity} />
          ))}
        </div>
      )}
    </HomePanel>
  );
}
