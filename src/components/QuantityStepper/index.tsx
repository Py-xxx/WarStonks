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
    <span className="qty-stepper" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="qty-stepper-btn"
        aria-label={t('wl.decreaseQuantity')}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <i className="ti ti-minus" aria-hidden="true" />
      </button>
      <input
        className="qty-stepper-value"
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
      <button
        type="button"
        className="qty-stepper-btn"
        aria-label={t('wl.increaseQuantity')}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <i className="ti ti-plus" aria-hidden="true" />
      </button>
    </span>
  );
}
