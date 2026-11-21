import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, pickMatch } from '../src/match.js';

const bidrl = 'Brother HC1850 Sewing and Quilting Machine, Factory Sealed, Retail $300';

test('scores the right product high and wrong ones low', () => {
  assert.ok(matchScore(bidrl, 'Brother HC1850 Computerized Sewing and Quilting Machine, 185 Built-in Stitches') >= 0.6);
  assert.ok(matchScore(bidrl, 'Brother XM2701 Sewing Machine, Lightweight') < 0.6, 'different model');
  assert.ok(matchScore(bidrl, 'Singer Heavy Duty Sewing Machine') < 0.4, 'different brand');
});

test('pickMatch takes the cheapest confident, non-sponsored result', () => {
  const r = pickMatch(bidrl, [
    { title: 'Brother XM2701 Sewing Machine', price: 99 },
    { title: 'Brother HC1850 Sewing and Quilting Machine', price: 289.99, url: 'a' },
    { title: 'Brother HC1850 Sewing Quilting Machine Bundle', price: 240, sponsored: true },
    { title: 'Brother HC1850 Computerized Sewing and Quilting Machine', price: 259.5, url: 'b' },
  ], 0.6);
  assert.equal(r.status, 'matched');
  assert.equal(r.price, 259.5);
});

test('pickMatch reports weak matches without using them', () => {
  assert.equal(pickMatch(bidrl, [{ title: 'Thread spool set 40 colors', price: 12 }], 0.6).status, 'low_confidence');
  assert.equal(pickMatch(bidrl, [{ title: 'x', price: NaN }], 0.6).status, 'no_results');
  assert.equal(pickMatch(bidrl, [], 0.6).status, 'no_results');
});
