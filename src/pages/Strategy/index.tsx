import { useAppStore } from '../../stores/useAppStore';

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </div>
  );
}

export function StrategyPage() {
  const sellerMode = useAppStore((s) => s.sellerMode);
  const autoProfile = useAppStore((s) => s.autoProfile);
  const toggleAutoProfile = useAppStore((s) => s.toggleAutoProfile);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Strategy</span>
        </div>
      </div>
      <div className="page-content">
        <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card">
            <div className="card-header"><span className="card-label">Strategy Profile</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <KVRow label="Profile">
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--accent-blue)' }}>
                  Fast Flipper
                </span>
              </KVRow>
              <KVRow label="Horizon">
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>Very Short</span>
              </KVRow>
              <KVRow label="Capital">
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>Balanced</span>
              </KVRow>
              <KVRow label="Seller Mode">
                <span className="badge badge-blue">
                  {sellerMode === 'ingame' ? 'Ingame' : 'Ingame + Online'}
                </span>
              </KVRow>
              <KVRow label="Auto Profile">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${autoProfile ? 'badge-green' : 'badge-muted'}`}>
                    {autoProfile ? 'Enabled' : 'Disabled'}
                  </span>
                  <div
                    className={`toggle${autoProfile ? ' on' : ''}`}
                    onClick={toggleAutoProfile}
                    role="switch"
                    aria-checked={autoProfile}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && toggleAutoProfile()}
                  />
                </div>
              </KVRow>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
