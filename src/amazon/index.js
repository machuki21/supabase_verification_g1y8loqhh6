import { searchSerpApi } from './serpapi.js';
import { searchRainforest } from './rainforest.js';
import { pickMatch, productTokens } from '../match.js';
import { cacheKey } from '../text.js';

const PROVIDERS = { serpapi: searchSerpApi, rainforest: searchRainforest };
const today = () => new Date().toISOString().slice(0, 10);

export function amazonSearchUrl(query, domain = 'amazon.com') {
  return `https://www.${domain}/s?k=${encodeURIComponent(query)}`;
}

function safeAmazonUrl(u, domain) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname.endsWith(domain) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Amazon price lookups with a persistent cache (keyed by normalized search query,
 * so duplicate lots share one paid call) and a daily budget.
 */
export function createAmazonLookup(cfg, store, { fetchImpl = fetch, log = () => {} } = {}) {
  const search = cfg.provider ? PROVIDERS[cfg.provider] : null;
  const ttlMs = cfg.cacheDays * 86400000;

  function usage() {
    const u = store.data.lookupUsage;
    if (u.date !== today()) {
      u.date = today();
      u.count = 0;
    }
    return u;
  }

  function cached(item) {
    const hit = store.data.amazonCache[cacheKey(item.query)];
    return hit && hit.expiresAt > Date.now() ? hit : null;
  }

  return {
    enabled: Boolean(search),
    remainingToday: () => (search ? Math.max(0, cfg.dailyLimit - usage().count) : 0),
    cached,

    async lookup(item) {
      if (!search) return { status: 'disabled' };
      const u = usage();
      if (u.count >= cfg.dailyLimit) return { status: 'budget_exhausted' };
      u.count++;
      const key = cacheKey(item.query);
      let result;
      try {
        const candidates = await search(item.query, { apiKey: cfg.apiKey, domain: cfg.domain, fetchImpl });
        const m = pickMatch(item.title, candidates, cfg.minConfidence);
        result = {
          status: m.status,
          price: m.price ?? null,
          title: m.title ?? null,
          asin: m.asin ?? null,
          url: m.url ? safeAmazonUrl(m.url, cfg.domain) : null,
          confidence: m.confidence ?? null,
          generic: Boolean(m.generic),
          candidates: candidates.length,
        };
      } catch (err) {
        log(`Amazon lookup failed for "${item.query}": ${err.message}`);
        // Errors are cached for 1 hour only so a transient outage doesn't burn the budget on retries.
        result = { status: 'error', error: err.message };
      }
      result.query = item.query;
      result.provider = cfg.provider;
      result.checkedAt = Date.now();
      result.expiresAt = result.checkedAt + (result.status === 'error' ? 3600000 : ttlMs);
      store.data.amazonCache[key] = result;
      store.save();
      return result;
    },
  };
}

/**
 * Which items to spend lookups on this cycle, one per unique search query:
 *  1. Your starred items (any end time, even vague titles — you asked for them)
 *  2. Items ending within the lookup window, highest stated retail first, then soonest.
 *     One- and two-word titles ("Light Fixture") are skipped here: too vague to be worth a paid search.
 */
export function lookupCandidates(items, amazon, { lookupWindowHours, perCycleLimit }, now = Date.now(), { priorityIds = new Set() } = {}) {
  const horizon = now + lookupWindowHours * 3600000;
  const open = items.filter((i) => i.endsAt > now && i.query && !amazon.cached(i));
  const starred = open.filter((i) => priorityIds.has(i.id)).sort((a, b) => a.endsAt - b.endsAt);
  const rest = open
    .filter((i) => !priorityIds.has(i.id) && i.endsAt <= horizon && productTokens(i.title).length >= 3)
    .sort((a, b) => (b.listedRetail || 0) - (a.listedRetail || 0) || a.endsAt - b.endsAt);
  const seen = new Set();
  return [...starred, ...rest]
    .filter((i) => {
      const k = cacheKey(i.query);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, Math.min(perCycleLimit, amazon.remainingToday()));
}
