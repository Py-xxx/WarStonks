/**
 * The furniture every settings section is built from.
 *
 * Settings had four modal files that each invented their own version of "a label with help text
 * and a control on the right", "a tinted note", and "a group of related fields" — five hand-rolled
 * switches and four close buttons between them. These are those shapes, once.
 *
 * They live here rather than in `components/ui/` deliberately: a settings row is a layout
 * convention for this one surface, not a primitive the whole app composes. The moment a second
 * surface wants one, it moves.
 */
import { cn } from '@/lib/utils';

/** A titled block of related settings. Space and a heading, not a bordered card — a group of
 *  fields is one region with a name, not four regions (`ELEMENTS.md` §6). */
export function SettingGroup({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1">
        <h3 className="font-mono text-[10px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
          {title}
        </h3>
        {description ? (
          <p className="text-[11px] leading-relaxed text-ink-dim">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One setting: a label, optional help, and its control on the right.
 *
 * `help` is for the four cases `ui-copy` allows — a format constraint, an irreversible
 * consequence, a non-obvious side effect, an external requirement. Not for restating the label.
 *
 * `children` renders **under** the row when present, which is how a channel carries its own
 * settings (ringtone under Sound, webhook URL under Discord) instead of them being collected into
 * a "config" row somewhere else on the screen.
 */
export function SettingRow({
  label,
  help,
  control,
  children,
  htmlFor,
}: {
  label: string;
  help?: string;
  control: React.ReactNode;
  children?: React.ReactNode;
  htmlFor?: string;
}) {
  const Tag = htmlFor ? 'label' : 'div';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-bg-panel px-3 py-2.5">
      <Tag
        className={cn('flex items-center justify-between gap-4', htmlFor && 'cursor-pointer')}
        {...(htmlFor ? { htmlFor } : {})}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-ink">{label}</span>
          {help ? <span className="text-[11px] leading-relaxed text-ink-dim">{help}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">{control}</span>
      </Tag>
      {children ? <div className="flex flex-col gap-2 pt-0.5">{children}</div> : null}
    </div>
  );
}

/** A labelled field inside a `SettingRow`'s body — the ringtone picker, the webhook URL. */
export function SettingField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="font-mono text-[10px] tracking-[0.08em] text-ink-dim uppercase"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const NOTE_CLASS = {
  info: 'border-line-strong bg-bg-base text-ink-dim',
  warn: 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber',
  error: 'border-accent-red/25 bg-accent-red/8 text-accent-red',
  success: 'border-accent-green/25 bg-accent-green/8 text-accent-green',
} as const;

const NOTE_ICON = {
  info: 'ti-info-circle',
  warn: 'ti-alert-triangle',
  error: 'ti-alert-triangle',
  success: 'ti-check',
} as const;

/** The one tinted note. It replaced `settings-inline-warning`, `settings-inline-error`,
 *  `settings-inline-success` and two ad-hoc red paragraphs. */
export function Note({
  tone = 'info',
  children,
  role,
}: {
  tone?: keyof typeof NOTE_CLASS;
  children: React.ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <p
      role={role}
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed',
        NOTE_CLASS[tone],
      )}
    >
      <i className={`ti ${NOTE_ICON[tone]} mt-px shrink-0 text-sm`} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A live status line — a dot, a state, and optional detail. Whether AlecaFrame is actually
 *  detected is the most useful fact in this surface; it used to be a 10px pill in a menu. */
export function StatusLine({
  tone,
  label,
  detail,
}: {
  tone: 'positive' | 'negative' | 'pending';
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-bg-base px-3 py-2">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          tone === 'positive'
            ? 'bg-accent-green'
            : tone === 'negative'
              ? 'bg-accent-red'
              : 'bg-ink-faint',
        )}
        aria-hidden="true"
      />
      <span className="text-xs text-ink">{label}</span>
      {detail ? <span className="truncate text-[11px] text-ink-dim">{detail}</span> : null}
    </div>
  );
}
