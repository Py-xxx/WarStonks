export function GuidePage() {
  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Guide</span>
        </div>
      </div>
      <div className="page-content">
        <div className="empty-state" style={{ marginTop: 40, minHeight: 220 }}>
          <span className="empty-primary">Guide is coming soon</span>
          <span className="empty-sub">
            This feature is planned for a future release and will be available soon.
          </span>
        </div>
      </div>
    </>
  );
}
