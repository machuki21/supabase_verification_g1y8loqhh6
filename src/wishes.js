import { tokens } from './text.js';
import { matchScore } from './match.js';

const stem = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
const stems = (s) => new Set(tokens(s).map(stem));
const MAX_SUGGESTIONS = 200;
const SIMILAR_MIN_SCORE = 0.6;

/** Every word of the wish appears in the item's title or category ("pool vacuum" matches "Cordless Robotic Pool Vacuum Cleaner"). */
export function wishMatches(item, wishTerms) {
  const want = [...stems(wishTerms)];
  if (!want.length) return false;
  const have = stems(`${item.title} ${item.category || ''}`);
  return want.every((w) => have.has(w));
}

/**
 * Things you might want: items matching a wish-list keyword, or similar to something you starred.
 * Returns [{ item, reasons: [...] }] sorted by soonest ending.
 */
export function findSuggestions(items, wishes, starred, now = Date.now()) {
  const starredIds = new Set(starred.map((s) => s.id));
  const out = [];
  for (const item of items) {
    if (item.endsAt <= now || starredIds.has(item.id)) continue;
    const reasons = [];
    for (const w of wishes) if (wishMatches(item, w.terms)) reasons.push(`matches "${w.terms}"`);
    for (const s of starred) {
      if (matchScore(s.title, item.title) >= SIMILAR_MIN_SCORE && matchScore(item.title, s.title) >= SIMILAR_MIN_SCORE) {
        reasons.push(`like "${s.title.slice(0, 40)}"`);
        break;
      }
    }
    if (reasons.length) out.push({ item, reasons });
  }
  return out.sort((a, b) => a.item.endsAt - b.item.endsAt).slice(0, MAX_SUGGESTIONS);
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** One notification summarizing new suggestions; null if there's nothing new. */
export function digestMessage(fresh, appUrl) {
  if (!fresh.length) return null;
  const lines = fresh.slice(0, 8).map(({ deal, reasons }) => {
    const price = deal.reference ? ` · max bid ${money(deal.maxBid)}` : '';
    return `• ${deal.title.slice(0, 60)} (${deal.city}) · bid ${money(deal.nextBid)}${price} · ends ${when(deal.endsAt)} · ${reasons[0]}`;
  });
  if (fresh.length > 8) lines.push(`…and ${fresh.length - 8} more in the app.`);
  return {
    title: fresh.length === 1 ? `You might want: ${fresh[0].deal.title.slice(0, 60)}` : `${fresh.length} new things you might want`,
    body: lines.join('\n'),
    url: appUrl || (fresh.length === 1 ? fresh[0].deal.url : null),
    tags: 'eyes',
  };
}
