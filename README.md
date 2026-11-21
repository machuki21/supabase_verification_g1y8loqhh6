# BidRL Deal Tracker

Watches BidRL auctions in **Turlock and Modesto**, prices each item against Amazon (or the retail price the listing states), and tells you the most you should bid.

For every item it shows:

| Field | Meaning |
|---|---|
| **New price** | What it costs new. Your own price first, then a confident Amazon match, then the listing's "Retail $X". |
| **Next bid** | The minimum bid BidRL will accept right now. |
| **Max bid** | The highest bid that still saves your target % (default 40%) after buyer's premium and sales tax. |
| **Don't go over** | Break-even bid. Above this, buying it new is cheaper. |

## My list

Tap **☆ Want** on any item to star it. **My list** shows your starred items, soonest-ending first, each with:

- **Your max bid**: type your own, or leave it blank to use the tracker's max bid.
- **Bid on BidRL · max $X**: opens the item on BidRL. Enter that amount as your max bid there, and BidRL bids for you up to that limit.
- **Update now**: fetches that item's latest bid from BidRL (one request).

With alerts set up (below), you get a reminder 30 minutes before each starred item ends, with a fresh bid, and an alert if the price passes your max. Ended items stay on the list for 3 days.

The tracker never logs in to BidRL or places bids. That stays in BidRL's own app, so your password and card never touch this tool.

Status: **Good** (next bid ≤ max bid) · **Fair** (between max bid and break-even) · **Over** · **No price**.

The math: `all-in = bid × (1 + buyer's premium) × (1 + sales tax) + extra fee`. The buyer's premium is read from each item (13–15% on BidRL). Sales tax defaults to 8.875% (Modesto; Turlock is about 8.625%), so max bids come out slightly conservative.

## Run it

Needs Node.js 20.6+ and has no dependencies.

```bash
cp .env.example .env     # optional: edit locations, Amazon key, alerts
npm start                # http://127.0.0.1:3000
```

**Windows:** double-click `start.bat`. It starts the tracker in a minimized window and opens the page; double-clicking it again while it's running just opens the page. To have it start automatically when you log in, press `Win+R`, type `shell:startup`, and put a shortcut to `start.bat` in that folder.

The first refresh takes about 30 seconds: 5 requests spaced 5 s apart, per BidRL's robots.txt crawl delay. After that it refreshes every 30 minutes, and the page updates itself every minute.

**On your phone, from anywhere (recommended):** install [Tailscale](https://tailscale.com/download) on your PC and phone and sign in to both with the same account. Then, with the tracker running, run `tailscale serve --bg 3000` once on the PC. It prints a private `https://<pc-name>.<tailnet>.ts.net` link that only your devices can open. Keep the PC awake.

To open it from your phone on the same Wi-Fi without Tailscale, set `HOST=0.0.0.0` and browse to `http://<your-computer-ip>:3000`. Don't expose it to the internet: it has no login.

## Automatic updates (Windows)

Set the app up once with Git instead of the ZIP. Then `start.bat` fetches the latest version every time it starts, and `update.bat` updates and restarts it on demand.

1. Install Git from https://git-scm.com/download/win, accepting the defaults.
2. In Command Prompt:
   ```bat
   git clone -b claude/bidrl-amazon-price-tracker-wrmbpf https://github.com/machuki21/supabase_verification_g1y8loqhh6.git "%USERPROFILE%\bidrl-tracker"
   ```
   A GitHub sign-in window opens the first time. The repo is private, so sign in.
3. Copy `.env` (and the `data` folder, if you want to keep your list) from the old folder into `%USERPROFILE%\bidrl-tracker`.

Your `.env` and `data` are never touched by updates.

## Amazon prices

Amazon blocks scraping, so live Amazon prices come from a paid search API. Choose one:

| Provider | `.env` | Notes |
|---|---|---|
| [SerpApi](https://serpapi.com) | `AMAZON_PROVIDER=serpapi` | Amazon Search engine |
| [Rainforest API](https://www.rainforestapi.com) | `AMAZON_PROVIDER=rainforest` | Amazon-only data API |

Then set `AMAZON_API_KEY`. To keep cost bounded:

- Only items ending within `AMAZON_LOOKUP_WINDOW_HOURS` (default 24 h) are looked up, highest stated retail first.
- Duplicate lots share one lookup, and results are cached for 3 days.
- Hard cap: `AMAZON_DAILY_LOOKUPS` (default 100 per day).
- A match is trusted only if the Amazon title covers most of the BidRL title, including brand and model number (`AMAZON_MIN_CONFIDENCE`). The cheapest trusted result is used. Weak matches are shown but not used.

Without a provider, the app uses the listing's stated retail (about 10% of items) and gives each item a **Search Amazon** link plus **Set price**, so you can enter the price yourself.

## Phone alerts (optional)

Set `NTFY_URL=https://ntfy.sh/<a-long-random-topic>` and subscribe to that topic in the [ntfy app](https://ntfy.sh), or set `ALERT_WEBHOOK_URL` to a Discord or Slack webhook. You get one alert per item when it is a **Good** deal, saves at least `ALERT_MIN_SAVINGS_PCT` (50%), and ends within `ALERT_ENDS_WITHIN_HOURS` (6 h).

## Settings

See `.env.example` for all settings. The bid rules (target savings, tax, extra cost, whether to trust listed retail) can also be changed in the app under **Bid rules**.

`BIDRL_LOCATIONS` takes BidRL location names, such as `Turlock,Modesto` or `Turlock,Modesto,Merced`. Leave it empty to watch every location.

## Caveats

- **BidRL's Terms of Use prohibit "any automatic device… to monitor or copy" their pages.** This tool does that, so use it at your own risk: BidRL could block your IP. It refreshes every 30 minutes, spaces requests 5 s apart, and only covers the locations you choose, to keep its footprint small.
- **Savings % is only meaningful near the close.** Days out, most lots sit at $1 and look like 99% off. Sort by **Ending soonest** and bid near the end.
- **Listed "Retail $X" is the seller's claim**, often MSRP, and can be well above street price. Prefer Amazon or your own price for anything you'd pay real money for.
- **Condition flags** (untested, damaged, open box, …) come from keywords in the listing. Liquidation items can be returns, so raise your target savings for risky items.
- BidRL data comes from the JSON endpoint its own website uses (`POST /api/getitems`). It is undocumented, so if BidRL changes it, refreshes will fail with a clear error in the status bar.

## Development

```bash
npm test        # node:test, no network
npm run dev     # restart on file changes
```

Code layout: `src/bidrl.js` (BidRL client), `src/amazon/` (price providers, cache, budget), `src/match.js` (title matching), `src/pricing.js` (bid math), `src/server.js` (API, poller, alerts), `public/` (UI).
