import { useMemo, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { GUIDE_SECTIONS, type GuideBlock, type GuideSection } from './guideContent';

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
      return <p className="guide-paragraph">{block.text}</p>;
    case 'subheading':
      return <h3 className="guide-subheading">{block.text}</h3>;
    case 'steps':
      return (
        <ol className="guide-steps">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="guide-list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'callout':
      return <div className={`guide-callout guide-callout-${block.tone}`}>{block.text}</div>;
    case 'tabCard':
      return (
        <div className="guide-tab-card">
          <div className="guide-tab-card-head">
            <span className="guide-tab-card-title">{block.title}</span>
            <button
              type="button"
              className="text-btn"
              onClick={() => setActivePage(block.page)}
            >
              Open {block.title} →
            </button>
          </div>
          <p className="guide-tab-card-line">
            <span className="guide-tab-card-label">What it’s for</span>
            {block.whatFor}
          </p>
          <p className="guide-tab-card-line">
            <span className="guide-tab-card-label">When to use it</span>
            {block.whenToUse}
          </p>
        </div>
      );
    case 'glossary':
      return (
        <dl className="guide-glossary">
          {block.terms.map((t, i) => (
            <div className="guide-glossary-item" key={i}>
              <dt>{t.term}</dt>
              <dd>{t.def}</dd>
            </div>
          ))}
        </dl>
      );
    case 'faq':
      return (
        <div className="guide-faq">
          {block.items.map((f, i) => (
            <div className="guide-faq-item" key={i}>
              <span className="guide-faq-q">{f.q}</span>
              <p className="guide-faq-a">{f.a}</p>
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
      <div className="subnav guide-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('guide.title')}</span>
          {!normalizedQuery
            ? GUIDE_SECTIONS.map((section) => (
                <span
                  key={section.id}
                  className={`subtab${activeSectionId === section.id ? ' active' : ''}`}
                  onClick={() => handleJump(section.id)}
                  role="tab"
                  aria-selected={activeSectionId === section.id}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && handleJump(section.id)}
                >
                  {section.title}
                </span>
              ))
            : null}
        </div>
        <div className="subnav-right">
          <input
            type="search"
            className="guide-search"
            placeholder={t('guide.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('guide.searchAria')}
          />
        </div>
      </div>

      <div className="page-content guide-page-content">
        <div className="guide-intro">{t('guide.intro')}</div>

        {visibleSections.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 32, minHeight: 160 }}>
            <span className="empty-primary">{t('guide.noMatches')}</span>
            <span className="empty-sub">{t('guide.noMatchesSub', { query })}</span>
          </div>
        ) : (
          visibleSections.map((section) => (
            <section
              key={section.id}
              id={`guide-section-${section.id}`}
              className="guide-section"
            >
              <header className="guide-section-header">
                <h2 className="guide-section-title">{section.title}</h2>
                <p className="guide-section-blurb">{section.blurb}</p>
              </header>
              <div className="guide-section-body">
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
