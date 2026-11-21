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
import { cacheKey } from './text.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

export function createApp(cfg, { fetchImpl = fetch } = {}) {
  const store = openStore(cfg.dataFile);
  const amazon = createAmazonLookup(cfg.amazon, store, { fetchImpl, log });
  const alerter = createAlerter(cfg.alerts, { fetchImpl, log });

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
        checkedAt: az.checkedAt,
        error: az.error,
      },
      amazonSearchUrl: amazonSearchUrl(item.query, cfg.amazon.domain),
      override,
      reference,
      ...evaluateDeal(item, reference, s),
    };
  }

  async function runLookups() {
    if (!amazon.enabled) return;
    const items = Object.values(store.data.items);
    const todo = lookupCandidates(items, amazon, cfg.amazon);
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
      store.save();
      log(`Poll done: ${store.data.lastPoll.count} open items`);
      await runLookups();
      await runAlerts();
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
      return new URL(origin).host === req.headers.host;
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

    const counts = { good: 0, fair: 0, over: 0, no_reference: 0 };
    const cities = {};
    for (const d of deals) {
      counts[d.status]++;
      if (d.city) cities[d.city] = (cities[d.city] || 0) + 1;
    }

    const q = (params.get('q') || '').toLowerCase().trim();
    const city = params.get('city') || '';
    const statuses = (params.get('status') || '').split(',').filter(Boolean);
    const minSavings = Number(params.get('minSavings'));
    const endsWithin = Number(params.get('endsWithin'));
    const source = params.get('source') || '';

    if (q) deals = deals.filter((d) => `${d.title} ${d.category} ${d.lotNumber}`.toLowerCase().includes(q));
    if (city) deals = deals.filter((d) => d.city === city);
    if (statuses.length) deals = deals.filter((d) => statuses.includes(d.status));
    if (Number.isFinite(minSavings) && params.has('minSavings')) deals = deals.filter((d) => d.savingsPct !== null && d.savingsPct >= minSavings);
    if (Number.isFinite(endsWithin) && endsWithin > 0) deals = deals.filter((d) => d.endsAt - now <= endsWithin * 3600000);
    if (source) deals = deals.filter((d) => d.reference?.source === source);

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
    start() {
      server.listen(cfg.port, cfg.host, () => log(`BidRL Deal Tracker on http://${cfg.host}:${cfg.port}`));
      schedule();
    },
    stop() {
      clearTimeout(timer);
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
