import { decodeEntities, stripHtml, parseListedRetail, conditionFlags, searchQuery } from './text.js';

export const BIDRL_BASE = 'https://www.bidrl.com';
const USER_AGENT = 'BidRLDealTracker/1.0 (personal price tracker; honors robots.txt crawl-delay)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function safeBidrlUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)bidrl\.com$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function safeImageUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** One page of open items from BidRL's own JSON endpoint (the one its website uses). */
export async function fetchItemsPage(page, perPage, { affiliateId = null, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const body = new URLSearchParams({ 'filters[perpage]': String(perPage), 'filters[page]': String(page) });
  // BidRL accepts one location (affiliate) per request; "19,3" silently returns only the first.
  if (affiliateId) body.set('filters[affiliates]', String(affiliateId));
  const res = await fetchImpl(`${BIDRL_BASE}/api/getitems`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`BidRL getitems page ${page}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.items)) throw new Error(`BidRL getitems page ${page}: unexpected response shape`);
  return data;
}

/** BidRL locations ("affiliates"): [{ id, name, auctionCount }]. */
export async function fetchLocations({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BIDRL_BASE}/api/affiliates`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`BidRL affiliates: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.data !== 'object') throw new Error('BidRL affiliates: unexpected response shape');
  return Object.values(data.data).map((a) => ({
    id: String(a.id),
    name: decodeEntities(a.company_name || '').trim(),
    auctionCount: toNum(a.auc_count),
  }));
}

/** Map location names (case-insensitive, e.g. "Turlock") or numeric IDs to BidRL affiliate IDs. */
export function resolveLocations(wanted, locations) {
  const ids = [];
  const unknown = [];
  for (const w of wanted) {
    const key = w.trim().toLowerCase();
    if (!key) continue;
    const hit = locations.find((l) => l.id === key || l.name.toLowerCase() === key) ||
      locations.find((l) => l.name.toLowerCase().includes(key));
    if (hit) ids.push(hit.id);
    else unknown.push(w.trim());
  }
  return { ids: [...new Set(ids)], unknown };
}

async function fetchAllPages(affiliateId, { perPage, delayMs, maxPages, fetchImpl, log, label }) {
  const first = await fetchItemsPage(1, perPage, { affiliateId, fetchImpl });
  const totalPages = Math.min(Number(first.total_pages) || 1, maxPages);
  const raw = [...first.items];
  log(`BidRL ${label} page 1/${totalPages}: ${first.items.length} items (site reports ${first.total})`);
  for (let page = 2; page <= totalPages; page++) {
    await sleep(delayMs);
    const data = await fetchItemsPage(page, perPage, { affiliateId, fetchImpl });
    raw.push(...data.items);
    log(`BidRL ${label} page ${page}/${totalPages}: ${data.items.length} items`);
    if (!data.items.length) break;
  }
  return raw;
}

/**
 * Every open item, politely spaced (robots.txt Crawl-delay: 5).
 * With affiliateIds, sweeps only those locations; otherwise the whole site.
 */
export async function fetchAllItems({ perPage = 500, delayMs = 5000, maxPages = 60, affiliateIds = [], fetchImpl = fetch, log = () => {} } = {}) {
  const targets = affiliateIds.length ? affiliateIds : [null];
  const byId = new Map();
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(delayMs);
    const label = targets[i] ? `location ${targets[i]}` : 'all locations';
    const raw = await fetchAllPages(targets[i], { perPage, delayMs, maxPages, fetchImpl, log, label });
    for (const r of raw) {
      const item = normalizeItem(r);
      if (item) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export function normalizeItem(raw) {
  if (!raw || !raw.id || !raw.title) return null;
  const title = decodeEntities(raw.title).trim();
  const description = stripHtml(raw.description).slice(0, 1500);
  const endsAt = toNum(raw.end_time || raw.ends) * 1000;
  const img = Array.isArray(raw.images) && raw.images[0] ? raw.images[0].thumb_url || raw.images[0].image_url : raw.thumb_url;

  return {
    id: String(raw.id),
    auctionId: String(raw.auction_id || ''),
    lotNumber: raw.lot_number || '',
    title,
    description,
    category: decodeEntities(raw.category_name || ''),
    auctionTitle: decodeEntities(raw.auction_title || ''),
    city: (raw.mapping_city || '').trim(),
    address: decodeEntities(raw.item_address || ''),
    url: safeBidrlUrl(raw.item_url),
    image: safeImageUrl(img),
    quantity: toNum(raw.quantity) || 1,
    currentBid: toNum(raw.current_bid),
    minimumBid: toNum(raw.minimum_bid),
    bidCount: toNum(raw.bid_count),
    buyerPremiumPct: toNum(raw.buyer_premium),
    convenienceFee: toNum(raw.convenience_fee),
    buyNow: toNum(raw.buy_now),
    hasReserve: Boolean(raw.has_reserve),
    reserveMet: Boolean(raw.reserve_met),
    endsAt,
    listedRetail: parseListedRetail(title, description),
    flags: conditionFlags(title, description),
    query: searchQuery(title),
  };
}

/** Latest bid/end time for one item — a single small request, used for watched items near their close. */
export async function fetchItemLive(itemId, auctionId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BIDRL_BASE}/api/ItemData`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({ item_id: String(itemId), auction_id: String(auctionId || 0) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`BidRL ItemData ${itemId}: HTTP ${res.status}`);
  const d = await res.json();
  if (!d || String(d.id) !== String(itemId)) throw new Error(`BidRL ItemData ${itemId}: unexpected response`);
  const live = {
    currentBid: toNum(d.current_bid),
    minimumBid: toNum(d.minimum_bid),
    bidCount: toNum(d.bid_count),
  };
  if (toNum(d.end_time) > 0) live.endsAt = toNum(d.end_time) * 1000;
  if (d.buyer_premium !== undefined && d.buyer_premium !== null) live.buyerPremiumPct = toNum(d.buyer_premium);
  return live;
}
