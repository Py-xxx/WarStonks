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

/// Ducats, as the game names them internally.
const DUCAT_ITEM_TYPE: &str = "/Lotus/Types/Items/MiscItems/PrimeBucks";

/// Reads one stacked item's count out of `MiscItems`.
///
/// Some currencies are inventory stacks rather than wallet fields, so they are absent from the
/// payload's top level entirely and have to be looked up by their `/Lotus/...` type.
fn stacked_item_count(root: &Value, item_type: &str) -> Option<i64> {
    root.get("MiscItems")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("ItemType").and_then(Value::as_str) == Some(item_type))
        .and_then(|entry| entry.get("ItemCount").and_then(Value::as_i64))
}

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
    /// WFM slug. Present for every item that survives the tradability filter, and the hook
    /// a future price lookup hangs off.
    pub slug: String,
    /// WFM item id, for the same reason.
    pub item_key: String,
    /// How many of this item **at this rank**. Ranks are never merged: five Arcane Hot Shot
    /// at rank 0 and one at rank 5 are different goods with different prices, so they are
    /// separate rows.
    pub count: i64,
    /// Current rank. `None` for items where rank is meaningless (prime parts).
    pub rank: Option<i64>,
    /// Max rank for this item, from the catalog. Needed because mods cap at different
    /// levels — a 5/5 is fully ranked while a 7/10 is not.
    pub max_rank: Option<i64>,
    /// Relic refinement. `None` for everything that isn't a relic.
    pub refinement: Option<RelicRefinement>,
    /// Icon for the item. Every inventory tile shows one, so this is not optional in practice
    /// — an item with no art is one the catalog could not resolve, and those are dropped.
    pub image_path: Option<String>,
    /// Which inventory list it came from. Kept because the same item type can live in two
    /// buckets — arcanes split across `RawUpgrades` (unranked) and `Upgrades` (ranked).
    pub bucket: String,
    pub category: ItemCategory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeInventory {
    pub account: AlecaframeAccount,
    /// Authoritative "as of", decoded from `LastInventorySync`. Unix seconds.
    pub last_inventory_sync: Option<i64>,
    pub items: Vec<AlecaframeItem>,
    /// Items dropped because the WFM catalog has no entry for them — Roller Balls, ability
    /// overrides, non-prime frame parts. Surfaced as a count so the filter is visible rather
    /// than silently swallowing things.
    pub untradable_count: usize,
}

/// Stacked buckets: `{ItemType, ItemCount}` per entry.
const STACK_BUCKETS: [&str; 3] = ["MiscItems", "Recipes", "RawUpgrades"];

fn account_i64(root: &Value, key: &str) -> i64 {
    root.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Resolves a `uniqueName` to its WFM catalog entry.
///
/// This is both the naming fix and the tradability filter, because they are the same
/// question. WFM's `gameRef` *is* the game's `/Lotus/...` path, so the catalog's existing
/// lookup tiers resolve these directly — measured at 99.3% of prime parts, 96.5% of mods
/// and 95.8% of arcanes against a real inventory.
///
/// Failing to resolve is meaningful, not an error: **not being in WFM's catalog is what
/// "not tradable" means.** Roller Balls, ability overrides and non-prime frame parts drop
/// out here, while genuinely tradable non-prime items (Perigale, Athodai, Parallax parts)
/// survive — which no "is it Prime?" name heuristic could get right.
///
/// It also fixes names AlecaFrame's own codex can't: `AvatarSlideBoostMod` is **Maglev**,
/// `StatusChanceOnUltimateHit` is **Zid-an Asheir**, and `...HelmetBlueprint` is
/// **Neuroptics**, never "Helmet".
/// Relic refinement, in the game's own order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelicRefinement {
    Intact,
    Exceptional,
    Flawless,
    Radiant,
}

/// The suffix the game appends per refinement, paired with what it means.
const RELIC_REFINEMENT_SUFFIXES: [(&str, RelicRefinement); 4] = [
    ("Bronze", RelicRefinement::Intact),
    ("Silver", RelicRefinement::Exceptional),
    ("Gold", RelicRefinement::Flawless),
    ("Platinum", RelicRefinement::Radiant),
];

/// Splits a relic `uniqueName` into the identity WFM knows and its refinement.
///
/// **WFM lists one item per relic; AlecaFrame stores one per refinement.** So
/// `T4VoidProjectionESilver` is WFM's `T4VoidProjectionE` at Exceptional. Without this
/// split relics resolve at 1.2%; with it, 100% of a real inventory resolves.
///
/// Returns `None` for anything that isn't a relic path, and `(name, None)` for the 8
/// suffix-less entries — those are generic placeholders ("Lith Relic", "Void Relic"), not
/// ownable items, so they must not be forced into a refinement.
///
/// Note what this deliberately does *not* do: derive a label. `T1VoidProjectionGaussPrimeA`
/// is **Lith C11**, not "Lith G1" — the letter+number is editorial and unrelated to the
/// path. The display name always comes from the catalog.
pub fn split_relic_unique_name(unique_name: &str) -> Option<(String, Option<RelicRefinement>)> {
    if !unique_name.contains("/Projections/") {
        return None;
    }
    for (suffix, refinement) in RELIC_REFINEMENT_SUFFIXES {
        if let Some(stem) = unique_name.strip_suffix(suffix) {
            return Some((stem.to_string(), Some(refinement)));
        }
    }
    Some((unique_name.to_string(), None))
}

#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub item_key: String,
    pub slug: String,
    pub name: String,
    /// `None` for items that do not rank at all.
    pub max_rank: Option<i64>,
    /// Warframe.Market art. The frontend swaps in its own component icon when the slug names
    /// a part, so this is the fallback for everything that isn't one.
    pub image_path: Option<String>,
}

type CatalogResolver<'a> = dyn Fn(&str) -> Option<CatalogEntry> + 'a;

/// Reads the rank out of an instanced upgrade's fingerprint.
///
/// The fingerprint is JSON embedded in a JSON string, so it needs parsing twice. `lvl` is
/// 0-indexed and **absent rather than zero** on an unranked instance, so a missing key
/// means rank 0, not "unknown". Rivens carry a much larger fingerprint (`compat`, `buffs`,
/// `curses`); they still expose `lvl` when ranked and are handled by the same path.
fn fingerprint_rank(entry: &Value) -> i64 {
    entry
        .get("UpgradeFingerprint")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|parsed| parsed.get("lvl").and_then(Value::as_i64))
        .unwrap_or(0)
}

pub fn parse_inventory(
    json: &str,
    names: &NameLookup,
    resolve: &CatalogResolver<'_>,
) -> Result<AlecaframeInventory> {
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
    let mut untradable_count = 0;

    let push = |unique_name: &str,
                count: i64,
                bucket: &str,
                rank: Option<i64>,
                items: &mut Vec<AlecaframeItem>| {
        // A relic's own uniqueName carries its refinement, which WFM's catalog has no entry
        // for. Resolving the stripped form is what stops every relic being discarded as
        // untradable; the refinement is kept alongside rather than thrown away.
        let (lookup_key, refinement) = match split_relic_unique_name(unique_name) {
            Some((stem, refinement)) => (stem, refinement),
            None => (unique_name.to_string(), None),
        };
        match resolve(&lookup_key) {
            Some(entry) => {
                items.push(AlecaframeItem {
                    unique_name: unique_name.to_string(),
                    // WFM's name, not AlecaFrame's — keeps the inventory consistent with the
                    // Market, watchlist and trade log, which all name items this way.
                    name: if entry.name.is_empty() {
                        names.resolve(unique_name)
                    } else {
                        entry.name
                    },
                    slug: entry.slug,
                    item_key: entry.item_key,
                    count,
                    // Rank only means something for items that rank; a prime part reporting
                    // "rank 0" would be noise.
                    rank: entry.max_rank.and(rank),
                    max_rank: entry.max_rank,
                    refinement,
                    image_path: entry.image_path,
                    bucket: bucket.to_string(),
                    category: categorize(unique_name),
                });
                true
            }
            None => false,
        }
    };

    for bucket in STACK_BUCKETS {
        let Some(entries) = root.get(bucket).and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            let Some(unique_name) = entry.get("ItemType").and_then(Value::as_str) else {
                continue;
            };
            let count = entry.get("ItemCount").and_then(Value::as_i64).unwrap_or(0);
            // `RawUpgrades` is by definition the unranked stack, so anything rankable here
            // is rank 0.
            let rank = (bucket == "RawUpgrades").then_some(0);
            if !push(unique_name, count, bucket, rank, &mut items) {
                untradable_count += 1;
            }
        }
    }

    // `Upgrades` holds ranked/instanced mods, arcanes and rivens — one object per instance
    // rather than a stack. Skipping this bucket entirely would report zero ranked arcanes,
    // which is the classic mistake. Instances are collapsed by **(item, rank)** rather than
    // by item alone: a rank-5 arcane and a rank-0 one are separately priced goods, so
    // merging them into "6x Arcane Hot Shot" would hide the only thing that matters.
    if let Some(entries) = root.get("Upgrades").and_then(Value::as_array) {
        let mut instanced: HashMap<(&str, i64), i64> = HashMap::new();
        for entry in entries {
            if let Some(unique_name) = entry.get("ItemType").and_then(Value::as_str) {
                *instanced.entry((unique_name, fingerprint_rank(entry))).or_insert(0) += 1;
            }
        }
        // HashMap order is arbitrary; sort so equal-count rows don't shuffle between reads.
        let mut instanced: Vec<_> = instanced.into_iter().collect();
        instanced.sort_by(|left, right| left.0.cmp(&right.0));
        for ((unique_name, rank), count) in instanced {
            if !push(unique_name, count, "Upgrades", Some(rank), &mut items) {
                untradable_count += 1;
            }
        }
    }

    // Merge rows that are indistinguishable once rank has been resolved.
    //
    // `Upgrades` groups instances by their *fingerprint* rank, but an item the catalog gives no
    // rank ladder for — riven mods, notably — has that rank discarded as meaningless. Three
    // veiled rivens at fingerprint ranks 0, 5 and 8 therefore became three rows identical in
    // every displayed field, which collided on the same React key: they rendered duplicated and
    // survived tab switches because React reused the DOM nodes. One item, one row.
    let mut merged: Vec<AlecaframeItem> = Vec::with_capacity(items.len());
    for item in items {
        match merged.iter_mut().find(|existing| {
            existing.unique_name == item.unique_name
                && existing.bucket == item.bucket
                && existing.rank == item.rank
                && existing.refinement == item.refinement
        }) {
            Some(existing) => existing.count += item.count,
            None => merged.push(item),
        }
    }
    let mut items = merged;

    items.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.rank.cmp(&right.rank))
    });

    Ok(AlecaframeInventory {
        account,
        last_inventory_sync,
        items,
        untradable_count,
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
pub fn read_alecaframe_inventory(
    app: tauri::AppHandle,
) -> Result<Option<AlecaframeInventory>, String> {
    // The setting is a real gate, not decoration: a user who turns this off should stop
    // having their AlecaFrame data read at all, not merely stop seeing a tab.
    let enabled = crate::settings::load_settings_inner(&app)
        .map(|settings| settings.alecaframe.enabled)
        .unwrap_or(false);
    if !enabled {
        return Ok(None);
    }

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

    // Without the catalog every item would read as untradable and the inventory would come
    // back empty — which looks identical to "you own nothing". Say so instead.
    let catalog = crate::item_catalog_v2::open_catalog_v2_from_remembered_path()
        .ok_or_else(|| "Item catalog is not ready yet — try again once startup finishes.".to_string())?;

    let resolve = |unique_name: &str| {
        crate::item_catalog_v2::lookup_item_v2_inner(&catalog, unique_name)
            .ok()
            .flatten()
            .map(|item| CatalogEntry {
                item_key: item.item_key,
                slug: item.slug,
                name: item.name_en,
                max_rank: item.max_rank,
                image_path: item.preferred_image,
            })
    };

    parse_inventory(&json, &names, &resolve)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// Builds the wallet snapshot from AlecaFrame's local data.
///
/// Replaces the old API-backed wallet: the same numbers are already in `lastData.dat`, so
/// this costs no network request and cannot be rate-limited or return a stale server-side
/// cache. Ducats are not in the payload — the game does not report a ducat balance — so that
/// field stays `None` rather than being invented.
#[tauri::command]
pub fn refresh_wallet_from_appdata(
    app: tauri::AppHandle,
) -> Result<crate::settings::WalletSnapshot, String> {
    let enabled = crate::settings::load_settings_inner(&app)
        .map(|settings| settings.alecaframe.enabled)
        .unwrap_or(false);

    let empty = crate::settings::WalletSnapshot {
        enabled,
        configured: enabled,
        balances: crate::settings::CurrencyBalance {
            platinum: None,
            credits: None,
            endo: None,
            ducats: None,
            aya: None,
        },
        username_when_public: None,
        last_update: None,
        error_message: None,
    };

    if !enabled {
        return Ok(empty);
    }

    let availability = crate::local_sources::probe();
    let crate::local_sources::SourceStatus::Available { path } = &availability.alecaframe_inventory
    else {
        return Ok(crate::settings::WalletSnapshot {
            error_message: Some("AlecaFrame data was not found on this PC.".to_string()),
            ..empty
        });
    };

    let parsed = std::fs::read(path)
        .map_err(|error| error.to_string())
        .and_then(|blob| decrypt_last_data(&blob).map_err(|error| error.to_string()))
        .and_then(|json| {
            serde_json::from_str::<Value>(&json).map_err(|error| error.to_string())
        });

    match parsed {
        Err(message) => Ok(crate::settings::WalletSnapshot {
            error_message: Some(message),
            ..empty
        }),
        Ok(root) => {
            let last_update = root
                .get("LastInventorySync")
                .and_then(oid_of)
                .and_then(object_id_timestamp)
                .and_then(|seconds| {
                    time::OffsetDateTime::from_unix_timestamp(seconds)
                        .ok()
                        .and_then(|value| {
                            value
                                .format(&time::format_description::well_known::Rfc3339)
                                .ok()
                        })
                });

            Ok(crate::settings::WalletSnapshot {
                enabled,
                configured: true,
                balances: crate::settings::CurrencyBalance {
                    platinum: root.get("PremiumCredits").and_then(Value::as_i64),
                    credits: root.get("RegularCredits").and_then(Value::as_i64),
                    endo: root.get("FusionPoints").and_then(Value::as_i64),
                    // Ducats are not a wallet field — the game holds them as an inventory
                    // stack under their internal name, "PrimeBucks". Verified against the
                    // reference payload, which carries 286 of them while every top-level key
                    // is silent about ducats.
                    ducats: stacked_item_count(&root, DUCAT_ITEM_TYPE),
                    aya: root.get("PrimeTokens").and_then(Value::as_i64),
                },
                username_when_public: None,
                last_update,
                error_message: None,
            })
        }
    }
}

/// Owned relics, grouped the way the relic cache stores them: `(tier, code)` with a count per
/// refinement.
///
/// Replaces the old API-backed relic fetch. Tier and code come from the **catalog's display
/// name** ("Lith C11 Relic" → `Lith` / `C11`) and never from the path — `T1VoidProjectionGaussPrimeA`
/// is Lith C11, and the letter+number in the path is unrelated editorial naming.
pub fn owned_relic_counts(
    inventory: &AlecaframeInventory,
) -> Vec<(String, String, RelicRefinement, i64)> {
    let mut out = Vec::new();
    for item in &inventory.items {
        let Some(refinement) = item.refinement else {
            continue;
        };
        // "Lith C11 Relic" -> ("Lith", "C11"). Anything that doesn't split cleanly is skipped
        // rather than guessed at.
        let mut parts = item.name.split_whitespace();
        let (Some(tier), Some(code)) = (parts.next(), parts.next()) else {
            continue;
        };
        out.push((tier.to_string(), code.to_string(), refinement, item.count));
    }
    out
}

/// Reads the inventory straight from disk for callers outside the Tauri command layer.
pub fn load_inventory_for_internal_use(
    app: &tauri::AppHandle,
) -> Result<Option<AlecaframeInventory>> {
    let enabled = crate::settings::load_settings_inner(app)
        .map(|settings| settings.alecaframe.enabled)
        .unwrap_or(false);
    if !enabled {
        return Ok(None);
    }

    let availability = crate::local_sources::probe();
    let crate::local_sources::SourceStatus::Available { path } = &availability.alecaframe_inventory
    else {
        return Ok(None);
    };

    let blob = std::fs::read(path)?;
    let json = decrypt_last_data(&blob)?;
    let names = load_name_lookup(path.parent().unwrap_or(Path::new(".")));
    let catalog = crate::item_catalog_v2::open_catalog_v2_from_remembered_path()
        .ok_or_else(|| anyhow!("Item catalog is not ready yet."))?;
    let resolve = |unique_name: &str| {
        crate::item_catalog_v2::lookup_item_v2_inner(&catalog, unique_name)
            .ok()
            .flatten()
            .map(|item| CatalogEntry {
                item_key: item.item_key,
                slug: item.slug,
                name: item.name_en,
                max_rank: item.max_rank,
                image_path: item.preferred_image,
            })
    };
    parse_inventory(&json, &names, &resolve).map(Some)
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

    /// Stands in for the WFM catalog, which isn't built in unit tests. Accepts anything the
    /// game marks as a prime part, mod or arcane and rejects the rest — enough to exercise
    /// the tradability filter without a database.
    fn stub_resolver(unique_name: &str) -> Option<CatalogEntry> {
        let tradable = unique_name.contains("Prime")
            || unique_name.starts_with("/Lotus/Upgrades/Mods/")
            || unique_name.starts_with("/Lotus/Upgrades/CosmeticEnhancers/")
            // Only the *stripped* form should ever reach here for relics.
            || (unique_name.contains("/Projections/")
                && !unique_name.ends_with("Bronze")
                && !unique_name.ends_with("Silver")
                && !unique_name.ends_with("Gold")
                && !unique_name.ends_with("Platinum"));
        if !tradable {
            return None;
        }
        let leaf = unique_name.rsplit('/').next().unwrap_or(unique_name);
        Some(CatalogEntry {
            item_key: format!("key-{leaf}"),
            slug: leaf.to_lowercase(),
            name: format!("WFM {leaf}"),
            image_path: Some(format!("items/images/en/thumbs/{leaf}.png")),
            // Arcanes cap at 5, mods at 10 here — enough to exercise "different maxima".
            max_rank: if unique_name.starts_with("/Lotus/Upgrades/CosmeticEnhancers/") {
                Some(5)
            } else if unique_name.starts_with("/Lotus/Upgrades/Mods/") {
                Some(10)
            } else {
                None
            },
        })
    }

    fn reference_inventory() -> AlecaframeInventory {
        let blob = std::fs::read(reference_dir().join("lastData.dat")).expect("lastData.dat");
        let json = decrypt_last_data(&blob).expect("decrypt");
        let names = load_name_lookup(&reference_dir());
        parse_inventory(&json, &names, &stub_resolver).expect("parse")
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

    /// Ducats are not a wallet field. The game keeps them as an inventory stack named
    /// "PrimeBucks", which is why the wallet reported a dash for them while the payload had
    /// 286 sitting in `MiscItems` all along.
    #[test]
    fn ducats_are_read_from_the_inventory_stack_not_the_wallet_fields() {
        let json = std::fs::read(reference_dir().join("lastData.dat")).expect("reference dat");
        let decrypted = decrypt_last_data(&json).expect("decrypts");
        let root: Value = serde_json::from_str(&decrypted).expect("parses");

        assert_eq!(
            root.get("Ducats"),
            None,
            "no top-level ducat field exists — that is the whole trap",
        );
        assert_eq!(stacked_item_count(&root, DUCAT_ITEM_TYPE), Some(286));
        // An item the account does not hold reads as absent rather than zero.
        assert_eq!(
            stacked_item_count(&root, "/Lotus/Types/Items/MiscItems/NotAThing"),
            None,
        );
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

    /// Two symptoms, one cause: veiled rivens rendering duplicated, and surviving onto tabs
    /// they do not belong to. `Upgrades` groups instances by fingerprint rank, but an item the
    /// catalog gives no rank ladder for has that rank discarded — so several instances became
    /// rows identical in every field, colliding on the same React key.
    #[test]
    fn instances_that_differ_only_by_a_discarded_rank_become_one_row() {
        let json = r#"{
          "Upgrades": [
            {"ItemType": "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
             "UpgradeFingerprint": "{\"lvl\":0}"},
            {"ItemType": "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
             "UpgradeFingerprint": "{\"lvl\":5}"},
            {"ItemType": "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
             "UpgradeFingerprint": "{\"lvl\":8}"}
          ]
        }"#;

        // No rank ladder, exactly as WFM lists a veiled riven.
        let resolve = |_unique_name: &str| {
            Some(CatalogEntry {
                item_key: "key-riven".to_string(),
                slug: "rifle_riven_mod_veiled".to_string(),
                name: "Rifle Riven Mod (Veiled)".to_string(),
                max_rank: None,
                image_path: None,
            })
        };
        let _ = &resolve;
        let inventory = parse_inventory(json, &NameLookup::default(), &resolve).expect("parses");

        assert_eq!(inventory.items.len(), 1, "three instances, one indistinguishable row");
        assert_eq!(inventory.items[0].count, 3, "and their counts add up");
        assert_eq!(
            inventory.items[0].category,
            ItemCategory::Mod,
            "a riven is a mod and must never appear under arcanes",
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
    fn reads_the_rank_out_of_an_instanced_upgrade() {
        let ranked = serde_json::json!({ "UpgradeFingerprint": "{\"lvl\":5}" });
        assert_eq!(fingerprint_rank(&ranked), 5);

        // Absent `lvl` means rank 0, not "unknown" — the game omits it when unranked.
        let unranked = serde_json::json!({ "UpgradeFingerprint": "{}" });
        assert_eq!(fingerprint_rank(&unranked), 0);
        assert_eq!(fingerprint_rank(&serde_json::json!({})), 0);

        // A riven's fingerprint is far larger but exposes `lvl` the same way.
        let riven = serde_json::json!({
            "UpgradeFingerprint": "{\"compat\":\"/Lotus/Weapons/X\",\"lvl\":3,\"rerolls\":2}"
        });
        assert_eq!(fingerprint_rank(&riven), 3);
    }

    #[test]
    fn the_same_item_at_different_ranks_stays_on_separate_rows() {
        // The whole point: 5x rank-0 and 1x rank-5 Arcane Hot Shot are differently priced
        // goods. Collapsing them into "6x" would hide the only thing that matters.
        let payload = serde_json::json!({
            "Upgrades": [
                { "ItemType": "/Lotus/Upgrades/CosmeticEnhancers/HotShot", "UpgradeFingerprint": "{\"lvl\":5}" },
                { "ItemType": "/Lotus/Upgrades/CosmeticEnhancers/HotShot", "UpgradeFingerprint": "{\"lvl\":0}" },
                { "ItemType": "/Lotus/Upgrades/CosmeticEnhancers/HotShot", "UpgradeFingerprint": "{\"lvl\":0}" },
            ]
        })
        .to_string();

        let inventory =
            parse_inventory(&payload, &NameLookup::default(), &stub_resolver).expect("parse");
        assert_eq!(inventory.items.len(), 2, "one row per rank, got {:?}", inventory.items);

        let rank5 = inventory.items.iter().find(|i| i.rank == Some(5)).expect("rank 5 row");
        let rank0 = inventory.items.iter().find(|i| i.rank == Some(0)).expect("rank 0 row");
        assert_eq!(rank5.count, 1);
        assert_eq!(rank0.count, 2);
        assert_eq!(rank5.max_rank, Some(5));
    }

    #[test]
    fn unranked_stacks_are_rank_zero_and_prime_parts_have_no_rank_at_all() {
        let payload = serde_json::json!({
            // RawUpgrades is by definition the unranked stack.
            "RawUpgrades": [
                { "ItemType": "/Lotus/Upgrades/Mods/Warframe/SomeMod", "ItemCount": 4 }
            ],
            // A prime part reporting "rank 0" would be meaningless noise.
            "MiscItems": [
                { "ItemType": "/Lotus/Types/Recipes/WarframeRecipes/AshPrimeHelmetBlueprint", "ItemCount": 2 }
            ]
        })
        .to_string();

        let inventory =
            parse_inventory(&payload, &NameLookup::default(), &stub_resolver).expect("parse");
        let mod_row = inventory.items.iter().find(|i| i.category == ItemCategory::Mod).unwrap();
        assert_eq!(mod_row.rank, Some(0));
        assert_eq!(mod_row.max_rank, Some(10));

        let part = inventory.items.iter().find(|i| i.category == ItemCategory::Blueprint).unwrap();
        assert_eq!(part.rank, None, "prime parts do not rank");
        assert_eq!(part.max_rank, None);
    }

    #[test]
    fn splits_a_relic_into_its_wfm_identity_and_refinement() {
        let (stem, refinement) =
            split_relic_unique_name("/Lotus/Types/Game/Projections/T4VoidProjectionESilver")
                .expect("relic");
        assert_eq!(stem, "/Lotus/Types/Game/Projections/T4VoidProjectionE");
        assert_eq!(refinement, Some(RelicRefinement::Exceptional));

        for (suffix, expected) in RELIC_REFINEMENT_SUFFIXES {
            let path = format!("/Lotus/Types/Game/Projections/T1VoidProjectionA{suffix}");
            let (stem, refinement) = split_relic_unique_name(&path).unwrap();
            assert_eq!(stem, "/Lotus/Types/Game/Projections/T1VoidProjectionA");
            assert_eq!(refinement, Some(expected));
        }

        // Non-relic paths are left entirely alone.
        assert_eq!(split_relic_unique_name("/Lotus/Upgrades/Mods/Warframe/X"), None);
    }

    #[test]
    fn the_eight_suffixless_relics_are_not_forced_into_a_refinement() {
        // "Lith Relic", "Void Relic" and friends are generic placeholders, not ownable
        // items. Assuming the suffix always exists would silently mislabel them Intact.
        for path in [
            "/Lotus/Types/Game/Projections/T1VoidProjection",
            "/Lotus/Types/Game/Projections/T0VoidProjection",
            // T5 is *mostly* Requiem, but this one is plain "Void Relic" — the tier code is
            // a hint, never a guarantee.
            "/Lotus/Types/Game/Projections/T5VoidProjectionImmortalOmni",
        ] {
            let (stem, refinement) = split_relic_unique_name(path).expect("relic path");
            assert_eq!(stem, path, "nothing should be stripped");
            assert_eq!(refinement, None);
        }
    }

    #[test]
    fn relics_survive_the_tradability_filter_and_keep_their_refinement() {
        // Before the split every relic failed catalog lookup (1.2% matched) and was thrown
        // away as untradable. Measured against the real inventory, stripping takes that to
        // 100%.
        let payload = serde_json::json!({
            "MiscItems": [
                { "ItemType": "/Lotus/Types/Game/Projections/T1VoidProjectionGaussPrimeABronze", "ItemCount": 3 },
                { "ItemType": "/Lotus/Types/Game/Projections/T1VoidProjectionGaussPrimeAGold", "ItemCount": 1 }
            ]
        })
        .to_string();

        let inventory =
            parse_inventory(&payload, &NameLookup::default(), &stub_resolver).expect("parse");
        assert_eq!(inventory.untradable_count, 0, "relics must not be discarded");
        assert_eq!(inventory.items.len(), 2, "one row per refinement");

        let intact = inventory
            .items
            .iter()
            .find(|item| item.refinement == Some(RelicRefinement::Intact))
            .expect("intact row");
        assert_eq!(intact.count, 3);
        assert_eq!(intact.category, ItemCategory::Relic);
        // Gold is Flawless, not Radiant — Platinum is Radiant. Both refinements of the same
        // relic share one WFM identity.
        let flawless = inventory
            .items
            .iter()
            .find(|item| item.refinement == Some(RelicRefinement::Flawless))
            .expect("flawless row");
        assert_eq!(flawless.count, 1);
        assert_eq!(intact.slug, flawless.slug);
    }

    #[test]
    fn items_absent_from_the_catalog_are_dropped_as_untradable() {
        // Not being in WFM's catalog IS what "not tradable" means, so Roller Balls, ability
        // overrides and non-prime frame parts must not reach the inventory at all.
        let inventory = reference_inventory();
        assert!(!inventory.items.is_empty(), "tradable items should survive");
        assert!(inventory.untradable_count > 0, "reference account holds untradable items");
        for item in &inventory.items {
            assert!(!item.slug.is_empty(), "a surviving item must carry its WFM slug");
            assert!(!item.item_key.is_empty(), "and its WFM item id, for pricing later");
        }
    }

    #[test]
    fn names_come_from_the_catalog_not_alecaframe() {
        // AlecaFrame's codex cannot name several real items (AvatarSlideBoostMod is Maglev,
        // ...HelmetBlueprint is Neuroptics). WFM can, and using it keeps the inventory
        // consistent with the Market, watchlist and trade log.
        let inventory = reference_inventory();
        assert!(
            inventory.items.iter().all(|item| item.name.starts_with("WFM ")),
            "every name should come from the resolver"
        );
        assert!(
            !inventory.items.iter().any(|item| item.name.starts_with("/Lotus/")),
            "no raw path should survive into the inventory"
        );
    }
}
