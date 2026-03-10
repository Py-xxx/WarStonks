use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const SETTINGS_DIR_NAME: &str = "settings";
const SETTINGS_FILE_NAME: &str = "integrations.json";
const ALECAFRAME_BASE_URL: &str = "https://stats.alecaframe.com";
const ALECAFRAME_PUBLIC_STATS_PATH: &str = "/api/stats/public";
const ALECAFRAME_USER_AGENT: &str = "warstonks/3.0.0";
const HTTP_TIMEOUT_SECONDS: u64 = 30;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyBalance {
    pub platinum: Option<i64>,
    pub credits: Option<i64>,
    pub endo: Option<i64>,
    pub ducats: Option<i64>,
    pub aya: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeSettings {
    pub enabled: bool,
    pub public_link: Option<String>,
    pub username_when_public: Option<String>,
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordWebhookSettings {
    pub enabled: bool,
    pub webhook_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub alecaframe: AlecaframeSettings,
    pub discord_webhook: DiscordWebhookSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeSettingsInput {
    pub enabled: bool,
    pub public_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlecaframeValidationResult {
    pub valid: bool,
    pub normalized_public_link: String,
    pub public_token: String,
    pub username_when_public: Option<String>,
    pub last_update: Option<String>,
    pub balances: CurrencyBalance,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletSnapshot {
    pub enabled: bool,
    pub configured: bool,
    pub balances: CurrencyBalance,
    pub username_when_public: Option<String>,
    pub last_update: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframePublicStatsResponse {
    #[serde(default)]
    general_data_points: Vec<AlecaframeDataPoint>,
    last_update: Option<String>,
    username_when_public: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlecaframeDataPoint {
    ts: Option<String>,
    plat: Option<i64>,
    credits: Option<i64>,
    endo: Option<i64>,
    ducats: Option<i64>,
    aya: Option<i64>,
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn compare_optional_timestamps(left: Option<&str>, right: Option<&str>) -> Ordering {
    left.cmp(&right)
}

fn select_latest_data_point(data_points: &[AlecaframeDataPoint]) -> Option<&AlecaframeDataPoint> {
    data_points
        .iter()
        .max_by(|left, right| compare_optional_timestamps(left.ts.as_deref(), right.ts.as_deref()))
}

fn map_currency_balance(data_point: &AlecaframeDataPoint) -> CurrencyBalance {
    CurrencyBalance {
        platinum: data_point.plat,
        credits: data_point.credits,
        endo: data_point.endo,
        ducats: data_point.ducats,
        aya: data_point.aya,
    }
}

fn build_settings_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve the app data directory")?;
    Ok(app_data_dir
        .join(SETTINGS_DIR_NAME)
        .join(SETTINGS_FILE_NAME))
}

fn load_settings_from_path(path: &Path) -> Result<AppSettings> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read settings file at {}", path.display()))?;

    if raw.trim().is_empty() {
        return Ok(AppSettings::default());
    }

    serde_json::from_str::<AppSettings>(&raw)
        .with_context(|| format!("failed to parse settings file at {}", path.display()))
}

fn save_settings_to_path(path: &Path, settings: &AppSettings) -> Result<()> {
    if let Some(parent_dir) = path.parent() {
        fs::create_dir_all(parent_dir).with_context(|| {
            format!(
                "failed to create settings directory {}",
                parent_dir.display()
            )
        })?;
    }

    let serialized =
        serde_json::to_string_pretty(settings).context("failed to serialize app settings")?;
    fs::write(path, serialized)
        .with_context(|| format!("failed to write settings file at {}", path.display()))
}

fn load_settings_inner(app: &tauri::AppHandle) -> Result<AppSettings> {
    let path = build_settings_path(app)?;
    load_settings_from_path(&path)
}

fn save_settings_inner(app: &tauri::AppHandle, settings: &AppSettings) -> Result<()> {
    let path = build_settings_path(app)?;
    save_settings_to_path(&path, settings)
}

fn extract_public_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.contains("://") {
        return Some(trimmed.to_string());
    }

    let parsed = Url::parse(trimmed).ok()?;

    for (key, candidate) in parsed.query_pairs() {
        if key == "token" || key == "publicToken" {
            let token = candidate.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
}

fn build_public_link(public_token: &str) -> String {
    let mut url = Url::parse(&format!(
        "{ALECAFRAME_BASE_URL}{ALECAFRAME_PUBLIC_STATS_PATH}"
    ))
    .expect("Alecaframe base URL should be valid");
    url.query_pairs_mut().append_pair("token", public_token);
    url.to_string()
}

fn fetch_public_stats(public_token: &str) -> Result<AlecaframePublicStatsResponse> {
    let client = Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .context("failed to construct Alecaframe client")?;

    client
        .get(format!(
            "{ALECAFRAME_BASE_URL}{ALECAFRAME_PUBLIC_STATS_PATH}"
        ))
        .query(&[("token", public_token)])
        .header("User-Agent", ALECAFRAME_USER_AGENT)
        .header("Accept", "application/json")
        .send()
        .context("failed to request Alecaframe public stats")?
        .error_for_status()
        .context("Alecaframe public stats request failed")?
        .json::<AlecaframePublicStatsResponse>()
        .context("failed to parse Alecaframe public stats response")
}

fn validate_public_link_inner(public_link: String) -> Result<AlecaframeValidationResult> {
    let normalized_public_link_input = normalize_optional(Some(public_link))
        .ok_or_else(|| anyhow!("Enter an Alecaframe public link or public token."))?;
    let public_token = extract_public_token(&normalized_public_link_input)
        .ok_or_else(|| anyhow!("Could not extract a public token from the Alecaframe value."))?;
    let payload = fetch_public_stats(&public_token)?;
    let latest_data_point = select_latest_data_point(&payload.general_data_points)
        .ok_or_else(|| anyhow!("Alecaframe did not return any wallet data points."))?;

    Ok(AlecaframeValidationResult {
        valid: true,
        normalized_public_link: build_public_link(&public_token),
        public_token,
        username_when_public: payload.username_when_public,
        last_update: payload.last_update,
        balances: map_currency_balance(latest_data_point),
    })
}

#[tauri::command]
pub fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings_inner(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn test_alecaframe_public_link(
    public_link: String,
) -> Result<AlecaframeValidationResult, String> {
    validate_public_link_inner(public_link).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_alecaframe_settings(
    app: tauri::AppHandle,
    input: AlecaframeSettingsInput,
) -> Result<AppSettings, String> {
    let mut settings = load_settings_inner(&app).map_err(|error| error.to_string())?;
    let trimmed_public_link = normalize_optional(input.public_link);

    let validation_result = match trimmed_public_link.clone() {
        Some(public_link) => Some(
            validate_public_link_inner(public_link)
                .map_err(|error| format!("Could not save Alecaframe settings: {error}"))?,
        ),
        None => None,
    };

    if input.enabled && validation_result.is_none() {
        return Err("Enter a valid Alecaframe public link before enabling the API.".to_string());
    }

    settings.alecaframe = AlecaframeSettings {
        enabled: input.enabled,
        public_link: validation_result
            .as_ref()
            .map(|result| result.normalized_public_link.clone()),
        username_when_public: validation_result
            .as_ref()
            .and_then(|result| result.username_when_public.clone()),
        last_validated_at: validation_result
            .as_ref()
            .and_then(|result| result.last_update.clone()),
    };

    save_settings_inner(&app, &settings).map_err(|error| error.to_string())?;

    Ok(settings)
}

#[tauri::command]
pub fn get_currency_balances(app: tauri::AppHandle) -> Result<WalletSnapshot, String> {
    let settings = load_settings_inner(&app).map_err(|error| error.to_string())?;
    let alecaframe_settings = settings.alecaframe;

    if !alecaframe_settings.enabled {
        return Ok(WalletSnapshot::default());
    }

    let Some(public_link) = alecaframe_settings.public_link else {
        return Ok(WalletSnapshot {
            enabled: true,
            configured: false,
            error_message: Some(
                "Alecaframe is enabled but no public link is configured.".to_string(),
            ),
            ..WalletSnapshot::default()
        });
    };

    match validate_public_link_inner(public_link) {
        Ok(result) => Ok(WalletSnapshot {
            enabled: true,
            configured: true,
            balances: result.balances,
            username_when_public: result.username_when_public,
            last_update: result.last_update,
            error_message: None,
        }),
        Err(error) => Ok(WalletSnapshot {
            enabled: true,
            configured: true,
            error_message: Some(error.to_string()),
            ..WalletSnapshot::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_public_token, load_settings_from_path, map_currency_balance, save_settings_to_path,
        select_latest_data_point, AlecaframeDataPoint, AlecaframeSettings, AppSettings,
        DiscordWebhookSettings,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_settings_path() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("warstonks-settings-{suffix}.json"))
    }

    #[test]
    fn extracts_token_from_raw_value() {
        assert_eq!(extract_public_token("abc123"), Some("abc123".to_string()));
    }

    #[test]
    fn extracts_token_from_public_url_query() {
        let input = "https://stats.alecaframe.com/api/stats/public?token=query-token";
        assert_eq!(extract_public_token(input), Some("query-token".to_string()));
    }

    #[test]
    fn extracts_token_from_public_url_path() {
        let input = "https://example.com/public-links/path-token";
        assert_eq!(extract_public_token(input), Some("path-token".to_string()));
    }

    #[test]
    fn latest_data_point_prefers_newest_timestamp() {
        let points = vec![
            AlecaframeDataPoint {
                ts: Some("2026-03-10T13:14:57.761Z".to_string()),
                plat: Some(100),
                credits: Some(200),
                endo: Some(300),
                ducats: Some(400),
                aya: Some(500),
            },
            AlecaframeDataPoint {
                ts: Some("2026-03-11T13:14:57.761Z".to_string()),
                plat: Some(999),
                credits: Some(888),
                endo: Some(777),
                ducats: Some(666),
                aya: Some(555),
            },
        ];

        let latest = select_latest_data_point(&points).expect("latest point should exist");
        let balance = map_currency_balance(latest);

        assert_eq!(balance.platinum, Some(999));
        assert_eq!(balance.credits, Some(888));
        assert_eq!(balance.endo, Some(777));
        assert_eq!(balance.ducats, Some(666));
        assert_eq!(balance.aya, Some(555));
    }

    #[test]
    fn settings_round_trip_uses_json_file() {
        let path = temp_settings_path();
        let settings = AppSettings {
            alecaframe: AlecaframeSettings {
                enabled: true,
                public_link: Some(
                    "https://stats.alecaframe.com/api/stats/public?token=abc123".to_string(),
                ),
                username_when_public: Some("py".to_string()),
                last_validated_at: Some("2026-03-10T13:14:57.761Z".to_string()),
            },
            discord_webhook: DiscordWebhookSettings {
                enabled: false,
                webhook_url: None,
            },
        };

        save_settings_to_path(&path, &settings).expect("settings should save");
        let loaded = load_settings_from_path(&path).expect("settings should load");
        fs::remove_file(&path).ok();

        assert!(loaded.alecaframe.enabled);
        assert_eq!(
            loaded.alecaframe.public_link,
            settings.alecaframe.public_link
        );
        assert_eq!(
            loaded.alecaframe.username_when_public,
            settings.alecaframe.username_when_public
        );
    }
}
