//! Reads AlecaFrame's locally cached Warframe inventory.
//!
//! See `Resources/WFAndAlecaAppData/ALECAFRAME_EXTRACT_README.md`. AlecaFrame caches the
//! raw inventory DE sends the game client, obfuscated with a static AES-128-CBC key. This
//! is the user's own data on their own disk — the encryption is obfuscation, not a
//! security boundary — but the key is a constant lifted from a third-party binary and
//! **will** break when AlecaFrame changes it. Every failure path here therefore reports
//! cleanly rather than panicking or serving stale data.
//!
//! Read-only by design at this stage: nothing here writes to `owned_set_components` or
//! the relic cache, because those are keyed by WFM slug and the `uniqueName` → slug
//! bridge doesn't exist yet.

use std::collections::HashMap;
use std::path::Path;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Static key/IV, `AlecaFrameClientLib.StaticData.lastDataKey` / `lastDataIV` (v2.6.90).
/// If decryption starts failing after an AlecaFrame update, these are what changed —
/// the README documents how to re-read them from the DLL.
const LAST_DATA_KEY: [u8; 16] = [
    0x4c, 0x45, 0x4f, 0x2d, 0x41, 0x4c, 0x45, 0x43, 0x09, 0x45, 0x4f, 0x2d, 0x41, 0x4c, 0x45, 0x43,
];
const LAST_DATA_IV: [u8; 16] = [
    0x31, 0x32, 0x46, 0x47, 0x42, 0x33, 0x36, 0x2d, 0x4c, 0x45, 0x33, 0x2d, 0x71, 0x3d, 0x39, 0x00,
];

/// The AlecaFrame release these constants were verified against.
pub const VERIFIED_ALECAFRAME_VERSION: &str = "2.6.90";

/// AES-128-CBC + PKCS7, UTF-8 — AlecaFrame's `Misc.ReadAllTextEncrypted`.
pub fn decrypt_last_data(blob: &[u8]) -> Result<String> {
    if blob.is_empty() || blob.len() % 16 != 0 {
        return Err(anyhow!(
            "encrypted payload is {} bytes, which is not a whole number of AES blocks",
            blob.len()
        ));
    }

    let plain = Aes128CbcDec::new(&LAST_DATA_KEY.into(), &LAST_DATA_IV.into())
        .decrypt_padded_vec_mut::<Pkcs7>(blob)
        .map_err(|_| {
            anyhow!(
                "AlecaFrame inventory failed to decrypt — the app's static key most likely \
                 changed (verified against v{VERIFIED_ALECAFRAME_VERSION})"
            )
        })?;

    // The payload is DE's own JSON and has been valid UTF-8 in every observed sample;
    // decoding lossily rather than failing keeps one stray byte from costing the whole
    // inventory.
    Ok(String::from_utf8_lossy(&plain).into_owned())
}

/// MongoDB ObjectId → unix seconds. The first 4 bytes are the timestamp, which is how
/// `LastInventorySync` yields the authoritative "as of" moment — file mtime is unreliable
/// because it does not survive copying.
pub fn object_id_timestamp(oid: &str) -> Option<i64> {
    if oid.len() < 8 {
        return None;
    }
    i64::from_str_radix(&oid[..8], 16).ok()
}

fn oid_of(value: &Value) -> Option<&str> {
    value.get("$oid").and_then(Value::as_str)
}

/// Broad classification driven by the `/Lotus/...` path. Deliberately coarse: it exists to
/// group the inventory for display, not to be authoritative about game mechanics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemCategory {
    Relic,
    Arcane,
    Mod,
    Blueprint,
    Gem,
    Fish,
    Resource,
    Equipment,
    Other,
}

pub fn categorize(unique_name: &str) -> ItemCategory {
    if unique_name.contains("/Projections/") {
        ItemCategory::Relic
    } else if unique_name.starts_with("/Lotus/Upgrades/CosmeticEnhancers/") {
        ItemCategory::Arcane
    } else if unique_name.starts_with("/Lotus/Upgrades/Mods/") {
        ItemCategory::Mod
    } else if unique_name.starts_with("/Lotus/Types/Recipes/") {
        ItemCategory::Blueprint
    } else if unique_name.contains("/Gems/") {
        ItemCategory::Gem
    } else if unique_name.contains("/Fish/") {
        ItemCategory::Fish
    } else if unique_name.starts_with("/Lotus/Types/Items/") {
        ItemCategory::Resource
    } else if unique_name.starts_with("/Lotus/Powersuits/")
        || unique_name.starts_with("/Lotus/Weapons/")
        || unique_name.starts_with("/Lotus/Types/Sentinels/")
    {
        ItemCategory::Equipment
    } else {
        ItemCategory::Other
    }
}

/// `uniqueName` → display name, from `cachedData/custom/basic.json`.
///
/// Roughly 7% of a real inventory does not resolve (144 of 1,936 in the reference run):
/// items newer than AlecaFrame's cached codex snapshot. Those keep their raw path rather
/// than being guessed at — `lang.json` cannot fill the gap, as its English names are null.
#[derive(Debug, Default)]
pub struct NameLookup {
    names: HashMap<String, String>,
}

impl NameLookup {
    pub fn from_basic_json(text: &str) -> Result<Self> {
        let parsed: Value = serde_json::from_str(text).context("basic.json is not valid JSON")?;
        let items = parsed
            .get("items")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("basic.json has no `items` object"))?;

        let mut names = HashMap::with_capacity(items.len());
        for (unique_name, entry) in items {
            if let Some(name) = entry.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    names.insert(unique_name.clone(), name.to_string());
                }
            }
        }
        Ok(Self { names })
    }

    /// Entry count, used to assert the codex actually loaded rather than silently
    /// yielding an empty lookup that would make every name fall back to its raw path.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.names.len()
    }

    /// Falls back to the raw path, which is honest about the gap and still identifies the
    /// item — better than an empty string or a name invented from the path.
    pub fn resolve(&self, unique_name: &str) -> String {
        self.names
            .get(unique_name)
            .cloned()
            .unwrap_or_else(|| unique_name.to_string())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeAccount {
    pub platinum: i64,
    pub credits: i64,
    /// Endo.
    pub fusion_points: i64,
    /// Regal Aya.
    pub prime_tokens: i64,
    pub mastery_rank: i64,
    /// Counts down from the daily cap of 20 — also a cross-check on trade detection.
    pub trades_remaining: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeItem {
    pub unique_name: String,
    pub name: String,
    pub count: i64,
    /// Which inventory list it came from. Kept because the same item type can live in two
    /// buckets — arcanes split across `RawUpgrades` (unranked) and `Upgrades` (ranked).
    pub bucket: String,
    pub category: ItemCategory,
    /// Whether the display name resolved, so the UI can show the gap honestly.
    pub name_resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeInventory {
    pub account: AlecaframeAccount,
    /// Authoritative "as of", decoded from `LastInventorySync`. Unix seconds.
    pub last_inventory_sync: Option<i64>,
    pub items: Vec<AlecaframeItem>,
    /// How many items fell back to their raw `/Lotus/...` path.
    pub unresolved_name_count: usize,
}

/// Stacked buckets: `{ItemType, ItemCount}` per entry.
const STACK_BUCKETS: [&str; 3] = ["MiscItems", "Recipes", "RawUpgrades"];

fn account_i64(root: &Value, key: &str) -> i64 {
    root.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub fn parse_inventory(json: &str, names: &NameLookup) -> Result<AlecaframeInventory> {
    let root: Value =
        serde_json::from_str(json).context("decrypted AlecaFrame payload is not valid JSON")?;

    let account = AlecaframeAccount {
        platinum: account_i64(&root, "PremiumCredits"),
        credits: account_i64(&root, "RegularCredits"),
        fusion_points: account_i64(&root, "FusionPoints"),
        prime_tokens: account_i64(&root, "PrimeTokens"),
        mastery_rank: account_i64(&root, "PlayerLevel"),
        trades_remaining: account_i64(&root, "TradesRemaining"),
    };

    let last_inventory_sync = root
        .get("LastInventorySync")
        .and_then(oid_of)
        .and_then(object_id_timestamp);

    let mut items = Vec::new();
    let mut unresolved_name_count = 0;

    for bucket in STACK_BUCKETS {
        let Some(entries) = root.get(bucket).and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let Some(unique_name) = entry.get("ItemType").and_then(Value::as_str) else {
                continue;
            };
            let count = entry.get("ItemCount").and_then(Value::as_i64).unwrap_or(0);
            let name = names.resolve(unique_name);
            let name_resolved = name != unique_name;
            if !name_resolved {
                unresolved_name_count += 1;
            }
            items.push(AlecaframeItem {
                unique_name: unique_name.to_string(),
                name,
                count,
                bucket: bucket.to_string(),
                category: categorize(unique_name),
                name_resolved,
            });
        }
    }

    // `Upgrades` holds ranked/instanced mods, arcanes and rivens — one object per instance
    // rather than a stack, so identical types are collapsed into a count here. Skipping
    // this bucket entirely would report zero ranked arcanes, which is the classic mistake.
    if let Some(entries) = root.get("Upgrades").and_then(Value::as_array) {
        let mut instanced: HashMap<&str, i64> = HashMap::new();
        for entry in entries {
            if let Some(unique_name) = entry.get("ItemType").and_then(Value::as_str) {
                *instanced.entry(unique_name).or_insert(0) += 1;
            }
        }
        for (unique_name, count) in instanced {
            let name = names.resolve(unique_name);
            let name_resolved = name != unique_name;
            if !name_resolved {
                unresolved_name_count += 1;
            }
            items.push(AlecaframeItem {
                unique_name: unique_name.to_string(),
                name,
                count,
                bucket: "Upgrades".to_string(),
                category: categorize(unique_name),
                name_resolved,
            });
        }
    }

    items.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(AlecaframeInventory {
        account,
        last_inventory_sync,
        items,
        unresolved_name_count,
    })
}

/// Loads `basic.json` from an AlecaFrame directory. Absent on a fresh install that has
/// never synced its codex, in which case names simply stay raw.
pub fn load_name_lookup(alecaframe_dir: &Path) -> NameLookup {
    let path = alecaframe_dir.join("cachedData/custom/basic.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| NameLookup::from_basic_json(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn read_alecaframe_inventory() -> Result<Option<AlecaframeInventory>, String> {
    let availability = crate::local_sources::probe();
    let crate::local_sources::SourceStatus::Available { path } = &availability.alecaframe_inventory
    else {
        // Not an error: the user may simply not run AlecaFrame.
        return Ok(None);
    };

    let blob = std::fs::read(path).map_err(|error| error.to_string())?;
    let json = decrypt_last_data(&blob).map_err(|error| error.to_string())?;
    let directory = path.parent().unwrap_or(Path::new("."));
    let names = load_name_lookup(directory);
    parse_inventory(&json, &names)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reference_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("Resources/WFAndAlecaAppData/AlecaFrame App Data Reference")
    }

    fn reference_inventory() -> AlecaframeInventory {
        let blob = std::fs::read(reference_dir().join("lastData.dat")).expect("lastData.dat");
        let json = decrypt_last_data(&blob).expect("decrypt");
        let names = load_name_lookup(&reference_dir());
        parse_inventory(&json, &names).expect("parse")
    }

    #[test]
    fn decrypts_the_real_reference_payload() {
        let blob = std::fs::read(reference_dir().join("lastData.dat")).expect("lastData.dat");
        let json = decrypt_last_data(&blob).expect("decrypt should succeed");
        assert!(json.starts_with('{'), "expected JSON object");
        let parsed: Value = serde_json::from_str(&json).expect("valid JSON");
        assert!(parsed.get("LastInventorySync").is_some());
    }

    #[test]
    fn a_corrupt_payload_reports_rather_than_panicking() {
        // The realistic failure is AlecaFrame rotating its key, which surfaces as garbage
        // that fails PKCS7 unpadding. It must not take the app down.
        assert!(decrypt_last_data(&[]).is_err(), "empty payload");
        assert!(decrypt_last_data(&[0u8; 7]).is_err(), "not a block multiple");
        assert!(decrypt_last_data(&[0u8; 32]).is_err(), "invalid padding");
    }

    #[test]
    fn decodes_the_sync_timestamp_from_its_object_id() {
        // First 4 bytes are unix seconds; this is the authoritative freshness signal.
        assert_eq!(object_id_timestamp("6a77a19846c260b94a0fc0d8"), Some(0x6a77_a198));
        assert_eq!(object_id_timestamp("short"), None);
    }

    #[test]
    fn reads_account_currencies_from_the_reference_file() {
        // Pinned against `lastData.dat` itself, NOT the committed `warstonks_inventory.json`
        // beside it — that JSON is an older extract (477 platinum, 20 trades remaining) and
        // the .dat has since synced. Same trap a user hits reading a stale snapshot.
        let inventory = reference_inventory();
        assert_eq!(inventory.account.platinum, 672);
        assert_eq!(inventory.account.credits, 4_762_561);
        assert_eq!(inventory.account.fusion_points, 51_096);
        assert_eq!(inventory.account.mastery_rank, 20);
        assert_eq!(inventory.account.trades_remaining, 15);
        // 2026-08-10T21:38:45Z — decoded from the LastInventorySync ObjectId.
        assert_eq!(inventory.last_inventory_sync, Some(1_786_397_925));
    }

    #[test]
    fn resolves_names_through_basic_json() {
        let lookup = load_name_lookup(&reference_dir());
        assert!(lookup.len() > 10_000, "basic.json should hold ~16k entries");
        assert_eq!(lookup.resolve("/Lotus/Types/Items/MiscItems/Ferrite"), "Ferrite");
        // Unknown paths fall through unchanged rather than becoming empty.
        assert_eq!(lookup.resolve("/Lotus/Not/Real"), "/Lotus/Not/Real");
    }

    #[test]
    fn arcanes_are_read_from_both_buckets_not_just_one() {
        // Arcanes split across RawUpgrades (unranked) and Upgrades (ranked). Reading only
        // MiscItems — the intuitive choice — reports zero arcanes.
        let inventory = reference_inventory();
        let arcanes: Vec<_> = inventory
            .items
            .iter()
            .filter(|item| item.category == ItemCategory::Arcane)
            .collect();
        assert!(!arcanes.is_empty(), "reference account owns arcanes");
        assert!(
            arcanes.iter().any(|item| item.bucket == "RawUpgrades"),
            "unranked arcanes live in RawUpgrades"
        );
        assert!(
            arcanes.iter().any(|item| item.bucket == "Upgrades"),
            "ranked arcanes live in Upgrades and must not be dropped"
        );
    }

    #[test]
    fn categorizes_the_paths_that_are_easy_to_get_wrong() {
        assert_eq!(
            categorize("/Lotus/Types/Game/Projections/T1VoidProjectionGaussPrimeABronze"),
            ItemCategory::Relic
        );
        assert_eq!(
            categorize("/Lotus/Upgrades/CosmeticEnhancers/Utility/ArcaneEnergize"),
            ItemCategory::Arcane
        );
        // Prime parts are Recipes, not MiscItems' resources, despite living in MiscItems.
        assert_eq!(
            categorize("/Lotus/Types/Recipes/WarframeRecipes/WispPrimeChassisComponent"),
            ItemCategory::Blueprint
        );
        assert_eq!(categorize("/Lotus/Types/Items/MiscItems/Ferrite"), ItemCategory::Resource);
    }

    #[test]
    fn the_unresolved_name_rate_stays_near_the_documented_seven_percent() {
        // A sudden jump here means basic.json went stale or the lookup broke — worth
        // failing on, since the symptom is otherwise just "some items look like paths".
        let inventory = reference_inventory();
        assert!(!inventory.items.is_empty());
        let rate = inventory.unresolved_name_count as f64 / inventory.items.len() as f64;
        assert!(rate < 0.20, "unresolved name rate {rate:.3} is far above the expected ~0.07");
    }
}
