import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allInCost, bidForBudget, evaluateDeal, chooseReference } from '../src/pricing.js';

const settings = { targetSavingsPct: 40, salesTaxPct: 8.75, extraFeePerItem: 0, trustListedRetail: true };
const item = (o = {}) => ({ buyerPremiumPct: 15, currentBid: 20, minimumBid: 21, convenienceFee: 0, listedRetail: null, ...o });

test('all-in cost = bid × (1+premium) × (1+tax) + fee', () => {
  assert.equal(allInCost(100, { buyerPremiumPct: 15, salesTaxPct: 8.75 }), 125.06);
  assert.equal(allInCost(100, { buyerPremiumPct: 15, salesTaxPct: 8.75, fixedFee: 5 }), 130.06);
});

test('bidForBudget inverts allInCost and never exceeds budget', () => {
  const c = { buyerPremiumPct: 15, salesTaxPct: 8.75, fixedFee: 2 };
  for (const budget of [10, 59.99, 120, 2199]) {
    const bid = bidForBudget(budget, c);
    assert.ok(allInCost(bid, c) <= budget + 0.005, `budget ${budget}`);
    assert.ok(allInCost(bid + 0.02, c) > budget, `tight for ${budget}`);
  }
  assert.equal(bidForBudget(1, { buyerPremiumPct: 15, salesTaxPct: 0, fixedFee: 5 }), 0);
});

test('evaluateDeal: good / fair / over / no_reference', () => {
  const ref = { price: 100, source: 'amazon' };
  // max bid for 40% off $100 → all-in ≤ $60 → bid ≤ 47.97; walk-away ≤ 79.96
  const good = evaluateDeal(item({ minimumBid: 40 }), ref, settings);
  assert.equal(good.status, 'good');
  assert.equal(good.maxBid, 47.97);
  assert.equal(good.walkAwayBid, 79.96);
  assert.equal(good.nextAllIn, 50.03);
  assert.equal(good.savingsPct, 50);
  assert.equal(evaluateDeal(item({ minimumBid: 60 }), ref, settings).status, 'fair');
  assert.equal(evaluateDeal(item({ minimumBid: 85, currentBid: 84 }), ref, settings).status, 'over');
  assert.equal(evaluateDeal(item(), null, settings).status, 'no_reference');
});

test('reference priority: manual > Amazon match > listed retail', () => {
  const it = item({ listedRetail: 300 });
  const az = { status: 'matched', price: 250, url: 'https://www.amazon.com/dp/X' };
  assert.equal(chooseReference(it, az, { price: 200 }, settings).source, 'manual');
  assert.equal(chooseReference(it, az, null, settings).price, 250);
  assert.equal(chooseReference(it, { status: 'low_confidence', price: 9 }, null, settings).source, 'listed_retail');
  assert.equal(chooseReference(it, null, null, { ...settings, trustListedRetail: false }), null);
});
