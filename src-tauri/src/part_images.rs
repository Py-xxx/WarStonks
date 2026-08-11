//! Component icon overrides.
//!
//! Warframe.Market serves every component of a set the **parent item's** art: a Neuroptics, a
//! Chassis and a Systems all come back as the same warframe picture, which makes a set's parts
//! visually indistinguishable everywhere they are listed. We ship our own per-part icons and
//! point the catalog's `preferred_image` at them instead.
//!
//! The override is stored as a sentinel — `warstonks:part/<key>` — rather than a file path, so
//! the backend never has to know which file extension the art happens to use. The frontend maps
//! the key to the bundled asset (`src/assets/partImages/index.ts`).

/// Every part we have art for, and whether a Prime variant exists.
///
/// Mirrors the files in `src/assets/partImages/`; `part_image_assets_match_the_declared_parts`
/// fails if the two drift apart.
const PARTS: &[(&str, bool)] = &[
    ("avionics", false),
    ("band", true),
    ("barrel", true),
    ("blade", true),
    ("buckle", true),
    ("carapace", true),
    ("cerebrum", true),
    ("chassis", true),
    ("collar", true),
    ("disk", true),
    ("engines", false),
    ("fuselage", false),
    ("gauntlet", true),
    ("grip", false),
    ("guard", true),
    ("handle", true),
    ("harness", true),
    ("head", true),
    ("hilt", true),
    ("hook", false),
    ("link", true),
    ("lower_limb", true),
    ("neuroptics", true),
    ("ornament", true),
    ("pouch", true),
    ("receiver", true),
    ("stars", true),
    ("stock", true),
    ("string", true),
    ("systems", true),
    ("upper_limb", true),
    ("wings", true),
];

/// Prefix marking an image path as one of ours rather than a Warframe.Market asset path.
pub const PART_IMAGE_SENTINEL: &str = "warstonks:part/";

/// The component icon for an item name, or `None` when the name is not a component.
///
/// Matching is anchored to the **end** of the name (after an optional trailing "Blueprint"),
/// which is what keeps it from firing on things that merely contain a part word. "Ash Prime
/// Systems Blueprint" is a component; "Ash Prime Set" and "Ash Prime" are not, and neither is a
/// weapon that happens to be called something like "Stock".
pub fn part_image_for_item_name(name: &str) -> Option<String> {
    let lowered = name.to_lowercase();
    let mut tokens: Vec<&str> = lowered.split_whitespace().collect();

    // "Ash Prime Systems Blueprint" and "Braton Prime Barrel" are the same kind of thing; the
    // trailing Blueprint only says it is the buildable form.
    if tokens.last() == Some(&"blueprint") {
        tokens.pop();
    }
    if tokens.len() < 2 {
        // A bare part word is a weapon or an oddity, never a component of a set.
        return None;
    }

    // Two-token parts first, so "Upper Limb" isn't read as a stray "limb". They need a word in
    // front of them to be a component at all — a bare "Upper Limb" is not an item.
    let matched = tokens
        .len()
        .checked_sub(2)
        .filter(|_| tokens.len() >= 3)
        .map(|start| tokens[start..].join("_"))
        .and_then(|candidate| find_part(&candidate))
        .or_else(|| tokens.last().and_then(|token| find_part(token)))?;

    let is_prime = tokens.contains(&"prime");
    let key = if is_prime && matched.1 {
        format!("{}_prime", matched.0)
    } else {
        matched.0.to_string()
    };

    Some(format!("{PART_IMAGE_SENTINEL}{key}"))
}

fn find_part(candidate: &str) -> Option<(&'static str, bool)> {
    PARTS
        .iter()
        .find(|(part, _)| *part == candidate)
        .map(|(part, has_prime)| (*part, *has_prime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn override_key(name: &str) -> Option<String> {
        part_image_for_item_name(name)
            .map(|value| value.trim_start_matches(PART_IMAGE_SENTINEL).to_string())
    }

    #[test]
    fn warframe_components_resolve_to_their_part() {
        assert_eq!(override_key("Ash Prime Neuroptics Blueprint").as_deref(), Some("neuroptics_prime"));
        assert_eq!(override_key("Ash Prime Chassis Blueprint").as_deref(), Some("chassis_prime"));
        assert_eq!(override_key("Ash Prime Systems Blueprint").as_deref(), Some("systems_prime"));
    }

    #[test]
    fn weapon_components_resolve_without_a_blueprint_suffix() {
        assert_eq!(override_key("Braton Prime Barrel").as_deref(), Some("barrel_prime"));
        assert_eq!(override_key("Braton Prime Receiver").as_deref(), Some("receiver_prime"));
        assert_eq!(override_key("Braton Prime Stock").as_deref(), Some("stock_prime"));
    }

    /// The whole point of the `_prime` split: a non-Prime component gets the plain art.
    #[test]
    fn non_prime_components_use_the_plain_variant() {
        assert_eq!(override_key("Boltor Barrel").as_deref(), Some("barrel"));
        assert_eq!(override_key("Excalibur Neuroptics Blueprint").as_deref(), Some("neuroptics"));
    }

    /// Not every part has Prime art. Falling back to the plain icon is right; emitting a key
    /// with no asset behind it would render nothing at all.
    #[test]
    fn parts_without_prime_art_fall_back_to_the_plain_icon() {
        assert_eq!(override_key("Odonata Prime Systems Blueprint").as_deref(), Some("systems_prime"));
        assert_eq!(override_key("Some Prime Grip").as_deref(), Some("grip"));
        assert_eq!(override_key("Some Prime Hook").as_deref(), Some("hook"));
    }

    #[test]
    fn two_word_parts_are_matched_before_their_last_word() {
        assert_eq!(override_key("Cernos Prime Upper Limb").as_deref(), Some("upper_limb_prime"));
        assert_eq!(override_key("Cernos Prime Lower Limb").as_deref(), Some("lower_limb_prime"));
        assert_eq!(override_key("Cernos Upper Limb").as_deref(), Some("upper_limb"));
        // Nothing precedes the part, so it isn't a component of anything.
        assert_eq!(override_key("Upper Limb"), None);
    }

    /// Anchoring to the end of the name is what prevents these. A set and a bare weapon both
    /// keep WFM's own art.
    #[test]
    fn sets_and_whole_items_are_not_components() {
        assert_eq!(override_key("Ash Prime Set"), None);
        assert_eq!(override_key("Ash Prime"), None);
        assert_eq!(override_key("Ash Prime Blueprint"), None);
        assert_eq!(override_key("Braton Prime"), None);
        // A bare part word is a weapon in its own right, not a component.
        assert_eq!(override_key("Stock"), None);
    }

    /// The Rust list and the shipped art are two halves of one fact. If they drift, an item
    /// resolves to a key with no file behind it and simply renders blank.
    #[test]
    fn part_image_assets_match_the_declared_parts() {
        let asset_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .join("src/assets/partImages");

        let mut on_disk = BTreeSet::new();
        for entry in std::fs::read_dir(&asset_dir).expect("part image directory") {
            let entry = entry.expect("directory entry");
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == "index.ts" || file_name.starts_with('.') {
                continue;
            }
            let stem = file_name
                .rsplit_once('.')
                .map(|(stem, _)| stem.to_string())
                .unwrap_or(file_name);
            on_disk.insert(stem);
        }

        let mut declared = BTreeSet::new();
        for (part, has_prime) in PARTS {
            declared.insert((*part).to_string());
            if *has_prime {
                declared.insert(format!("{part}_prime"));
            }
        }

        assert_eq!(declared, on_disk, "PARTS and src/assets/partImages/ disagree");
    }
}
