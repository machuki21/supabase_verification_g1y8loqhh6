import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { fetchAllItems, fetchLocations, resolveLocations } from './bidrl.js';
import { createAmazonLookup, lookupCandidates, amazonSearchUrl } from './amazon/index.js';
import { chooseReference, evaluateDeal } from './pricing.js';
import { createAlerter } from './alerts.js';
import { createWatchlist } from './watchlist.js';
import { findSuggestions, digestMessage } from './wishes.js';
import { cacheKey } from './text.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

export function createApp(cfg, { fetchImpl = fetch } = {}) {
  const store = openStore(cfg.dataFile);
  const amazon = createAmazonLookup(cfg.amazon, store, { fetchImpl, log });
  const alerter = createAlerter(cfg.alerts, { fetchImpl, log });

  let watchTimer = null;
  let polling = false;
  let locationIds = null; // resolved lazily from names; null = not resolved yet
  let locationNames = [];
  let nextPollAt = null;
  let timer = null;

  const settings = () => ({ ...cfg.defaults, ...store.data.settings });

  function buildDeal(item, s = settings()) {
    const az = store.data.amazonCache[cacheKey(item.query)] || null;
    const override = store.data.overrides[item.id] || null;
    const reference = chooseReference(item, az, override, s);
    return {
      ...item,
      amazon: az && {
        status: az.status,
        price: az.price,
        title: az.title,
        url: az.url,
        confidence: az.confidence,
        generic: Boolean(az.generic),
        checkedAt: az.checkedAt,
        error: az.error,
      },
      amazonSearchUrl: amazonSearchUrl(item.query, cfg.amazon.domain),
      override,
      reference,
      ...evaluateDeal(item, reference, s),
      wanted: Boolean(store.data.watchlist[item.id]),
      myMaxBid: store.data.watchlist[item.id]?.maxBid ?? null,
    };
  }

  function suggestions() {
    const starred = Object.values(store.data.watchlist).map((w) => w.item);
    return findSuggestions(Object.values(store.data.items), store.data.wishes, starred);
  }

  /** After each poll: one notification listing suggestions you haven't been told about yet. */
  async function runWishDigest() {
    if (!alerter.enabled) return;
    const s = settings();
    const fresh = suggestions()
      .filter(({ item }) => !store.data.suggested[item.id])
      .map(({ item, reasons }) => ({ deal: buildDeal(item, s), reasons }));
    const msg = digestMessage(fresh, cfg.alerts.appUrl);
    if (msg && (await alerter.sendMessage(msg))) {
      for (const f of fresh) store.data.suggested[f.deal.id] = Date.now();
      log(`Suggestion digest sent: ${fresh.length} items`);
      store.save();
    }
  }

  /** Compact snapshot for an assistant: starred items, suggestions, and a ready-to-read text version. */
  function summary() {
    const s = settings();
    const now = Date.now();
    const pick = (d) => ({
      id: d.id,
      title: d.title,
      url: d.url,
      city: d.city,
      endsAt: new Date(d.endsAt).toISOString(),
      minutesLeft: Math.max(0, Math.round((d.endsAt - now) / 60000)),
      nextBid: d.nextBid,
      newPrice: d.reference?.price ?? null,
      priceSource: d.reference ? (d.reference.generic ? 'amazon_typical' : d.reference.source) : null,
      maxBid: d.maxBid,
      dontGoOver: d.walkAwayBid,
    });
    const starred = watchlist.all().map((d) => ({ ...pick(d), yourMax: d.watch.effectiveMax, status: d.watch.status }));
    const might = suggestions()
      .slice(0, 20)
      .map(({ item, reasons }) => ({ ...pick(buildDeal(item, s)), reasons }));
    const money = (n) => (n === null || n === undefined ? 'n/a' : `$${n.toFixed(2)}`);
    const left = (m) => (m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`);
    const active = starred.filter((x) => x.status !== 'ended');
    const lines = [
      `BidRL tracker (${(cfg.locations.length ? cfg.locations : ['all locations']).join(', ')}), updated ${store.data.lastPoll?.finishedAt ? new Date(store.data.lastPoll.finishedAt).toLocaleString() : 'never'}.`,
      active.length ? `Starred (${active.length}):` : 'Nothing starred.',
      ...active.map(
        (x) =>
          `- ${x.title} (${x.city}): next bid ${money(x.nextBid)}, your max ${money(x.yourMax)}, ${x.status === 'over_max' ? 'PAST YOUR MAX' : 'ok'}, ends in ${left(x.minutesLeft)}. ${x.url || ''}`,
      ),
      might.length ? `You might want (${might.length}):` : 'No new suggestions.',
      ...might.map((x) => `- ${x.title} (${x.city}): next bid ${money(x.nextBid)}, max bid ${money(x.maxBid)}, ends in ${left(x.minutesLeft)}, ${x.reasons[0]}. ${x.url || ''}`),
    ];
    return {
      generatedAt: new Date(now).toISOString(),
      lastRefresh: store.data.lastPoll,
      wishes: store.data.wishes.map((w) => w.terms),
      starred,
      youMightWant: might,
      text: lines.join('\n'),
    };
  }

  const watchlist = createWatchlist({ store, buildDeal, alerter, remindMinutes: cfg.watch.remindMinutes, fetchImpl, log });

  async function runLookups() {
    if (!amazon.enabled) return;
    const items = Object.values(store.data.items);
    const todo = lookupCandidates(items, amazon, cfg.amazon, Date.now(), { priorityIds: new Set(Object.keys(store.data.watchlist)) });
    if (todo.length) log(`Amazon: looking up ${todo.length} items (${amazon.remainingToday()} lookups left today)`);
    for (const item of todo) {
      const r = await amazon.lookup(item);
      if (r.status === 'budget_exhausted') break;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  async function runAlerts() {
    if (!alerter.enabled) return;
    const s = settings();
    for (const item of Object.values(store.data.items)) {
      if (store.data.alerted[item.id]) continue;
      const deal = buildDeal(item, s);
      if (!alerter.qualifies(deal)) continue;
      if (await alerter.send(deal)) {
        store.data.alerted[item.id] = Date.now();
        log(`Alert sent: ${deal.title}`);
      }
    }
    store.save();
  }

  function prune() {
    const now = Date.now();
    const live = store.data.items;
    for (const id of Object.keys(store.data.alerted)) if (!live[id]) delete store.data.alerted[id];
    for (const id of Object.keys(store.data.suggested)) if (!live[id]) delete store.data.suggested[id];
    for (const id of Object.keys(store.data.overrides)) {
      if (!live[id] && now - (store.data.overrides[id].setAt || 0) > 30 * 86400000) delete store.data.overrides[id];
    }
    for (const [k, v] of Object.entries(store.data.amazonCache)) {
      if (v.expiresAt + 7 * 86400000 < now) delete store.data.amazonCache[k];
    }
  }

  async function poll() {
    if (polling) return false;
    polling = true;
    const startedAt = Date.now();
    try {
      if (cfg.locations.length && !locationIds) {
        const all = await fetchLocations({ fetchImpl });
        const { ids, unknown } = resolveLocations(cfg.locations, all);
        if (unknown.length || !ids.length) {
          throw new Error(`Unknown BidRL location(s): ${unknown.join(', ') || cfg.locations.join(', ')}. Available: ${all.map((l) => l.name).join(', ')}`);
        }
        locationIds = ids;
        locationNames = ids.map((id) => all.find((l) => l.id === id).name);
        log(`Watching BidRL locations: ${locationNames.join(', ')} (IDs ${ids.join(', ')})`);
      }
      const items = await fetchAllItems({
        affiliateIds: locationIds || [],
        perPage: cfg.perPage,
        delayMs: cfg.requestDelayMs,
        maxPages: cfg.maxPages,
        fetchImpl,
        log,
      });
      const now = Date.now();
      store.data.items = Object.fromEntries(items.filter((i) => i.endsAt > now).map((i) => [i.id, i]));
      store.data.lastPoll = { startedAt, finishedAt: Date.now(), ok: true, count: Object.keys(store.data.items).length };
      prune();
      watchlist.syncFromPoll();
      store.save();
      log(`Poll done: ${store.data.lastPoll.count} open items`);
      await runLookups();
      await runAlerts();
      await watchlist.tick();
      await runWishDigest();
    } catch (err) {
      // Keep the previous item list; just record the failure.
      const msg = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
      store.data.lastPoll = { ...(store.data.lastPoll || {}), startedAt, finishedAt: Date.now(), ok: false, error: msg };
      log(`Poll failed: ${msg}`);
    } finally {
      polling = false;
      store.save();
    }
    return true;
  }

  function schedule() {
    const every = cfg.pollMinutes * 60000;
    const tick = async () => {
      await poll();
      nextPollAt = Date.now() + every;
      timer = setTimeout(tick, every);
    };
    tick();
  }

  // ---------- HTTP ----------

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };

  function send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 10_000) {
          reject(Object.assign(new Error('Body too large'), { code: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { code: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  // Blocks other websites in your browser from changing settings via cross-site requests.
  function sameOriginWrite(req) {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      // Behind a local reverse proxy (e.g. `tailscale serve`), Host may be rewritten; the original is in X-Forwarded-Host.
      // Cross-site pages can't forge either: the JSON content-type above already forces a CORS preflight we never approve.
      const host = new URL(origin).host;
      return host === req.headers.host || host === req.headers['x-forwarded-host'];
    } catch {
      return false;
    }
  }

  function listDeals(params) {
    const s = settings();
    const now = Date.now();
    let deals = Object.values(store.data.items)
      .filter((i) => i.endsAt > now)
      .map((i) => buildDeal(i, s));

    const cities = {};
    for (const d of deals) if (d.city) cities[d.city] = (cities[d.city] || 0) + 1;

    const q = (params.get('q') || '').toLowerCase().trim();
    const city = params.get('city') || '';
    const statuses = (params.get('status') || '').split(',').filter(Boolean);
    const minSavings = Number(params.get('minSavings'));
    const endsWithin = Number(params.get('endsWithin'));
    const source = params.get('source') || '';

    if (q) deals = deals.filter((d) => `${d.title} ${d.category} ${d.lotNumber}`.toLowerCase().includes(q));
    if (city) deals = deals.filter((d) => d.city === city);
    if (Number.isFinite(endsWithin) && endsWithin > 0) deals = deals.filter((d) => d.endsAt - now <= endsWithin * 3600000);
    if (source) deals = deals.filter((d) => d.reference?.source === source);

    // Status counts reflect the other filters (location, search, …) so the chips match what you'd see.
    const counts = { good: 0, fair: 0, over: 0, no_reference: 0 };
    for (const d of deals) counts[d.status]++;

    if (statuses.length) deals = deals.filter((d) => statuses.includes(d.status));
    if (Number.isFinite(minSavings) && params.has('minSavings')) deals = deals.filter((d) => d.savingsPct !== null && d.savingsPct >= minSavings);

    const sorters = {
      savings: (a, b) => (b.savingsPct ?? -1e9) - (a.savingsPct ?? -1e9) || a.endsAt - b.endsAt,
      savingsAmount: (a, b) => (b.savingsAmount ?? -1e9) - (a.savingsAmount ?? -1e9) || a.endsAt - b.endsAt,
      ending: (a, b) => a.endsAt - b.endsAt,
      reference: (a, b) => (b.reference?.price ?? 0) - (a.reference?.price ?? 0),
    };
    deals.sort(sorters[params.get('sort')] || sorters.savings);

    const total = deals.length;
    const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(params.get('offset')) || 0, 0);
    return { total, counts, cities, settings: s, deals: deals.slice(offset, offset + limit) };
  }

  function status() {
    return {
      polling,
      nextPollAt,
      lastPoll: store.data.lastPoll,
      itemCount: Object.keys(store.data.items).length,
      locations: locationNames.length ? locationNames : cfg.locations,
      pollMinutes: cfg.pollMinutes,
      watchCount: Object.keys(store.data.watchlist).length,
      remindMinutes: cfg.watch.remindMinutes,
      amazon: {
        enabled: amazon.enabled,
        provider: cfg.amazon.provider,
        remainingToday: amazon.remainingToday(),
        dailyLimit: cfg.amazon.dailyLimit,
      },
      alertsEnabled: alerter.enabled,
    };
  }

  function validateSettings(body) {
    const out = {};
    const rules = {
      targetSavingsPct: [0, 95],
      salesTaxPct: [0, 20],
      extraFeePerItem: [0, 1000],
    };
    for (const [k, [min, max]] of Object.entries(rules)) {
      if (body[k] === undefined) continue;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`${k} must be ${min}–${max}`), { code: 400 });
      out[k] = n;
    }
    if (body.trustListedRetail !== undefined) out.trustListedRetail = Boolean(body.trustListedRetail);
    return out;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(publicDir, file)), type);
    }
    if (req.method === 'GET' && p === '/api/deals') return send(res, 200, listDeals(url.searchParams));
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, status());
    if (req.method === 'GET' && p === '/api/settings') return send(res, 200, settings());
    if (req.method === 'GET' && p === '/api/watchlist') return send(res, 200, { entries: watchlist.all() });
    if (req.method === 'GET' && p === '/api/summary') {
      // Read-only feed for an assistant (e.g. Galatea). Optional FEED_TOKEN guards it if it's ever exposed.
      if (cfg.feedToken) {
        const given = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (given !== cfg.feedToken) return send(res, 401, { error: 'Missing or wrong token' });
      }
      return send(res, 200, summary());
    }
    if (req.method === 'GET' && p === '/api/wishes') {
      const s = settings();
      return send(res, 200, {
        wishes: store.data.wishes,
        suggestions: suggestions()
          .slice(0, 100)
          .map(({ item, reasons }) => ({ ...buildDeal(item, s), reasons })),
      });
    }

    const isWrite = ['POST', 'PUT', 'DELETE'].includes(req.method);
    if (isWrite && p.startsWith('/api/') && !sameOriginWrite(req)) {
      return send(res, 403, { error: 'Writes must be same-origin JSON requests' });
    }

    if (req.method === 'PUT' && p === '/api/settings') {
      const patch = validateSettings(await readJson(req));
      store.data.settings = { ...store.data.settings, ...patch };
      store.save();
      return send(res, 200, settings());
    }

    if (req.method === 'POST' && p === '/api/refresh') {
      if (polling) return send(res, 409, { error: 'A refresh is already running' });
      poll();
      return send(res, 202, { started: true });
    }

    if (req.method === 'POST' && p === '/api/wishes') {
      const terms = String((await readJson(req)).terms || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      if (!terms) return send(res, 400, { error: 'Type something to look for, e.g. "dyson" or "pool vacuum"' });
      if (store.data.wishes.length >= 50) return send(res, 400, { error: 'You have 50 already. Remove some first.' });
      if (store.data.wishes.some((w) => w.terms.toLowerCase() === terms.toLowerCase())) {
        return send(res, 409, { error: 'Already on your wish list' });
      }
      const wish = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, terms, createdAt: Date.now() };
      store.data.wishes.push(wish);
      store.save();
      return send(res, 201, wish);
    }
    const dm = p.match(/^\/api\/wishes\/([a-z0-9]+)$/);
    if (dm && req.method === 'DELETE') {
      store.data.wishes = store.data.wishes.filter((w) => w.id !== dm[1]);
      store.save();
      return send(res, 200, { removed: true });
    }

    const wm = p.match(/^\/api\/watchlist\/(\d+)(\/refresh)?$/);
    if (wm) {
      const id = wm[1];
      if (!wm[2] && req.method === 'PUT') {
        const body = await readJson(req);
        let maxBid = null;
        if (body.maxBid !== undefined && body.maxBid !== null && body.maxBid !== '') {
          maxBid = Number(body.maxBid);
          if (!Number.isFinite(maxBid) || maxBid <= 0 || maxBid > 100000) return send(res, 400, { error: 'Max bid must be between $0 and $100,000' });
          maxBid = Math.floor(maxBid * 100) / 100;
        }
        const isNew = !watchlist.has(id);
        const v = watchlist.set(id, maxBid);
        if (!v) return send(res, 404, { error: 'Item not found (it may have ended)' });
        const item = store.data.items[id];
        if (isNew && item && amazon.enabled && !amazon.cached(item) && amazon.remainingToday() > 0) {
          // Starred = worth a lookup now. Runs in the background; the list picks it up on its next refresh.
          amazon.lookup(item).catch((err) => log(`Amazon lookup failed: ${err.message}`));
        }
        return send(res, 200, v);
      }
      if (!wm[2] && req.method === 'DELETE') {
        watchlist.remove(id);
        return send(res, 200, { removed: true });
      }
      if (wm[2] && req.method === 'POST') {
        if (!watchlist.has(id)) return send(res, 404, { error: 'Not on your list' });
        try {
          return send(res, 200, await watchlist.refresh(id));
        } catch (err) {
          return send(res, 502, { error: `Couldn't reach BidRL: ${err.message}` });
        }
      }
    }

    const m = p.match(/^\/api\/items\/(\d+)\/(override|lookup)$/);
    if (m) {
      const item = store.data.items[m[1]];
      if (!item) return send(res, 404, { error: 'Item not found (it may have ended)' });

      if (m[2] === 'override' && req.method === 'POST') {
        const body = await readJson(req);
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0 || price > 100000) return send(res, 400, { error: 'price must be 0–100000' });
        let link = null;
        if (body.url) {
          try {
            const u = new URL(String(body.url));
            if (u.protocol !== 'https:') throw new Error();
            link = u.href;
          } catch {
            return send(res, 400, { error: 'url must be an https:// link' });
          }
        }
        store.data.overrides[item.id] = { price, url: link, setAt: Date.now() };
        store.save();
        return send(res, 200, buildDeal(item));
      }
      if (m[2] === 'override' && req.method === 'DELETE') {
        delete store.data.overrides[item.id];
        store.save();
        return send(res, 200, buildDeal(item));
      }
      if (m[2] === 'lookup' && req.method === 'POST') {
        if (!amazon.enabled) return send(res, 400, { error: 'No Amazon provider configured (set AMAZON_PROVIDER and AMAZON_API_KEY)' });
        const r = await amazon.lookup(item);
        if (r.status === 'budget_exhausted') return send(res, 429, { error: 'Daily Amazon lookup budget used up' });
        return send(res, 200, buildDeal(item));
      }
    }

    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const code = err.code >= 400 && err.code < 600 ? err.code : 500;
      if (code === 500) log('Request error:', err);
      if (!res.headersSent) send(res, code, { error: code === 500 ? 'Internal error' : err.message });
    });
  });

  return {
    server,
    store,
    poll,
    watchlist,
    start() {
      server.listen(cfg.port, cfg.host, () => log(`BidRL Deal Tracker on http://${cfg.host}:${cfg.port}`));
      schedule();
      watchTimer = setInterval(() => watchlist.tick().catch((err) => log(`Watch tick failed: ${err.message}`)), 60000);
    },
    stop() {
      clearTimeout(timer);
      clearInterval(watchTimer);
      server.close();
      store.flush();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }
  if (!cfg.amazon.provider) {
    log('No AMAZON_PROVIDER set: using listed retail prices + manual prices only. See README to enable Amazon lookups.');
  }
  const app = createApp(cfg);
  app.start();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('Shutting down');
      app.stop();
      process.exit(0);
    });
  }
}
