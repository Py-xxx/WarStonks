//! Streaming parser for Warframe's `EE.log`.
//!
//! See `Resources/WFAndAlecaAppData/WARFRAME_APPDATA.md`. Three properties of this file
//! drive the whole design:
//!
//! 1. **It is truncated on every game launch**, with no rotation and no `.bak`. Anything
//!    not captured as it appears is gone, so this must run continuously.
//! 2. **Line prefixes are seconds since launch**, not clock time. A single anchor line
//!    near the top carries the wall clock.
//! 3. **It contains other people's data** — squadmate IP addresses, every message the
//!    user sends. So this module emits structured events only and never retains,
//!    persists, or logs a raw line.
//!
//! Deliberately no `regex` dependency: the reference doc documents a regex that passes
//! six of seven names then greedily swallows thousands of lines on the seventh. Manual
//! scanning makes the failure modes visible.

use serde::{Deserialize, Serialize};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

/// Unicode Private Use Area. Player names carry a trailing glyph from this block — and
/// it is *not* always the same one (`U+E000`, `U+E002`, `U+E004`, `U+E006` all observed),
/// so never match a specific codepoint. Rank pips on item lines use `U+E0A6`, also in
/// this block, which is why item lines are parsed separately from names.
const PUA_START: char = '\u{e000}';
const PUA_END: char = '\u{f8ff}';

/// How long after a tab opens an outgoing whisper still implies *we* opened it.
/// Matches `testApp/chat.py`'s verified window.
const SELF_STARTED_AFTER_S: f64 = 1.0;
/// And how long before. A whisper fractionally ahead of the tab is still us.
const SELF_STARTED_BEFORE_S: f64 = 0.5;

pub fn strip_private_use(value: &str) -> String {
    value
        .chars()
        .filter(|c| !(*c >= PUA_START && *c <= PUA_END))
        .collect::<String>()
        .trim()
        .to_string()
}

/// `0.298 Sys [Diag]: ...` → `0.298`. Returns `None` for continuation lines inside a
/// multi-line dialog block, which is how those are recognised.
pub fn elapsed_seconds(line: &str) -> Option<f64> {
    let end = line.find(' ')?;
    line[..end].parse::<f64>().ok()
}

/// Reads the wall-clock anchor:
/// `0.298 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 [UTC: Mon Aug 10 21:38:18 2026]`
///
/// Always takes the bracketed **UTC** value, never the local one preceding it.
pub fn parse_session_anchor(line: &str) -> Option<OffsetDateTime> {
    let start = line.find("[UTC:")? + "[UTC:".len();
    let rest = &line[start..];
    let end = rest.find(']')?;
    parse_asctime(rest[..end].trim())
}

/// `Mon Aug 10 21:38:18 2026` — C `asctime`, which no date library parses out of the box.
/// Day-of-month may be space-padded, so fields are split on whitespace runs.
fn parse_asctime(value: &str) -> Option<OffsetDateTime> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }

    let month = match parts[1] {
        "Jan" => Month::January,
        "Feb" => Month::February,
        "Mar" => Month::March,
        "Apr" => Month::April,
        "May" => Month::May,
        "Jun" => Month::June,
        "Jul" => Month::July,
        "Aug" => Month::August,
        "Sep" => Month::September,
        "Oct" => Month::October,
        "Nov" => Month::November,
        "Dec" => Month::December,
        _ => return None,
    };

    let day: u8 = parts[2].parse().ok()?;
    let year: i32 = parts[4].parse().ok()?;

    let mut clock = parts[3].split(':');
    let hour: u8 = clock.next()?.parse().ok()?;
    let minute: u8 = clock.next()?.parse().ok()?;
    let second: u8 = clock.next()?.parse().ok()?;

    let date = Date::from_calendar_date(year, month, day).ok()?;
    let time = Time::from_hms(hour, minute, second).ok()?;
    Some(PrimitiveDateTime::new(date, time).assume_utc())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectMessageEvent {
    /// Sender, with the private-use glyph stripped.
    pub user: String,
    /// Seconds since game launch — the log's own clock.
    pub elapsed_s: f64,
    /// Wall clock, when a session anchor has been seen. `None` if the tailer attached
    /// mid-session and missed it.
    pub occurred_at: Option<OffsetDateTime>,
    /// Stable across re-reads of the same session, so replays don't duplicate.
    pub key: String,
}

/// One side of a trade. Quantity is `1` for a bare line; `Name x N` carries an explicit count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradedItem {
    pub name: String,
    pub quantity: i64,
    /// Current rank — the number of **filled** pips. `None` for unrankable items.
    pub rank: Option<i64>,
    /// Max rank — the **total** pip count. `None` for unrankable items.
    pub max_rank: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeEvent {
    /// Trade partner, private-use glyph stripped.
    pub partner: String,
    /// What the user handed over.
    pub giving: Vec<TradedItem>,
    /// What the user received.
    pub getting: Vec<TradedItem>,
    /// Platinum received and paid. The log gives a **total per trade, never per item**, so a
    /// multi-item trade cannot be priced automatically — that is a user decision.
    pub platinum_in: i64,
    pub platinum_out: i64,
    pub elapsed_s: f64,
    pub occurred_at: Option<OffsetDateTime>,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EeLogEvent {
    DirectMessage(DirectMessageEvent),
    /// Only emitted after the game confirms the trade completed. A cancelled dialog produces
    /// no event at all.
    Trade(TradeEvent),
}

/// A DM tab that opened but whose direction isn't decided yet.
#[derive(Debug, Clone)]
struct PendingTab {
    user: String,
    elapsed_s: f64,
}

/// Feed it lines; it yields events.
///
/// Stateful for two reasons: the session anchor arrives once near the top and stamps
/// everything after it, and DM direction can only be settled by looking slightly
/// *forward* — see [`Self::push_line`].
/// Which half of the trade dialog is currently being read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TradeSide {
    Giving,
    Getting,
}

/// A trade block that has been read but not yet confirmed.
#[derive(Debug, Clone)]
struct PendingTrade {
    partner: String,
    giving: Vec<TradedItem>,
    getting: Vec<TradedItem>,
    elapsed_s: f64,
}

#[derive(Debug, Default)]
pub struct EeLogParser {
    session_start: Option<OffsetDateTime>,
    pending_tabs: Vec<PendingTab>,
    latest_elapsed: f64,
    /// Set while inside a trade dialog, cleared at `, title=`.
    trade_side: Option<TradeSide>,
    /// The block being read, then the completed-but-unconfirmed block.
    trade_in_progress: Option<PendingTrade>,
}

impl EeLogParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called when the file shrinks — the game relaunched and truncated it. Everything
    /// buffered belongs to a session that no longer exists.
    pub fn reset_for_new_session(&mut self) {
        *self = Self::new();
    }

    /// Supplies the session anchor read from the file's header.
    ///
    /// The tailer attaches at EOF, so it never feeds the header through `push_line` and the
    /// anchor has to arrive this way. A later anchor in the stream still wins nothing — the
    /// first one is the session's, and `push_line` only sets it when unset.
    pub fn adopt_session_start(&mut self, anchor: OffsetDateTime) {
        if self.session_start.is_none() {
            self.session_start = Some(anchor);
        }
    }

    /// Wall-clock time for an event at `elapsed_s` seconds into the session.
    ///
    /// Prefers the log's own anchor. Without it — a log whose header has already been rotated
    /// past, or a game that has only just started writing — it infers the session start from
    /// the clock instead: the newest line in the file is, by definition of tailing, roughly
    /// *now*, so `now - (latest - elapsed)` places the event correctly relative to it.
    ///
    /// Returning `None` here is what previously put untimed rows into the trade log, so this
    /// deliberately always produces a timestamp.
    fn wall_clock_for(&self, elapsed_s: f64) -> Option<OffsetDateTime> {
        match self.session_start {
            Some(start) => Some(start + time::Duration::seconds_f64(elapsed_s)),
            None => Some(
                OffsetDateTime::now_utc()
                    - time::Duration::seconds_f64((self.latest_elapsed - elapsed_s).max(0.0)),
            ),
        }
    }

    /// Feeds one line, returning any events it completes.
    ///
    /// `AddTab` alone cannot tell an incoming DM from one the user opened: it fires for
    /// both. The tell is an outgoing whisper to the same person within about a second.
    /// In a batch parse you can look ahead; streaming, we hold the tab briefly and
    /// release it once the window has demonstrably passed. So a DM event is emitted
    /// *slightly after* the line that caused it, by design.
    pub fn push_line(&mut self, line: &str) -> Vec<EeLogEvent> {
        // The game writes CRLF (6,686 of them and not one bare LF in the reference session),
        // and neither `read_to_string` nor `split('\n')` strips the `\r`. Left on, it defeats
        // every suffix match — the trade partner silently parses as an empty string.
        let line = line.strip_suffix('\r').unwrap_or(line);

        if let Some(elapsed) = elapsed_seconds(line) {
            self.latest_elapsed = elapsed;
        }

        if let Some(event) = self.push_trade_line(line) {
            return vec![event];
        }

        if self.session_start.is_none() && line.contains("Current time:") {
            self.session_start = parse_session_anchor(line);
        }

        if let Some(user) = parse_add_tab(line) {
            if let Some(elapsed) = elapsed_seconds(line) {
                self.pending_tabs.push(PendingTab { user, elapsed_s: elapsed });
            }
        }

        // An outgoing whisper cancels the matching pending tab: we started it.
        if let Some((target, elapsed)) = parse_outgoing_privmsg(line) {
            self.pending_tabs.retain(|tab| {
                let delta = elapsed - tab.elapsed_s;
                let within = (-SELF_STARTED_BEFORE_S..=SELF_STARTED_AFTER_S).contains(&delta);
                // `chat.py` matches on timing alone; also requiring the target to match
                // avoids calling an incoming DM self-started just because the user
                // happened to whisper somebody else at the same moment.
                !(within && tab.user == target)
            });
        }

        self.release_settled_tabs(self.latest_elapsed)
    }

    /// Feeds the trade state machine.
    ///
    /// The dialog spans multiple lines, so a line-at-a-time parser cannot work — the block is
    /// buffered from `You are offering:` through `, title=`. Crucially the block is then held
    /// rather than emitted: **`The trade was successful!` is the only proof it completed**,
    /// and the dialog can be cancelled. A block that is never confirmed is discarded when the
    /// next one opens.
    fn push_trade_line(&mut self, line: &str) -> Option<EeLogEvent> {
        if line.contains(TRADE_OPEN) {
            // A new dialog supersedes any unconfirmed one — that earlier trade was cancelled.
            self.trade_in_progress = Some(PendingTrade {
                partner: String::new(),
                giving: Vec::new(),
                getting: Vec::new(),
                elapsed_s: elapsed_seconds(line).unwrap_or(self.latest_elapsed),
            });
            self.trade_side = Some(TradeSide::Giving);
            return None;
        }

        if self.trade_in_progress.is_some() && line.contains(TRADE_SUCCESS) {
            let pending = self.trade_in_progress.take()?;
            self.trade_side = None;
            let platinum_in = platinum_total(&pending.getting);
            let platinum_out = platinum_total(&pending.giving);
            return Some(EeLogEvent::Trade(TradeEvent {
                partner: pending.partner,
                giving: pending.giving,
                getting: pending.getting,
                platinum_in,
                platinum_out,
                elapsed_s: pending.elapsed_s,
                occurred_at: self.wall_clock_for(pending.elapsed_s),
                key: build_event_key(self.session_start, pending.elapsed_s),
            }));
        }

        let Some(side) = self.trade_side else {
            return None;
        };
        let trade = self.trade_in_progress.as_mut()?;

        // The receive header both names the partner and switches sides.
        if let Some(rest) = line.strip_prefix(TRADE_RECEIVE_PREFIX) {
            if let Some(partner) = rest.strip_suffix(TRADE_RECEIVE_SUFFIX) {
                trade.partner = strip_private_use(partner);
                self.trade_side = Some(TradeSide::Getting);
                return None;
            }
        }

        // The final received item shares its line with the dialog's trailing arguments.
        let (content, ends_block) = match line.find(TRADE_BLOCK_END) {
            Some(index) => (&line[..index], true),
            None => (line, false),
        };

        if let Some(item) = parse_traded_item(content) {
            // Every copy gets its own line, and the last one carries the dialog's trailing
            // arguments. Two identical lines therefore mean two real items — confirmed
            // against a trade of two Arcane Universal Fallout for 10p. An earlier version
            // treated the closing line as a repeat of the one before it and silently
            // under-counted every multi-copy trade by one.
            match side {
                TradeSide::Giving => trade.giving.push(item),
                TradeSide::Getting => trade.getting.push(item),
            }
        }

        if ends_block {
            // Block read; now wait for confirmation.
            self.trade_side = None;
        }
        None
    }

    /// Releases tabs whose decision window has closed, using the log's own clock.
    ///
    /// A quiet log advances no timestamps, so a caller that has gone idle should call
    /// this with a monotonically advancing value (see [`Self::flush_after_idle`]) or a
    /// final DM would sit buffered forever.
    fn release_settled_tabs(&mut self, now_elapsed: f64) -> Vec<EeLogEvent> {
        let mut released = Vec::new();
        let session_start = self.session_start;
        let mut settled = Vec::new();
        self.pending_tabs.retain(|tab| {
            if now_elapsed - tab.elapsed_s <= SELF_STARTED_AFTER_S {
                return true;
            }
            settled.push(tab.clone());
            false
        });
        for tab in settled {
            released.push(EeLogEvent::DirectMessage(DirectMessageEvent {
                user: tab.user.clone(),
                elapsed_s: tab.elapsed_s,
                occurred_at: self.wall_clock_for(tab.elapsed_s),
                key: build_event_key(session_start, tab.elapsed_s),
            }));
        }
        released
    }

    /// Flushes anything still buffered once the file has gone quiet for longer than the
    /// decision window. Call from the tailer's idle tick.
    pub fn flush_after_idle(&mut self) -> Vec<EeLogEvent> {
        let cutoff = self.latest_elapsed + SELF_STARTED_AFTER_S + 1.0;
        self.release_settled_tabs(cutoff)
    }
}

fn build_event_key(session_start: Option<OffsetDateTime>, elapsed_s: f64) -> String {
    let stamp = session_start
        .and_then(|start| start.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(|| "?".to_string());
    format!("{stamp}|{elapsed_s:.3}")
}

/// Rank pips, drawn as private-use glyphs on the item line itself. The bar renders one pip
/// per rank, filled up to the item's current rank:
///
/// | Glyph | Meaning | Observed |
/// |---|---|---|
/// | `U+E0A6` | empty pip | a rank 0/5 arcane — five empty |
/// | `U+E0CB` | filled pip | a rank 5/5 arcane — five filled |
///
/// So **total pips = max rank** and **filled pips = current rank**. The two codepoints are
/// not adjacent (0x25 apart), so there is no arithmetic shortcut — they are a known set.
///
/// Caveat: only the all-empty and all-filled extremes have been captured. A partial rank is
/// expected to mix the two, which is what this counts, but that specific case is inferred
/// rather than observed.
const RANK_PIP_EMPTY: char = '\u{e0a6}';
const RANK_PIP_FILLED: char = '\u{e0cb}';

fn is_rank_pip(value: char) -> bool {
    value == RANK_PIP_EMPTY || value == RANK_PIP_FILLED
}

const TRADE_OPEN: &str = "Are you sure you want to accept this trade? You are offering:";
const TRADE_RECEIVE_PREFIX: &str = "and will receive from ";
const TRADE_RECEIVE_SUFFIX: &str = " the following:";
const TRADE_BLOCK_END: &str = ", title=";
const TRADE_SUCCESS: &str = "Dialog::CreateOk(description=The trade was successful!";

/// Parses one item line: `Platinum x 24` or a bare `Alternox Prime Blueprint`.
///
/// Rank pips are stripped before the name is read — they are invisible in a terminal, so
/// leaving them in produces names that look correct and compare unequal.
fn parse_traded_item(line: &str) -> Option<TradedItem> {
    let total_pips = line.chars().filter(|c| is_rank_pip(*c)).count();
    let filled_pips = line.chars().filter(|c| *c == RANK_PIP_FILLED).count();
    let cleaned = strip_private_use(line);
    if cleaned.is_empty() {
        return None;
    }

    // `Name x N`, where N may carry thousands separators.
    let (name, quantity) = match cleaned.rfind(" x ") {
        Some(index) => {
            let (head, tail) = cleaned.split_at(index);
            let digits = tail.trim_start_matches(" x ").replace(',', "");
            match digits.parse::<i64>() {
                Ok(value) => (head.trim().to_string(), value),
                // An item whose own name contains " x " and no trailing count.
                Err(_) => (cleaned.clone(), 1),
            }
        }
        None => (cleaned.clone(), 1),
    };

    if name.is_empty() {
        return None;
    }
    Some(TradedItem {
        name,
        quantity,
        rank: (total_pips > 0).then_some(filled_pips as i64),
        max_rank: (total_pips > 0).then_some(total_pips as i64),
    })
}

fn platinum_total(items: &[TradedItem]) -> i64 {
    items
        .iter()
        .filter(|item| item.name.eq_ignore_ascii_case("platinum"))
        .map(|item| item.quantity)
        .sum()
}

const ADD_TAB_MARKER: &str = "ChatRedux::AddTab: Adding tab with channel name: ";

/// Extracts the sender from a DM tab line, or `None` for any other channel.
///
/// Channel prefixes: `F` = DM, `C` = clan, `S` = squad, `G_`/`Q_`/`R_`/`T_` = public,
/// `J_` = alliance. Only `F` is a private message.
fn parse_add_tab(line: &str) -> Option<String> {
    let start = line.find(ADD_TAB_MARKER)? + ADD_TAB_MARKER.len();
    let channel = &line[start..];
    let name = channel.strip_prefix('F')?;

    // Names terminate at the first private-use glyph. Taking everything up to it (rather
    // than searching for one specific codepoint) is what keeps a `U+E002`-terminated
    // name from running past its line.
    let user: String = name.chars().take_while(|c| !(*c >= PUA_START && *c <= PUA_END)).collect();
    let cleaned = user.trim();

    // `C`/`S`/`G_`… channels also start with a letter; requiring a terminator glyph is
    // what distinguishes a real player name from `G_EN_EU` (which has none).
    if cleaned.is_empty() || cleaned.len() == name.chars().count() {
        return None;
    }
    Some(cleaned.to_string())
}

const PRIVMSG_MARKER: &str = "IRC out: PRIVMSG ";

fn parse_outgoing_privmsg(line: &str) -> Option<(String, f64)> {
    let elapsed = elapsed_seconds(line)?;
    let start = line.find(PRIVMSG_MARKER)? + PRIVMSG_MARKER.len();
    let rest = &line[start..];
    let end = rest.find(' ').unwrap_or(rest.len());
    let target = strip_private_use(&rest[..end]);
    if target.is_empty() {
        return None;
    }
    Some((target, elapsed))
}

/// Follows `EE.log` across game restarts.
///
/// The game holds the file open and appends to it, and **truncates it on every launch**
/// with no rotation. So the only reliable restart signal is the file getting *shorter*
/// than where we last read to — at which point the previous session's buffered state is
/// meaningless and must be dropped.
pub struct EeLogTailer {
    path: std::path::PathBuf,
    offset: u64,
    parser: EeLogParser,
}

impl EeLogTailer {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into(), offset: 0, parser: EeLogParser::new() }
    }

    /// Starts from the end, so attaching to an in-progress session doesn't replay hours
    /// of history as fresh notifications.
    ///
    /// **Reads the header first.** Every timestamp in this log is "seconds since launch", and
    /// the only thing that turns those into wall-clock time is the `Current time: ... [UTC: ...]`
    /// line the game writes once, at the very top. Seeking straight to EOF skipped it, so the
    /// parser ran the whole session with `session_start = None` and stamped every live-detected
    /// event with no time at all — which is fine for a debug table and fatal once those events
    /// became real trade-log rows.
    pub fn skip_to_end(&mut self) -> std::io::Result<()> {
        self.prime_session_anchor();
        self.offset = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        Ok(())
    }

    /// Scans the start of the file for the session anchor without consuming it as events.
    ///
    /// Best-effort by design: a log with no anchor yet (the game just launched) still tails
    /// fine, because `EeLogParser` falls back to inferring the session start from the clock.
    fn prime_session_anchor(&mut self) {
        use std::io::Read;

        // The anchor is within the first few lines; 64 KiB is far more than enough and bounds
        // the read on a log that has already grown to megabytes.
        const HEADER_BYTES: usize = 64 * 1024;

        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return;
        };
        let mut buffer = vec![0_u8; HEADER_BYTES];
        let Ok(read) = file.read(&mut buffer) else {
            return;
        };
        buffer.truncate(read);

        let text = String::from_utf8_lossy(&buffer);
        for line in text.split('\n') {
            if let Some(anchor) = parse_session_anchor(line) {
                self.parser.adopt_session_start(anchor);
                return;
            }
        }
    }

    /// Reads whatever has been appended since the last call.
    ///
    /// Decodes lossily: the log contains bytes that are not valid UTF-8, and dropping the
    /// whole read because of one of them would lose real events.
    pub fn poll(&mut self) -> std::io::Result<Vec<EeLogEvent>> {
        use std::io::{Read, Seek, SeekFrom};

        let size = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            // Absent between game launches; not an error worth surfacing.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };

        if size < self.offset {
            self.offset = 0;
            self.parser.reset_for_new_session();
        }
        if size == self.offset {
            return Ok(self.parser.flush_after_idle());
        }

        let mut file = std::fs::File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)?;

        // Only consume through the last complete line; a partial tail would be re-read
        // and double-counted next poll.
        let consumed = match buffer.iter().rposition(|byte| *byte == b'\n') {
            Some(index) => index + 1,
            None => return Ok(Vec::new()),
        };
        self.offset += consumed as u64;

        let text = String::from_utf8_lossy(&buffer[..consumed]);
        let mut events = Vec::new();
        for line in text.split('\n') {
            events.extend(self.parser.push_line(line));
        }
        Ok(events)
    }
}

/// Process-wide tailer. The frontend polls it on a timer, matching how every other
/// live source in this app is driven (hooks on `AppShell`), rather than pushing from a
/// background thread — one less lifecycle to get wrong, and the tailer's own offset
/// state already makes repeat calls cheap and idempotent.
fn shared_tailer() -> &'static std::sync::Mutex<Option<EeLogTailer>> {
    static TAILER: std::sync::OnceLock<std::sync::Mutex<Option<EeLogTailer>>> =
        std::sync::OnceLock::new();
    TAILER.get_or_init(|| std::sync::Mutex::new(None))
}

/// Returns events appended since the previous call.
///
/// First call attaches at the *end* of the current file: a user who starts the app
/// mid-session should not receive a burst of notifications for messages they already
/// read hours ago.
#[tauri::command]
pub fn poll_ee_log_events() -> Result<Vec<EeLogEvent>, String> {
    let availability = crate::local_sources::probe();
    let path = match &availability.warframe_log {
        crate::local_sources::SourceStatus::Available { path } => path.clone(),
        // Not an error: the game may simply not be running yet.
        crate::local_sources::SourceStatus::Unavailable { .. } => return Ok(Vec::new()),
    };

    let mut guard = shared_tailer()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let tailer = match guard.as_mut() {
        Some(existing) => existing,
        None => {
            let mut fresh = EeLogTailer::new(&path);
            fresh.skip_to_end().map_err(|error| error.to_string())?;
            guard.insert(fresh)
        }
    };

    tailer.poll().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reference_log() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("Resources/WFAndAlecaAppData/EE.log")
    }

    fn parse_all(text: &str) -> Vec<EeLogEvent> {
        let mut parser = EeLogParser::new();
        let mut events = Vec::new();
        for line in text.split('\n') {
            events.extend(parser.push_line(line));
        }
        events.extend(parser.flush_after_idle());
        events
    }

    #[test]
    fn reads_the_utc_anchor_not_the_local_one() {
        let line = "0.298 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                    [UTC: Mon Aug 10 21:38:18 2026]";
        let anchor = parse_session_anchor(line).expect("anchor");
        assert_eq!(anchor.hour(), 21, "must take the UTC value, not local 23:38");
        assert_eq!(anchor.year(), 2026);
        assert_eq!(anchor.day(), 10);
    }

    #[test]
    fn strips_every_private_use_glyph_not_just_the_common_one() {
        // U+E000 is by far the most frequent, but U+E002/E004/E006 all appear on real
        // names. Matching one codepoint silently corrupts the rest.
        assert_eq!(strip_private_use("oket1\u{e000}"), "oket1");
        assert_eq!(strip_private_use("rxkki_desses_021\u{e002}"), "rxkki_desses_021");
        assert_eq!(strip_private_use("GodDragon\u{e006}"), "GodDragon");
        assert_eq!(strip_private_use("Meowmeow67\u{e004}"), "Meowmeow67");
    }

    #[test]
    fn only_f_prefixed_channels_are_private_messages() {
        let dm = "74.588 Script [Info]: ChatRedux.lua: ChatRedux::AddTab: \
                  Adding tab with channel name: FGodDragon\u{e006} to index 6";
        assert_eq!(parse_add_tab(dm).as_deref(), Some("GodDragon"));

        // Public and clan channels carry no terminator glyph and must not be treated
        // as player names.
        for other in [
            "1.0 x: ChatRedux::AddTab: Adding tab with channel name: G_EN_EU to index 1",
            "1.0 x: ChatRedux::AddTab: Adding tab with channel name: C6798b938 to index 2",
        ] {
            assert_eq!(parse_add_tab(other), None, "should ignore: {other}");
        }
    }

    #[test]
    fn a_tab_the_user_opened_is_suppressed() {
        // An outgoing whisper within the window means we opened the conversation.
        let text = "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                    [UTC: Mon Aug 10 21:38:18 2026]\n\
                    10.0 Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
                    FSomeone\u{e000} to index 6\n\
                    10.4 Net [Info]: IRC out: PRIVMSG Someone\u{e000} :hi\n\
                    30.0 Sys [Info]: unrelated\n";
        assert!(parse_all(text).is_empty(), "self-opened tab must not notify");
    }

    #[test]
    fn whispering_a_different_person_does_not_suppress_an_incoming_tab() {
        // chat.py matches on timing alone, so a simultaneous unrelated whisper would
        // wrongly cancel a real incoming DM. Requiring the target to match fixes that.
        let text = "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                    [UTC: Mon Aug 10 21:38:18 2026]\n\
                    10.0 Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
                    FIncoming\u{e000} to index 6\n\
                    10.2 Net [Info]: IRC out: PRIVMSG SomebodyElse\u{e000} :unrelated\n\
                    30.0 Sys [Info]: unrelated\n";
        let events = parse_all(text);
        assert_eq!(events.len(), 1);
        let EeLogEvent::DirectMessage(dm) = &events[0] else { panic!("expected a DM") };
        assert_eq!(dm.user, "Incoming");
    }

    #[test]
    fn a_late_reply_still_counts_as_incoming() {
        // Replying two seconds later is the normal incoming case, not self-started.
        let text = "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                    [UTC: Mon Aug 10 21:38:18 2026]\n\
                    10.0 Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
                    FThem\u{e000} to index 6\n\
                    12.5 Net [Info]: IRC out: PRIVMSG Them\u{e000} :hello back\n";
        let events = parse_all(text);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn events_carry_wall_clock_derived_from_the_anchor() {
        let text = "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                    [UTC: Mon Aug 10 21:38:18 2026]\n\
                    60.0 Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
                    FThem\u{e000} to index 6\n";
        let events = parse_all(text);
        let EeLogEvent::DirectMessage(dm) = &events[0] else { panic!("expected a DM") };
        let at = dm.occurred_at.expect("wall clock");
        assert_eq!((at.hour(), at.minute(), at.second()), (21, 39, 18));
        assert!(dm.key.starts_with("2026-08-10T21:38:18Z|"), "key was {}", dm.key);
    }

    #[test]
    fn a_reset_discards_state_from_the_truncated_session() {
        let mut parser = EeLogParser::new();
        parser.push_line(
            "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
             [UTC: Mon Aug 10 21:38:18 2026]",
        );
        parser.push_line(
            "5.0 Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
             FThem\u{e000} to index 6",
        );
        parser.reset_for_new_session();
        assert!(parser.flush_after_idle().is_empty(), "buffered tab must not survive");
    }

    const ANCHOR_LINE: &str = "0.1 Sys [Diag]: Current time: Mon Aug 10 23:38:18 2026 \
                               [UTC: Mon Aug 10 21:38:18 2026]\n";

    fn dm_line(elapsed: &str, user: &str) -> String {
        format!(
            "{elapsed} Script [Info]: ChatRedux::AddTab: Adding tab with channel name: \
             F{user}\u{e000} to index 6\n"
        )
    }

    #[test]
    fn a_tailer_reads_only_what_was_appended_since_last_poll() {
        let path = std::env::temp_dir().join("warstonks-tailer-append.log");
        std::fs::write(&path, ANCHOR_LINE).unwrap();

        let mut tailer = EeLogTailer::new(&path);
        assert!(tailer.poll().unwrap().is_empty());

        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(&dm_line("10.0", "Someone"));
        text.push_str("30.0 Sys [Info]: later\n");
        std::fs::write(&path, &text).unwrap();

        let events = tailer.poll().unwrap();
        assert_eq!(events.len(), 1);
        // Nothing new appended, so a second poll must not repeat it.
        assert!(tailer.poll().unwrap().is_empty(), "events must not be re-emitted");

        std::fs::remove_file(&path).ok();
    }

    /// The bug that silently broke live trade detection.
    ///
    /// The tailer attaches at EOF so it doesn't replay history — which meant it never read the
    /// header, and the header is the only place the log states its own start time. Every
    /// timestamp in the file is "seconds since launch", so without it the parser produced
    /// events with `occurred_at: None`, and a trade-log row with no `closed_at` is not a
    /// usable trade.
    #[test]
    fn a_tailer_attached_mid_session_still_times_its_trades() {
        let path = std::env::temp_dir().join("warstonks-tailer-anchor.log");
        let mut existing = String::from(ANCHOR_LINE);
        existing.push_str("500.0 Sys [Info]: history we must not replay\n");
        std::fs::write(&path, &existing).unwrap();

        let mut tailer = EeLogTailer::new(&path);
        tailer.skip_to_end().unwrap();
        assert!(tailer.poll().unwrap().is_empty(), "attaching must not replay history");

        // A trade happens after we attached, so it arrives without the header.
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(&trade_block("793.432", &["Grendel Prime Systems Blueprint"], "Partner", &["Platinum x 8"]));
        text.push_str("795.0 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!, title=)\n");
        std::fs::write(&path, &text).unwrap();

        let trades = only_trades(tailer.poll().unwrap());
        assert_eq!(trades.len(), 1);

        let occurred_at = trades[0].occurred_at.expect("a live trade must carry a timestamp");
        // 21:38:18 UTC + 793.432s = 21:51:31.
        assert_eq!((occurred_at.hour(), occurred_at.minute()), (21, 51));
        assert_ne!(trades[0].key, "?|793.432", "the dedup key must not degrade to a bare '?'");

        std::fs::remove_file(&path).ok();
    }

    /// A log whose header is missing entirely (rotated past, or the game only just started)
    /// must still produce a usable timestamp rather than none at all.
    #[test]
    fn a_missing_anchor_falls_back_to_the_wall_clock() {
        let path = std::env::temp_dir().join("warstonks-tailer-no-anchor.log");
        std::fs::write(&path, "500.0 Sys [Info]: no header in this file\n").unwrap();

        let mut tailer = EeLogTailer::new(&path);
        tailer.skip_to_end().unwrap();

        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(&trade_block("505.0", &["Some Prime Blueprint"], "Partner", &["Platinum x 8"]));
        text.push_str("506.0 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!, title=)\n");
        std::fs::write(&path, &text).unwrap();

        let trades = only_trades(tailer.poll().unwrap());
        assert_eq!(trades.len(), 1);

        let occurred_at = trades[0].occurred_at.expect("must still be timed");
        let drift = (OffsetDateTime::now_utc() - occurred_at).whole_seconds().abs();
        assert!(drift < 60, "a live trade should land near now, drifted {drift}s");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_truncated_file_restarts_cleanly_instead_of_seeking_past_the_end() {
        // The game relaunching truncates the log. Keeping the old offset would skip the
        // entire new session; keeping parser state would stamp it with a stale anchor.
        let path = std::env::temp_dir().join("warstonks-tailer-truncate.log");
        let mut first = String::from(ANCHOR_LINE);
        first.push_str(&dm_line("10.0", "OldSession"));
        first.push_str("30.0 Sys [Info]: filler\n");
        std::fs::write(&path, &first).unwrap();

        let mut tailer = EeLogTailer::new(&path);
        assert_eq!(tailer.poll().unwrap().len(), 1);

        // Relaunch: shorter file, new session.
        let mut second = String::from(
            "0.1 Sys [Diag]: Current time: Tue Aug 11 01:00:00 2026 \
             [UTC: Tue Aug 11 00:00:00 2026]\n",
        );
        second.push_str(&dm_line("5.0", "NewSession"));
        second.push_str("20.0 Sys [Info]: filler\n");
        assert!(second.len() < first.len(), "test needs a genuinely shorter file");
        std::fs::write(&path, &second).unwrap();

        let events = tailer.poll().unwrap();
        assert_eq!(events.len(), 1);
        let EeLogEvent::DirectMessage(dm) = &events[0] else { panic!("expected a DM") };
        assert_eq!(dm.user, "NewSession");
        // Stamped from the NEW anchor, not the previous session's.
        assert_eq!(dm.occurred_at.unwrap().hour(), 0);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_half_written_line_is_left_for_the_next_poll() {
        // The game appends while we read, so the tail is routinely a partial line.
        // Consuming it would corrupt that event and double-count its remainder.
        let path = std::env::temp_dir().join("warstonks-tailer-partial.log");
        std::fs::write(&path, ANCHOR_LINE).unwrap();
        let mut tailer = EeLogTailer::new(&path);
        tailer.poll().unwrap();

        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("10.0 Script [Info]: ChatRedux::AddTab: Adding tab with chann");
        std::fs::write(&path, &text).unwrap();
        assert!(tailer.poll().unwrap().is_empty(), "partial line must not be parsed");

        // Completed on the next write.
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("el name: FSomeone\u{e000} to index 6\n30.0 Sys [Info]: later\n");
        std::fs::write(&path, &text).unwrap();

        let events = tailer.poll().unwrap();
        assert_eq!(events.len(), 1, "completed line should parse once");
        let EeLogEvent::DirectMessage(dm) = &events[0] else { panic!("expected a DM") };
        assert_eq!(dm.user, "Someone");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn matches_the_reference_python_parser_on_the_real_log() {
        // Cross-validation against testApp/chat.py, which was verified by hand against
        // this session. Divergence here means one of the two is wrong.
        let text = std::fs::read_to_string(reference_log()).expect("reference EE.log");
        let events = parse_all(&text);
        let extracted: Vec<(String, f64)> = events
            .iter()
            .filter_map(|event| match event {
                EeLogEvent::DirectMessage(dm) => Some((dm.user.clone(), dm.elapsed_s)),
                _ => None,
            })
            .collect();

        let expected = [
            ("GodDragon", 74.588),
            ("Meowmeow67", 83.197),
            ("Mgodzillajr", 676.037),
            ("Mgodzillajr", 774.28),
        ];

        assert_eq!(extracted.len(), expected.len(), "got {extracted:?}");
        for ((user, elapsed), (want_user, want_elapsed)) in extracted.iter().zip(expected) {
            assert_eq!(user, want_user);
            assert!((elapsed - want_elapsed).abs() < 1e-6, "{elapsed} != {want_elapsed}");
        }
    }

    fn trade_block(elapsed: &str, giving: &[&str], partner: &str, getting: &[&str]) -> String {
        let mut out = format!(
            "{elapsed} Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description={}\n\n",
            TRADE_OPEN
        );
        for item in giving {
            out.push_str(item);
            out.push('\n');
        }
        out.push_str("\n\n");
        out.push_str(&format!("and will receive from {partner}\u{e000} the following:\n\n"));
        for (index, item) in getting.iter().enumerate() {
            out.push_str(item);
            if index + 1 == getting.len() {
                out.push_str(", title= leftItem=/Menu/Confirm_Item_Ok)");
            }
            out.push('\n');
        }
        out
    }

    fn only_trades(events: Vec<EeLogEvent>) -> Vec<TradeEvent> {
        events
            .into_iter()
            .filter_map(|event| match event {
                EeLogEvent::Trade(trade) => Some(trade),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_confirmed_trade_is_recorded_with_both_sides() {
        let mut text = String::from(ANCHOR_LINE);
        text.push_str(&trade_block(
            "793.432",
            &["Alternox Prime Blueprint", "Alternox Prime Stock"],
            "-ONG-.FxN",
            &["Platinum x 24"],
        ));
        text.push_str("797.879 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!, title=)\n");

        let trades = only_trades(parse_all(&text));
        assert_eq!(trades.len(), 1);
        let trade = &trades[0];
        assert_eq!(trade.partner, "-ONG-.FxN", "glyph must be stripped");
        assert_eq!(trade.giving.len(), 2);
        assert_eq!(trade.getting.len(), 1);
        assert_eq!(trade.platinum_in, 24);
        assert_eq!(trade.platinum_out, 0);
        assert!((trade.elapsed_s - 793.432).abs() < 1e-6);
    }

    #[test]
    fn a_cancelled_trade_is_never_recorded() {
        // The dialog can be dismissed. Without the success line there is no trade, and
        // recording one would invent a transaction that never happened.
        let mut text = String::from(ANCHOR_LINE);
        text.push_str(&trade_block("100.0", &["Platinum x 10"], "Someone", &["Ash Prime Blueprint"]));
        text.push_str("104.0 Script [Info]: Dialog.lua: Dialog::SendResult(1)\n");
        assert!(only_trades(parse_all(&text)).is_empty());
    }

    #[test]
    fn a_cancelled_trade_does_not_contaminate_the_next_one() {
        let mut text = String::from(ANCHOR_LINE);
        text.push_str(&trade_block("100.0", &["Cancelled Item"], "Nobody", &["Platinum x 99"]));
        text.push_str(&trade_block("200.0", &["Real Item"], "Partner", &["Platinum x 5"]));
        text.push_str("205.0 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!, title=)\n");

        let trades = only_trades(parse_all(&text));
        assert_eq!(trades.len(), 1, "only the confirmed trade counts");
        assert_eq!(trades[0].partner, "Partner");
        assert_eq!(trades[0].platinum_in, 5);
        assert_eq!(trades[0].giving[0].name, "Real Item", "no leakage from the cancelled block");
    }

    #[test]
    fn item_lines_carry_quantity_and_rank_pips() {
        // `Name x N` is an explicit count; a bare line is one.
        let single = parse_traded_item("Alternox Prime Blueprint").unwrap();
        assert_eq!((single.name.as_str(), single.quantity), ("Alternox Prime Blueprint", 1));
        assert_eq!(single.max_rank, None);

        let many = parse_traded_item("Platinum x 24").unwrap();
        assert_eq!((many.name.as_str(), many.quantity), ("Platinum", 24));

        let thousands = parse_traded_item("Credits x 1,250").unwrap();
        assert_eq!(thousands.quantity, 1250);

        // Five rank pips = a 0-5 item. Verified against a real rank-0/5 arcane trade whose
        // line carried exactly five U+E0A6, with the app's own whisper confirming "(Rank 0/5)".
        // Five empty pips: a 0/5 item. Verified against a real trade whose whisper confirmed
        // "(Rank 0/5)".
        let unranked = parse_traded_item("Arcane Universal Fallout \u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}")
            .unwrap();
        assert_eq!(unranked.name, "Arcane Universal Fallout", "pips must not leak into the name");
        assert_eq!((unranked.rank, unranked.max_rank), (Some(0), Some(5)));
        assert_eq!(unranked.quantity, 1);

        // Five filled pips: a 5/5 item, from a real Secondary Dexterity trade.
        let maxed = parse_traded_item("Secondary Dexterity \u{e0cb}\u{e0cb}\u{e0cb}\u{e0cb}\u{e0cb}")
            .unwrap();
        assert_eq!(maxed.name, "Secondary Dexterity");
        assert_eq!((maxed.rank, maxed.max_rank), (Some(5), Some(5)));

        // A partial rank mixes the two. Inferred from the bar's structure rather than
        // observed, so it is pinned here to make the assumption explicit.
        let partial = parse_traded_item("Some Mod \u{e0cb}\u{e0cb}\u{e0cb}\u{e0a6}\u{e0a6}")
            .unwrap();
        assert_eq!((partial.rank, partial.max_rank), (Some(3), Some(5)));
        assert_eq!(partial.name, "Some Mod");
    }

    #[test]
    fn every_copy_of_an_item_is_counted() {
        // Each copy occupies its own line and the last carries the dialog arguments, so two
        // identical lines are two real items. Verified against a trade of two Arcane
        // Universal Fallout for 10p. Treating the closing line as a repeat under-counts
        // every multi-copy trade by one.
        let mut text = String::from(ANCHOR_LINE);
        text.push_str(&format!(
            "500.0 Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description={}\n\n\
             Platinum x 10\n\n\
             and will receive from Someone\u{e000} the following:\n\n\
             Arcane Universal Fallout \u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}\n\n\
             Arcane Universal Fallout \u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}\u{e0a6}, title= leftItem=/Menu/Confirm_Item_Ok)\n\
             505.0 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!, title=)\n",
            TRADE_OPEN
        ));

        let trades = only_trades(parse_all(&text));
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].getting.len(), 2, "two arcanes were traded, not one");
        assert_eq!(trades[0].platinum_out, 10);
    }

    #[test]
    fn parses_the_real_trade_from_the_reference_log() {
        let text = std::fs::read_to_string(reference_log()).expect("reference EE.log");
        let trades = only_trades(parse_all(&text));
        assert_eq!(trades.len(), 1, "the reference session holds one completed trade");

        let trade = &trades[0];
        assert_eq!(trade.partner, "Ervil_LeBaron");
        assert_eq!(trade.platinum_out, 10, "user paid 10 platinum");
        assert_eq!(trade.platinum_in, 0);
        // Two arcanes for 10 platinum — a real multi-copy trade, not a parsing artefact.
        assert_eq!(trade.getting.len(), 2);
        assert_eq!(trade.getting[0].name, "Arcane Universal Fallout");
        assert_eq!(trade.getting[1].name, "Arcane Universal Fallout");
        // Rank is readable from the pips even though EE.log has no rank field.
        assert_eq!(trade.getting[0].max_rank, Some(5));
        assert_eq!(trade.getting[0].rank, Some(0), "both arcanes were unranked");
        assert!(trade.occurred_at.is_some());
    }

    #[test]
    fn parses_the_real_reference_log() {
        let text = std::fs::read_to_string(reference_log())
            .expect("reference EE.log — see Resources/WFAndAlecaAppData");
        let events = parse_all(&text);

        assert!(!events.is_empty(), "reference session contains DM tabs");
        for event in &events {
            let EeLogEvent::DirectMessage(dm) = event else { continue };
            assert!(!dm.user.is_empty());
            // A name that kept its glyph, or ran past the line, is the classic failure.
            assert!(
                !dm.user.chars().any(|c| (PUA_START..=PUA_END).contains(&c)),
                "private-use glyph survived in {:?}",
                dm.user
            );
            assert!(dm.user.len() < 64, "name ran past its line: {:?}", dm.user);
            assert!(dm.occurred_at.is_some(), "anchor should stamp every event");
        }
    }
}
