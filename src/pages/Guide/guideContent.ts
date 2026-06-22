import type { PageId } from '../../types';

/**
 * Data-driven content model for the Guide page. Keeping the copy in a typed
 * structure (rather than hardcoded JSX) lets the page auto-build its table of
 * contents, render every block through one small switch, and power a live
 * search/filter over both section text and glossary terms.
 *
 * All copy is intentionally plain-language so a brand-new user can understand
 * the app without knowing the underlying maths.
 */

export type GuideBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'tabCard'; page: PageId; title: string; whatFor: string; whenToUse: string }
  | { kind: 'glossary'; terms: { term: string; def: string }[] }
  | { kind: 'callout'; tone: 'blue' | 'amber' | 'green'; text: string }
  | { kind: 'faq'; items: { q: string; a: string }[] };

export interface GuideSection {
  id: string;
  title: string;
  blurb: string;
  blocks: GuideBlock[];
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'quick-start',
    title: 'Quick Start',
    blurb: 'Get up and running in your first few minutes.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'WarStonks helps you trade items on Warframe.Market: it watches prices for you, tells you when something is worth buying, and keeps track of your trades and profit. Here is the fastest path to your first deal.',
      },
      {
        kind: 'steps',
        items: [
          'Connect your Warframe.Market account in Trades. This lets the app read your orders and detect completed trades. You only sign in once — it is remembered securely.',
          'Search for an item using the search bar and open it. You will see its live price and analytics.',
          'Add an item to your Watchlist with a target (desired) price. The app then scans it on a timer and watches for sellers at or below your price.',
          'When a seller hits your target you get an Alert. Open Home → Alerts to see it.',
          'Click Copy Message on the alert or watchlist row. This copies a ready-to-send whisper you can paste into Warframe to message the seller.',
          'After you buy, click Mark as bought so the app records the trade for your Portfolio and profit tracking.',
        ],
      },
      {
        kind: 'callout',
        tone: 'blue',
        text: 'You do not need to sign in just to browse prices and analytics. Signing in is only required for order management and automatic trade detection.',
      },
    ],
  },
  {
    id: 'workflow',
    title: 'Typical Workflow',
    blurb: 'The day-to-day loop most traders settle into.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'There is no single "right" way to use WarStonks, but most traders fall into a rhythm that looks like this:',
      },
      {
        kind: 'steps',
        items: [
          'Build a watchlist of items you care about, each with the price you would happily pay.',
          'Let the scanners run in the background. Check the Scanners and Opportunities tabs for items that are currently mispriced or have a healthy margin.',
          'Before committing, open an item and read its analytics — is the current price actually a good deal, or just a single cheap listing?',
          'Buy at or below your target, then immediately whisper the next-cheapest seller if you want more.',
          'Mark each purchase as bought. If you plan to resell, list it back on the market from the Trades tab.',
          'Review your performance in Portfolio: what you are holding, what you have flipped, and your realised profit.',
        ],
      },
      {
        kind: 'callout',
        tone: 'green',
        text: 'A good flip is "buy below the fair value, sell near it." The analytics are built to help you judge both ends of that without guessing.',
      },
    ],
  },
  {
    id: 'tabs',
    title: 'The Tabs',
    blurb: 'What each part of the app is for.',
    blocks: [
      {
        kind: 'tabCard',
        page: 'home',
        title: 'Home',
        whatFor: 'Your dashboard. Holds your Watchlist, live Alerts when targets are hit, and an at-a-glance Overview.',
        whenToUse: 'Start here. It is where you react to deals and manage the items you are tracking.',
      },
      {
        kind: 'tabCard',
        page: 'market',
        title: 'Market',
        whatFor: 'Deep-dive analytics for any single item: price history, fair value, entry/exit zones, and order-book health.',
        whenToUse: 'When you want to understand an item before buying or selling it.',
      },
      {
        kind: 'tabCard',
        page: 'events',
        title: 'Events',
        whatFor: 'Live Warframe worldstate: fissures, alerts, the Void Trader (Baro), and other time-limited activities.',
        whenToUse: 'To catch time-sensitive opportunities tied to in-game events.',
      },
      {
        kind: 'tabCard',
        page: 'scanners',
        title: 'Scanners',
        whatFor: 'Automated sweeps that surface mispriced items, arbitrage between a set and its parts, and relic-related plays.',
        whenToUse: 'When you want the app to find opportunities for you rather than searching manually.',
      },
      {
        kind: 'tabCard',
        page: 'opportunities',
        title: 'Opportunities',
        whatFor: 'A curated, ranked list of the strongest buy/flip candidates the engine has found right now.',
        whenToUse: 'When you have plat to spend and want the best ideas in one place.',
      },
      {
        kind: 'tabCard',
        page: 'trades',
        title: 'Trades',
        whatFor: 'Connect your Warframe.Market account, manage your buy and sell orders, and let the app detect completed trades automatically.',
        whenToUse: 'To sign in, post or update listings, and keep your order book healthy.',
      },
      {
        kind: 'tabCard',
        page: 'portfolio',
        title: 'Portfolio',
        whatFor: 'Your holdings and trade history with realised profit and loss.',
        whenToUse: 'To review how you are doing and what you are currently holding.',
      },
      {
        kind: 'callout',
        tone: 'amber',
        text: 'The Strategy tab is planned for a future release and is not active yet.',
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Reading the Analytics Tab',
    blurb: 'What every chart line, zone, and panel on the Analytics tab means.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The Analytics tab is the data view: price history plus the live order book, turned into a few clear judgements — what an item is worth, where to buy, and where to sell. Here is each piece, top to bottom.',
      },
      { kind: 'subheading', text: 'The Price Chart' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Median (price line)', def: 'The typical price of confirmed completed sales in each time bucket — what people actually paid, not what sellers are asking. This is the backbone of the chart.' },
          { term: 'Average', def: 'The volume-weighted average of confirmed sales in the bucket. Sits near the median but is pulled more by unusually large or expensive trades.' },
          { term: 'Open / Close / High / Low', def: 'The candle for each bucket: the first and last confirmed sale price, and the highest and lowest within that period.' },
          { term: 'Live floor (lowest sell)', def: 'The cheapest listing on the market right now. It is a live, open-order value — a single cheap listing does not mean the item is cheap overall.' },
          { term: 'Highest buy', def: 'The most anyone is currently offering to pay (the top live WTB order).' },
          { term: 'Volume', def: 'How many confirmed sales happened in each bucket. Taller volume = more trading = more reliable prices.' },
          { term: 'Entry / Exit zone bands', def: 'Shaded ranges overlaid on the chart showing the historically good buy range (entry) and sell range (exit).' },
          { term: 'Range & Bucket', def: 'Range is how far back the chart looks (e.g. 48h, 30d); Bucket is how much time each point covers (e.g. 1 hour, 1 day).' },
        ],
      },
      {
        kind: 'callout',
        tone: 'blue',
        text: 'Why the current hour can look empty: the price line only uses confirmed sales. If nothing has sold yet this hour, there is no median to draw — you will still see the live floor. This is intentional, so open listings can never inflate the history.',
      },
      { kind: 'subheading', text: 'Entry / Exit Zone Overview' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Current Lowest', def: 'The cheapest live sell order right now (your realistic buy-in price this second).' },
          { term: 'Median Lowest', def: 'The typical cheapest-sell price over the recent window — a sanity check on whether the current floor is unusually high or low.' },
          { term: 'Fair Value Band', def: 'The estimated true-worth range, smoothing out spikes. Buying below it and selling near/above it is the core flip idea.' },
          { term: 'Entry Zone', def: 'The price range that has historically been a good place to buy. Built from confirmed-sale history, not live asks.' },
          { term: 'Exit Zone', def: 'The price range that has historically been a good place to sell. Capped against the live book so you never aim above what buyers will actually pay.' },
          { term: 'Zone Quality', def: 'How trustworthy the entry/exit zones are, based on how much clean data backs them.' },
        ],
      },
      { kind: 'subheading', text: 'Orderbook Pressure' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Pressure Ratio', def: 'A measure of whether buyers or sellers dominate the live book. Above balance leans toward demand (prices may rise); below leans toward supply.' },
          { term: 'Book Bias', def: 'The plain-language read of the pressure ratio (e.g. demand-leaning, balanced, supply-leaning).' },
          { term: 'Demand Ratio / Qty-Weighted Demand', def: 'How much buy interest there is relative to sell interest, counting order quantities — not just the number of orders.' },
          { term: 'Entry Depth / Exit Depth', def: 'How many units are stacked near the buy side (entry) and sell side (exit). Deep books absorb trades without moving price much.' },
          { term: 'Spread', def: 'The gap between the highest buy and lowest sell. A tight spread means an efficient, liquid market.' },
          { term: 'Sellers Within +2pt', def: 'How many sellers are clustered within 2 platinum of the floor. Many = heavy undercutting competition.' },
          { term: 'Undercut Velocity', def: 'How quickly sellers are cutting each other’s prices. High velocity means the floor is dropping fast.' },
        ],
      },
      { kind: 'subheading', text: 'Trend Quality Breakdown' },
      {
        kind: 'glossary',
        terms: [
          { term: '1H / 3H / 6H Slope', def: 'The direction and steepness of price over the last 1, 3, and 6 hours. Positive = rising, negative = falling.' },
          { term: 'Direction', def: 'The overall trend read (up, down, or flat) once the slopes are combined.' },
          { term: 'Confidence', def: 'How much to trust the trend read — higher when the data is consistent and there is enough volume.' },
          { term: 'Volatility', def: 'How much the price jumps around. High volatility means more risk and wider safety margins are needed.' },
          { term: 'Stability', def: 'The opposite of volatility — how steady and predictable recent prices have been.' },
          { term: 'Noise', def: 'Random, meaningless price wiggle that should not be mistaken for a real trend.' },
          { term: 'Reversal', def: 'A signal that the trend may be turning the other way.' },
        ],
      },
      { kind: 'subheading', text: 'Action Card' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Action (Buy / Hold / Caution / Wait)', def: 'The headline recommendation, combining the price zones, liquidity, trend, and risk into one call. Buy = favourable; Wait = not yet.' },
          { term: 'Active Signals', def: 'The specific reasons behind the action — the individual checks that fired for or against a trade.' },
          { term: 'Cross Signal', def: 'A confirmation when several independent indicators agree, which strengthens the recommendation.' },
        ],
      },
    ],
  },
  {
    id: 'analysis',
    title: 'Reading the Analysis Tab',
    blurb: 'What the trade-readout panels on the Analysis tab mean.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The Analysis tab is the decision view: it takes the same market data and turns it into a trading readout — a posture, a profit estimate, risk checks, and supply context — so you can decide quickly whether an item is worth it.',
      },
      { kind: 'subheading', text: 'Trade Posture (headline)' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Trade Posture', def: 'The overall stance on the item right now: e.g. Buy Bias, Selective, Wait, Cautious Read, or High Caution. It blends margin, liquidity, trend, and risk into one verdict.' },
          { term: 'Entry Price', def: 'The price the engine suggests buying at, derived from confirmed-sale history and sanity-checked against the live floor.' },
          { term: 'Exit Price', def: 'The price the engine suggests selling at. The label (e.g. P60) shows which percentile of the sell ladder it targets.' },
          { term: 'Exit Percentile (P60)', def: 'Where in the range of sell prices the exit sits. P60 means the 60th percentile — a realistic sell point, not the greedy top.' },
          { term: 'Gross Margin', def: 'The raw difference between exit and entry price, before any costs or realism adjustments.' },
          { term: 'Net Margin', def: 'The expected profit after accounting for execution realism — the number that actually matters for a flip.' },
          { term: 'Liquidity (score & label)', def: 'How easily you can trade the item, as a percentage and a word (e.g. Thin, Healthy). Low liquidity means a flip may sit unsold for a long time.' },
          { term: 'Trend Confidence', def: 'How reliable the current price direction is — backs up whether the margin is likely to hold.' },
          { term: 'Risk Posture', def: 'A quick read of how risky the item is right now, driven mainly by the manipulation-risk check.' },
        ],
      },
      { kind: 'subheading', text: 'Flip Analysis, Liquidity & Trend panels' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Zone Adjusted Edge', def: 'Your expected edge once the entry/exit zones and current conditions are factored in — a more honest profit read than gross margin.' },
          { term: 'Efficiency Score', def: 'How cleanly a trade can actually be executed given the live book. High = easy fills; low = you will fight undercutting or thin demand.' },
          { term: 'Efficiency Penalty', def: 'The deduction applied to your edge for a messy or illiquid market.' },
          { term: 'Liquidity Detail', def: 'The supporting numbers behind the liquidity score — order counts, depth, and how active the book is.' },
          { term: 'Time of Day Liquidity', def: 'When this item trades most actively. The Strongest/Weakest Window tells you the best and worst hours to buy or sell.' },
          { term: 'Strongest / Weakest Window', def: 'The hours with the most and least trading activity for this item — time your trades around the strong window.' },
        ],
      },
      { kind: 'subheading', text: 'Manipulation Risk' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Risk Level', def: 'How likely recent prices are being artificially pushed around rather than reflecting genuine demand. Higher risk = discount any margin you see.' },
          { term: 'Market Structure', def: 'Whether the order book looks natural or shows tell-tale signs of manipulation (e.g. walls, spoofing patterns).' },
          { term: 'Safety', def: 'A summary of how safe it is to act on the current readout.' },
        ],
      },
      { kind: 'subheading', text: 'Supply, Event & Item Context' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Supply Context', def: 'Where the item comes from — its drop sources and how easy it is to farm. Plentiful supply caps how high a price can hold.' },
          { term: 'Drop Sources', def: 'The missions, relics, or vendors that produce the item.' },
          { term: 'Event Context / World State', def: 'Live in-game events (fissures, Baro, etc.) that can affect supply or demand for the item right now.' },
          { term: 'Item Details', def: 'Reference data from the local catalog: description, category, rank scaling, and a wiki link.' },
          { term: 'Observatory Tape', def: 'WarStonks’ own recorded history of market snapshots, used to validate and enrich the analysis.' },
          { term: 'Analytics Carryover', def: 'Values brought in from the Analytics tab’s snapshot so both tabs stay consistent.' },
        ],
      },
      { kind: 'subheading', text: 'Track Record / Backtest' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Backtest Status', def: 'Whether the engine’s past recommendations are still being graded (Pending) or have a result (Graded).' },
          { term: 'Hit Rate', def: 'The share of past buy recommendations that worked out — a rolling measure of how often the engine is right.' },
          { term: 'Median Days Held', def: 'How long a typical recommended flip took to close.' },
          { term: 'Median Return / Return Range', def: 'The typical profit of graded recommendations, and the spread between the weaker (p25) and stronger (p75) outcomes.' },
          { term: 'Open Positions', def: 'Recommendations still in flight that have not been graded yet.' },
        ],
      },
      {
        kind: 'callout',
        tone: 'amber',
        text: 'The track record reflects how the engine’s recommendations have performed historically — it is context to calibrate your trust, not a guarantee of future results.',
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    blurb: 'Warframe, trading, and data terms explained simply.',
    blocks: [
      { kind: 'subheading', text: 'Warframe terms' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Platinum (plat)', def: 'Warframe’s premium currency and the unit nearly all trades are priced in.' },
          { term: 'Ducats', def: 'A currency from selling prime parts to Baro; not the same as plat, but relevant to prime-part value.' },
          { term: 'Set vs Part', def: 'Many items (e.g. Prime sets) are sold either whole or as individual parts. Prices for the set and its parts can diverge.' },
          { term: 'Rank', def: 'Mods and some items have a level (e.g. Rank 0–10). Higher ranks are usually worth more, so rank matters when pricing.' },
          { term: 'Riven', def: 'A randomised mod whose value depends heavily on its stats; priced individually.' },
          { term: 'Fissure', def: 'A time-limited in-game mission type that drops relics; relevant to prime-part supply.' },
          { term: 'Relic', def: 'An item opened in fissure missions to obtain prime parts.' },
          { term: 'Void Trader (Baro Ki’Teer)', def: 'A travelling vendor who appears periodically with rare goods; his visits can shift prices.' },
          { term: 'Worldstate', def: 'The live state of the game world — events, alerts, fissures, and traders — pulled from an external feed.' },
        ],
      },
      { kind: 'subheading', text: 'Trading basics' },
      {
        kind: 'glossary',
        terms: [
          { term: 'WTS / WTB', def: 'Want To Sell / Want To Buy — the two sides of every market listing.' },
          { term: 'Order / Listing', def: 'A public offer to buy or sell an item at a set price.' },
          { term: 'Order book', def: 'The full set of live buy and sell orders for an item right now.' },
          { term: 'Floor', def: 'The cheapest current sell price (lowest ask).' },
          { term: 'Spread', def: 'The gap between the highest buy and the lowest sell. Tight = efficient market.' },
          { term: 'Liquidity', def: 'How quickly you can buy or sell without moving the price. High = lots of active traders.' },
          { term: 'Depth', def: 'How many units are stacked at or near the best prices — deep books absorb trades without big price swings.' },
          { term: 'Undercutting', def: 'Sellers repeatedly listing just below each other to win the sale, which drags the floor down.' },
          { term: 'Arbitrage', def: 'Profiting from a price gap — e.g. buying parts cheaply and selling the assembled set for more (or vice versa).' },
          { term: 'Flip', def: 'Buying low and selling higher for profit; the core activity WarStonks supports.' },
          { term: 'Whisper', def: 'A direct in-game message. WarStonks generates a ready-to-paste whisper to contact a seller.' },
        ],
      },
      { kind: 'subheading', text: 'Data & analytics terms' },
      {
        kind: 'glossary',
        terms: [
          { term: 'Closed vs Live data', def: 'Closed = confirmed completed sales (history). Live = current open orders. WarStonks keeps price history on closed data and the order-book reads on live data.' },
          { term: 'Median', def: 'The middle value — the typical price, unaffected by a few extreme trades. Preferred over the average for a fair read.' },
          { term: 'Average (weighted)', def: 'The mean price, weighted by trade volume; more sensitive to large or pricey trades than the median.' },
          { term: 'Percentile (e.g. P60)', def: 'A position within a sorted range. P60 = higher than 60% of the values — used to pick a realistic exit price.' },
          { term: 'Fair value', def: 'WarStonks’ estimate of an item’s true worth, smoothing out short-term spikes.' },
          { term: 'Margin (gross / net)', def: 'Gross = exit minus entry. Net = expected profit after execution realism. Net is the one to trust.' },
          { term: 'Pressure / Pressure ratio', def: 'Whether buyers or sellers dominate the live book — a hint about which way price may lean.' },
          { term: 'Slope', def: 'The rate of price change over a time window (1H/3H/6H). Positive = rising, negative = falling.' },
          { term: 'Volatility', def: 'How much the price jumps around. High volatility = more risk.' },
          { term: 'Confidence', def: 'How much to trust a given read, based on data quality and volume.' },
          { term: 'Liquidity score', def: 'A 0–100% rating of how tradeable an item is right now.' },
          { term: 'Manipulation risk', def: 'A warning when prices look artificially pushed around rather than driven by genuine demand.' },
          { term: 'Hit rate', def: 'The share of past recommendations that worked out — a track-record measure.' },
          { term: 'Backtest', def: 'Grading past recommendations against what actually happened, to measure the engine’s accuracy.' },
        ],
      },
    ],
  },
  {
    id: 'faq',
    title: 'FAQ & Troubleshooting',
    blurb: 'Common questions and fixes.',
    blocks: [
      {
        kind: 'faq',
        items: [
          {
            q: 'Why do I need to sign in to Warframe.Market?',
            a: 'Only features that touch your own account — managing your orders and detecting your completed trades — require signing in. Browsing prices and analytics works without it. Your login is stored securely in your operating system’s keychain and is only cleared when you manually disconnect.',
          },
          {
            q: 'Why does a worldstate feed show as offline?',
            a: 'Events data comes from an external service that can occasionally be unavailable. The app caches the last good data and retries automatically; you can also hit Retry on the alert.',
          },
          {
            q: 'Why is the current hour’s price sometimes blank?',
            a: 'The price line only uses confirmed sales. If nothing has sold yet this hour, there is no median to plot — the live floor still shows the cheapest current listing.',
          },
          {
            q: 'Why is scanning sometimes a little slow?',
            a: 'WarStonks deliberately rate-limits its requests to Warframe.Market to stay within their fair-use limits and protect your account. Heavy watchlists are scanned in turn rather than all at once.',
          },
          {
            q: 'My copied whisper has a rank in it — is that right?',
            a: 'Yes. For ranked items the whisper includes the rank (e.g. "Rank 0/10") so the seller knows exactly which variant you want.',
          },
        ],
      },
    ],
  },
];
