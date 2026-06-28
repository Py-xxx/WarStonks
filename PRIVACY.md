# WarStonks Privacy Policy

_Last updated: 2026-06-27_

WarStonks is a **local-first desktop application**. The developer ("py.") does **not** operate any
WarStonks server, does **not** collect, store, or transmit your personal data to us, and has **no
analytics, telemetry, or tracking** of any kind.

## What stays on your device

All of your data lives **locally** on your computer:

- Your watchlist, owned inventory, accepted opportunities, trade log, and app settings (stored in
  local files / SQLite databases and your browser-engine local storage).
- Cached market data (price snapshots, statistics) used to work offline.
- Your Warframe.Market session token, stored in your **operating system's secure keychain**
  (Windows Credential Manager), never in plain files and never sent to the developer.

You can export or delete this data at any time from **Settings → Import & Export**.

## What WarStonks sends, and to whom

To do its job, WarStonks communicates **directly** from your device with third-party services you
choose to use. The developer never sees this traffic. These services have their own privacy
policies:

| Service | Why | What is sent |
|---|---|---|
| **Warframe.Market** (`api.warframe.market`) | Live prices, orders, sign-in, listing management | Your WFM credentials/session and the actions you take (only when you sign in / act) |
| **warframestat.us** | Worldstate data (fissures, Void Trader, cycles, etc.) | Standard request metadata only |
| **GitHub** (`github.com`) | Checking for and downloading app updates | Standard request metadata only |
| **Alecaframe** (`stats.alecaframe.com`) | Optional wallet/inventory sync | Only if you enable it and provide your public link |
| **Discord** (your webhook) | Optional alert notifications | Only the alert content, and only if you configure a webhook URL |

WarStonks only contacts Alecaframe or Discord if **you** explicitly enable and configure them.

## No accounts, no third-party sharing by us

There is no WarStonks account. Because the developer collects nothing, there is nothing for us to
sell, share, or hand over.

## Contact

Questions: <https://pyth.co.za> · project: <https://github.com/Py-xxx/WarStonks>
