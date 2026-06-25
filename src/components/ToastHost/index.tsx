import { useAppStore } from '../../stores/useAppStore';

/** Renders transient toast notifications (success / error / info) bottom-right. */
export function ToastHost() {
  const toasts = useAppStore((state) => state.toasts);
  const dismissToast = useAppStore((state) => state.dismissToast);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {/* Each toast carries its own live-region role (alert/status) so it's announced exactly
          once; the container is a plain landmark region (no aria-live) to avoid double-announce. */}
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          // Errors announce assertively (role="alert"); info/success announce politely via
          // the region above (role="status") so screen-reader users hear every toast.
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={`toast toast-${toast.tone}`}
          onClick={() => dismissToast(toast.id)}
          title="Dismiss"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
