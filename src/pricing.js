const round2 = (n) => Math.round(n * 100) / 100;
const floor2 = (n) => Math.floor(n * 100 + 1e-6) / 100;

/** Total out-of-pocket for a winning bid: hammer + buyer's premium, taxed, plus any fixed fee. */
export function allInCost(bid, { buyerPremiumPct, salesTaxPct, fixedFee = 0 }) {
  return round2(bid * (1 + buyerPremiumPct / 100) * (1 + salesTaxPct / 100) + fixedFee);
}

/** Largest bid whose all-in cost stays at or under `budget`. */
export function bidForBudget(budget, { buyerPremiumPct, salesTaxPct, fixedFee = 0 }) {
  const bid = (budget - fixedFee) / ((1 + buyerPremiumPct / 100) * (1 + salesTaxPct / 100));
  return bid > 0 ? floor2(bid) : 0;
}

/**
 * Pick the price we compare against: your manual override, then a confident
 * Amazon match, then the retail price the listing states (if allowed).
 */
export function chooseReference(item, amazon, override, settings) {
  if (override?.price > 0) return { price: override.price, source: 'manual', url: override.url || null };
  if (amazon?.status === 'matched' && amazon.price > 0) return { price: amazon.price, source: 'amazon', url: amazon.url || null };
  if (settings.trustListedRetail && item.listedRetail > 0) return { price: item.listedRetail, source: 'listed_retail', url: null };
  return null;
}

/**
 * Bid guidance for one item.
 *  - maxBid:      highest bid that still gets you `targetSavingsPct` off the reference price, all-in
 *  - walkAwayBid: break-even bid — above this you'd pay more than buying it new
 *  - status:      good (next bid ≤ maxBid) | fair (≤ walkAway) | over | no_reference
 */
export function evaluateDeal(item, reference, settings) {
  const costs = {
    buyerPremiumPct: item.buyerPremiumPct,
    salesTaxPct: settings.salesTaxPct,
    fixedFee: settings.extraFeePerItem + (item.convenienceFee || 0),
  };
  const nextBid = Math.max(item.minimumBid || 0, item.currentBid || 0);
  const nextAllIn = allInCost(nextBid, costs);

  if (!reference) {
    return { status: 'no_reference', nextBid, nextAllIn, maxBid: null, walkAwayBid: null, savingsPct: null, savingsAmount: null };
  }

  const ref = reference.price;
  const maxBid = bidForBudget(ref * (1 - settings.targetSavingsPct / 100), costs);
  const walkAwayBid = bidForBudget(ref, costs);
  const savingsAmount = round2(ref - nextAllIn);
  const savingsPct = Math.round((savingsAmount / ref) * 1000) / 10;

  let status = 'over';
  if (nextBid <= maxBid) status = 'good';
  else if (nextBid <= walkAwayBid) status = 'fair';

  return { status, nextBid, nextAllIn, maxBid, walkAwayBid, savingsPct, savingsAmount };
}
