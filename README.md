# BidRL Deal Tracker

Watches BidRL auctions in **Turlock and Modesto**, prices each item against Amazon (or the retail price the listing states), and tells you the most you should bid.

For every item it shows:

| Field | Meaning |
|---|---|
| **New price** | What it costs new. Your own price first, then a confident Amazon match, then the listing's "Retail $X". |
| **Next bid** | The minimum bid BidRL will accept right now. |
| **Max bid** | The highest bid that still saves your target % (default 40%) after buyer's premium and sales tax. |
| **Don't go over** | Break-even bid. Above this, buying it new is cheaper. |

Status: **Good** (next bid ≤ max bid) · **Fair** (between max bid and break-even) · **Over** · **No price**.

The math: `all-in = bid × (1 + buyer's premium) × (1 + sales tax) + extra fee`. The buyer's premium is read from each item (13–15% on BidRL). Sales tax defaults to 8.875% (Modesto; Turlock is about 8.625%), so max bids come out slightly conservative.

## Run it

Needs Node.js 20.6+ and has no dependencies.

```bash
cp .env.example .env     # optional: edit locations, Amazon key, alerts
npm start                # http://127.0.0.1:3000
```

**Windows:** double-click `start.bat`. It starts the tracker in a minimized window and opens the page; double-clicking it again while it's running just opens the page. To have it start automatically when you log in, press `Win+R`, type `shell:startup`, and put a shortcut to `start.bat` in that folder.

The first refresh takes about 30 seconds: 5 requests spaced 5 s apart, per BidRL's robots.txt crawl delay. After that it refreshes every 15 minutes, and the page updates itself every minute.

To open it from your phone on the same Wi-Fi, set `HOST=0.0.0.0` and browse to `http://<your-computer-ip>:3000`. Don't expose it to the internet: it has no login.

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
