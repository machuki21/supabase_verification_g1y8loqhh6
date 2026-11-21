import { tokens, searchQuery } from './text.js';

const hasDigit = (t) => /\d/.test(t);
const isModel = (t) => /[a-z]/.test(t) && /\d/.test(t) && t.length >= 3; // e.g. hc1850, rx-100 → "rx", "100"

/**
 * How well an Amazon title covers the BidRL title (0–1).
 * Coverage of the BidRL tokens, with numbers/model codes weighted heavier,
 * and penalties when the brand (first word) or a model code is missing.
 * Heuristic — the UI shows the score so you can judge borderline matches.
 */
export function matchScore(bidrlTitle, amazonTitle) {
  const a = [...new Set(tokens(searchQuery(bidrlTitle)))]; // ignore "Factory Sealed, Retail $X" boilerplate
  const b = new Set(tokens(amazonTitle));
  if (!a.length || !b.size) return 0;

  let total = 0;
  let hit = 0;
  for (const t of a) {
    const w = isModel(t) ? 3 : hasDigit(t) ? 2 : 1;
    total += w;
    if (b.has(t)) hit += w;
  }
  let score = hit / total;

  const brand = a[0];
  if (brand && !hasDigit(brand) && !b.has(brand)) score *= 0.7;
  if (a.some((t) => isModel(t) && !b.has(t))) score *= 0.75;
  return Math.round(score * 100) / 100;
}

/**
 * Pick the reference Amazon price from search candidates.
 * Uses the cheapest candidate that clears the confidence bar — conservative,
 * because that's what you could actually buy it for new.
 */
export function pickMatch(bidrlTitle, candidates, minConfidence) {
  const scored = candidates
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.title)
    .map((c) => ({ ...c, confidence: matchScore(bidrlTitle, c.title) }))
    .sort((x, y) => y.confidence - x.confidence);

  if (!scored.length) return { status: 'no_results' };

  const good = scored.filter((c) => c.confidence >= minConfidence && !c.sponsored);
  const pool = good.length ? good : scored.filter((c) => c.confidence >= minConfidence);
  if (pool.length) {
    const best = pool.reduce((lo, c) => (c.price < lo.price ? c : lo));
    return { status: 'matched', ...best };
  }
  return { status: 'low_confidence', ...scored[0] };
}
