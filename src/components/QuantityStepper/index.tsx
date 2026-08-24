import { Button } from '@/components/ui/button';
import { useTranslation } from '../../i18n';

/**
 * Compact −/+ quantity control. Callers own the value; changes are expected to be cheap locally
 * (any expensive sync should be debounced by the caller, not throttled here).
 */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 999,
  disabled = false,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const clamp = (next: number) => Math.max(min, Math.min(max, next));

  return (
    // `stopPropagation` because this sits inside a clickable watchlist row.
    <span
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg-base p-0.5"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        static
        className="size-5.5 rounded-sm"
        aria-label={t('wl.decreaseQuantity')}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <i className="ti ti-minus text-[11px]" aria-hidden="true" />
      </Button>
      {/* `appearance-none` and no spinners: the −/+ buttons ARE the stepper, and the browser's
          own arrows would be a second one inside it. */}
      <input
        className="w-8 appearance-none border-0 bg-transparent p-0 text-center font-mono text-[11px] tabular-nums text-ink outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        aria-label={label ?? t('wl.qty')}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed)) {
            onChange(clamp(parsed));
          }
        }}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        static
        className="size-5.5 rounded-sm"
        aria-label={t('wl.increaseQuantity')}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <i className="ti ti-plus text-[11px]" aria-hidden="true" />
      </Button>
    </span>
  );
}
