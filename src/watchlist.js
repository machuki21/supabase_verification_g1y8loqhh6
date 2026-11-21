import { fetchItemLive } from './bidrl.js';

const money = (n) => `$${Number(n).toFixed(2)}`;
const MIN_GAP_MS = 5000; // robots.txt crawl delay, shared by all live refreshes
const PER_ITEM_COOLDOWN_MS = 15000;
const KEEP_ENDED_MS = 3 * 86400000;

/**
 * Your "Want" list: items you starred, each with an optional personal max bid.
 * Entries keep a snapshot of the item so they still show (as ended) after BidRL drops them.
 */
export function createWatchlist({ store, buildDeal, alerter, remindMinutes, fetchImpl = fetch, log = () => {} }) {
  const list = () => store.data.watchlist;
  let lastLiveAt = 0;
  let ticking = false;

  function view(id, now = Date.now()) {
    const w = list()[id];
    if (!w) return null;
    const item = store.data.items[id] || w.item;
    const deal = buildDeal(item);
    const effectiveMax = w.maxBid ?? deal.maxBid ?? null;
    let status;
    if (item.endsAt <= now) status = 'ended';
    else if (effectiveMax === null) status = 'no_max';
    else if (deal.nextBid > effectiveMax) status = 'over_max';
    else status = 'ok';
    return {
      ...deal,
      wanted: true,
      myMaxBid: w.maxBid,
      watch: { maxBid: w.maxBid, effectiveMax, status, addedAt: w.addedAt, refreshedAt: w.refreshedAt || null, remindedAt: w.remindedAt || null },
    };
  }

  function all() {
    const now = Date.now();
    const views = Object.keys(list()).map((id) => view(id, now)).filter(Boolean);
    const active = views.filter((v) => v.watch.status !== 'ended').sort((a, b) => a.endsAt - b.endsAt);
    const ended = views.filter((v) => v.watch.status === 'ended').sort((a, b) => b.endsAt - a.endsAt);
    return [...active, ...ended];
  }

  function set(id, maxBid) {
    const existing = list()[id];
    const item = store.data.items[id] || existing?.item;
    if (!item) return null;
    list()[id] = {
      ...(existing || { addedAt: Date.now() }),
      item,
      maxBid,
      overAlertedAt: null, // a new max re-arms the "passed your max" alert
    };
    store.save();
    return view(id);
  }

  function remove(id) {
    const had = Boolean(list()[id]);
    delete list()[id];
    store.save();
    return had;
  }

  /** After each full poll: refresh snapshots and drop entries that ended long ago. */
  function syncFromPoll() {
    const now = Date.now();
    for (const [id, w] of Object.entries(list())) {
      if (store.data.items[id]) w.item = store.data.items[id];
      else if (w.item.endsAt + KEEP_ENDED_MS < now) delete list()[id];
    }
    store.save();
  }

  /** Fetch the latest bid for one watched item (rate-limited). */
  async function refresh(id) {
    const w = list()[id];
    if (!w) return null;
    if (w.refreshedAt && Date.now() - w.refreshedAt < PER_ITEM_COOLDOWN_MS) return view(id);
    const wait = lastLiveAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLiveAt = Date.now();
    const live = await fetchItemLive(id, w.item.auctionId, { fetchImpl });
    w.item = { ...w.item, ...live };
    if (store.data.items[id]) store.data.items[id] = { ...store.data.items[id], ...live };
    w.refreshedAt = Date.now();
    store.save();
    return view(id);
  }

  /** Runs every minute: "ending soon" reminders (with a fresh bid) and "passed your max" alerts. */
  async function tick() {
    if (ticking || !alerter.enabled) return;
    ticking = true;
    try {
      const now = Date.now();
      for (const id of Object.keys(list())) {
        const w = list()[id];
        if (!w) continue;
        let v = view(id, now);
        if (v.watch.status === 'ended') continue;

        if (!w.remindedAt && v.endsAt - now <= remindMinutes * 60000) {
          try {
            v = (await refresh(id)) || v;
          } catch (err) {
            log(`Live refresh failed for ${id}: ${err.message}`);
          }
          const mins = Math.max(0, Math.round((v.endsAt - Date.now()) / 60000));
          const max = v.watch.effectiveMax;
          const line =
            max === null
              ? `Next bid ${money(v.nextBid)}. No max set.`
              : v.watch.status === 'over_max'
                ? `Next bid ${money(v.nextBid)} is already past your max ${money(max)}. Skip it or raise your max.`
                : `Next bid ${money(v.nextBid)}. Your max: ${money(max)}.`;
          if (await alerter.sendMessage({ title: `Ends in ${mins} min: ${v.title.slice(0, 70)}`, body: `${line}\n${v.city}`, url: v.url, tags: 'alarm_clock' })) {
            w.remindedAt = Date.now();
            log(`Reminder sent: ${v.title}`);
          }
          v = view(id);
        }

        if (v.watch.status === 'over_max' && !w.overAlertedAt) {
          if (
            await alerter.sendMessage({
              title: `Past your max: ${v.title.slice(0, 70)}`,
              body: `Next bid ${money(v.nextBid)} is over your max ${money(v.watch.effectiveMax)}. Ends ${new Date(v.endsAt).toLocaleString()}.`,
              url: v.url,
              tags: 'warning',
            })
          ) {
            w.overAlertedAt = Date.now();
          }
        } else if (v.watch.status === 'ok' && w.overAlertedAt) {
          w.overAlertedAt = null;
        }
      }
      store.save();
    } finally {
      ticking = false;
    }
  }

  return { view, all, set, remove, refresh, syncFromPoll, tick, has: (id) => Boolean(list()[id]), maxFor: (id) => list()[id]?.maxBid ?? null };
}
