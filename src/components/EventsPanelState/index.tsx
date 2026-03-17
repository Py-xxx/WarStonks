type EventsPanelEmptyProps = {
  title: string;
  detail: string;
  actionLabel?: string | null;
  onAction?: (() => void) | null;
};

export function EventsPanelEmpty({
  title,
  detail,
  actionLabel = null,
  onAction = null,
}: EventsPanelEmptyProps) {
  return (
    <div className="empty-state activity-empty-state">
      <span className="empty-primary">{title}</span>
      <span className="empty-sub">{detail}</span>
      {actionLabel && onAction ? (
        <button type="button" className="market-empty-state-action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function EventsPanelNotice({
  message,
  tone,
  loading,
  onRefresh,
}: {
  message: string | null;
  tone: 'warning' | 'error';
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!message) {
    return null;
  }

  return (
    <div className="activity-inline-state">
      <span className={tone === 'warning' ? 'settings-inline-warning' : 'settings-inline-error'}>
        {message}
      </span>
      <button className="text-btn" type="button" onClick={onRefresh}>
        {loading ? 'Refreshing…' : 'Retry'}
      </button>
    </div>
  );
}
