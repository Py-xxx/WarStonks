-- Item catalog schema generated from:
--   data/v2_items.json
--   data/wfstat-items.json
--
-- Observed on 2026-03-10:
--   WFM items: 3751
--   WFStat full items: 16901
--   Direct top-level matches by gameRef = uniqueName: 2193
--   Direct + component uniqueName matches: 2806
--   Coverage after marketInfo/name/blueprint fallback rules: 3718 / 3751
--   Manual alias candidates remaining after generic rules: 33
--
-- Important:
-- 1. Do not assume a 1:1 match between sources.
-- 2. Keep raw JSON from each source so no source fields are lost.
-- 3. Relic refinements such as Intact / Exceptional / Flawless / Radiant
--    are source variants of the same canonical relic, not separate items.
-- 4. Arrays and nested objects are normalized into child tables instead of
--    flattening them into one giant sparse table.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_versions (
  source_name TEXT PRIMARY KEY,
  api_version TEXT,
  content_sha256 TEXT,
  item_count INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  source_file TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS items (
  item_id INTEGER PRIMARY KEY,
  canonical_ref TEXT NOT NULL UNIQUE,
  canonical_name TEXT,
  canonical_name_normalized TEXT,
  base_name TEXT,
  item_family TEXT,
  parent_item_id INTEGER REFERENCES items (item_id) ON DELETE SET NULL,
  match_status TEXT NOT NULL,
  primary_match_method TEXT,
  preferred_name TEXT,
  preferred_slug TEXT,
  preferred_image TEXT,
  wfm_id TEXT UNIQUE,
  wfm_slug TEXT,
  wfm_game_ref TEXT,
  primary_wfstat_unique_name TEXT,
  wfstat_name TEXT,
  relic_tier TEXT,
  relic_code TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_wfm_game_ref ON items (wfm_game_ref);
CREATE INDEX IF NOT EXISTS idx_items_primary_wfstat_unique_name ON items (primary_wfstat_unique_name);
CREATE INDEX IF NOT EXISTS idx_items_match_status ON items (match_status);
CREATE INDEX IF NOT EXISTS idx_items_parent_item_id ON items (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_items_canonical_name_normalized ON items (canonical_name_normalized);
CREATE INDEX IF NOT EXISTS idx_items_item_family ON items (item_family);

CREATE TABLE IF NOT EXISTS item_aliases (
  alias_id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  alias_scope TEXT NOT NULL,
  alias_value TEXT NOT NULL,
  normalized_alias_value TEXT,
  source_name TEXT,
  source_table TEXT,
  source_record_key TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_aliases_item_id ON item_aliases (item_id);
CREATE INDEX IF NOT EXISTS idx_item_aliases_scope_value ON item_aliases (alias_scope, alias_value);
CREATE INDEX IF NOT EXISTS idx_item_aliases_scope_normalized ON item_aliases (alias_scope, normalized_alias_value);

CREATE TABLE IF NOT EXISTS item_source_matches (
  source_match_id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items (item_id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_key TEXT NOT NULL,
  source_record_label TEXT,
  match_method TEXT NOT NULL,
  matched_field TEXT,
  matched_value TEXT,
  confidence REAL,
  is_manual INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_source_matches_unique_source
  ON item_source_matches (source_name, source_table, source_record_key);
CREATE INDEX IF NOT EXISTS idx_item_source_matches_item_id ON item_source_matches (item_id);
CREATE INDEX IF NOT EXISTS idx_item_source_matches_method ON item_source_matches (match_method);

CREATE TABLE IF NOT EXISTS item_manual_aliases (
  manual_alias_id INTEGER PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  lookup_type TEXT NOT NULL,
  lookup_value TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_value TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_manual_aliases_lookup
  ON item_manual_aliases (source_name, source_table, lookup_type, lookup_value);

CREATE TABLE IF NOT EXISTS item_variants (
  variant_id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  source_name TEXT,
  source_table TEXT,
  source_record_key TEXT,
  variant_group_name TEXT,
  variant_group_name_normalized TEXT,
  variant_kind TEXT NOT NULL,
  variant_value TEXT,
  variant_value_normalized TEXT,
  variant_rank INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_variants_item_id ON item_variants (item_id);
CREATE INDEX IF NOT EXISTS idx_item_variants_group ON item_variants (variant_group_name_normalized);
CREATE INDEX IF NOT EXISTS idx_item_variants_kind_value ON item_variants (variant_kind, variant_value_normalized);

CREATE TABLE IF NOT EXISTS item_relationships (
  relationship_id INTEGER PRIMARY KEY,
  parent_item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  child_item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  source_name TEXT,
  source_record_key TEXT,
  relationship_label TEXT,
  sort_order INTEGER,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_relationships_parent ON item_relationships (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relationships_child ON item_relationships (child_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relationships_type ON item_relationships (relationship_type);

CREATE TABLE IF NOT EXISTS wfm_items (
  wfm_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  game_ref TEXT,
  name_en TEXT,
  normalized_name_en TEXT,
  item_family TEXT,
  variant_group_name TEXT,
  variant_group_name_normalized TEXT,
  variant_kind TEXT,
  variant_value TEXT,
  variant_value_normalized TEXT,
  variant_rank INTEGER,
  icon TEXT,
  thumb TEXT,
  sub_icon TEXT,
  base_endo INTEGER,
  bulk_tradable INTEGER,
  ducats INTEGER,
  endo_multiplier REAL,
  max_amber_stars INTEGER,
  max_cyan_stars INTEGER,
  max_rank INTEGER,
  vaulted INTEGER,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wfm_items_item_id ON wfm_items (item_id);
CREATE INDEX IF NOT EXISTS idx_wfm_items_game_ref ON wfm_items (game_ref);
CREATE INDEX IF NOT EXISTS idx_wfm_items_slug ON wfm_items (slug);
CREATE INDEX IF NOT EXISTS idx_wfm_items_normalized_name ON wfm_items (normalized_name_en);
CREATE INDEX IF NOT EXISTS idx_wfm_items_variant_group ON wfm_items (variant_group_name_normalized);

CREATE TABLE IF NOT EXISTS wfm_item_i18n (
  wfm_id TEXT NOT NULL REFERENCES wfm_items (wfm_id) ON DELETE CASCADE,
  lang_code TEXT NOT NULL,
  name TEXT,
  icon TEXT,
  thumb TEXT,
  sub_icon TEXT,
  PRIMARY KEY (wfm_id, lang_code)
);

CREATE TABLE IF NOT EXISTS wfm_item_tags (
  wfm_id TEXT NOT NULL REFERENCES wfm_items (wfm_id) ON DELETE CASCADE,
  tag_index INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (wfm_id, tag_index)
);

CREATE INDEX IF NOT EXISTS idx_wfm_item_tags_tag ON wfm_item_tags (tag);

CREATE TABLE IF NOT EXISTS wfm_item_subtypes (
  wfm_id TEXT NOT NULL REFERENCES wfm_items (wfm_id) ON DELETE CASCADE,
  subtype_index INTEGER NOT NULL,
  subtype TEXT NOT NULL,
  PRIMARY KEY (wfm_id, subtype_index)
);

CREATE TABLE IF NOT EXISTS wfstat_items (
  wfstat_unique_name TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT,
  item_family TEXT,
  variant_group_name TEXT,
  variant_group_name_normalized TEXT,
  variant_kind TEXT,
  variant_value TEXT,
  variant_value_normalized TEXT,
  variant_rank INTEGER,
  description TEXT,
  category TEXT,
  type TEXT,
  image_name TEXT,
  compat_name TEXT,
  rarity TEXT,
  polarity TEXT,
  stance_polarity TEXT,
  product_category TEXT,
  mod_set TEXT,
  tradable INTEGER NOT NULL,
  masterable INTEGER,
  transmutable INTEGER,
  is_augment INTEGER,
  is_prime INTEGER,
  is_exilus INTEGER,
  is_utility INTEGER,
  vaulted INTEGER,
  wiki_available INTEGER,
  exclude_from_codex INTEGER,
  show_in_inventory INTEGER,
  consume_on_build INTEGER,
  base_drain INTEGER,
  fusion_limit INTEGER,
  item_count INTEGER,
  mastery_req INTEGER,
  market_cost INTEGER,
  bp_cost INTEGER,
  build_price INTEGER,
  build_quantity INTEGER,
  build_time INTEGER,
  skip_build_time_price INTEGER,
  accuracy REAL,
  critical_chance REAL,
  critical_multiplier REAL,
  fire_rate REAL,
  omega_attenuation REAL,
  proc_chance REAL,
  reload_time REAL,
  magazine_size INTEGER,
  multishot INTEGER,
  slot INTEGER,
  total_damage REAL,
  disposition INTEGER,
  range REAL,
  follow_through REAL,
  blocking_angle INTEGER,
  combo_duration INTEGER,
  heavy_attack_damage INTEGER,
  heavy_slam_attack INTEGER,
  heavy_slam_radial_damage INTEGER,
  heavy_slam_radius INTEGER,
  slam_attack INTEGER,
  slam_radial_damage INTEGER,
  slam_radius INTEGER,
  slide_attack INTEGER,
  wind_up REAL,
  power INTEGER,
  stamina INTEGER,
  health INTEGER,
  shield INTEGER,
  armor INTEGER,
  sprint_speed REAL,
  region_bits INTEGER,
  release_date TEXT,
  vault_date TEXT,
  estimated_vault_date TEXT,
  wikia_thumbnail TEXT,
  wikia_url TEXT,
  noise TEXT,
  trigger TEXT,
  market_info_id TEXT,
  market_info_url_name TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wfstat_items_item_id ON wfstat_items (item_id);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_name ON wfstat_items (name);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_normalized_name ON wfstat_items (normalized_name);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_type ON wfstat_items (type);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_category ON wfstat_items (category);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_variant_group ON wfstat_items (variant_group_name_normalized);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_market_info_id ON wfstat_items (market_info_id);
CREATE INDEX IF NOT EXISTS idx_wfstat_items_market_info_url_name ON wfstat_items (market_info_url_name);

CREATE TABLE IF NOT EXISTS wfstat_item_introduced (
  wfstat_unique_name TEXT PRIMARY KEY REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  introduced_name TEXT,
  introduced_url TEXT,
  introduced_parent TEXT,
  introduced_date TEXT,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wfstat_item_introduced_aliases (
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_item_introduced (wfstat_unique_name) ON DELETE CASCADE,
  alias_index INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (wfstat_unique_name, alias_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_damage (
  wfstat_unique_name TEXT PRIMARY KEY REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  blast REAL,
  cinematic REAL,
  cold REAL,
  corrosive REAL,
  electricity REAL,
  energy_drain REAL,
  gas REAL,
  health_drain REAL,
  heat REAL,
  impact REAL,
  magnetic REAL,
  puncture REAL,
  radiation REAL,
  shield_drain REAL,
  slash REAL,
  tau REAL,
  total REAL,
  toxin REAL,
  true_damage REAL,
  viral REAL,
  void REAL
);

CREATE TABLE IF NOT EXISTS wfstat_item_damage_per_shot (
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  shot_index INTEGER NOT NULL,
  damage_value REAL,
  PRIMARY KEY (wfstat_unique_name, shot_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_tags (
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  tag_index INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (wfstat_unique_name, tag_index)
);

CREATE INDEX IF NOT EXISTS idx_wfstat_item_tags_tag ON wfstat_item_tags (tag);

CREATE TABLE IF NOT EXISTS wfstat_item_polarities (
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  polarity_index INTEGER NOT NULL,
  polarity TEXT NOT NULL,
  PRIMARY KEY (wfstat_unique_name, polarity_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_parents (
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  parent_index INTEGER NOT NULL,
  parent_item_id INTEGER REFERENCES items (item_id) ON DELETE SET NULL,
  parent_value TEXT NOT NULL,
  PRIMARY KEY (wfstat_unique_name, parent_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_levels (
  level_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  level_index INTEGER NOT NULL,
  UNIQUE (wfstat_unique_name, level_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_level_stat_lines (
  level_id INTEGER NOT NULL REFERENCES wfstat_item_levels (level_id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  stat_text TEXT NOT NULL,
  PRIMARY KEY (level_id, line_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_drops (
  drop_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  drop_index INTEGER NOT NULL,
  drop_item_id INTEGER REFERENCES items (item_id) ON DELETE SET NULL,
  chance REAL,
  location TEXT,
  rarity TEXT,
  type TEXT,
  UNIQUE (wfstat_unique_name, drop_index)
);

CREATE INDEX IF NOT EXISTS idx_wfstat_item_drops_location ON wfstat_item_drops (location);

CREATE TABLE IF NOT EXISTS wfstat_item_locations (
  item_location_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  location_index INTEGER NOT NULL,
  chance REAL,
  location TEXT,
  rarity TEXT,
  UNIQUE (wfstat_unique_name, location_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_patchlogs (
  patchlog_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  patchlog_index INTEGER NOT NULL,
  patch_name TEXT,
  patch_date TEXT,
  patch_url TEXT,
  additions TEXT,
  changes TEXT,
  fixes TEXT,
  UNIQUE (wfstat_unique_name, patchlog_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_rewards (
  reward_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  reward_index INTEGER NOT NULL,
  reward_item_id INTEGER REFERENCES items (item_id) ON DELETE SET NULL,
  chance REAL,
  rarity TEXT,
  reward_item_name TEXT,
  reward_item_unique_name TEXT,
  reward_wfm_id TEXT,
  reward_wfm_url_name TEXT,
  UNIQUE (wfstat_unique_name, reward_index)
);

CREATE INDEX IF NOT EXISTS idx_wfstat_item_rewards_reward_unique_name ON wfstat_item_rewards (reward_item_unique_name);
CREATE INDEX IF NOT EXISTS idx_wfstat_item_rewards_reward_item_id ON wfstat_item_rewards (reward_item_id);

CREATE TABLE IF NOT EXISTS wfstat_item_resistances (
  resistance_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  resistance_index INTEGER NOT NULL,
  resistance_type TEXT,
  amount REAL,
  UNIQUE (wfstat_unique_name, resistance_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_resistance_affectors (
  resistance_id INTEGER NOT NULL REFERENCES wfstat_item_resistances (resistance_id) ON DELETE CASCADE,
  affector_index INTEGER NOT NULL,
  element TEXT,
  modifier REAL,
  PRIMARY KEY (resistance_id, affector_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_abilities (
  ability_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  ability_index INTEGER NOT NULL,
  ability_name TEXT,
  description TEXT,
  image_name TEXT,
  ability_unique_name TEXT,
  UNIQUE (wfstat_unique_name, ability_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_attacks (
  attack_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  attack_index INTEGER NOT NULL,
  attack_name TEXT,
  charge_time REAL,
  crit_chance REAL,
  crit_mult REAL,
  flight INTEGER,
  shot_speed INTEGER,
  shot_type TEXT,
  slide TEXT,
  speed REAL,
  status_chance REAL,
  UNIQUE (wfstat_unique_name, attack_index)
);

CREATE TABLE IF NOT EXISTS wfstat_item_attack_damage (
  attack_id INTEGER PRIMARY KEY REFERENCES wfstat_item_attacks (attack_id) ON DELETE CASCADE,
  blast REAL,
  cold REAL,
  electricity REAL,
  heat REAL,
  impact REAL,
  magnetic REAL,
  puncture REAL,
  radiation REAL,
  slash REAL
);

CREATE TABLE IF NOT EXISTS wfstat_item_attack_falloff (
  attack_id INTEGER PRIMARY KEY REFERENCES wfstat_item_attacks (attack_id) ON DELETE CASCADE,
  start_range REAL,
  end_range REAL,
  reduction REAL
);

CREATE TABLE IF NOT EXISTS wfstat_item_components (
  component_id INTEGER PRIMARY KEY,
  wfstat_unique_name TEXT NOT NULL REFERENCES wfstat_items (wfstat_unique_name) ON DELETE CASCADE,
  component_item_id INTEGER NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  component_index INTEGER NOT NULL,
  component_unique_name TEXT,
  name TEXT,
  description TEXT,
  image_name TEXT,
  type TEXT,
  product_category TEXT,
  release_date TEXT,
  estimated_vault_date TEXT,
  wikia_thumbnail TEXT,
  wikia_url TEXT,
  wiki_available INTEGER,
  tradable INTEGER,
  masterable INTEGER,
  vaulted INTEGER,
  accuracy REAL,
  critical_chance REAL,
  critical_multiplier REAL,
  fire_rate REAL,
  omega_attenuation REAL,
  proc_chance REAL,
  reload_time REAL,
  magazine_size INTEGER,
  multishot INTEGER,
  slot INTEGER,
  total_damage REAL,
  disposition INTEGER,
  mastery_req INTEGER,
  ducats INTEGER,
  prime_selling_price INTEGER,
  item_count INTEGER,
  noise TEXT,
  trigger TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE (wfstat_unique_name, component_index)
);

CREATE INDEX IF NOT EXISTS idx_wfstat_item_components_unique_name ON wfstat_item_components (component_unique_name);
CREATE INDEX IF NOT EXISTS idx_wfstat_item_components_name ON wfstat_item_components (name);
CREATE INDEX IF NOT EXISTS idx_wfstat_item_components_component_item_id ON wfstat_item_components (component_item_id);

CREATE TABLE IF NOT EXISTS wfstat_component_introduced (
  component_id INTEGER PRIMARY KEY REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  introduced_name TEXT,
  introduced_url TEXT,
  introduced_parent TEXT,
  introduced_date TEXT,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wfstat_component_introduced_aliases (
  component_id INTEGER NOT NULL REFERENCES wfstat_component_introduced (component_id) ON DELETE CASCADE,
  alias_index INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (component_id, alias_index)
);

CREATE TABLE IF NOT EXISTS wfstat_component_damage (
  component_id INTEGER PRIMARY KEY REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  blast REAL,
  cinematic REAL,
  cold REAL,
  corrosive REAL,
  electricity REAL,
  energy_drain REAL,
  gas REAL,
  health_drain REAL,
  heat REAL,
  impact REAL,
  magnetic REAL,
  puncture REAL,
  radiation REAL,
  shield_drain REAL,
  slash REAL,
  tau REAL,
  total REAL,
  toxin REAL,
  true_damage REAL,
  viral REAL,
  void REAL
);

CREATE TABLE IF NOT EXISTS wfstat_component_damage_per_shot (
  component_id INTEGER NOT NULL REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  shot_index INTEGER NOT NULL,
  damage_value REAL,
  PRIMARY KEY (component_id, shot_index)
);

CREATE TABLE IF NOT EXISTS wfstat_component_tags (
  component_id INTEGER NOT NULL REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  tag_index INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (component_id, tag_index)
);

CREATE TABLE IF NOT EXISTS wfstat_component_polarities (
  component_id INTEGER NOT NULL REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  polarity_index INTEGER NOT NULL,
  polarity TEXT NOT NULL,
  PRIMARY KEY (component_id, polarity_index)
);

CREATE TABLE IF NOT EXISTS wfstat_component_drops (
  component_drop_id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  drop_index INTEGER NOT NULL,
  component_drop_item_id INTEGER REFERENCES items (item_id) ON DELETE SET NULL,
  chance REAL,
  location TEXT,
  rarity TEXT,
  type TEXT,
  component_drop_unique_name TEXT,
  UNIQUE (component_id, drop_index)
);

CREATE INDEX IF NOT EXISTS idx_wfstat_component_drops_component_drop_item_id ON wfstat_component_drops (component_drop_item_id);

CREATE TABLE IF NOT EXISTS wfstat_component_attacks (
  component_attack_id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES wfstat_item_components (component_id) ON DELETE CASCADE,
  attack_index INTEGER NOT NULL,
  attack_name TEXT,
  charge_time REAL,
  crit_chance REAL,
  crit_mult REAL,
  flight INTEGER,
  shot_speed INTEGER,
  shot_type TEXT,
  slide TEXT,
  speed REAL,
  status_chance REAL,
  UNIQUE (component_id, attack_index)
);

CREATE TABLE IF NOT EXISTS wfstat_component_attack_damage (
  component_attack_id INTEGER PRIMARY KEY REFERENCES wfstat_component_attacks (component_attack_id) ON DELETE CASCADE,
  blast REAL,
  cold REAL,
  electricity REAL,
  heat REAL,
  impact REAL,
  magnetic REAL,
  puncture REAL,
  radiation REAL,
  slash REAL
);

CREATE TABLE IF NOT EXISTS wfstat_component_attack_falloff (
  component_attack_id INTEGER PRIMARY KEY REFERENCES wfstat_component_attacks (component_attack_id) ON DELETE CASCADE,
  start_range REAL,
  end_range REAL,
  reduction REAL
);
