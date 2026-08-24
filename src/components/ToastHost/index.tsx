import { Button } from '@/components/ui/button';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';

/** The tone shows in the border only — a toast is a message, not a status block, and a fully
 *  tinted surface at this size reads as an alert bar. */
const TONE_BORDER: Record<string, string> = {
  success: 'border-accent-green/40',
  error: 'border-accent-red/40',
  info: 'border-accent-blue/40',
};

/** Renders transient toast notifications (success / error / info) bottom-right. */
export function ToastHost() {
  const { t } = useTranslation();
  const toasts = useAppStore((state) => state.toasts);
  const dismissToast = useAppStore((state) => state.dismissToast);

  if (toasts.length === 0) {
    return null;
  }

  return (
    // `z-(--z-toast)` — the top of the layering scale, above dialogs: a toast that a modal covers
    // is a toast nobody sees. Written in the form Tailwind actually generates (guard 7).
    <div
      className="fixed right-4 bottom-4 z-(--z-toast) flex max-w-[340px] flex-col gap-2"
      role="region"
      aria-label={t('settings.section.notifications.label')}
    >
      {/* Each toast carries its own live-region role (alert/status) so it's announced exactly
          once; the container is a plain landmark region (no aria-live) to avoid double-announce. */}
      {toasts.map((toast) => (
        <Button
          key={toast.id}
          variant="ghost"
          static
          // Errors announce assertively (role="alert"); info/success announce politely via
          // the region above (role="status") so screen-reader users hear every toast.
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={`h-auto justify-start rounded-lg border bg-bg-overlay px-3.5 py-2.5 text-left text-[13px] leading-relaxed whitespace-normal text-ink shadow-float hover:bg-bg-elevated ${
            TONE_BORDER[toast.tone] ?? TONE_BORDER.info
          }`}
          onClick={() => dismissToast(toast.id)}
          title={t('a11y.dismiss')}
        >
          {toast.message}
        </Button>
      ))}
    </div>
  );
}
