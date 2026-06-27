//! Global "data maintenance" gate. While active (during an import/export), all WFM API
//! requests are held so no scan or poll writes to the databases mid-operation. The WFM
//! scheduler checks `is_maintenance_active()` before dispatching; the export/import commands
//! hold a `MaintenanceGuard` for the duration so it always clears, even on error/panic.

use std::sync::atomic::{AtomicUsize, Ordering};

// Ref-counted so overlapping export/import operations each hold the gate independently —
// maintenance stays active until the *last* guard drops.
static MAINTENANCE_DEPTH: AtomicUsize = AtomicUsize::new(0);

pub fn is_maintenance_active() -> bool {
    MAINTENANCE_DEPTH.load(Ordering::SeqCst) > 0
}

/// RAII guard: marks maintenance active for its lifetime and clears it on drop.
pub struct MaintenanceGuard;

impl MaintenanceGuard {
    pub fn acquire() -> Self {
        MAINTENANCE_DEPTH.fetch_add(1, Ordering::SeqCst);
        MaintenanceGuard
    }
}

impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        MAINTENANCE_DEPTH.fetch_sub(1, Ordering::SeqCst);
    }
}
