import { useAppStore } from '../../stores/useAppStore';

function KVRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: valueColor ?? 'var(--text-muted)' }}>
        {value}
      </span>
    </div>
  );
}

export function MarketPage() {
  const marketSubTab = useAppStore((s) => s.marketSubTab);
  const setMarketSubTab = useAppStore((s) => s.setMarketSubTab);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Market</span>
          {(['analysis', 'analytics'] as const).map((tab) => (
            <span
              key={tab}
              className={`subtab${marketSubTab === tab ? ' active' : ''}`}
              onClick={() => setMarketSubTab(tab)}
              role="tab"
              aria-selected={marketSubTab === tab}
              tabIndex={0}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </span>
          ))}
        </div>
      </div>

      <div className="page-content">
        {/* Item selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 14 }}>
          <div style={{ width: 48, height: 48, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
            IMG
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>No item selected</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Strategy: Auto · very_short_3h · balanced</div>
          </div>
          <button className="btn-sm" style={{ marginLeft: 'auto' }}>Refresh</button>
        </div>

        {/* 4 info cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Entry Price', note: '' },
            { label: 'Exit (P60)',  note: '' },
            { label: 'Net Margin', note: 'No label' },
            { label: 'Liquidity',  note: 'No score' },
          ].map(({ label, note }) => (
            <div key={label} className="info-card">
              <div className="info-card-label">{label}</div>
              <div className="info-card-val neutral" style={{ fontSize: 22 }}>--</div>
              {note && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{note}</div>}
            </div>
          ))}
        </div>

        {/* 3 detail cards */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div className="card">
            <div className="card-header"><span className="card-label">Flip Analysis</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <KVRow label="Entry price"  value="--" />
              <KVRow label="Exit (p60)"   value="--" />
              <KVRow label="Gross margin" value="--" />
              <KVRow label="Net margin"   value="--" />
              <KVRow label="Formula"      value="task3-v1" valueColor="var(--accent-blue)" />
              <KVRow label="Margin %"     value="--" />
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-label">Liquidity Detail</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <KVRow label="Executable depth (+5pt)" value="--" />
              <KVRow label="Executable sellers"      value="--" />
              <KVRow label="Unique sellers"          value="--" />
              <KVRow label="Liquidity %"             value="--" />
              <KVRow label="Liquidity score"         value="--" />
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-label">Strategy Signal</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <KVRow label="Profile"      value="risk_averse_trader" valueColor="var(--text-primary)" />
              <KVRow label="Horizon"      value="very_short_3h"      valueColor="var(--text-primary)" />
              <KVRow label="Capital"      value="balanced"           valueColor="var(--text-primary)" />
              <KVRow label="Auto profile" value="Enabled"            valueColor="var(--accent-green)" />
              <KVRow label="Action"       value="--" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
