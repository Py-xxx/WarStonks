import { useMemo, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { PageHeading } from '../../components/PageHeading';
import { useTranslation } from '../../i18n';
import { GUIDE_SECTIONS, type GuideBlock, type GuideSection } from './guideContent';

/** Callout tone → its frame. Amber warns, green confirms, blue is neutral information. */
const CALLOUT_TONE: Record<string, string> = {
  info: 'border-accent-blue/25 border-l-accent-blue bg-accent-blue/8 text-ink-soft',
  warning: 'border-accent-amber/25 border-l-accent-amber bg-accent-amber/8 text-ink-soft',
  success: 'border-accent-green/25 border-l-accent-green bg-accent-green/8 text-ink-soft',
  tip: 'border-accent-blue/25 border-l-accent-blue bg-accent-blue/8 text-ink-soft',
};

/** Lowercased haystack of every searchable string in a section. */
function sectionSearchText(section: GuideSection): string {
  const parts: string[] = [section.title, section.blurb];
  for (const block of section.blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'subheading':
      case 'callout':
        parts.push(block.text);
        break;
      case 'steps':
      case 'list':
        parts.push(...block.items);
        break;
      case 'tabCard':
        parts.push(block.title, block.whatFor, block.whenToUse);
        break;
      case 'glossary':
        for (const t of block.terms) parts.push(t.term, t.def);
        break;
      case 'faq':
        for (const f of block.items) parts.push(f.q, f.a);
        break;
    }
  }
  return parts.join(' · ').toLowerCase();
}

function GuideBlockView({ block }: { block: GuideBlock }) {
  const setActivePage = useAppStore((s) => s.setActivePage);

  switch (block.kind) {
    case 'paragraph':
      // `max-w-[70ch]` throughout: this is the one surface in the app that is genuinely prose,
      // and a line of body text running the full width of a desktop window is unreadable.
      return <p className="max-w-[70ch] text-xs leading-relaxed text-ink-soft">{block.text}</p>;
    case 'subheading':
      return <h3 className="mt-1 text-xs font-semibold text-ink">{block.text}</h3>;
    case 'steps':
      return (
        <ol className="ml-4 flex max-w-[70ch] list-decimal flex-col gap-1 text-xs leading-relaxed text-ink-soft marker:text-ink-faint">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="ml-4 flex max-w-[70ch] list-disc flex-col gap-1 text-xs leading-relaxed text-ink-soft marker:text-ink-faint">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'callout':
      return (
        <p
          className={`max-w-[70ch] rounded-md border border-l-[3px] px-3 py-2 text-xs leading-relaxed ${
            CALLOUT_TONE[block.tone] ?? CALLOUT_TONE.info
          }`}
        >
          {block.text}
        </p>
      );
    case 'tabCard':
      return (
        <Panel className="max-w-[70ch] gap-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">{block.title}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-accent-blue hover:bg-accent-blue/10 hover:text-accent-blue"
              onClick={() => setActivePage(block.page)}
            >
              {block.title}
              <i className="ti ti-arrow-right" aria-hidden="true" />
            </Button>
          </div>
          {(
            [
              ['What it’s for', block.whatFor],
              ['When to use it', block.whenToUse],
            ] as const
          ).map(([label, text]) => (
            <p key={label} className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
                {label}
              </span>
              <span className="text-xs leading-relaxed text-ink-soft">{text}</span>
            </p>
          ))}
        </Panel>
      );
    case 'glossary':
      return (
        <dl className="flex max-w-[70ch] flex-col gap-2">
          {block.terms.map((term, i) => (
            <div key={i} className="flex flex-col gap-0.5 border-l-2 border-line-strong pl-3">
              <dt className="text-xs font-semibold text-ink">{term.term}</dt>
              <dd className="text-xs leading-relaxed text-ink-dim">{term.def}</dd>
            </div>
          ))}
        </dl>
      );
    case 'faq':
      return (
        <div className="flex max-w-[70ch] flex-col gap-3">
          {block.items.map((faq, i) => (
            <div key={i} className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink">{faq.q}</span>
              <p className="text-xs leading-relaxed text-ink-dim">{faq.a}</p>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}

export function GuidePage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeSectionId, setActiveSectionId] = useState<string>(GUIDE_SECTIONS[0]?.id ?? '');

  const normalizedQuery = query.trim().toLowerCase();

  const visibleSections = useMemo(() => {
    if (!normalizedQuery) {
      return GUIDE_SECTIONS;
    }
    return GUIDE_SECTIONS.filter((section) =>
      sectionSearchText(section).includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const handleJump = (id: string) => {
    setActiveSectionId(id);
    const el = document.getElementById(`guide-section-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      {/* The guide's sections are a document table of contents, not navigation — they scroll the
          page rather than change it — which is why they live here and not in the sidebar
          (`ELEMENTS.md` §7 excludes Guide for exactly this reason). */}
      <PageHeading
        page="guide"
        actions={
          <span className="relative flex w-56 items-center">
            <i
              className="ti ti-search pointer-events-none absolute left-2.5 text-sm text-ink-dim"
              aria-hidden="true"
            />
            <Input
              type="search"
              className="pl-8"
              placeholder={t('guide.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('guide.searchAria')}
            />
          </span>
        }
      />

      <div className="page-content flex flex-col gap-4 [&>*]:shrink-0">
        {/* Hidden while searching: the contents list describes the whole document, and a filtered
            view is not the document. */}
        {!normalizedQuery ? (
          <nav
            className="flex flex-wrap items-center gap-1"
            aria-label={t('guide.title')}
          >
            {GUIDE_SECTIONS.map((section) => (
              <Button
                key={section.id}
                variant="ghost"
                size="sm"
                static
                aria-current={activeSectionId === section.id ? 'true' : undefined}
                onClick={() => handleJump(section.id)}
                className={`h-7 rounded-md px-2.5 text-[11px] ${
                  activeSectionId === section.id
                    ? 'bg-bg-elevated text-ink'
                    : 'text-ink-dim hover:text-ink'
                }`}
              >
                {section.title}
              </Button>
            ))}
          </nav>
        ) : null}

        {/* Temporary. The guide predates the local-source pivot, so parts of it describe an
            app that no longer exists — say so rather than let it quietly mislead. */}
        <p
          role="status"
          className="flex max-w-[70ch] items-start gap-2 rounded-md border border-accent-amber/25 bg-accent-amber/8 px-3 py-2 text-[11px] leading-relaxed text-accent-amber"
        >
          <i className="ti ti-alert-triangle mt-px shrink-0 text-sm" aria-hidden="true" />
          {t('guide.staleNotice')}
        </p>

        <p className="max-w-[70ch] text-xs leading-relaxed text-ink-soft">{t('guide.intro')}</p>

        {visibleSections.length === 0 ? (
          <EmptyState
            className="py-10"
            icon="ti-search-off"
            title={t('guide.noMatches')}
            detail={t('guide.noMatchesSub', { query })}
          />
        ) : (
          visibleSections.map((section) => (
            <section
              key={section.id}
              id={`guide-section-${section.id}`}
              // `scroll-mt` so `scrollIntoView` does not tuck the heading under the top bar.
              className="flex scroll-mt-4 flex-col gap-3 border-t border-line pt-4 first-of-type:border-t-0 first-of-type:pt-0"
            >
              <header className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold text-ink">{section.title}</h2>
                <p className="max-w-[70ch] text-[11px] leading-relaxed text-ink-dim">
                  {section.blurb}
                </p>
              </header>
              <div className="flex flex-col gap-3">
                {section.blocks.map((block, i) => (
                  <GuideBlockView key={i} block={block} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}
