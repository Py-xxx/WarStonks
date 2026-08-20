import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/en';
import type { PageId } from '../types';

/**
 * The heading every page starts with.
 *
 * Pages used to open with a `.subnav` bar carrying the title *and* that page's tab row. The tabs
 * moved to the sidebar, so what remains is a title — and rather than leave seven pages each
 * rendering their own slightly different version of that, it is one component.
 *
 * `aside` sits beside the title (Home's live indicator); `actions` is pushed to the right and
 * takes what used to live in `.subnav-right` — Scanners' auto-scan toggle and Run button, Trades'
 * account controls. Those are page controls, not navigation, so they stay on the page.
 */
export function PageHeading({
  page,
  titleKey,
  aside,
  actions,
}: {
  /** Uses `nav.<page>` for the label, so the heading and the sidebar can never disagree. */
  page?: PageId;
  /** Escape hatch for a page whose heading is not its nav label. */
  titleKey?: TranslationKey;
  aside?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const label = titleKey ? t(titleKey) : page ? t(`nav.${page}` as TranslationKey) : '';

  return (
    <div className="flex min-h-8 items-center gap-3 px-4 pt-4">
      <h1 className="text-base font-semibold tracking-tight">{label}</h1>
      {aside ? <div className="flex min-w-0 items-center gap-2">{aside}</div> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
